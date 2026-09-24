/**
 * Durable per-project tool policy for `dsh-project-mcp`.
 *
 * The panel lets a user decide how one project's MCP tools are offered — never
 * defer (`direct`), do not offer them at all (`off`), or keep the shipped
 * on-demand presentation (`disclosure`) — and which tool names are pinned. That
 * decision is the same kind of state as the usage counters: remembered across
 * sessions and restarts in one versioned document under `$DSH_HOME`, written
 * atomically on a debounce, and never able to break a model request.
 *
 * The decision logic is pure ({@link policyFor}, {@link withMode},
 * {@link withPin}) and the document only sits behind {@link PolicyStore}, so the
 * model is testable without a filesystem. Absent file, absent project and absent
 * field all mean {@link DEFAULT_TOOL_POLICY}, so a broken or hand-edited
 * document can only ever fall back to the shipped behaviour.
 *
 * @module dsh-project-mcp/policy
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from './discovery.ts'
import { DEFAULT_TOOL_POLICY } from './types.ts'
import type { ConflictChoice, ToolMode, ToolPolicy } from './types.ts'

/** Current on-disk document version; another version is ignored, not migrated. */
export const POLICY_VERSION = 1

/** Policy document name under `$DSH_HOME`, next to the usage counters. */
export const POLICY_FILE_NAME = 'dsh-project-mcp-policy.json'

/** Every mode a request may store, in the order the type declares them. */
export const TOOL_MODES: readonly ToolMode[] = ['disclosure', 'direct', 'off']

/** Policy of every project ever configured, keyed by project root. */
export type PolicyState = Record<string, ToolPolicy>

/** The durable policy document as written to disk. */
export interface PolicyDocument {
  /** Document version; a reader that does not know it starts clean. */
  version: typeof POLICY_VERSION
  /** Policy of every project the user configured. */
  projects: PolicyState
}

/** The logger surface the store uses; a Cordis logger satisfies it. */
export interface PolicyLogger {
  /** Non-fatal report; the store never throws at its caller. */
  warn(message: string): void
}

/** Construction options for {@link PolicyStore}; production uses the defaults. */
export interface PolicyStoreOptions {
  /** Absolute document path; defaults to `$DSH_HOME/dsh-project-mcp-policy.json`. */
  file?: string
  /** Debounce before a policy change reaches disk. */
  flushMs?: number
  /** Sink for a corrupt document or a failed write. */
  logger?: PolicyLogger
}

/** Debounce that keeps a panel click off the filesystem. */
const DEFAULT_FLUSH_MS = 1_000

/**
 * The shape `@deepseek-ai/dsh-mcp-client` accepts for a reserved `serverName`,
 * narrowed to a name that may open a stored conflict key: a key that fails it is
 * a hand-edit or an array index, and never a server this host could mount.
 */
const SERVER_NAME_SHAPE = /^[A-Za-z_][A-Za-z0-9_-]*$/

/**
 * Whether a value is one of the modes this plugin stores.
 *
 * The routes read an untrusted JSON body, so the check belongs here rather than
 * in the type system: a body that names an unknown mode is refused instead of
 * being stored as a mode no assembly would know what to do with.
 *
 * @param value - parsed request or document value.
 * @returns `true` when the value is a {@link ToolMode}.
 */
export function isToolMode(value: unknown): value is ToolMode {
  return typeof value === 'string' && (TOOL_MODES as readonly string[]).includes(value)
}

/**
 * The policy in force for one project.
 *
 * Pure: it reads the state only. An absent project is the shipped default rather
 * than an error, which is what makes a fresh install behave exactly like the
 * plugin before this document existed.
 *
 * @param state - policies before the read.
 * @param projectRoot - project root the policy belongs to.
 * @returns the stored policy, or {@link DEFAULT_TOOL_POLICY} when there is none.
 */
export function policyFor(state: PolicyState, projectRoot: string): ToolPolicy {
  return state[projectRoot] ?? DEFAULT_TOOL_POLICY
}

/**
 * Whether a value is one of the conflict answers this plugin stores.
 *
 * Read from an untrusted route body and from a hand-edited document, so the
 * check lives here: a body that names an answer no build knows is refused
 * instead of stored.
 *
 * @param value - parsed request or document value.
 * @returns `true` when the value is a {@link ConflictChoice}.
 */
export function isConflictChoice(value: unknown): value is ConflictChoice {
  return value === 'profile' || value === 'local' || value === 'native'
}

/**
 * What the user chose for one contested `serverName`.
 *
 * Pure: the absence of a choice is the shipped answer — the profile's instance
 * keeps the name — so a project that never saw the toggle behaves exactly like
 * the plugin before the choice existed.
 *
 * @param state - policies before the read.
 * @param projectRoot - project root the name belongs to.
 * @param server - contested `serverName` as declared.
 * @returns the stored answer, or `'profile'` when there is none.
 */
export function choiceFor(state: PolicyState, projectRoot: string, server: string): ConflictChoice {
  return aliasesOf(state[projectRoot])[server] ?? 'profile'
}

/** The choices of one policy, treating an absent map and an empty one alike. */
export function aliasesOf(policy: ToolPolicy | undefined): Readonly<Record<string, ConflictChoice>> {
  return policy?.aliases ?? {}
}

/**
 * Store one contested name's answer, keeping the mode, the pins and the other
 * names.
 *
 * Pure and idempotent. Choosing the profile again *removes* the entry rather
 * than storing `'profile'`, because the absence already says exactly that: a
 * document that kept both spellings of one answer would grow with every click
 * and hand-edit its way into disagreeing with itself.
 *
 * @param state - policies before the change.
 * @param projectRoot - project root the name belongs to.
 * @param server - contested `serverName` as declared.
 * @param choice - the answer to store.
 * @returns a new state, or the input when the answer did not change.
 */
export function withConflictChoice(
  state: PolicyState,
  projectRoot: string,
  server: string,
  choice: ConflictChoice,
): PolicyState {
  const current = policyFor(state, projectRoot)
  if (choiceFor(state, projectRoot, server) === choice) return state
  const aliases: Record<string, ConflictChoice> = { ...aliasesOf(current) }
  if (choice === 'profile') delete aliases[server]
  else aliases[server] = choice
  return { ...state, [projectRoot]: normalizePolicy(current.mode, current.pins, aliases) }
}

/**
 * Store one project's mode, keeping its pins.
 *
 * Pure and idempotent: storing the mode already in force returns the input state
 * unchanged, so a panel that resubmits a switch does not schedule a write.
 *
 * @param state - policies before the change.
 * @param projectRoot - project root the mode applies to.
 * @param mode - the mode to store.
 * @returns a new state, or the input when the mode did not change.
 */
export function withMode(state: PolicyState, projectRoot: string, mode: ToolMode): PolicyState {
  const current = policyFor(state, projectRoot)
  if (current.mode === mode) return state
  return { ...state, [projectRoot]: normalizePolicy(mode, current.pins, aliasesOf(current)) }
}

/**
 * Pin or unpin one name of one project.
 *
 * Pins keep the order the user pinned them in — a pin is appended, an unpin
 * removes exactly that name — because the panel lists them in that order and a
 * re-pin after an unpin must not silently jump to the front. A name is never
 * validated against the project's mounts here: a pin of a tool the project does
 * not mount yet is kept, so a declaration that comes back finds its pin again.
 *
 * @param state - policies before the change.
 * @param projectRoot - project root the pin belongs to.
 * @param tool - public registry name, eg `mcp__tglider__workspace`.
 * @param pinned - `true` pins it, `false` unpins it.
 * @returns a new state, or the input when the list did not change.
 */
export function withPin(
  state: PolicyState,
  projectRoot: string,
  tool: string,
  pinned: boolean,
): PolicyState {
  const current = policyFor(state, projectRoot)
  const has = current.pins.includes(tool)
  if (pinned === has) return state
  const pins = pinned ? [...current.pins, tool] : current.pins.filter((name) => name !== tool)
  return { ...state, [projectRoot]: normalizePolicy(current.mode, pins, aliasesOf(current)) }
}

/**
 * One policy entry as the store keeps it: the mode and the pins always, the
 * choices only when there are any.
 *
 * Written through here rather than assembled field by field at each call site,
 * so the state the panel changes and the document that is flushed have one
 * shape — an entry that carries an empty map in memory but not on disk would be
 * a difference nothing could explain from the file.
 *
 * @param mode - mode in force.
 * @param pins - pinned names, in order.
 * @param aliases - choices per contested name.
 * @returns the entry to store.
 */
function normalizePolicy(
  mode: ToolMode,
  pins: readonly string[],
  aliases: Readonly<Record<string, ConflictChoice>>,
): ToolPolicy {
  return Object.keys(aliases).length === 0 ? { mode, pins } : { mode, pins, aliases }
}

/**
 * Parse one durable policy document.
 *
 * Anything this version cannot trust — malformed JSON, a foreign shape, or
 * another version — yields `undefined` so the caller starts from the shipped
 * default instead of throwing. A project entry is sanitized field by field: an
 * unknown mode falls back to `disclosure` and a pin list keeps only non-empty
 * deduplicated strings, so a hand-edited document cannot poison a request.
 *
 * @param text - raw document contents.
 * @returns the policies, or `undefined` when the document is not usable.
 */
export function parsePolicyDocument(text: string): PolicyState | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  if (value.version !== POLICY_VERSION) return undefined
  if (!isRecord(value.projects)) return undefined
  const projects: PolicyState = {}
  for (const [root, raw] of Object.entries(value.projects)) {
    const policy = sanitizePolicy(raw)
    if (policy === undefined) continue
    // An entry that carries no mode, no pin and no choice says nothing the
    // default would not say, so it is dropped rather than written back.
    if (
      policy.mode === DEFAULT_TOOL_POLICY.mode &&
      policy.pins.length === 0 &&
      Object.keys(aliasesOf(policy)).length === 0
    ) {
      continue
    }
    projects[root] = policy
  }
  return projects
}

/**
 * The durable policy: one versioned document under `$DSH_HOME`, loaded once when
 * the plugin applies and written atomically on a debounce.
 *
 * Every failure mode is non-fatal by design, exactly like the counters. A
 * missing, unreadable, foreign or older-version document starts from the shipped
 * default, and a write that fails is logged and forgotten, because a panel click
 * must never fail on a policy that could not be stored.
 */
export class PolicyStore {
  private state: PolicyState
  private timer: ReturnType<typeof setTimeout> | undefined
  private dirty = false
  private disposed = false
  private readonly file: string
  private readonly flushMs: number
  private readonly logger: PolicyLogger | undefined

  /** @param options - document path, debounce and log sink. */
  constructor(options: PolicyStoreOptions = {}) {
    this.file = options.file ?? join(dshHome(), POLICY_FILE_NAME)
    this.flushMs = options.flushMs ?? DEFAULT_FLUSH_MS
    this.logger = options.logger
    this.state = this.load()
  }

  /** Policy of one project root; the shipped default when it has none. */
  forProject(projectRoot: string): ToolPolicy {
    return policyFor(this.state, projectRoot)
  }

  /** Store one project's mode and schedule the debounced write. */
  setMode(projectRoot: string, mode: ToolMode): ToolPolicy {
    this.commit(withMode(this.state, projectRoot, mode))
    return policyFor(this.state, projectRoot)
  }

  /** Pin or unpin one name of one project and schedule the debounced write. */
  setPin(projectRoot: string, tool: string, pinned: boolean): ToolPolicy {
    this.commit(withPin(this.state, projectRoot, tool, pinned))
    return policyFor(this.state, projectRoot)
  }

  /**
   * Store which of two conflicting declarations one name shows and schedule the
   * debounced write.
   *
   * Durable on purpose: the answer is what the user decided about their project,
   * not what one session happened to mount, so it survives the restart that
   * would otherwise bring the profile's instance back unopposed.
   */
  setConflictChoice(
    projectRoot: string,
    server: string,
    choice: ConflictChoice,
  ): ToolPolicy {
    this.commit(withConflictChoice(this.state, projectRoot, server, choice))
    return policyFor(this.state, projectRoot)
  }

  /** Write the policy atomically now. Best effort: it never throws. */
  flush(): void {
    if (!this.dirty) return
    const document: PolicyDocument = { version: POLICY_VERSION, projects: this.state }
    const temporary = `${this.file}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(temporary, `${JSON.stringify(document, undefined, 2)}\n`, 'utf8')
      renameSync(temporary, this.file)
      this.dirty = false
    } catch (error) {
      this.logger?.warn(
        `project-mcp: writing the tool policy to ${this.file} failed: ${errorText(error)}`,
      )
    }
  }

  /**
   * Cancel the pending write, flush what is dirty, and stop storing. Safe to
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

  /** Adopt a state a pure change produced, and schedule the write when it moved. */
  private commit(next: PolicyState): void {
    if (this.disposed || next === this.state) return
    this.state = next
    this.dirty = true
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, this.flushMs)
    this.timer.unref?.()
  }

  private load(): PolicyState {
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return {}
    }
    const state = parsePolicyDocument(text)
    if (state === undefined) {
      this.logger?.warn(
        `project-mcp: ignoring the tool policy in ${this.file} (unreadable or unsupported version); starting from the default`,
      )
      return {}
    }
    return state
  }
}

/** Sanitize one project entry; `undefined` when it is not even a record. */
function sanitizePolicy(value: unknown): ToolPolicy | undefined {
  if (!isRecord(value)) return undefined
  const pins: string[] = []
  if (Array.isArray(value.pins)) {
    for (const pin of value.pins) {
      if (typeof pin !== 'string' || pin === '' || pins.includes(pin)) continue
      pins.push(pin)
    }
  }
  const aliases: Record<string, ConflictChoice> = {}
  if (isRecord(value.aliases)) {
    for (const [server, choice] of Object.entries(value.aliases)) {
      // The profile is what an absent entry means, so storing it would only
      // duplicate the default; an answer this build does not know is dropped.
      // A key that is no `serverName` at all — empty, or a bare index — is a
      // hand-edit or an array that JSON turned into an object, and is dropped
      // with the answer it carried.
      if (!SERVER_NAME_SHAPE.test(server) || !isConflictChoice(choice) || choice === 'profile') continue
      aliases[server] = choice
    }
  }
  return normalizePolicy(isToolMode(value.mode) ? value.mode : DEFAULT_TOOL_POLICY.mode, pins, aliases)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
