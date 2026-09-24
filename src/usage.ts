/**
 * Durable per-project MCP usage counters for `dsh-project-mcp`.
 *
 * The host half counts the `tools/result` events whose tool belongs to a server
 * it mounted itself, keyed by project root and `serverName`. The numbers are
 * remembered across sessions and restarts in one versioned document under
 * `$DSH_HOME`, written atomically on a debounce so a tool call never waits for
 * the filesystem, and a failed write is logged and dropped rather than allowed
 * to disturb the call.
 *
 * Counting itself is pure ({@link recordUsage}) and the document only sits
 * behind {@link UsageStore}, so the model is testable without a filesystem.
 *
 * @module dsh-project-mcp/usage
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from './discovery.ts'
import type { ServerUsage, SessionUsage } from './types.ts'

/** Current on-disk document version; another version is ignored, not migrated. */
export const USAGE_VERSION = 1

/** Counter document name under `$DSH_HOME`. */
export const USAGE_FILE_NAME = 'dsh-project-mcp-usage.json'

/** Counters keyed by project root, then by `serverName`. */
export type UsageState = Record<string, Record<string, ServerUsage>>

/** The durable counter document as written to disk. */
export interface UsageDocument {
  /** Document version; a reader that does not know it starts clean. */
  version: typeof USAGE_VERSION
  /** Counters of every project ever seen. */
  projects: UsageState
}

/** One registry call, before it is attributed to a mounted server. */
export interface UsageCall {
  /** Project root the calling agent resolved to. */
  projectRoot: string
  /** Server names this plugin currently mounts for that project. */
  servers: ReadonlySet<string>
  /**
   * Public tool name delivered by `tools/result`, ie `mcp__<serverName>__<name>`.
   * A name the registry had to truncate to the function-name budget keeps this
   * prefix, so the server is still identifiable.
   */
  toolName: string
  /** `true` when the settled result carried an error. */
  isError: boolean
  /** Epoch milliseconds of the call. */
  at: number
  /**
   * Session the call belongs to: the id of the agent that made it.
   *
   * The host resolves an agent from the call's own event, and every other
   * surface of this plugin already calls that id the session id (a `LogEvent`,
   * a `SessionSnapshot`). Counting is therefore attributable without a second
   * lookup, which is what lets the panel answer "and how much of this is mine?"
   * (F-34).
   */
  sessionId: string
}

/** One counted call, attributed to a project and a server this plugin mounted. */
export interface UsageEvent {
  /** Project root the calling agent resolved to. */
  projectRoot: string
  /** `serverName` this plugin mounted for that project. */
  serverName: string
  /**
   * Tool name as declared by the server, ie without the `mcp__<serverName>__`
   * prefix. A name the registry truncated to its function-name budget cannot be
   * reversed, so its key is the public suffix the registry published.
   */
  tool: string
  /** `true` when the settled result carried an error. */
  isError: boolean
  /** Epoch milliseconds of the call. */
  at: number
  /** Session (agent) id this call is counted under, besides the project total. */
  sessionId: string
}

/** The `tools/result` execution view this module reads. */
export interface ToolResultEventLike {
  /** Public tool name, `mcp__<serverName>__<name>`. */
  readonly name: string
  /** Agent the call ran for; absent on a host-level call, which is not counted. */
  readonly agent?: { readonly id: string } | undefined
}

/** The settled `tools/result` outcome view this module reads. */
export interface ToolResultLike {
  /** `true` when the call settled as an error. */
  readonly isError: boolean
}

/** Everything {@link observeToolResults} needs, injected so it is testable. */
export interface ToolResultObserverOptions {
  /** Register the `tools/result` listener; returns its disposer. */
  on(
    name: 'tools/result',
    handler: (exec: ToolResultEventLike, result: ToolResultLike) => undefined,
  ): (() => void) | undefined
  /** Resolve the project and the mounted servers of the agent that made a call. */
  mountsFor(agentId: string): { projectRoot: string; servers: ReadonlySet<string> } | undefined
  /** Durable store the attributed calls are recorded in. */
  store: Pick<UsageStore, 'record'>
  /** Clock override; defaults to `Date.now`. */
  now?: () => number
}

/** The logger surface the store uses; a Cordis logger satisfies it. */
export interface UsageLogger {
  /** Non-fatal report; the store never throws at its caller. */
  warn(message: string): void
}

/** Construction options for {@link UsageStore}; production uses the defaults. */
export interface UsageStoreOptions {
  /** Absolute document path; defaults to `$DSH_HOME/dsh-project-mcp-usage.json`. */
  file?: string
  /** Debounce before a recorded call reaches disk. */
  flushMs?: number
  /** Sink for a corrupt document or a failed write. */
  logger?: UsageLogger
}

/** Debounce that keeps a tool call off the filesystem. */
const DEFAULT_FLUSH_MS = 1_000

/**
 * Attribute one registry tool name to a server this plugin mounted.
 *
 * The prefix is never parsed blindly: only mounted names are candidates, and
 * the longest match wins, so a mounted `alpha_` is never shadowed by a mounted
 * `alpha` when both publish tools into one scope.
 *
 * @param toolName - public registry name, `mcp__<serverName>__<name>`.
 * @param servers - names this plugin mounted for the calling agent's project.
 * @returns the matched `serverName`, or `undefined` for a foreign tool.
 */
export function matchServer(toolName: string, servers: ReadonlySet<string>): string | undefined {
  let match: string | undefined
  for (const server of servers) {
    if (!toolName.startsWith(`mcp__${server}__`)) continue
    if (match === undefined || server.length > match.length) match = server
  }
  return match
}

/**
 * Attribute one registry call, or `undefined` when no server this plugin
 * mounted for the project claims the name.
 * @param call - the raw `tools/result` view plus the caller's mounts.
 * @returns the counted event, ready for {@link recordUsage}.
 */
export function usageEventFor(call: UsageCall): UsageEvent | undefined {
  const serverName = matchServer(call.toolName, call.servers)
  if (serverName === undefined) return undefined
  return {
    projectRoot: call.projectRoot,
    serverName,
    tool: call.toolName.slice(`mcp__${serverName}__`.length),
    isError: call.isError,
    at: call.at,
    sessionId: call.sessionId,
  }
}

/**
 * Count one call into the state.
 *
 * Pure: it reads and returns counters only, touching no filesystem, clock or
 * logger, so the model is testable on its own.
 *
 * @param state - counters before the call.
 * @param event - one attributed call.
 * @returns a new state carrying the increment; `lastUsedAt` moves and is set
 * only on a success, while a failure keeps the previous stamp.
 */
export function recordUsage(state: UsageState, event: UsageEvent): UsageState {
  const project = state[event.projectRoot] ?? {}
  const previous = project[event.serverName]
  const tools: Record<string, number> = { ...previous?.tools }
  tools[event.tool] = (tools[event.tool] ?? 0) + 1
  const lastUsedAt = event.isError ? previous?.lastUsedAt : new Date(event.at).toISOString()
  const sessions: Record<string, SessionUsage> = { ...previous?.sessions }
  const previousSession = sessions[event.sessionId]
  const sessionTools: Record<string, number> = { ...previousSession?.tools }
  sessionTools[event.tool] = (sessionTools[event.tool] ?? 0) + 1
  const sessionLastUsedAt = event.isError
    ? previousSession?.lastUsedAt
    : new Date(event.at).toISOString()
  sessions[event.sessionId] = {
    calls: (previousSession?.calls ?? 0) + 1,
    errors: (previousSession?.errors ?? 0) + (event.isError ? 1 : 0),
    tools: sessionTools,
    ...(sessionLastUsedAt === undefined ? {} : { lastUsedAt: sessionLastUsedAt }),
  }
  const usage: ServerUsage = {
    calls: (previous?.calls ?? 0) + 1,
    errors: (previous?.errors ?? 0) + (event.isError ? 1 : 0),
    tools,
    sessions,
    ...(lastUsedAt === undefined ? {} : { lastUsedAt }),
  }
  return {
    ...state,
    [event.projectRoot]: { ...project, [event.serverName]: usage },
  }
}

/**
 * Subscribe the durable counters to `tools/result`.
 *
 * Counting is per event, never deduplicated against a parent: a programmatic
 * sub-dispatch is its own call with its own result, while the enclosing
 * `run_code` carries a name no server claims, so each MCP call is counted
 * exactly once on either path.
 *
 * @param options - registry subscription, agent resolver, store and clock.
 * @returns the disposer that unregisters the listener.
 */
export function observeToolResults(options: ToolResultObserverOptions): () => void {
  const now = options.now ?? Date.now
  const listener = (exec: ToolResultEventLike, result: ToolResultLike): undefined => {
    const agentId = exec.agent?.id
    if (agentId === undefined) return undefined
    const mounts = options.mountsFor(agentId)
    if (mounts === undefined) return undefined
    const event = usageEventFor({
      projectRoot: mounts.projectRoot,
      servers: mounts.servers,
      toolName: exec.name,
      isError: result.isError,
      at: now(),
      sessionId: agentId,
    })
    if (event === undefined) return undefined
    options.store.record(event)
    return undefined
  }
  const dispose = options.on('tools/result', listener)
  return () => {
    dispose?.()
  }
}

/**
 * The durable counters: one versioned document under `$DSH_HOME`, loaded once
 * when the plugin applies and written atomically on a debounce.
 *
 * Every failure mode is non-fatal by design. A missing, unreadable, foreign or
 * older-version document starts clean, and a write that fails is logged and
 * forgotten, because a tool call must never fail on a counter that could not
 * be stored.
 */
export class UsageStore {
  private state: UsageState
  private timer: ReturnType<typeof setTimeout> | undefined
  private dirty = false
  private disposed = false
  private readonly file: string
  private readonly flushMs: number
  private readonly logger: UsageLogger | undefined

  /** @param options - document path, debounce and log sink. */
  constructor(options: UsageStoreOptions = {}) {
    this.file = options.file ?? join(dshHome(), USAGE_FILE_NAME)
    this.flushMs = options.flushMs ?? DEFAULT_FLUSH_MS
    this.logger = options.logger
    this.state = this.load()
  }

  /** Counters of one project root, or `undefined` when it has none yet. */
  forProject(projectRoot: string): Record<string, ServerUsage> | undefined {
    return this.state[projectRoot]
  }

  /** Count one attributed call and schedule the debounced write. */
  record(event: UsageEvent): void {
    if (this.disposed) return
    this.state = recordUsage(this.state, event)
    this.dirty = true
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, this.flushMs)
    this.timer.unref?.()
  }

  /** Write the counters atomically now. Best effort: it never throws. */
  flush(): void {
    if (!this.dirty) return
    const document: UsageDocument = { version: USAGE_VERSION, projects: this.state }
    const temporary = `${this.file}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(temporary, `${JSON.stringify(document, undefined, 2)}\n`, 'utf8')
      renameSync(temporary, this.file)
      this.dirty = false
    } catch (error) {
      this.logger?.warn(
        `project-mcp: writing usage counters to ${this.file} failed: ${errorText(error)}`,
      )
    }
  }

  /**
   * Cancel the pending write, flush what is dirty, and stop counting. Safe to
   * call more than once; the plugin fiber calls it on disposal.
   */
  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.disposed) return
    this.disposed = true
    this.flush()
  }

  private load(): UsageState {
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return {}
    }
    const state = parseUsageDocument(text)
    if (state === undefined) {
      this.logger?.warn(
        `project-mcp: ignoring usage counters in ${this.file} (unreadable or unsupported version); starting clean`,
      )
      return {}
    }
    return state
  }
}

/**
 * Parse one durable counter document.
 *
 * Anything this version cannot trust — malformed JSON, a foreign shape, or
 * another version — yields `undefined` so the caller starts clean instead of
 * throwing, and each counter is validated so a hand-edited document cannot
 * poison later arithmetic.
 *
 * @param text - raw document contents.
 * @returns the counters, or `undefined` when the document is not usable.
 */
export function parseUsageDocument(text: string): UsageState | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  if (value.version !== USAGE_VERSION) return undefined
  if (!isRecord(value.projects)) return undefined
  return sanitizeProjects(value.projects)
}

function sanitizeProjects(raw: Record<string, unknown>): UsageState {
  const projects: UsageState = {}
  for (const [root, servers] of Object.entries(raw)) {
    if (!isRecord(servers)) continue
    const rows: Record<string, ServerUsage> = {}
    for (const [server, usage] of Object.entries(servers)) {
      const parsed = sanitizeUsage(usage)
      if (parsed !== undefined) rows[server] = parsed
    }
    if (Object.keys(rows).length > 0) projects[root] = rows
  }
  return projects
}

function sanitizeUsage(value: unknown): ServerUsage | undefined {
  if (!isRecord(value)) return undefined
  if (!isCount(value.calls) || !isCount(value.errors)) return undefined
  return {
    calls: value.calls,
    errors: value.errors,
    tools: countMap(value.tools),
    // The per-session split is carried through, not rebuilt: a reader that
    // dropped it would lose every session figure on the first restart, while
    // the project totals it kept looked perfectly healthy.
    ...sanitizeSessions(value.sessions),
    ...(typeof value.lastUsedAt === 'string' ? { lastUsedAt: value.lastUsedAt } : {}),
  }
}

/** A record of non-negative integer counts, with every other entry dropped. */
function countMap(value: unknown): Record<string, number> {
  const counts: Record<string, number> = {}
  if (isRecord(value)) {
    for (const [name, count] of Object.entries(value)) {
      if (isCount(count)) counts[name] = count
    }
  }
  return counts
}

/** The `sessions` half of a stored record, as the `...` spread a caller wants. */
function sanitizeSessions(value: unknown): { sessions?: Record<string, SessionUsage> } {
  if (!isRecord(value)) return {}
  const sessions: Record<string, SessionUsage> = {}
  for (const [id, usage] of Object.entries(value)) {
    const parsed = sanitizeSessionUsage(usage)
    if (parsed !== undefined) sessions[id] = parsed
  }
  return Object.keys(sessions).length === 0 ? {} : { sessions }
}

function sanitizeSessionUsage(value: unknown): SessionUsage | undefined {
  if (!isRecord(value)) return undefined
  if (!isCount(value.calls) || !isCount(value.errors)) return undefined
  return {
    calls: value.calls,
    errors: value.errors,
    tools: countMap(value.tools),
    ...(typeof value.lastUsedAt === 'string' ? { lastUsedAt: value.lastUsedAt } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
