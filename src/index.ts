/**
 * `dsh-project-mcp` — per-project MCP servers for DeepSeek Harness.
 *
 * The host half reads a project's own MCP documents and mounts the declared
 * servers on the Cordis context of every session (`agent`) whose working
 * directory resolves to that project. Servers therefore exist exactly where
 * they are declared, and two projects may declare the same `serverName`
 * without colliding with each other or with profile-level entries.
 *
 * Sources, in increasing priority (later documents override by `serverName`):
 * 1. the global documents this deployment lists in `globalFiles` — none by default
 * 2. the project-relative documents it lists in `localFiles` —
 *    `<project>/.dsh/mcp.json` out of the box
 *
 * @module dsh-project-mcp
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_ACTIVATION_ENABLED,
  DEFAULT_ACTIVATION_MIN_CALLS,
  DEFAULT_ACTIVATION_SEEDED,
  DEFAULT_AUTO_ACTIVATION_LIMIT,
  DEFAULT_AUTO_ACTIVATION_STICKY_STEPS,
  DEFAULT_TOOL_BUDGET_CHARS,
  DEFAULT_TOOL_IDLE_MS,
} from './activation.ts'
import {
  DEFAULT_FILE_MARKERS,
  DEFAULT_GLOBAL_FILES,
  DEFAULT_LOCAL_FILES,
  DEFAULT_PROJECT_MARKERS,
  defaultCredentialsPath,
} from './discovery.ts'
import { DEFAULT_GUIDANCE_ENABLED } from './guidance.ts'
import { isValidLocalPrefix } from './naming.ts'
import { PolicyStore } from './policy.ts'
import { ProjectMcpRuntime } from './runtime.ts'
import type {
  AgentLike,
  AgentScopeLike,
  PolicyOutcome,
  RuntimeConfig,
  RuntimeOptions,
  SaveOutcome,
  ToolFactsOutcome,
} from './runtime.ts'
import type { ConflictRequest, PinRequest, PolicyRequest, SaveRequest } from './shared.ts'
import { UsageStore, observeToolResults } from './usage.ts'
import type { ToolResultEventLike, ToolResultLike } from './usage.ts'
import { disposeRegistration, registerRoutes } from './ui.ts'
import type { WebServerLike } from './ui.ts'
import type { McpSnapshot, SnapshotChange } from './types.ts'

export { ProjectMcpRuntime, mountTrigger } from './runtime.ts'
export type {
  AgentLike,
  AgentMounts,
  AgentScopeLike,
  MountDecision,
  MountTrigger,
  PolicyOutcome,
  PolicySource,
  RuntimeConfig,
  RuntimeOptions,
  SaveOutcome,
  ToolFactsOutcome,
  UsageSource,
} from './runtime.ts'
export {
  POLICY_FILE_NAME,
  POLICY_VERSION,
  PolicyStore,
  TOOL_MODES,
  isToolMode,
  parsePolicyDocument,
  policyFor,
  withMode,
  withPin,
} from './policy.ts'
export type {
  PolicyDocument,
  PolicyLogger,
  PolicyState,
  PolicyStoreOptions,
} from './policy.ts'
export { findProjectRoot, configDirectories, expandConfigPath, globalConfigPaths, localConfigPaths } from './discovery.ts'
export { parseDocument, mergeEntries, parseCredentials } from './parse.ts'
export {
  DEFAULT_ACTIVATION_ENABLED,
  DEFAULT_ACTIVATION_MIN_CALLS,
  DEFAULT_ACTIVATION_SEEDED,
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_TOOL_IDLE_MS,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_TOKENS,
  SEARCH_TOOL_NAME,
  activate,
  createActivationState,
  createSearchTool,
  installActivation,
  noteUse,
  onCompaction,
  presentedNames,
  pruneIdle,
  seedFromUsage,
  withActiveTools,
} from './activation.ts'
export type {
  ActivationContextLike,
  ActivationState,
  ActivationWiringOptions,
  AssembleListener,
  AssemblyLike,
  ListenerLike,
  SearchToolOptions,
  SeedOptions,
  SessionEventLike,
  TextBlockLike,
  ToolDefinitionLike,
  ToolSchemaLike,
} from './activation.ts'
export {
  DEFAULT_GUIDANCE_ENABLED,
  GUIDANCE_SECTION_NAME,
  MAX_GUIDANCE_CHARS,
  MAX_GUIDANCE_PURPOSE,
  MAX_GUIDANCE_SERVERS,
  MAX_GUIDANCE_HIDDEN_NAMES,
  buildGuidance,
  installGuidance,
  projectLabel,
} from './guidance.ts'
export type {
  GuidanceContextLike,
  GuidanceInput,
  GuidancePromptLike,
  GuidancePromptScopeLike,
  GuidanceSectionLike,
  GuidanceServer,
  GuidanceWiringOptions,
} from './guidance.ts'
export {
  USAGE_FILE_NAME,
  USAGE_VERSION,
  UsageStore,
  matchServer,
  observeToolResults,
  parseUsageDocument,
  recordUsage,
  usageEventFor,
} from './usage.ts'
export { createRouteHandler, disposeRegistration, registerRoutes } from './ui.ts'
export { ROUTE_PREFIX, TAB_ID } from './shared.ts'
export type { RouteHandler, WebServerLike } from './ui.ts'
export type {
  McpSnapshot,
  ProjectSnapshot,
  ServerRow,
  ServerStatus,
  ServerUsage,
  SessionSnapshot,
  SnapshotChange,
  SnapshotIssue,
} from './types.ts'
export type {
  ToolResultEventLike,
  ToolResultLike,
  ToolResultObserverOptions,
  UsageCall,
  UsageDocument,
  UsageEvent,
  UsageLogger,
  UsageState,
  UsageStoreOptions,
} from './usage.ts'

/**
 * Plugin config: everything two deployments may want to set differently.
 *
 * Live editing: on DSH ≥ 0.1.7 the keys of {@link VOLATILE_CONFIG_KEYS} arrive
 * not as plain values but as volatile refs (`{ get(): T }`, see
 * {@link VolatileLike}) that the host re-points on every profile edit and
 * re-reads on `loader/volatile-update`. Every read of those keys goes through
 * {@link liveValue}, which accepts both shapes, so a plain object — yaml
 * config on an older host, and every test fixture — keeps working unchanged.
 */
export interface Config {
  /** Master switch; `false` mounts nothing and reads nothing. */
  enabled?: boolean
  /**
   * Project-relative MCP documents to read, lowest priority first — a later
   * document overrides an earlier entry of the same `serverName`. A spec is
   * relative to the project root, or absolute, or `~/…` / `$DSH_HOME/…`.
   * Default: `['.dsh/mcp.json']`.
   */
  localFiles?: string[]
  /**
   * Global MCP documents read before a project's own, lowest priority first.
   * A relative spec resolves against `$HOME`; `~`, `$DSH_HOME` and absolute
   * paths work as in {@link localFiles}. Empty — the default — reads none, so
   * a project never inherits a server it did not declare.
   *
   * A boolean is accepted as a **migration guard only**, for a config written
   * when this key was the switch "also read `~/.dsh/mcp.json` and
   * `~/.kimi-code/mcp.json`": `true` reads `~/.dsh/mcp.json`, `false` reads
   * nothing. Set a list instead.
   */
  globalFiles?: string[] | boolean
  /** Read `<project>/.env` and `<project>/.dsh/.env` for `${...}` values. */
  envFiles?: boolean
  /** Values for `${input:NAME}` references, consulted before env and credentials. */
  inputs?: Record<string, string>
  /** Directory names that terminate the upward project-root walk. */
  projectMarkers?: string[]
  /** File suffixes that also terminate the upward project-root walk. */
  fileMarkers?: string[]
  /** Timeout for every generated mcp-client config. */
  toolCallTimeoutMs?: number
  /** Whether a failed initial MCP connection should fail the mount. */
  failOnStartupError?: boolean
  /** Report a mount that produced no tool within this window as an error row; `0` disables. */
  connectTimeoutMs?: number
  /** Mount a session's project on its first turn instead of at session creation. */
  lazy?: boolean
  /** Release a session's mounts after this much inactivity; `0` disables. */
  idleTimeoutMs?: number
  /** How long the first step of a turn may wait for a pending mount; `0` never waits. */
  activationWaitMs?: number
  /** Profile-level `serverName` reservations win; the project row becomes `conflict`. */
  profileWins?: boolean
  /**
   * Local namespace a project entry mounts under when the profile already owns
   * its `serverName` and the user chose to see this project's copy as well,
   * at most five characters (`[A-Za-z0-9_-]`, {@link isValidLocalPrefix}).
   * Empty — the default — derives one from the project's own folder, so a
   * conflict has an answer without a setting. Only the local answer reads it:
   * the choice that mounts the entry under its declared name needs no prefix.
   */
  localPrefix?: string
  /** Watch project config documents for edits and re-sync. */
  watch?: boolean
  /** Debounce applied to watcher and lifecycle events (ms). */
  debounceMs?: number
  /** Safety-net rescan interval (ms). */
  rescanIntervalMs?: number
  /** Credentials document consulted for `${input:NAME}` values. */
  credentialsFile?: string
  /**
   * Offer the session's MCP tools through `mcp_search_tools` + activation, and
   * put the active ones back into each assembled request. `false` restores the
   * plain registry presentation: every mounted tool is always listed.
   */
  activationEnabled?: boolean
  /** Tools the durable counters may seed into the always-offered baseline; `0` seeds none. */
  activationSeeded?: number
  /** Calls one tool needs in the counters before it is seeded into the baseline. */
  activationMinCalls?: number
  /** Drop a session-activated tool after this long without a call; `0` disables. */
  toolIdleMs?: number
  /**
   * Publish one short project-MCP guidance section in the session's system
   * prompt, ahead of the per-server `mcp:<server>` instruction blocks, so the
   * model knows the rest of the project's tools can be requested. `false`
   * registers no section at all.
   */
  guidanceEnabled?: boolean
  /**
   * Cap on the names the context-driven tier offers at once; `0` disables the
   * tier. Optional so a config object that predates this feature keeps the
   * shipped default.
   */
  activationAutoLimit?: number
  /** Extra advances one context-driven offer survives after leaving the ranking. */
  activationAutoStickySteps?: number
  /**
   * Serialized size of a session's MCP surface, in characters, above which its
   * tools are offered on demand instead of being listed; `0` defers every
   * surface, however small.
   */
  activationToolBudgetChars?: number
  /**
   * Permit the panel to write the documents of the `globalFiles` list. `false`
   * keeps them read-only; a write also needs an explicit per-write consent, so
   * both gates must be open. Default `false`.
   */
  allowGlobalWrite?: boolean
}

const DEFAULTS = {
  enabled: true,
  localFiles: [...DEFAULT_LOCAL_FILES],
  globalFiles: [...DEFAULT_GLOBAL_FILES],
  envFiles: true,
  toolCallTimeoutMs: 60_000,
  failOnStartupError: false,
  connectTimeoutMs: 60_000,
  lazy: true,
  idleTimeoutMs: 300_000,
  activationWaitMs: 2_000,
  profileWins: true,
  localPrefix: '',
  watch: true,
  debounceMs: 300,
  rescanIntervalMs: 10_000,
  activationEnabled: DEFAULT_ACTIVATION_ENABLED,
  activationSeeded: DEFAULT_ACTIVATION_SEEDED,
  activationMinCalls: DEFAULT_ACTIVATION_MIN_CALLS,
  toolIdleMs: DEFAULT_TOOL_IDLE_MS,
  guidanceEnabled: DEFAULT_GUIDANCE_ENABLED,
  activationAutoLimit: DEFAULT_AUTO_ACTIVATION_LIMIT,
  activationAutoStickySteps: DEFAULT_AUTO_ACTIVATION_STICKY_STEPS,
  activationToolBudgetChars: DEFAULT_TOOL_BUDGET_CHARS,
  allowGlobalWrite: false,
} as const

const nonEmptyString = z.string().min(1)

/**
 * The volatile-ref shape a DSH ≥ 0.1.7 host hands a volatile config field: a
 * stable reference whose `get()` reads the current, live-edited value.
 * Declared locally so no cordis version is needed to name it; an older host
 * passes the plain value instead, which {@link liveValue} also accepts.
 */
interface VolatileLike<T> {
  get(): T
}

// The loader's event typing ships with `@deepseek-ai/cordis-plugin-loader`,
// which this plugin does not depend on; declaring the one event it listens to
// keeps the dependency surface unchanged. The signature matches the loader's
// own augmentation, so both merge cleanly where the loader's types are loaded.
declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Volatile config values were committed into the running fiber without a
     * remount; dispatched to the owning fiber only.
     * @param paths - changed config paths as key arrays.
     */
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

/**
 * Mark a config field volatile — live-editable from Plugins → dsh-project-mcp
 * on DSH ≥ 0.1.7 — when the installed schemastery knows the flag. An older
 * schemastery at runtime gets the schema back unchanged, and the field stays
 * yaml-only there.
 */
function volatileField<S>(schema: S): S {
  const mark = (schema as unknown as { volatile?: unknown }).volatile
  if (typeof mark !== 'function') return schema
  return (mark as (this: unknown) => S).call(schema)
}

/**
 * Read one config field that may be a live-edited volatile ref.
 * @param field - plain value, or a {@link VolatileLike} ref wrapping it.
 * @returns the current value, whichever shape arrived.
 */
export function liveValue<T>(field: T | VolatileLike<T> | undefined): T | undefined {
  if (
    typeof field === 'object' &&
    field !== null &&
    typeof (field as VolatileLike<T>).get === 'function'
  ) {
    return (field as VolatileLike<T>).get()
  }
  return field as T | undefined
}

/**
 * The {@link Config} keys a DSH ≥ 0.1.7 host may live-edit without restarting
 * the entry: all of them are read at use time, so merging them into the
 * running config is safe. Every other key is structural or boot-time
 * (documents, markers, credentials, the watch switch) and stays yaml-only.
 */
export const VOLATILE_CONFIG_KEYS: readonly (keyof RuntimeConfig)[] = [
  'activationEnabled',
  'activationSeeded',
  'activationMinCalls',
  'toolIdleMs',
  'guidanceEnabled',
  'activationAutoLimit',
  'activationAutoStickySteps',
  'activationToolBudgetChars',
  'allowGlobalWrite',
  'envFiles',
  'lazy',
  'localPrefix',
  'profileWins',
  'connectTimeoutMs',
  'toolCallTimeoutMs',
  'idleTimeoutMs',
  'debounceMs',
  'activationWaitMs',
]

/** Validated Loader schema for {@link Config}. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled),
  localFiles: z.array(nonEmptyString).default([...DEFAULT_LOCAL_FILES]),
  // The union is a migration guard, not a second setting: a document still
  // carrying the boolean this key used to be validates instead of failing the
  // entry, and `configuredFiles` reads its intent.
  globalFiles: z.union([z.array(nonEmptyString), z.boolean()]).default([...DEFAULT_GLOBAL_FILES]),
  envFiles: volatileField(z.boolean().default(DEFAULTS.envFiles)),
  inputs: z.dict(String).default({}),
  projectMarkers: z.array(nonEmptyString).default([...DEFAULT_PROJECT_MARKERS]),
  fileMarkers: z.array(nonEmptyString).default([...DEFAULT_FILE_MARKERS]),
  toolCallTimeoutMs: volatileField(z.number().step(1).min(1).default(DEFAULTS.toolCallTimeoutMs)),
  failOnStartupError: z.boolean().default(DEFAULTS.failOnStartupError),
  connectTimeoutMs: volatileField(z.number().step(1).min(0).default(DEFAULTS.connectTimeoutMs)),
  lazy: volatileField(z.boolean().default(DEFAULTS.lazy)),
  idleTimeoutMs: volatileField(z.number().step(1).min(0).default(DEFAULTS.idleTimeoutMs)),
  activationWaitMs: volatileField(
    z.number().step(1).min(0).max(30_000).default(DEFAULTS.activationWaitMs),
  ),
  profileWins: volatileField(z.boolean().default(DEFAULTS.profileWins)),
  localPrefix: volatileField(z.string().default(DEFAULTS.localPrefix)),
  watch: z.boolean().default(DEFAULTS.watch),
  debounceMs: volatileField(z.number().step(1).min(0).max(60_000).default(DEFAULTS.debounceMs)),
  rescanIntervalMs: z.number().step(1).min(1_000).default(DEFAULTS.rescanIntervalMs),
  credentialsFile: z.string().default(''),
  activationEnabled: volatileField(z.boolean().default(DEFAULTS.activationEnabled)),
  activationSeeded: volatileField(z.number().step(1).min(0).default(DEFAULTS.activationSeeded)),
  activationMinCalls: volatileField(
    z.number().step(1).min(0).default(DEFAULTS.activationMinCalls),
  ),
  toolIdleMs: volatileField(z.number().step(1).min(0).default(DEFAULTS.toolIdleMs)),
  guidanceEnabled: volatileField(z.boolean().default(DEFAULTS.guidanceEnabled)),
  activationAutoLimit: volatileField(
    z.number().step(1).min(0).default(DEFAULTS.activationAutoLimit),
  ),
  activationAutoStickySteps: volatileField(
    z.number().step(1).min(0).default(DEFAULTS.activationAutoStickySteps),
  ),
  activationToolBudgetChars: volatileField(
    z.number().step(1).min(0).default(DEFAULTS.activationToolBudgetChars),
  ),
  allowGlobalWrite: volatileField(z.boolean().default(DEFAULTS.allowGlobalWrite)),
})

/** Cordis plugin name used by loader diagnostics. */
export const name = 'project-mcp'

/** Services required before project MCP servers can be mounted. */
export const inject = ['tools']

/** Service name under which the runtime publishes its snapshot. */
export const SERVICE_NAME = 'projectMcp'

/** Read-only handle published as the `projectMcp` service. */
export interface ProjectMcpService {
  /** Current rows per project with live sessions, merged and split per session. */
  snapshot(): McpSnapshot
  /**
   * Run one reconciliation pass immediately and await it, as the operator call:
   * it may start a session's declared servers without that session having
   * started a turn. Every other pass — a turn, an event, the rescan tick —
   * mounts only the sessions whose own working directory asked for their
   * project.
   * @param projectRoot - restricts the pass to one project's sessions.
   */
  syncNow(projectRoot?: string): Promise<void>
  /**
   * Ask for the same pass and answer at once, without waiting for it: the
   * panel's `Sync`. Scripted reconciliation awaits {@link ProjectMcpService.syncNow}.
   * @param projectRoot - restricts the pass to one project's sessions.
   */
  syncSoon(projectRoot?: string): void
  /**
   * Drop the failed mounts and re-mount them (after fixing their cause). Answers
   * as soon as they are dropped; the pass that mounts them again runs in the
   * background, because waiting for it is what made the panel's `Retry` look
   * hung while a server was still connecting.
   * @param projectRoot - restricts the drop and the pass to one project.
   */
  retry(projectRoot?: string): Promise<void>
  /**
   * Watch the picture instead of asking for it: the listener is told the current
   * state at once, then once per change that changes something. Backs the
   * panel's status channel, so an open panel polls nothing.
   * @param listener - told the revision and the whole snapshot it belongs to.
   * @returns a disposer that stops watching.
   */
  subscribe(listener: (change: SnapshotChange) => void): () => void
  /** Give one session's servers back now, or every mounted session's when no id is given. */
  release(agentId?: string): Promise<void>
  /**
   * Read one tool's detail for a row a panel opened: its model-facing
   * description, the fields its schema accepts, and the reason this session's
   * request does not carry it. Answered on demand instead of riding the
   * snapshot, because descriptions and schemas are the expensive part and this
   * is read once per opened row.
   * @param projectRoot - project root the panel read the row from.
   * @param sessionId - live agent id the row belongs to.
   * @param name - public registry name, as the panel drew it.
   * @returns the tool's facts, or the coded refusal the route maps to a status.
   */
  toolFacts(projectRoot: string, sessionId: string, name: string): ToolFactsOutcome
  /**
   * Write one edited entry back to the document that declares it.
   * @param request - entry body, declaring document and the revision it was read at.
   * @returns the fresh snapshot, or the coded refusal the route maps to a status.
   */
  save(request: SaveRequest): Promise<SaveOutcome>
  /**
   * Pin or unpin one tool of one project. Durable, and never a rescan: the policy
   * is not part of any declaring document.
   * @param request - project root, public tool name and the wanted pin state.
   * @returns the fresh snapshot, or the coded refusal the route maps to a status.
   */
  setPin(request: PinRequest): PolicyOutcome
  /**
   * Store one project's tool mode (`disclosure` | `direct` | `off`).
   * @param request - project root and the mode to store.
   * @returns the fresh snapshot, or the coded refusal the route maps to a status.
   */
  setPolicy(request: PolicyRequest): PolicyOutcome
  /**
   * Choose which declaration of one contested `serverName` this project shows.
   * Durable, and followed by a reconcile: the choice is what moves the entry
   * between a conflict report and a mount under its local name.
   * @param request - project root, contested name and the declaration to show.
   * @returns the fresh snapshot, or the coded refusal the route maps to a status.
   */
  setConflictChoice(request: ConflictRequest): PolicyOutcome
}

/**
 * Mount project-declared MCP servers per session scope.
 * @param ctx - host context of the plugin entry.
 * @param config - validated plugin configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.enabled === false) {
    ctx.logger.info('project-mcp: disabled by configuration')
    return
  }
  const usage = new UsageStore({ logger: ctx.logger })
  // The per-project tool policy is durable state of the same kind as the
  // counters, so it is loaded once here and published by the same runtime.
  const policy = new PolicyStore({ logger: ctx.logger })
  const runtime = new ProjectMcpRuntime(ctx, resolveConfig(config), { usage, policy })
  // A volatile-capable host (DSH ≥ 0.1.7) re-points the volatile refs inside
  // `config` on every profile edit and announces it here instead of restarting
  // the entry; an older host never emits the event, so this subscribes
  // unconditionally. `resolveConfig` re-reads the refs through `liveValue`,
  // and the runtime merges only the volatile keys.
  ctx.on('loader/volatile-update', () => {
    runtime.applyLiveConfig(resolveConfig(config))
  })
  const service: ProjectMcpService = {
    snapshot: () => runtime.snapshot(),
    syncNow: (projectRoot) => runtime.syncNow(projectRoot),
    syncSoon: (projectRoot) => runtime.syncSoon(projectRoot),
    retry: (projectRoot) => runtime.retry(projectRoot),
    release: (agentId) => runtime.release(agentId),
    toolFacts: (projectRoot, sessionId, name) => runtime.toolFactsOf(projectRoot, sessionId, name),
    save: (request) => runtime.saveEntry(request),
    setPin: (request) => runtime.setPin(request),
    setPolicy: (request) => runtime.setPolicy(request),
    setConflictChoice: (request) => runtime.setConflictChoice(request),
    subscribe: (listener) => runtime.subscribe(listener),
  }
  // `agents` exists in every interactive composition but is resolved lazily so
  // the plugin still loads when a deployment mounts it without the agent plane.
  ctx.inject(['agents'], (scope) => {
    runtime.attach(scope as unknown as AgentScopeLike)
    scope.provide(SERVICE_NAME, service)
  })
  // The sidebar panel runs in the browser half, which can reach neither this
  // service nor the host context that owns it: publish the same surface over HTTP
  // when the composition has a web server.
  ctx.inject(['webServer'], (scope) => {
    const webServer = (scope as unknown as { webServer?: WebServerLike }).webServer
    if (webServer === undefined) return
    scope.effect(() => {
      const registration = registerRoutes(webServer, service)
      return () => disposeRegistration(registration)
    }, 'project-mcp: panel routes')
  })
  ctx.effect(
    () => () => {
      void runtime.disposeAll()
    },
    'project-mcp: runtime',
  )
  // Counters ride the registry's own result event: one listener for every
  // agent, attributed through the runtime's agent -> project mapping, so only
  // servers this plugin mounted can be counted. Activation freshness rides the
  // same event — a real call is what keeps an activated tool offered — so no
  // second `tools/result` subscription exists.
  ctx.effect(() => {
    const dispose = observeToolResults({
      on: (event, handler) =>
        ctx.on(event, (exec: ToolResultEventLike, result: ToolResultLike) => {
          runtime.noteToolUse(exec.agent?.id, exec.name)
          return handler(exec, result)
        }),
      mountsFor: (agentId) => runtime.mountsFor(agentId),
      store: usage,
    })
    return () => {
      dispose()
      usage.dispose()
    }
  }, 'project-mcp: usage counters')
  // The policy store owns the same debounced write the counters do, so it is
  // flushed and stopped with the fiber that created it.
  ctx.effect(
    () => () => {
      policy.dispose()
    },
    'project-mcp: tool policy',
  )
}

/**
 * The local prefix one config asks for.
 *
 * A value the `serverName` alphabet cannot carry, or one longer than the five
 * characters the panel promises, is refused rather than trimmed: a silently
 * different namespace would rename a project's tools behind the user's back.
 * The empty string — the default and the answer to a refused value — asks for
 * the prefix derived from the project's own folder.
 *
 * @param value - raw `localPrefix` from the config.
 * @returns a valid prefix, or `''` for the derived one.
 */
function localPrefixOf(value: string | undefined): string {
  if (value === undefined || value === '') return ''
  if (value === value.trim() && isValidLocalPrefix(value)) return value
  return ''
}

/**
 * One configured document list, from either shape the config can carry.
 *
 * A list is used as written. A boolean is the migration guard of the key that
 * used to be the switch "also read the global documents": `true` meant the
 * documents in `legacyTrue` (what that switch turned on), `false` meant none.
 * An absent value falls back to the default list.
 *
 * @param value - raw `localFiles` or `globalFiles`.
 * @param fallback - list used when the config says nothing.
 * @param legacyTrue - documents a legacy `true` stands for.
 * @returns specs, lowest priority first, with blanks dropped.
 */
function configuredFiles(
  value: readonly string[] | boolean | undefined,
  fallback: readonly string[],
  legacyTrue: readonly string[],
): string[] {
  if (value === undefined) return [...fallback]
  if (Array.isArray(value)) return value.filter((spec) => spec !== '')
  return value ? [...legacyTrue] : []
}

/** Resolve the plugin config into the runtime's fully-defaulted shape. */
export function resolveConfig(config: Config): RuntimeConfig {
  return {
    localFiles: configuredFiles(config.localFiles, DEFAULTS.localFiles, DEFAULT_LOCAL_FILES),
    // The only key whose boolean is legacy: it used to switch the DSH home
    // document on, so that is what `true` keeps meaning here.
    globalFiles: configuredFiles(config.globalFiles, DEFAULTS.globalFiles, ['$DSH_HOME/mcp.json']),
    envFiles: liveValue(config.envFiles) ?? DEFAULTS.envFiles,
    inputs: config.inputs ?? {},
    projectMarkers: [...(config.projectMarkers ?? DEFAULT_PROJECT_MARKERS)],
    fileMarkers: [...(config.fileMarkers ?? DEFAULT_FILE_MARKERS)],
    toolCallTimeoutMs: liveValue(config.toolCallTimeoutMs) ?? DEFAULTS.toolCallTimeoutMs,
    failOnStartupError: config.failOnStartupError ?? DEFAULTS.failOnStartupError,
    connectTimeoutMs: liveValue(config.connectTimeoutMs) ?? DEFAULTS.connectTimeoutMs,
    lazy: liveValue(config.lazy) ?? DEFAULTS.lazy,
    idleTimeoutMs: liveValue(config.idleTimeoutMs) ?? DEFAULTS.idleTimeoutMs,
    activationWaitMs: liveValue(config.activationWaitMs) ?? DEFAULTS.activationWaitMs,
    profileWins: liveValue(config.profileWins) ?? DEFAULTS.profileWins,
    localPrefix: localPrefixOf(liveValue(config.localPrefix)),
    watch: config.watch ?? DEFAULTS.watch,
    debounceMs: liveValue(config.debounceMs) ?? DEFAULTS.debounceMs,
    rescanIntervalMs: config.rescanIntervalMs ?? DEFAULTS.rescanIntervalMs,
    credentialsFile:
      config.credentialsFile !== undefined && config.credentialsFile !== ''
        ? config.credentialsFile
        : defaultCredentialsPath(),
    activationEnabled: liveValue(config.activationEnabled) ?? DEFAULTS.activationEnabled,
    activationSeeded: liveValue(config.activationSeeded) ?? DEFAULTS.activationSeeded,
    activationMinCalls: liveValue(config.activationMinCalls) ?? DEFAULTS.activationMinCalls,
    toolIdleMs: liveValue(config.toolIdleMs) ?? DEFAULTS.toolIdleMs,
    guidanceEnabled: liveValue(config.guidanceEnabled) ?? DEFAULTS.guidanceEnabled,
    activationAutoLimit: liveValue(config.activationAutoLimit) ?? DEFAULTS.activationAutoLimit,
    activationAutoStickySteps:
      liveValue(config.activationAutoStickySteps) ?? DEFAULTS.activationAutoStickySteps,
    activationToolBudgetChars:
      liveValue(config.activationToolBudgetChars) ?? DEFAULTS.activationToolBudgetChars,
    allowGlobalWrite: liveValue(config.allowGlobalWrite) ?? DEFAULTS.allowGlobalWrite,
  }
}
