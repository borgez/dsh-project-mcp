/**
 * Project-scoped MCP mounting runtime.
 *
 * Isolation model: every live agent (session) resolves its own working
 * directory to a project root, and the servers declared by that project are
 * mounted **once for the project** inside a Cordis scope minted for it
 * (`createScope(hostCtx, projectKey)`), exactly the pattern the in-box
 * browser-use runtime uses for MCP servers. Each session additionally gets its
 * own scope, parented to its project's (`bindScopeParent(agent, projectKey)`):
 * a session sees its project's layer through the scope chain, which is how one
 * child process serves every session of that project — subagents included —
 * while a session of another project never resolves it. Because mcp-client
 * reserves a `serverName` per registration scope, two projects may declare the
 * same name without a conflict, and the plugin's own teardown disposes every
 * scope it minted: the project scope when its last holder releases it, so a
 * shared instance goes away on exactly the trigger a per-session one did.
 *
 * @module dsh-project-mcp/runtime
 */

import { readFileSync, statSync, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { Scope, ScopeParentBinding } from '@deepseek-ai/dsh-scope'
import type { Context } from '@deepseek-ai/cordis'
import { ForwardBatch, forwardProjectTools, projectToolNames } from './bridge.ts'
import type { BridgeContextLike, BridgeRegistryLike } from './bridge.ts'
import {
  DEFAULT_ACTIVATION_ENABLED,
  DEFAULT_ACTIVATION_MIN_CALLS,
  DEFAULT_ACTIVATION_SEEDED,
  DEFAULT_TOOL_IDLE_MS,
  SEARCH_TOOL_NAME,
  createActivationState,
  createAutoOfferState,
  installActivation,
  noteUse,
  presentedNames,
  pruneIdle,
  schemaChars,
  seedFromUsage,
  toolsFor,
} from './activation.ts'
import type {
  ActivationContextLike,
  ActivationState,
  AutoOfferState,
  ToolSchemaLike,
} from './activation.ts'
import {
  configDirectories,
  findProjectRoot,
  globalConfigPaths,
  localConfigPaths,
  projectEnvPaths,
  readEnvFile,
  readSecrets,
} from './discovery.ts'
import {
  DEFAULT_GUIDANCE_ENABLED,
  buildGuidance,
  installGuidance,
  projectLabel,
} from './guidance.ts'
import type { GuidanceContextLike, GuidanceServer } from './guidance.ts'
// The volatile key list lives at the entry (`src/index.ts`) because the schema
// declares it; the import cycles back here, but it is read only inside
// `applyLiveConfig`, long after both modules finished evaluating.
import { VOLATILE_CONFIG_KEYS } from './index.ts'
import { LOG_PAGE_SIZE, countForSession, countOf, latest } from './logs.ts'
import { emitEvent, logConsumer, subscribeEvent } from './notifications.ts'
import type { PluginEvent } from './notifications.ts'
import {
  SERVER_NAME_PATTERN,
  extractServerMap,
  mergeEntries,
  parseDocument,
  referencesCredentials,
  slugifyServerName,
} from './parse.ts'
import type { ParsedEntry, ParseIssue, ResolveContext } from './parse.ts'
import { isValidLocalPrefix, resolveConflictNames } from './naming.ts'
import { aliasesOf, isConflictChoice, isToolMode } from './policy.ts'
import type { ConflictRequest, PinRequest, PolicyRequest, SaveErrorCode, SaveRequest } from './shared.ts'
import { DEFAULT_TOOL_POLICY } from './types.ts'
import type {
  ConfiguredFile,
  ConflictChoice,
  EntrySnapshot,
  McpSnapshot,
  ProjectSnapshot,
  PresentationOwner,
  ServerConflict,
  ServerRow,
  ServerStatus,
  ServerUsage,
  SessionSnapshot,
  SessionTools,
  SnapshotChange,
  SnapshotIssue,
  ToolFacts,
  ToolField,
  ToolMode,
  ToolPolicy,
  ToolReason,
  WriteScope,
} from './types.ts'
import { matchServer } from './usage.ts'
import {
  applyEntry,
  buildEntrySnapshot,
  documentRevision,
  entryToDeclaration,
  visibleUrl,
  WriteDocError,
  writeDocument,
  writeScopeFor,
} from './write.ts'
import type { CredentialKeys, WriteScopeInfo } from './write.ts'

/** Live agent handle: only the fields this plugin consumes. */
export interface AgentLike {
  /** Session id, unique per agent. */
  readonly id: string
  /** Session header carrying the working directory. */
  readonly session: { readonly header?: { readonly cwd?: string } }
  /**
   * Host-reported lifecycle status, when the composition publishes one. Read
   * live where a release decision needs the truth rather than the last event
   * this plugin happened to see.
   */
  readonly status?: 'idle' | 'running'
  /** The agent's own Cordis context. */
  readonly ctx: Context
}

/** The subset of `ctx.agents` used here. */
export interface AgentsLike {
  /** All live agents. */
  list(): AgentLike[]
}

/** One agent-plane event, as far as this plugin consumes it. */
export interface AgentEventLike {
  /** The subject agent. */
  agent: AgentLike
  /** `agent/status` only: whether a turn is currently running. */
  status?: 'idle' | 'running'
}

/** The subset of the hosting scope used here. */
export interface AgentScopeLike {
  /** Agent registry (injected). */
  readonly agents: AgentsLike
  /**
   * Subscribe to an agent lifecycle or turn event. `agent/pre-step` is a
   * waterfall hook, so its handler receives a continuation and must return it.
   */
  on(name: string, handler: (event: AgentEventLike, next: () => Promise<unknown>) => unknown): unknown
  /** Register a fiber-scoped cleanup. */
  effect(fn: () => unknown, label?: string): unknown
}

/** Resolved plugin configuration. */
export interface RuntimeConfig {
  /**
   * Project-relative MCP documents to read, lowest priority first. A spec is
   * relative to the project root, or absolute / `~/…` / `$DSH_HOME/…`.
   */
  localFiles: string[]
  /**
   * Global MCP documents read before a project's own, lowest priority first;
   * `[]` reads none.
   */
  globalFiles: string[]
  /**
   * Read the project's own dotenv documents (`<project>/.env` and
   * `<project>/.dsh/.env`) for `${...}` values.
   */
  envFiles?: boolean
  inputs: Record<string, string>
  projectMarkers: string[]
  fileMarkers: string[]
  toolCallTimeoutMs: number
  failOnStartupError: boolean
  /** Window after which a mount that produced no tool is reported as an error; `0` disables. */
  connectTimeoutMs: number
  /** Mount a session's project on its first turn instead of at session creation. */
  lazy: boolean
  /** Release a session's mounts after this much inactivity; `0` disables. */
  idleTimeoutMs: number
  /** How long the first step of a turn may wait for a pending mount; `0` never waits. */
  activationWaitMs: number
  profileWins: boolean
  /**
   * Local namespace a project entry takes when a profile-level instance already
   * owns its `serverName` and the user chose to see the project's copy too.
   * Empty asks for one derived from the project's own folder
   * (`src/naming.ts`, {@link isValidLocalPrefix}); never longer than five
   * characters, because it is a name a person has to read in front of every
   * tool of that server.
   */
  localPrefix: string
  watch: boolean
  debounceMs: number
  rescanIntervalMs: number
  credentialsFile: string
  /**
   * Offer the session's MCP tools through `mcp_search_tools` + activation, and
   * put the active ones back into each assembled request. Optional so a config
   * object that predates this feature keeps the shipped default.
   */
  activationEnabled?: boolean
  /** Total tools the durable counters may seed into the baseline; `0` seeds none. */
  activationSeeded?: number
  /** Calls one tool needs in the counters before it is seeded into the baseline. */
  activationMinCalls?: number
  /** Drop a session-activated tool after this long without a call; `0` disables. */
  toolIdleMs?: number
  /**
   * Publish one short project-MCP guidance section in the session's system
   * prompt, just ahead of the per-server `mcp:<server>` instruction blocks.
   * `false` registers no section at all. Optional so a config object that
   * predates this feature keeps the shipped default.
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
   * Permit writes to the documents of the `globalFiles` list. Off by default:
   * a global write needs both this switch and an explicit per-write `consent`,
   * so a panel mistake cannot rewrite every project's servers. Optional so a
   * config object that predates this feature keeps it disabled.
   */
  allowGlobalWrite?: boolean
}

/**
 * Outcome of {@link ProjectMcpRuntime.saveEntry}: the fresh snapshot after a
 * write, or the code the route maps to a status.
 */
export type SaveOutcome =
  | { readonly ok: true; readonly snapshot: McpSnapshot }
  | {
      readonly ok: false
      readonly code: SaveErrorCode
      readonly message: string
      /**
       * Stable wire code of `message` (`projectMcp.host` namespace), for
       * client-side translation (F-48); the prose `message` keeps its
       * byte-identical English and stays the fallback.
       */
      readonly messageCode?: string
      /** Flat params of {@link messageCode}, stringified at emission. */
      readonly messageParams?: Record<string, string>
    }

/**
 * Outcome of {@link ProjectMcpRuntime.setPin} and
 * {@link ProjectMcpRuntime.setPolicy}: the fresh snapshot after the store was
 * changed, or the code the route maps to a status. Both refusals are `400`s:
 * `not-found` for a project this host has no live session in, `invalid` for a
 * mode no assembly knows, `failed` when the host was built without a policy
 * store.
 */
export type PolicyOutcome =
  | { readonly ok: true; readonly snapshot: McpSnapshot }
  | {
      readonly ok: false
      readonly code: SaveErrorCode
      readonly message: string
      /** Wire code of `message`, the same contract as {@link SaveOutcome}'s. */
      readonly messageCode?: string
      /** Flat params of {@link messageCode}, stringified at emission. */
      readonly messageParams?: Record<string, string>
    }

/**
 * Outcome of {@link ProjectMcpRuntime.toolFactsOf}: one tool's on-demand detail,
 * or the code the route maps to a status.
 *
 * A refusal is a `404`: the route only asks about a project root, a session id
 * and a name a panel read from a snapshot, so one this host does not know is a
 * stale read rather than a malformed request — the three parameters themselves
 * are checked by the route. The prose stays plain English and uncoded, the way
 * `GET logs` refuses.
 */
export type ToolFactsOutcome =
  | { readonly ok: true; readonly value: ToolFacts }
  | { readonly ok: false; readonly code: SaveErrorCode; readonly message: string }

/**
 * Identity of the Cordis scope one project's servers are mounted in. Every
 * session of that project is parented to it, so the registrations inside are
 * visible to those sessions and to nobody else.
 */
export interface ProjectScopeKey {
  /** Project root whose sessions share this scope. */
  readonly projectRoot: string
}

/**
 * Whether one scope key names a project's shared registrations rather than a
 * session. A host that models scopes (a test double, a diagnostic) can tell the
 * two apart without the object identity the runtime keeps to itself.
 * @param key - key handed to {@link RuntimeOptions.createScope}.
 * @returns `true` when the key is a {@link ProjectScopeKey}.
 */
export function isProjectScopeKey(key: unknown): key is ProjectScopeKey {
  return isRecord(key) && typeof (key as { projectRoot?: unknown }).projectRoot === 'string'
}

/** Injection points that tests override; production uses the real defaults. */
export interface RuntimeOptions {
  /** Plugin object mounted per server; defaults to `@deepseek-ai/dsh-mcp-client`. */
  plugin?: unknown
  /**
   * Scope factory; defaults to `createScope` from `@deepseek-ai/dsh-scope`.
   * Called once per session and once per project that mounts something. The
   * parent link of a session scope is established by the runtime itself, before
   * this is called — the factory only mints the scope. A session key is the
   * agent's own scope key; a project key is a {@link ProjectScopeKey}.
   */
  createScope?: (ctx: Context, key: AgentLike | ProjectScopeKey) => Pick<Scope, 'ctx' | 'dispose'>
  /**
   * Registry surface the forwarding bridge reads: one scoped lookup. It is read
   * off the plugin's own context by default, which is the same `ctx.tools` the
   * registration path uses; tests override it with their double's registry.
   */
  registry?: BridgeRegistryLike
  /**
   * Bridge context factory; defaults to reading the scope tag
   * ({@link scopeOf}) from the minted scope's context and wiring the registry
   * getter to it. A test whose scope double is a plain object overrides this,
   * because its contexts carry no `dsh-scope` tag to read.
   */
  bridgeContext?: (scope: Pick<Scope, 'ctx' | 'dispose'>) => BridgeContextLike
  /** Durable counters `snapshot()` publishes alongside the rows; absent means none. */
  usage?: UsageSource
  /**
   * Durable per-project policy the snapshot publishes and the assembly reads;
   * absent means every project keeps {@link DEFAULT_TOOL_POLICY}.
   */
  policy?: PolicySource
}

/** Read-only view of the durable counters, consulted by {@link ProjectMcpRuntime.snapshot}. */
export interface UsageSource {
  /** Counters recorded for one project root, or `undefined` when it has none. */
  forProject(projectRoot: string): Record<string, ServerUsage> | undefined
}

/**
 * The durable policy as the runtime consumes it: read on every snapshot and
 * every assembly, written by the two panel service methods. Structural on
 * purpose, so a test can pass a plain object and the plugin does not depend on
 * the store class.
 */
export interface PolicySource {
  /** Policy of one project root; the shipped default when none is stored. */
  forProject(projectRoot: string): ToolPolicy
  /** Store one project's mode and return the policy now in force. */
  setMode(projectRoot: string, mode: ToolMode): ToolPolicy
  /** Pin or unpin one tool of one project and return the policy now in force. */
  setPin(projectRoot: string, tool: string, pinned: boolean): ToolPolicy
  /**
   * Store which declaration of one contested `serverName` the project shows and
   * return the policy now in force.
   */
  setConflictChoice(
    projectRoot: string,
    server: string,
    choice: ConflictChoice,
  ): ToolPolicy
}

/**
 * What this plugin currently mounts for one live agent: the project root the
 * agent resolved to and the server names it mounted there.
 */
export interface AgentMounts {
  /** Project root the agent's working directory resolved to. */
  projectRoot: string
  /** Names of the servers this plugin mounted for that agent right now. */
  servers: ReadonlySet<string>
}

/** Minimal fiber surface used for mount bookkeeping. */
interface MountFiber {
  dispose(): unknown
  await?(): Promise<unknown>
}

/** Result of a bounded wait on a fiber operation. */
type WaitOutcome<T> =
  | { kind: 'settled'; value: T }
  | { kind: 'failed'; error: unknown }
  | { kind: 'timeout' }

/** Cordis fiber states (mirrors `@deepseek-ai/cordis`). */
const FIBER_ACTIVE = 2

/** Plugin names that identify a profile-level mcp-client registration. */
const MCP_CLIENT_ENTRY_NAMES = new Set(['@deepseek-ai/dsh-mcp-client', 'dsh-mcp-client'])

/**
 * Entry names that identify a second owner of the assembled tool list.
 *
 * Matched the way {@link MCP_CLIENT_ENTRY_NAMES} is: by the module specifier the
 * loader entry imports. A loader entry's `options.name` names a module, not a
 * capability, so a check that did not name the known owners could not tell a
 * presentation plugin from a logging one. The scoped spelling is included
 * because that is how a published plugin is mounted in a profile.
 */
const PRESENTATION_OWNER_ENTRY_NAMES = new Set([
  '@deepseek-ai/dsh-progressive-tools',
  'dsh-progressive-tools',
])

/**
 * Why this plugin and another presentation owner cannot shape one request.
 *
 * One explanation for every owner, not one per artifact: the reason is about
 * the plumbing (`assembly.tools` waterfall, outer listener wins) and not about
 * what the other plugin is called. Short because a panel prints it in a single
 * line under the tools list.
 */
const PRESENTATION_OWNER_NOTE =
  'a second presentation owner rewrites assembly.tools after this plugin does, so the two never combine in one request: either this plugin shapes only its own mcp__* entries, or the other owner is unmounted.'

/**
 * Host prose plus its wire code (F-48): the English sentence, byte-identical
 * to what the site emitted before codes existed, and the `projectMcp.host`
 * code the client translates by. The two travel as one value so a call site
 * cannot reword the prose without touching the code, and so a reason passed
 * down a call chain (`detach` → `releaseProject` → `unmount`) keeps its code.
 */
interface CodedText {
  /** The English sentence, as it always read. */
  readonly text: string
  /** The dotted wire code, into the client's `projectMcp.host` namespace. */
  readonly code: string
  /** Flat params of the code, when it has any; numbers stringify here. */
  readonly params?: Record<string, string>
}

/** `detail` of a declared server that `lazy` has not mounted yet. */
const LAZY_DETAIL: CodedText = {
  code: 'idle.lazy',
  text: 'not mounted yet — this session has not started a turn (lazy mounting is on)',
}

/** Why one pass may start a project's servers for one session. */
export type MountTrigger = 'turn' | 'mounted' | 'eager' | 'operator'

/** What one session contributes to the mount decision of one pass. */
export interface MountDecision {
  /** Whether `lazy` is on: without it a session mounts as soon as it exists. */
  lazy: boolean
  /** This session's own turn asked for its project (a pre-step or a `running` status). */
  activationPending: boolean
  /** This session already holds mounts, so a pass reconciles them live. */
  mounted: boolean
  /** An operator asked for exactly this session (`syncNow`, `retry`, an edit). */
  operatorRequested: boolean
}

/**
 * Sessions one pass may mount without their own turn asking: `'all'` for an
 * operator call that reconciles every session, a set of session ids for a pass
 * that belongs to one project, the project root itself for an operator call
 * scoped to a project — matched while the pass runs, so it also covers a session
 * whose working directory has not been read yet — and no requests at all for a
 * pass driven by a turn, an event or the rescan tick.
 */
export type PassRequests = 'all' | ReadonlySet<string> | { readonly projectRoot: string }

/** The pass a turn, an event or the rescan tick runs: every session must ask. */
const NO_REQUESTS: PassRequests = new Set()

/**
 * Decide whether one pass may start servers for one session, and why.
 *
 * The plugin's isolation rule lives here: a session starts the servers of the
 * project its working directory resolves to only when *that* session asks to
 * work there — its own turn, an operator request that names it, or a
 * deployment that turned `lazy` off. A session that is merely live (restored,
 * listed, idle, or another session's neighbour) never starts anything, and a
 * session that already holds mounts is reconciled so edits reach them.
 * @param decision - what one session contributes to one pass.
 * @returns the trigger, or `undefined` when the session must stay idle.
 */
export function mountTrigger(decision: MountDecision): MountTrigger | undefined {
  if (decision.operatorRequested) return 'operator'
  if (decision.activationPending) return 'turn'
  if (decision.mounted) return 'mounted'
  if (!decision.lazy) return 'eager'
  return undefined
}

/**
 * Run the parsed config through mcp-client's own Schemastery schema, exactly as
 * the in-box precedent does (`ctx.plugin(McpClient, McpClient.Config({...}))`):
 * this fills `maxInstructionBytes`/`reconnect` defaults and fails loudly on a
 * config the client would reject. A plugin without a callable `Config` keeps
 * the raw value.
 */
function clientConfig(value: unknown): unknown {
  const schema = (mcpClient as { Config?: (input: unknown) => unknown }).Config
  return typeof schema === 'function' ? schema(value) : value
}

interface LoaderEntryLike {
  options?: {
    id?: unknown
    name?: unknown
    config?: { serverName?: unknown }
    disabled?: unknown
  }
  fiber?: { state?: unknown }
}

interface LoaderLike {
  entries?(): LoaderEntryLike[]
}

interface MountedInstance {
  name: string
  /**
   * The `serverName` this mount actually registers under: the declared name, or
   * the local alias when a profile instance owns the declared one. It is what
   * the registry prefixes this server's tools with, so every lookup that goes by
   * tool prefix — status, guidance, the activation baseline — reads this and
   * never {@link name}.
   */
  runtimeName: string
  /** Project root whose declaration this instance was mounted from. */
  projectRoot: string
  fingerprint: string
  fiber: MountFiber | undefined
  status: ServerStatus
  detail: string | undefined
  /** Wire companions of {@link MountedInstance.detail} (F-48), set with it. */
  detailCode: string | undefined
  detailParams: Record<string, string> | undefined
  source: string | undefined
  transport: 'stdio' | 'streamable-http' | undefined
  /** Endpoint label already stripped of arguments and query strings. */
  endpoint: string
  /** When this mount started, for the connect watchdog. */
  startedAt: number
  /** `true` once the watchdog has reported the mount as never connected. */
  stalled: boolean
  /** `true` when activation itself failed, so no retry can revive this fiber. */
  failed: boolean
}

/**
 * The forwarding bridge one session holds when its key could not be joined to
 * its project's chain: the thin definitions registered in the session's own
 * layer, and the subscription that keeps them level with the project's live
 * tool set.
 */
interface BridgeForwarders {
  /**
   * The session's live registration batch. It owns the swap and the re-entrancy
   * every registration forces on it (`tools/change` is emitted from inside the
   * insertion, and the session is subscribed to it).
   */
  readonly batch: ForwardBatch
  /** Disposer of the project-scope `tools/change` subscription. */
  detach: () => void
}

/**
 * Where one session's MCP instances live — one home per project, forever.
 *
 * A session whose scope key could be parented to its project resolves the
 * project's shared home directly: one scope and one process per declared
 * server, shared by every session that works there. A session whose key the
 * harness already parented to something else cannot join that chain —
 * `dsh-scope` binds a key once, and the agent-preset roster binds every
 * composed agent before it is published — so it holds the SAME project home and
 * reads it through the forwarding bridge: a thin definition in its own layer
 * whose call runs the project's own. That is what makes "one process per
 * project" true in a preset composition too, instead of one instance per
 * session. See `docs/design/contracts/bridge.md`.
 */
interface MountHome {
  /** The project root whose declarations this home serves. */
  projectRoot: string
  /** Scope key the mcp-client instances are mounted under. */
  key: AgentLike | ProjectScopeKey
  /** The scope those instances live in; `undefined` before the first mount. */
  scope: Pick<Scope, 'ctx' | 'dispose'> | undefined
  /** One live instance per declared `serverName`. */
  mounts: Map<string, MountedInstance>
  /** `true` when every session of the project shares this home. */
  shared: boolean
}

/**
 * One project's shared mount state: the scope its sessions' servers are
 * registered in, and the live mounts those sessions share. The scope is minted
 * with the project's first mount and dropped with its last holder, so a project
 * costs one scope and one process per declared server however many sessions
 * work in it.
 */
interface ProjectState extends MountHome {
  projectRoot: string
  /** Scope key the project's registrations are tagged with. */
  key: ProjectScopeKey
  /** The project scope; `undefined` before the first mount and after teardown. */
  scope: Pick<Scope, 'ctx' | 'dispose'> | undefined
  /** One live instance per declared `serverName`, shared by every holder. */
  mounts: Map<string, MountedInstance>
  shared: true
}

/** No mounts: what a session that holds none sees. */
const NO_MOUNTS: ReadonlyMap<string, MountedInstance> = new Map()

/**
 * Parent links minted for session scope keys, kept process-wide because the
 * relation they feed (`bindScopeParent`) is process-wide too: a second runtime
 * in one process reuses the handle the first bound instead of failing on a key
 * that is already linked.
 */
const parentBindings = new WeakMap<object, ScopeParentBinding>()

/**
 * Point one scope key at the scope key it may resolve layers from, and keep the
 * binding that alone may re-link it later.
 *
 * This link is the mechanism that makes a project's shared servers visible to
 * exactly its sessions: the tools registry and the prompt assembly resolve a
 * session's catalog by walking `scopeChainOf(agentKey)`, so a project layer is
 * reachable only from a key parented to it. Re-linking is what a project change
 * and a release need, which is why the binding is retained rather than passed
 * to {@link createScope} and forgotten: the dsh-scope contract for a re-link
 * holds here — the runtime disposes the session scope and drops every
 * registration produced under the old parent before pointing the key
 * elsewhere.
 *
 * Reports who owns the resulting link: `true` when this runtime just created it
 * or already owns the key's binding, `false` when another composition parented
 * the key first — in which case the link is left untouched and the caller takes
 * the forwarding bridge instead of silently moving a binding it does not own.
 *
 * @param key - scope key to link.
 * @param parent - the key whose registrations the linked key may see.
 * @returns whether this runtime now owns the link.
 */
function linkScopeParent(key: object, parent: object): boolean {
  const bound = parentBindings.get(key)
  if (bound !== undefined) {
    bound.rebind(parent)
    return true
  }
  try {
    parentBindings.set(key, bindScopeParent(key, parent))
    return true
  } catch {
    return false
  }
}

interface AgentState {
  agent: AgentLike
  cwd: string | undefined
  projectRoot: string | undefined
  /**
   * Digest of the last reconciled pass: the document set, the profile
   * reservations, and the published state of the shared mounts. Identical means
   * "nothing to do" — including when another session of the same project
   * mounted, settled or dropped something this session would otherwise render
   * from a stale row.
   */
  digest: string | undefined
  scope: Pick<Scope, 'ctx' | 'dispose'> | undefined
  /**
   * The project whose shared mounts this session currently holds; `undefined`
   * while it holds none. Every holder resolves the one home, whether its own key
   * joined the project's chain or the bridge carries the tools to it.
   */
  project: ProjectState | undefined
  /**
   * The forwarding bridge this session holds when its key could not be parented
   * to its project (the harness bound that key first, and `dsh-scope` binds a
   * key once). `undefined` for a session whose own chain already resolves the
   * project's layer, which needs no bridge.
   */
  bridge: BridgeForwarders | undefined
  /**
   * Whether {@link linkScopeParent} linked this session's key, so a detach knows
   * it owns the re-link and not another plugin that parented the same key.
   */
  parentLinked: boolean
  /**
   * Layer-less scope key a released session is re-linked to. Without it a
   * session that let a project's servers go would keep resolving them from the
   * still-running shared layer — the one thing per-session mounting gave for
   * free, because disposing the session scope removed its whole chain.
   */
  detachedKey: object | undefined
  rows: ServerRow[]
  issues: SnapshotIssue[]
  /**
   * `serverName` conflicts of the last reconciled pass: a profile-level
   * instance that already owns a name, or one name two project documents
   * declare. Always the truth of that pass — an empty list is the answer "no
   * conflicts", not an absent one.
   */
  conflicts: ServerConflict[]
  /** Last observed activity (turn start, step, turn end); `undefined` until then. */
  lastActivityAt: number | undefined
  /** `true` while a turn runs, so idle release never fires in the middle of one. */
  busy: boolean
  /**
   * Set when a turn starts while nothing is mounted, so the next pass mounts
   * the project even in `lazy` mode. Cleared by the pass that mounts it.
   */
  activationPending: boolean
  /**
   * Session activation state (counter baseline + session-activated names).
   * `undefined` until the session's first scope is minted and seeds it; kept
   * across an idle release so the session keeps what it activated.
   */
  activation: ActivationState | undefined
  /**
   * Number of the agent step this session is on, counted from `agent/pre-step`
   * and starting at `1` for the first step the hook sees. `0` means no step has
   * started yet, and then no offer carries a number.
   */
  step: number
  /**
   * Step each session activation was recorded on, keyed by public name. Kept
   * next to {@link AgentState.activation} because the two outlive an idle
   * release together: the activation is what a row lists, and this is when it
   * was offered. Pruned with the activation it belongs to.
   */
  steps: Map<string, number>
  /**
   * Disposer of the activation wiring installed on the current scope. Kept so a
   * scope teardown unregisters `mcp_search_tools` explicitly: the scope fiber
   * owns that registration with the real registry, but a test host may publish a
   * plain `tools` stub, and the tool must disappear either way.
   */
  activationDispose: (() => void) | undefined
  /**
   * Disposer of the guidance-section wiring installed on the current scope. Kept
   * for the same reason as {@link AgentState.activationDispose}: the scope fiber
   * owns the registration with the real prompt registry, but a host that
   * publishes a plain `systemPrompt` stub has only this path.
   */
  guidanceDispose: (() => void) | undefined
  /**
   * Context-driven offer window (BM25 task ranking + sticky names). Kept next
   * to `activation` so a re-minted scope of the same session resumes the offers
   * it was showing instead of starting over — the same reason the activation
   * state outlives an idle release.
   */
  auto: AutoOfferState | undefined
}

interface CachedDocument {
  mtimeMs: number
  size: number
  /** Exact bytes the parse was made from; the write path revises them. */
  text: string
  /**
   * Identity of the value sources the parse expanded `${...}` against. A
   * document whose own bytes did not move is still re-parsed when its sources
   * did, so an edit to a project `.env` or to the credentials file reaches the
   * mounts without `mcp.json` being touched at all.
   */
  stamp: string
  /** Raw `name -> entry` map the document declared, when it held one. */
  raw: Record<string, unknown> | undefined
  entries: ParsedEntry[]
  issues: ParseIssue[]
}

/** Everything the editor needs from one declaring document, per server name. */
interface DocumentInfo extends WriteScopeInfo {
  /** Content revision of the document at snapshot time. */
  revision: string
  /** Entry body per sanitized `serverName`, for the entries that parsed. */
  entries: Map<string, EntrySnapshot>
}

/**
 * Owns every project-scoped mount, the config watchers, and the rescan timer.
 * One instance per plugin fiber; `attach()` binds it to the agent service.
 */
export class ProjectMcpRuntime {
  private readonly states = new Map<string, AgentState>()
  /** Projects with a live shared scope, keyed by project root. */
  private readonly projects = new Map<string, ProjectState>()
  private readonly documents = new Map<string, CachedDocument>()
  /** Cached credentials document, re-read only when mtime/size change. */
  private secrets: { mtimeMs: number; size: number; values: Record<string, string> } | undefined
  /**
   * Dotenv values per project document, re-read only when mtime/size change.
   * Every pass of every session resolves `${...}` references, so an uncached
   * read here would cost one stat plus parse per file per session per pass.
   */
  private readonly envFiles = new Map<
    string,
    { mtimeMs: number; size: number; values: Record<string, string> }
  >()
  private readonly watchers = new Map<string, FSWatcher[]>()
  /** Config directories currently watched per project root. */
  private readonly watchedDirs = new Map<string, WatchTarget[]>()
  private readonly watchedRoots = new Set<string>()
  private timer: ReturnType<typeof setInterval> | undefined
  private debounce: ReturnType<typeof setTimeout> | undefined
  private chain: Promise<void> = Promise.resolve()
  /** The host's live-session registry, once `attach()` has bound one. */
  private listAgents: (() => AgentLike[]) | undefined
  /** `undefined` until a recursive watch has been attempted. */
  private recursiveWatch: boolean | undefined = undefined
  private ready = false
  private disposed = false
  /** Panels watching the picture through the status channel. */
  private readonly listeners = new Set<(change: SnapshotChange) => void>()
  /** Changes announced so far; the picture a stream opens on is revision `0`. */
  private revision = 0
  /** JSON of the last announced picture, so an unchanged pass announces nothing. */
  private announced: string | undefined
  /**
   * Disposer of the DSH-log subscriber this runtime installs on the notification
   * service in {@link ProjectMcpRuntime.attach}. One subscription per live
   * runtime, dropped in {@link ProjectMcpRuntime.disposeAll}, so a re-mount
   * cannot leave a second logger reading the same events.
   */
  private detachLog: (() => void) | undefined

  /**
   * @param ctx - the plugin's own context (host/root scope).
   * @param config - resolved plugin configuration.
   * @param options - mount overrides (tests only).
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: RuntimeConfig,
    private readonly options: RuntimeOptions = {},
  ) {}

  /** Bind to the agent service: existing agents, lifecycle events, rescan timer. */
  attach(scope: AgentScopeLike): void {
    this.ready = true
    // The DSH log is a consumer of the notification service, not a second write
    // path: this runtime's own logger subscribes here, once, and is told every
    // event the runtime publishes.
    this.detachLog ??= subscribeEvent(logConsumer(this.ctx.logger))
    this.listAgents = () => scope.agents.list()
    scope.on('agent/created', ({ agent }) => {
      if (this.disposed) return
      this.states.set(agent.id, this.newState(agent))
      // The scope is owned by this plugin, but the agent may also be disposed
      // without a matching event reaching us first; this keeps teardown ordered.
      agent.ctx.effect(
        () => () => {
          this.dropAgent(agent.id)
        },
        'project-mcp: session',
      )
      this.schedule('agent/created')
    })
    scope.on('agent/disposed', ({ agent }) => {
      if (this.disposed) return
      this.dropAgent(agent.id)
    })
    scope.on('agent/status', (event) => {
      this.onStatus(event)
    })
    scope.on('agent/pre-step', (event, next) => this.onPreStep(event, next))
    for (const agent of scope.agents.list()) this.states.set(agent.id, this.newState(agent))
    scope.effect(
      () => () => {
        void this.disposeAll()
      },
      'project-mcp: lifecycle',
    )
    // The safety-net tick also drives idle release, so it runs whenever either
    // of the two needs it.
    if (this.config.watch || this.config.idleTimeoutMs > 0) {
      this.timer = setInterval(() => this.schedule('rescan'), this.config.rescanIntervalMs)
      // A rescan timer must not keep a headless DSH process alive on its own.
      this.timer.unref?.()
    }
    this.schedule('attach')
  }

  /**
   * Merge one live-edited config into the running one.
   *
   * A DSH ≥ 0.1.7 host serves the volatile config keys as a profile-backed
   * form and re-resolves them on `loader/volatile-update` instead of
   * restarting the entry. Only those keys are taken from `next` — every other
   * key (documents, markers, credentials, the watch switch) stays whatever the
   * entry booted with, because nothing here re-reads it safely at runtime.
   * All volatile keys are consumed at use time, so the merge alone moves the
   * behavior.
   *
   * The one exception is the safety-net tick: it is armed once in
   * {@link ProjectMcpRuntime.attach}, yet its need — `watch || idleTimeoutMs
   * > 0` — flips with a live edit of `idleTimeoutMs`, so it is re-armed or
   * cleared here. Arming is reserved to an attached runtime: before
   * `attach()` the merge alone is enough, because `attach()` arms from the
   * merged values; after disposal nothing may come back.
   *
   * @param next - the freshly resolved config; only the volatile keys are read.
   */
  applyLiveConfig(next: RuntimeConfig): void {
    const target = this.config as Record<keyof RuntimeConfig, unknown>
    for (const key of VOLATILE_CONFIG_KEYS) {
      const value = next[key]
      if (value !== undefined) target[key] = value
    }
    if (this.timer !== undefined && !this.config.watch && this.config.idleTimeoutMs === 0) {
      clearInterval(this.timer)
      this.timer = undefined
    } else if (
      this.timer === undefined &&
      this.ready &&
      !this.disposed &&
      (this.config.watch || this.config.idleTimeoutMs > 0)
    ) {
      this.timer = setInterval(() => this.schedule('rescan'), this.config.rescanIntervalMs)
      // A rescan timer must not keep a headless DSH process alive on its own.
      this.timer.unref?.()
    }
  }

  /**
   * Current snapshot: projects with live agents, their rows, and watched roots.
   *
   * Each project carries both a merge and the per-session split. The merge is
   * deliberately not "first session wins": sessions of one project mount
   * independently, so the same server can be mounted for one and idle for
   * another, and the panel must not report a running server as idle (or hide a
   * failing one) just because the idle session was registered first.
   *
   * A session that mounted tools also carries what it offers the model right
   * now (see {@link sessionTools}); the row is derived per call, never stored,
   * so a panel that polls after an activation sees it.
   */
  snapshot(): McpSnapshot {
    const byProject = new Map<string, ProjectSnapshot>()
    for (const state of this.states.values()) {
      if (state.projectRoot === undefined) continue
      let project = byProject.get(state.projectRoot)
      if (project === undefined) {
        project = { projectRoot: state.projectRoot, sessionIds: [], rows: [], issues: [], sessions: [], conflicts: [] }
        byProject.set(state.projectRoot, project)
      }
      project.sessionIds.push(state.agent.id)
      project.sessions.push(this.sessionSnapshot(state, state.projectRoot))
      mergeRows(project.rows, this.liveRows(state))
      for (const issue of state.issues) {
        if (!project.issues.some((existing) => existing.message === issue.message)) {
          project.issues.push(issue)
        }
      }
      // Conflicts merge exactly like issues do: every session of one root reads
      // the same documents and the same profile, so one name gets one report and
      // the first session to name it keeps it. The list is published even when
      // empty — that is the panel's "no conflicts", not a field it guesses about.
      if (state.conflicts.length > 0) {
        const merged: ServerConflict[] = [...(project.conflicts ?? [])]
        for (const conflict of state.conflicts) {
          if (!merged.some((existing) => existing.server === conflict.server)) merged.push(conflict)
        }
        // Code-unit order, the rule the rest of the plugin sorts names by, so a
        // project of two sessions reports one stable list.
        merged.sort((left, right) =>
          left.server < right.server ? -1 : left.server > right.server ? 1 : 0,
        )
        project.conflicts = merged
      }
    }
    // Counters outlive the sessions that produced them, so they are read from
    // the durable store instead of accumulated per session. The policy is
    // published for every project, stored or not: the panel reads a project's
    // mode and pins from here, and an absent field is meant for a host older
    // than the policy store rather than for a project that never changed one.
    for (const project of byProject.values()) {
      const usage = this.options.usage?.forProject(project.projectRoot)
      if (usage !== undefined) project.usage = usage
      project.policy = this.policyFor(project.projectRoot)
      // Which documents this project reads is a config fact, not a row fact, and
      // the panel needs it to number a row's priority: publish it per project so
      // the number matches the read order of this deployment.
      project.files = this.readFiles(project.projectRoot)
      // The tab is drawn from the snapshot, so the newest page rides here and the
      // ring's size says how much more the route can page. A project that never
      // recorded an event carries neither field — no empty array.
      const logs = latest(project.projectRoot, LOG_PAGE_SIZE)
      if (logs.length > 0) {
        project.logs = logs
        project.logCount = countOf(project.projectRoot)
      }
    }
    // A second presentation owner belongs to the loaded profile, not to one
    // project, so the scan runs once per snapshot and the record rides every
    // project. Absent means this plugin assembles alone, which is what keeps a
    // panel from drawing a coexistence notice that is not true.
    const presentation = this.presentationOwner()
    if (presentation !== undefined) {
      for (const project of byProject.values()) project.presentation = presentation
    }
    return {
      ready: this.ready,
      projects: [...byProject.values()],
      sources: { local: [...this.config.localFiles], global: [...this.config.globalFiles] },
      watchedFiles: [...this.watchedRoots],
    }
  }

  /**
   * Watch the picture instead of asking for it: the listener is told the current
   * state at once, then once per change that actually changes something — a pass
   * that committed, a mount that appeared or connected, a release, a save, a
   * policy write. A rescan that found the same servers announces nothing, so an
   * open panel receives no traffic for a project nothing is happening in.
   * @param listener - told the revision and the whole snapshot it belongs to.
   * @returns a disposer that stops watching.
   */
  subscribe(listener: (change: SnapshotChange) => void): () => void {
    this.listeners.add(listener)
    try {
      listener({ revision: this.revision, snapshot: this.snapshot() })
    } catch (error) {
      this.ctx.logger.warn(`project-mcp: announcing the first snapshot failed: ${errorText(error)}`)
    }
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Announce the picture if it differs from the last one announced.
   *
   * The comparison is what keeps the status channel quiet: a pass runs on every
   * watcher event and every rescan tick, and almost all of them re-derive the
   * same rows. With no listener attached nothing is built at all — a headless
   * host pays nothing for a channel nobody reads.
   */
  private notify(): void {
    if (this.listeners.size === 0 || this.disposed) return
    const snapshot = this.snapshot()
    const digest = JSON.stringify(snapshot)
    if (digest === this.announced) return
    this.announced = digest
    this.revision += 1
    const change: SnapshotChange = { revision: this.revision, snapshot }
    for (const listener of [...this.listeners]) {
      try {
        listener(change)
      } catch (error) {
        this.ctx.logger.warn(`project-mcp: announcing a change failed: ${errorText(error)}`)
      }
    }
  }

  /**
   * One session's snapshot row, carrying its live tool presentation only when
   * the host has mounted tools for it, and how much of the project's log history
   * belongs to it when there is any.
   * @param state - the session's own runtime state.
   * @param projectRoot - the project the session works in.
   * @returns the row; `tools` stays absent for an unmounted session, and
   * `logCount` for a session that recorded nothing.
   */
  private sessionSnapshot(state: AgentState, projectRoot: string): SessionSnapshot {
    const session: SessionSnapshot = {
      id: state.agent.id,
      rows: this.liveRows(state),
      issues: state.issues,
    }
    const tools = this.sessionTools(state)
    if (tools !== undefined) session.tools = tools
    const logCount = countForSession(projectRoot, state.agent.id)
    if (logCount > 0) session.logCount = logCount
    session.conflicts = state.conflicts
    return session
  }

  /**
   * What one session offers the model, measured from its live state at call
   * time.
   *
   * The mounted set is the whole visible MCP surface — this plugin's project
   * mounts plus the profile plane and any F-19 forwarders — the same surface
   * the activation wiring measures against the budget, so the counts cannot
   * describe a different catalog than the one the request is built from. Total
   * on purpose: a probe that fails leaves the row out and warns instead of
   * failing the snapshot.
   * @param state - the session's own runtime state.
   * @returns the presentation row, or `undefined` when nothing is mounted.
   */
  private sessionTools(state: AgentState): SessionTools | undefined {
    try {
      const mounted = this.visibleSchemas(state)
      if (mounted.length === 0) return undefined
      const activationEnabled = this.config.activationEnabled ?? DEFAULT_ACTIVATION_ENABLED
      return toolsFor({
        sessionId: state.agent.id,
        mounted,
        activation: activationEnabled ? this.seedActivation(state) : state.activation,
        auto: state.auto,
        activationEnabled,
        policy: this.policyFor(state.projectRoot),
        steps: state.steps,
        ...(state.step === 0 ? {} : { step: state.step }),
        ...(this.config.activationToolBudgetChars === undefined
          ? {}
          : { budgetChars: this.config.activationToolBudgetChars }),
      })
    } catch (error) {
      this.ctx.logger.warn(
        `project-mcp: reading the tool presentation of session ${state.agent.id} failed: ${errorText(error)}`,
      )
      return undefined
    }
  }

  /**
   * One tool's on-demand detail, answered for a row a panel opened.
   *
   * A read, never a rescan: the definition comes from the same mount home the
   * snapshot's session row was measured from, so a **deferred** name answers
   * exactly like an offered one — the home's catalog carries the whole mounted
   * surface, and only the request's own deferral decision leaves a name out of
   * it. That is also what makes the reason honest: `budget` is reported exactly
   * when the session's own row lists the name in `deferred`, and every figure on
   * it is a host measurement — {@link schemaChars} of this definition, the
   * session's `budgetChars` and its `visibleChars`. A number the host does not
   * have is omitted rather than guessed.
   *
   * The published fields are the schema's top-level `parameters.properties`
   * only: a nested object or array is drawn as its type and never expanded, and
   * a property's `default` is never published — the schema a model reads is the
   * definition's, and this record is a *view* of it, not a second copy with
   * defaults baked in.
   *
   * @param projectRoot - project root the panel read the row from.
   * @param sessionId - live agent id the row belongs to.
   * @param name - public registry name, as the panel drew it.
   * @returns the tool's facts, or the `not-found` refusal the route maps to 404.
   */
  toolFactsOf(projectRoot: string, sessionId: string, name: string): ToolFactsOutcome {
    const state = this.states.get(sessionId)
    if (state === undefined || state.projectRoot !== projectRoot) {
      return {
        ok: false,
        code: 'not-found',
        message: `no live session ${sessionId} in ${projectRoot}`,
      }
    }
    const home = this.homeOf(state)
    if (home === undefined) {
      return {
        ok: false,
        code: 'not-found',
        message: `no live session ${sessionId} in ${projectRoot}`,
      }
    }
    const schema = this.schemasOf(home, state.agent.id).find(
      (candidate) => candidate.name === name,
    )
    if (schema === undefined) {
      return {
        ok: false,
        code: 'not-found',
        message: `${name} is not mounted in ${projectRoot}`,
      }
    }
    const fields = toolFieldsOf(schema.parameters)
    const description = schema.description === '' ? undefined : schema.description
    // Only a name the session's own row hides is unexplained by the request, so
    // only such a name carries a reason; an offered one has nothing to explain.
    const deferred = this.sessionTools(state)?.deferred ?? []
    const reason = deferred.includes(name) ? this.budgetReason(state, schema) : undefined
    return {
      ok: true,
      value: {
        name: schema.name,
        ...(description === undefined ? {} : { description }),
        fields,
        ...(reason === undefined ? {} : { reason }),
      },
    }
  }

  /**
   * Why the budget left one definition out of this session's request: the host's
   * own numbers, each omitted when the row that carries it did not measure it.
   * @param state - the session whose row and budget are read.
   * @param schema - the definition the row does not offer.
   * @returns the `budget` reason, carrying only figures the host holds.
   */
  private budgetReason(state: AgentState, schema: ToolSchemaLike): ToolReason {
    const tools = this.sessionTools(state)
    return {
      kind: 'budget',
      chars: schemaChars(schema),
      ...(tools === undefined
        ? {}
        : {
            budget: tools.budgetChars,
            ...(tools.visibleChars === undefined ? {} : { used: tools.visibleChars }),
          }),
    }
  }

  /**
   * What this plugin currently mounts for one live agent: the project root the
   * agent resolved to and the server names it mounted there. `undefined` when
   * the agent is unknown or resolved to no project, so a tool call from it is
   * simply not counted.
   * @param agentId - agent (session) id a tool call ran for.
   */
  mountsFor(agentId: string): AgentMounts | undefined {
    const state = this.states.get(agentId)
    if (state === undefined || state.projectRoot === undefined) return undefined
    return { projectRoot: state.projectRoot, servers: this.runtimeNamesOf(state) }
  }

  /**
   * Pin or unpin one tool of one project.
   *
   * The project must be one this host currently has a live session in: the panel
   * only ever names a root it read from a snapshot, so anything else is a stale
   * click and is refused rather than stored for a project nothing would show. No
   * rescan follows — the policy is part of no declaring document — so the answer
   * carries the current snapshot with the fresh pin list.
   * @param request - project root, public tool name and the wanted pin state.
   * @returns the fresh snapshot, or the refusal code the route maps to a status.
   */
  setPin(request: PinRequest): PolicyOutcome {
    const policy = this.options.policy
    if (policy === undefined) {
      return {
        ok: false,
        code: 'failed',
        message: 'this host has no tool-policy store',
        messageCode: 'save.noPolicyStore',
      }
    }
    if (!this.projectKnown(request.projectRoot)) {
      return {
        ok: false,
        code: 'not-found',
        message: `no live session in ${request.projectRoot}`,
        messageCode: 'save.noLiveSession',
        messageParams: { projectRoot: request.projectRoot },
      }
    }
    policy.setPin(request.projectRoot, request.tool, request.pinned)
    this.notify()
    return { ok: true, snapshot: this.snapshot() }
  }

  /**
   * Store one project's tool mode.
   *
   * The same two refusals as {@link setPin}, plus a mode no assembly knows: the
   * mode is read on every assembly, so a stored change applies to the next model
   * step without re-minting the session scope.
   * @param request - project root and the mode to store.
   * @returns the fresh snapshot, or the refusal code the route maps to a status.
   */
  setPolicy(request: PolicyRequest): PolicyOutcome {
    if (!isToolMode(request.mode)) {
      return {
        ok: false,
        code: 'invalid',
        message: `unknown tool mode ${JSON.stringify(request.mode)}`,
        messageCode: 'save.unknownMode',
        messageParams: { mode: JSON.stringify(request.mode) },
      }
    }
    const policy = this.options.policy
    if (policy === undefined) {
      return {
        ok: false,
        code: 'failed',
        message: 'this host has no tool-policy store',
        messageCode: 'save.noPolicyStore',
      }
    }
    if (!this.projectKnown(request.projectRoot)) {
      return {
        ok: false,
        code: 'not-found',
        message: `no live session in ${request.projectRoot}`,
        messageCode: 'save.noLiveSession',
        messageParams: { projectRoot: request.projectRoot },
      }
    }
    policy.setMode(request.projectRoot, request.mode)
    this.notify()
    return { ok: true, snapshot: this.snapshot() }
  }

  /**
   * Choose which declaration of one contested `serverName` this project shows.
   *
   * The same two refusals as {@link setPin}, plus an answer no build knows. The
   * choice is stored first and the project reconciled right away, because a
   * choice is a mount changing name: the row it produces must be the row the
   * registry ends up carrying, not one that waits for the next turn.
   *
   * Nothing is refused for a name the project does not conflict over: the store
   * keeps a choice for a name that is not contested yet, so a declaration that
   * comes back — or a profile entry that is added later — finds the answer the
   * user already gave.
   * @param request - project root, contested name and the declaration to show.
   * @returns the fresh snapshot, or the refusal code the route maps to a status.
   */
  setConflictChoice(request: ConflictRequest): PolicyOutcome {
    if (!isConflictChoice(request.choice)) {
      return {
        ok: false,
        code: 'invalid',
        message: `unknown conflict choice ${JSON.stringify(request.choice)}`,
        messageCode: 'save.unknownChoice',
        messageParams: { choice: JSON.stringify(request.choice) },
      }
    }
    if (!this.projectKnown(request.projectRoot)) {
      return {
        ok: false,
        code: 'not-found',
        message: `no live session in ${request.projectRoot}`,
        messageCode: 'save.noLiveSession',
        messageParams: { projectRoot: request.projectRoot },
      }
    }
    const policy = this.options.policy
    if (policy === undefined) {
      return {
        ok: false,
        code: 'failed',
        message: 'this host has no tool-policy store',
        messageCode: 'save.noPolicyStore',
      }
    }
    policy.setConflictChoice(request.projectRoot, request.server, request.choice)
    this.notify()
    // The pass that follows the click is what moves the entry between a
    // conflict report and a mount, and it is not awaited: an operator click
    // must not wait for a server to start.
    void this.syncNow(request.projectRoot)
    return { ok: true, snapshot: this.snapshot() }
  }

  /**
   * The policy in force for one project root.
   *
   * Read at snapshot and assembly time — never captured — so a stored change is
   * visible to the next model step and to the next panel poll. A host built
   * without a store follows the shipped default for every project.
   * @param projectRoot - project root, or `undefined` before a session resolves one.
   * @returns the stored policy, or {@link DEFAULT_TOOL_POLICY} when there is none.
   */
  private policyFor(projectRoot: string | undefined): ToolPolicy {
    if (projectRoot === undefined) return DEFAULT_TOOL_POLICY
    return this.options.policy?.forProject(projectRoot) ?? DEFAULT_TOOL_POLICY
  }

  /**
   * Whether one project root has a live session on this host.
   * @param projectRoot - project root a policy request names.
   * @returns `true` when a bound session resolved to that root.
   */
  private projectKnown(projectRoot: string): boolean {
    for (const state of this.states.values()) {
      if (state.projectRoot === projectRoot) return true
    }
    return false
  }

  /**
   * Write one edited entry back to the document that declares it.
   *
   * The checks run in the contract's order and every one of them must pass
   * before a byte is written: the row must still exist, its declaring document
   * must belong to the project or to the (consented, enabled) global tier, the
   * revision must be the one the editor read, and the resulting entry must pass
   * the same parse path the mount uses. The document is then replaced by
   * {@link writeDocument} (`.bak`, then temp file, then rename) and rescanned,
   * so the answer carries a fresh snapshot.
   * @param request - the entry body, its declaring document and the read revision.
   * @returns the fresh snapshot, or the refusal code the route maps to a status.
   */
  async saveEntry(request: SaveRequest): Promise<SaveOutcome> {
    const states = [...this.states.values()].filter((state) => state.projectRoot === request.projectRoot)
    const row = states
      .flatMap((state) => state.rows)
      .find((candidate) => candidate.name === request.server)
    if (row === undefined) {
      return {
        ok: false,
        code: 'not-found',
        message: `server "${request.server}" is not declared for ${request.projectRoot}`,
        messageCode: 'save.serverNotDeclared',
        messageParams: { server: request.server, projectRoot: request.projectRoot },
      }
    }
    const document = row.source
    if (document === undefined) {
      return {
        ok: false,
        code: 'blocked',
        message: `server "${request.server}" has no declaring document to write`,
        messageCode: 'save.noDeclaringDocument',
        messageParams: { server: request.server },
      }
    }
    const scope = writeScopeFor(document, request.projectRoot, {
      projectDocuments: localConfigPaths(request.projectRoot, this.config.localFiles),
      globalDocuments: this.globalFiles(),
      allowGlobalWrite: this.config.allowGlobalWrite === true,
    })
    if (scope.scope === 'readonly') {
      // The scope's own reason already carries its write.blocked.* code; the
      // save.notWritable fallback is for the reason-less shape alone.
      return {
        ok: false,
        code: 'blocked',
        message: scope.reason ?? `${document} is not writable`,
        messageCode: scope.blockedCode ?? 'save.notWritable',
        messageParams: scope.blockedParams ?? { document },
      }
    }
    if (scope.scope === 'global' && request.consent !== true) {
      return {
        ok: false,
        code: 'blocked',
        message: `writing ${document} needs explicit consent`,
        messageCode: 'save.needsConsent',
        messageParams: { document },
      }
    }
    if (scope.scope === 'global' && this.config.allowGlobalWrite !== true) {
      return {
        ok: false,
        code: 'blocked',
        message: `writing the global tier is disabled by this deployment (allowGlobalWrite: false)`,
        messageCode: 'save.globalDisabled',
      }
    }
    if (request.document !== document) {
      return {
        ok: false,
        code: 'not-found',
        message: `server "${request.server}" is now declared by ${document}`,
        messageCode: 'save.declaredElsewhere',
        messageParams: { server: request.server, document },
      }
    }
    let text: string
    try {
      text = readFileSync(document, 'utf8')
    } catch {
      return {
        ok: false,
        code: 'not-found',
        message: `the declaring document ${document} is gone`,
        messageCode: 'save.documentGone',
        messageParams: { document },
      }
    }
    if (documentRevision(text) !== request.revision) {
      return {
        ok: false,
        code: 'conflict',
        message: `${document} changed since the entry was read; reload it and edit again`,
        messageCode: 'save.documentChanged',
        messageParams: { document },
      }
    }
    let root: unknown
    try {
      root = JSON.parse(text) as unknown
    } catch (error) {
      return {
        ok: false,
        code: 'invalid',
        message: `the declaring document is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        messageCode: 'save.invalidJson',
        messageParams: { document, error: error instanceof Error ? error.message : String(error) },
      }
    }
    const servers = isRecord(root) ? root.mcpServers : undefined
    if (!isRecord(servers)) {
      return {
        ok: false,
        code: 'blocked',
        message: `${document} does not use an "mcpServers" object, so this editor cannot rewrite it`,
        messageCode: 'save.noMcpServers',
        messageParams: { document },
      }
    }
    // The panel edits the sanitized `serverName`; the document key may differ
    // (`my server` vs `my-server`), so the declaration goes back under the key
    // the document actually holds.
    const key = Object.keys(servers).find(
      (candidate) => candidate === request.server || slugifyServerName(candidate) === request.server,
    )
    if (key === undefined) {
      return {
        ok: false,
        code: 'not-found',
        message: `server "${request.server}" is no longer declared in ${document}`,
        messageCode: 'save.noLongerDeclared',
        messageParams: { server: request.server, document },
      }
    }
    let next: string
    try {
      next = applyEntry(text, key, entryToDeclaration(request.entry, servers[key]))
    } catch (error) {
      // A WriteDocError already carries the refusal's wire code; anything else
      // crosses as prose alone.
      return {
        ok: false,
        code: 'invalid',
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof WriteDocError
          ? {
              messageCode: error.code,
              ...(error.params === undefined ? {} : { messageParams: error.params }),
            }
          : {}),
      }
    }
    // Same parse path the mount uses: what the host would not mount, it does
    // not write either.
    const parsed = parseDocument(next, document, this.resolveContext(request.projectRoot))
    const candidate = parsed.entries.find((entry) => entry.name === request.server)
    if (candidate === undefined || candidate.error !== undefined || candidate.config === undefined) {
      // A parse failure's prose already has its own parse.* code (Task 2);
      // save.entryNotParsed names only the shapeless fallback.
      return {
        ok: false,
        code: 'invalid',
        message: candidate?.error ?? `the edited entry "${request.server}" did not parse`,
        messageCode: candidate?.errorCode ?? 'save.entryNotParsed',
        ...(candidate?.errorCode === undefined
          ? { messageParams: { server: request.server } }
          : candidate.errorParams === undefined
            ? {}
            : { messageParams: candidate.errorParams }),
      }
    }
    try {
      writeDocument(document, next)
    } catch (error) {
      return {
        ok: false,
        code: 'failed',
        message: `writing ${document} failed: ${error instanceof Error ? error.message : String(error)}`,
        messageCode: 'save.writeFailed',
        messageParams: { document, error: error instanceof Error ? error.message : String(error) },
      }
    }
    // Drop the read cache and the pass digest for this project: a write that
    // only reformats the document keeps the same mounted config, so the digest
    // alone would skip the row rebuild the editor needs.
    this.documents.delete(document)
    for (const state of states) state.digest = undefined
    // An edit belongs to the project that declares the entry: reconcile it as an
    // operator request for *its* sessions — so the change reaches a live mount —
    // and never as a request for another project, whose sessions must not start
    // a server because an entry moved here.
    await this.enqueue(new Set(states.map((state) => state.agent.id)))
    return { ok: true, snapshot: this.snapshot() }
  }

  /**
   * Run one reconciliation pass and await it.
   *
   * The operator call: it requests every listed session — or, with a
   * `projectRoot`, only that project's — so a session whose declaration was
   * never mounted (or whose mount was dropped) may start here without a turn.
   * Every other pass — a turn, an event, the rescan tick — requests only the
   * sessions that asked. Scripted reconciliation uses this awaiting form; the
   * panel's `Sync` uses {@link syncSoon}.
   * @param projectRoot - restricts the pass to one project's sessions.
   */
  async syncNow(projectRoot?: string): Promise<void> {
    await this.enqueue(this.requestsFor(projectRoot))
  }

  /**
   * Ask for the same pass and return at once — the panel's `Sync`.
   *
   * Waiting for the pass is what turned a `Sync` on a project whose server was
   * still connecting into a hang: the HTTP answer, and with it the panel's busy
   * flag, stayed open for `connectTimeoutMs`. The pass runs in the background,
   * and the panel watches its outcome on the status channel.
   * @param projectRoot - restricts the pass to one project's sessions.
   */
  syncSoon(projectRoot?: string): void {
    this.kick(projectRoot)
  }

  /**
   * Queue the operator pass without awaiting it, containing a rejection the way
   * every other background pass does: by the time either operator route
   * answers, the pass is nobody's request to wait for.
   * @param projectRoot - restricts the pass to one project's sessions.
   */
  private kick(projectRoot: string | undefined): void {
    void this.enqueue(this.requestsFor(projectRoot)).catch((error: unknown) => {
      this.ctx.logger.warn(`project-mcp: operator pass failed: ${errorText(error)}`)
    })
  }

  /**
   * The sessions one operator pass may mount: every listed one, or the sessions
   * of a single project when the call came from a surface that shows one. The
   * project is named, not resolved here: {@link syncAgent} matches it against
   * each session's own working directory, so the very first operator call for a
   * session reaches the project it named.
   * @param projectRoot - the project the caller named, when it named one.
   * @returns the request the pass takes.
   */
  private requestsFor(projectRoot: string | undefined): PassRequests {
    return projectRoot === undefined ? 'all' : { projectRoot }
  }

  /** Queue one pass behind whatever is already running. */
  private enqueue(requests: PassRequests): Promise<void> {
    this.chain = this.chain.then(
      () => this.runPass(requests),
      () => this.runPass(requests),
    )
    return this.chain
  }

  /**
   * Drop the mounts currently in an `error` state and ask for a pass that mounts
   * them again, so a server that was fixed outside the plugin is picked up
   * without editing its declaration. A stalled mount is restarted from scratch.
   *
   * The drop is awaited — it is local and quick, and the answer the route sends
   * back must already show those rows as unmounted rather than failed. The pass
   * is not: a server that boots slowly would otherwise hold the `POST retry`
   * answer open for `connectTimeoutMs`, which the panel showed as a hang. A
   * `projectRoot` keeps both the drop and the pass inside that one project, so
   * retrying a row never starts a server for another one.
   *
   * The drop is per project: one failed instance is shared by every session of
   * its project, so retrying it must not try to unmount it once per session.
   * @param projectRoot - restricts the drop and the pass to one project.
   */
  async retry(projectRoot?: string): Promise<void> {
    // Every instance a session renders lives in its project's shared home — one
    // home per project, bridged or joined — so the project records are the whole
    // list of homes a retry has to walk.
    const homes: MountHome[] = [...this.projects.values()]
    for (const home of homes) {
      if (projectRoot !== undefined && home.projectRoot !== projectRoot) continue
      let dropped = false
      for (const [name, mount] of [...home.mounts]) {
        if (mount.status !== 'error') continue
        await this.unmount(home, name, { code: 'unmount.reason.operatorRetry', text: 'an operator retry replaces it' })
        dropped = true
      }
      // The documents are unchanged, so the pass below would take its steady
      // state shortcut — the dropped mount is exactly why it must not. Every
      // session that renders this home's rows must rebuild them. (A lazy
      // declaration that was never mounted needs no nudge: the operator pass
      // mounts it by itself, see the merge pass.)
      if (!dropped) continue
      for (const state of this.states.values()) {
        if (state.projectRoot === home.projectRoot) state.digest = undefined
      }
    }
    // The rows the drop just freed are visible now; the pass that mounts them
    // again reports for itself, one mount at a time.
    this.notify()
    this.kick(projectRoot)
  }

  /** Dispose every mount, scope, watcher and timer owned by this runtime. */
  async disposeAll(): Promise<void> {
    this.disposed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    if (this.debounce !== undefined) clearTimeout(this.debounce)
    this.timer = undefined
    this.debounce = undefined
    for (const watchers of this.watchers.values()) {
      for (const watcher of watchers) watcher.close()
    }
    this.watchers.clear()
    this.watchedDirs.clear()
    this.watchedRoots.clear()
    const states = [...this.states.values()]
    this.states.clear()
    this.documents.clear()
    this.secrets = undefined
    this.envFiles.clear()
    // Sessions first — each hands its hold back — then whatever no session names
    // any more, so a shared project is released exactly once either way.
    await Promise.all(states.map((state) => this.disposeState(state, { code: 'unmount.reason.unloading', text: 'the plugin is unloading' })))
    for (const project of [...this.projects.values()]) {
      await this.releaseProject(project, { code: 'unmount.reason.unloading', text: 'the plugin is unloading' })
    }
    this.projects.clear()
    // Last, so the teardown events above still reach the log: this runtime stops
    // being a consumer once it has nothing left to report.
    this.detachLog?.()
    this.detachLog = undefined
  }

  private newState(agent: AgentLike): AgentState {
    return {
      agent,
      cwd: agent.session.header?.cwd,
      projectRoot: undefined,
      digest: undefined,
      scope: undefined,
      project: undefined,
      bridge: undefined,
      parentLinked: false,
      detachedKey: undefined,
      rows: [],
      issues: [],
      conflicts: [],
      lastActivityAt: undefined,
      busy: false,
      activationPending: false,
      activation: undefined,
      step: 0,
      steps: new Map(),
      activationDispose: undefined,
      guidanceDispose: undefined,
      auto: undefined,
    }
  }

  private dropAgent(id: string): void {
    const state = this.states.get(id)
    this.states.delete(id)
    if (state !== undefined) void this.disposeState(state, { code: 'unmount.reason.sessionGone', text: 'the session went away' })
    this.sweepProjects()
    this.syncWatchers()
    this.notify()
  }

  /**
   * Release the sessions the host registry no longer lists.
   *
   * A finished or abandoned session produces no further event — no
   * `agent/status`, no `idle` transition to clear the busy flag, nothing for
   * the idle sweep to time out from. The pass is the path that exists: whatever
   * the registry still lists is live, and anything else hands its servers back
   * here, even with the idle sweep disabled.
   */
  private async releaseAbandoned(): Promise<void> {
    const listed = this.listAgents?.()
    if (listed === undefined) return
    const live = new Set(listed.map((agent) => agent.id))
    for (const id of [...this.states.keys()]) {
      if (live.has(id)) continue
      const state = this.states.get(id)
      this.states.delete(id)
      if (state !== undefined) await this.disposeState(state, { code: 'unmount.reason.sessionUnlisted', text: 'the registry no longer lists the session' })
    }
  }

  /**
   * Whether one session is running a turn right now.
   *
   * The host's own status wins where it publishes one: `busy` only ever
   * reflects the events this plugin happened to see, so a session whose `idle`
   * transition never arrives would pin its mounts forever behind a stale flag.
   * @param state - the session to judge.
   * @returns true while the session must keep its mounts unconditionally.
   */
  private working(state: AgentState): boolean {
    const live = state.agent.status
    return live === undefined ? state.busy : live === 'running'
  }

  /**
   * Forget everything one session presented. The session's project is gone with
   * the scope (or the session is over), so a baseline seeded from that project's
   * counters must not leak into a different one. An idle release goes through
   * `releaseMounts`, not here.
   *
   * The hold on the old project's shared servers is given back here too: a
   * session that moves to another project — or disappears — must not keep the
   * project it left running for nobody.
   * @param state - the session state to clear.
   */
  private async disposeState(state: AgentState, reason: CodedText): Promise<void> {
    state.digest = undefined
    state.rows = []
    state.issues = []
    state.activation = undefined
    state.auto = undefined
    await this.detach(state, reason)
  }

  /**
   * Take one session's hold on a project: link its scope key to the project's
   * so the shared layer resolves for it, or install the forwarding bridge when
   * that link is impossible, then mint its own scope and install the session
   * wiring on it. Idempotent while the hold is unchanged.
   *
   * The link comes first because it is what makes the project's already-running
   * servers visible to this session from its first request on. A key the
   * harness already parented cannot be linked again — `dsh-scope` binds a key
   * once, and the agent-preset roster binds every composed agent to its
   * standing scope before the agent is published — so that session holds the
   * SAME project home and gets a forwarding bridge instead: thin definitions in
   * its own layer whose calls run the project's one instance (`src/bridge.ts`).
   * One process per project is the whole point; the alternative was one process
   * per session, which is what the panel showed in the web GUI.
   * @param state - the session taking the hold.
   * @param project - the project whose mounts it shares.
   * @returns the home the session now holds.
   */
  private async holdProject(state: AgentState, project: ProjectState): Promise<MountHome> {
    const held = this.homeOf(state)
    if (held !== undefined && held.projectRoot === project.projectRoot) return held
    if (held !== undefined) await this.detach(state, { code: 'unmount.reason.sessionMoved', text: 'the session moved to another project' })
    // The session's own layer key is private to this session, so the link either
    // succeeds (this runtime just bound it, or owns the binding) or another
    // composition already parented that key — a foreign hold this runtime must
    // not move. The session still holds the project — the servers run once for
    // the whole project — and the bridge carries their tools into this session's
    // own layer, where the registry resolves them for exactly this key.
    state.parentLinked = linkScopeParent(state.agent, project.key)
    if (!state.parentLinked) {
      this.ctx.logger.debug?.(
        `project-mcp: session ${state.agent.id} keeps a foreign scope parent, so its tools are forwarded from ${project.projectRoot}`,
      )
    }
    state.project = project
    const home: MountHome = project
    this.ensureSessionScope(state.agent, state)
    if (state.parentLinked) this.dropBridge(state)
    else this.installBridge(state, project)
    return home
  }

  /**
   * Give one session's hold back. Its own scope and wiring go away, its scope
   * key is unlinked from the project so the shared servers stop resolving for
   * it, and the project's instance is released exactly when this was the last
   * holder — a session that goes idle or leaves while another one still works
   * must not stop the servers that one is using.
   * @param state - the session releasing its hold.
   * @param reason - why the hold is going back; every instance this drops is
   * logged with it, so the log says why a server stopped, not only that it did.
   */
  private async detach(state: AgentState, reason: CodedText): Promise<void> {
    const project = state.project
    state.project = undefined
    this.dropBridge(state)
    if (project !== undefined && state.parentLinked) {
      state.parentLinked = false
      state.detachedKey ??= {}
      if (!linkScopeParent(state.agent, state.detachedKey)) {
        this.ctx.logger.warn(
          `project-mcp: unlinking session ${state.agent.id} from its project failed: its session key is held by another composition`,
        )
      }
    }
    await this.disposeSessionScope(state, reason)
    if (project !== undefined && !this.hasHolders(project)) await this.releaseProject(project, reason)
  }

  /** Drop the session scope and the wiring installed on it. Idempotent. */
  private async disposeSessionScope(state: AgentState, reason: CodedText): Promise<void> {
    const scope = state.scope
    state.scope = undefined
    this.releaseWiring(state)
    if (scope === undefined) return
    try {
      await scope.dispose()
    } catch (error) {
      this.ctx.logger.warn(`project-mcp: disposing session scope failed: ${errorText(error)}`)
    }
  }

  /**
   * Whether any live session still holds one project's shared mounts.
   * @param project - the project to look for.
   * @returns `true` while at least one session keeps the instance alive.
   */
  private hasHolders(project: ProjectState): boolean {
    for (const state of this.states.values()) {
      if (state.project === project) return true
    }
    return false
  }

  /**
   * Release one project's shared servers and the scope that owns them.
   *
   * Runs when the project's last holder lets go, so a shared instance goes away
   * on exactly the trigger a per-session one did: the project's last session
   * releasing it (idle release, request, disposal, a move to another project, or
   * a declaration that mounts nothing any more). Idempotent.
   * @param project - the project to tear down.
   */
  private async releaseProject(project: ProjectState, reason: CodedText): Promise<void> {
    for (const name of [...project.mounts.keys()]) await this.unmount(project, name, reason)
    const scope = project.scope
    project.scope = undefined
    if (scope !== undefined) {
      try {
        await scope.dispose()
      } catch (error) {
        this.ctx.logger.warn(
          `project-mcp: disposing the shared scope of ${project.projectRoot} failed: ${errorText(error)}`,
        )
      }
    }
    // The record itself stays while a session is still bound to this root: a
    // pass mounting concurrently (a session disposed while another one turns)
    // would otherwise create a second record — and a second instance — for one
    // root. `sweepProjects` forgets it once nothing is bound any more.
    this.sweepProjects()
  }

  /**
   * Forget the project records no live session is bound to any more. A record
   * with mounts or a scope is never dropped: either one means someone still
   * holds the project.
   */
  private sweepProjects(): void {
    for (const [projectRoot, project] of this.projects) {
      if (project.scope !== undefined || project.mounts.size > 0) continue
      if (this.hasRootSessions(projectRoot)) continue
      this.projects.delete(projectRoot)
    }
  }

  /** Whether any live session resolved its working directory to one root. */
  private hasRootSessions(projectRoot: string): boolean {
    for (const state of this.states.values()) {
      if (state.projectRoot === projectRoot) return true
    }
    return false
  }

  /**
   * The project record one root's sessions share, created with its first holder
   * and forgotten when its last one lets go.
   * @param projectRoot - resolved project root.
   * @returns the live record.
   */
  private ensureProject(projectRoot: string): ProjectState {
    const existing = this.projects.get(projectRoot)
    if (existing !== undefined) return existing
    const project: ProjectState = {
      projectRoot,
      key: { projectRoot },
      scope: undefined,
      mounts: new Map(),
      shared: true,
    }
    this.projects.set(projectRoot, project)
    return project
  }

  /**
   * The home one session mounts in: the project it holds, bridged or joined.
   * `undefined` while it holds nothing.
   * @param state - the session to read.
   * @returns the session's mount home, or `undefined` when it holds none.
   */
  private homeOf(state: AgentState): MountHome | undefined {
    return state.project
  }

  /**
   * The mounts one session renders right now: its own home's when it has one for
   * this root, otherwise the project's shared set, so a session that holds
   * nothing still notices another session's mounts and re-renders its rows.
   * @param state - the session to read.
   * @param projectRoot - the project root the pass is reconciling.
   * @returns the mount map whose changes this session's digest tracks.
   */
  private visibleMounts(state: AgentState, projectRoot: string): ReadonlyMap<string, MountedInstance> {
    const home = this.homeOf(state)
    if (home !== undefined && home.projectRoot === projectRoot) return home.mounts
    return this.projects.get(projectRoot)?.mounts ?? NO_MOUNTS
  }

  /**
   * The live mounts one session currently holds. Empty for a session that holds
   * nothing: the servers run for their project, and only a holder shares them.
   * @param state - the session to read.
   * @returns the shared mount map, or a shared empty one.
   */
  private mountsOf(state: AgentState): ReadonlyMap<string, MountedInstance> {
    return this.homeOf(state)?.mounts ?? NO_MOUNTS
  }

  /**
   * The `serverName` every one of the session's mounts registers under.
   *
   * The registry — and every name it publishes — is keyed by this, not by the
   * declared name: a shadowed declaration registers as its local alias, and a
   * lookup by the contested name would read as "this project mounts nothing".
   * @param state - the session to read.
   * @returns the runtime names, one per live mount.
   */
  private runtimeNamesOf(state: AgentState): Set<string> {
    return new Set([...this.mountsOf(state).values()].map((mount) => mount.runtimeName))
  }

  /**
   * Unregister everything the current scope's session wiring installed. The
   * scope fiber disposes the same registrations with the real services, while a
   * host that publishes plain `systemPrompt`/`tools` stubs has only this path.
   * Idempotent.
   */
  private releaseWiring(state: AgentState): void {
    this.releaseGuidance(state)
    this.releaseActivation(state)
  }

  /**
   * Unregister the guidance section of the current scope, if one is installed.
   * Released exactly where the scope is — an idle release and agent disposal —
   * so no section ever describes mounts that are gone.
   */
  private releaseGuidance(state: AgentState): void {
    const dispose = state.guidanceDispose
    state.guidanceDispose = undefined
    if (dispose === undefined) return
    try {
      dispose()
    } catch (error) {
      this.ctx.logger.warn(
        `project-mcp: releasing guidance for session ${state.agent.id} failed: ${errorText(error)}`,
      )
    }
  }

  /**
   * Unregister the activation wiring of the current scope. Idempotent: the
   * scope fiber disposes the same registrations with the real registry, while a
   * host that publishes a plain `tools` stub has only this path.
   */
  private releaseActivation(state: AgentState): void {
    const dispose = state.activationDispose
    state.activationDispose = undefined
    if (dispose === undefined) return
    try {
      dispose()
    } catch (error) {
      this.ctx.logger.warn(
        `project-mcp: releasing activation for session ${state.agent.id} failed: ${errorText(error)}`,
      )
    }
  }

  /**
   * Ask for a pass. A pending pass is kept instead of being pushed back: the
   * rescan tick is often shorter than the debounce, and restarting the timer on
   * every tick would starve reconciliation forever. Bursts of watcher events
   * still collapse into the one queued pass, and each pass re-reads the
   * documents through the digest, so a late event costs one cheap pass.
   */
  private schedule(reason: string): void {
    if (this.disposed) return
    this.ctx.logger.debug?.(`project-mcp: sync scheduled (${reason})`)
    if (this.debounce !== undefined) return
    this.debounce = setTimeout(() => {
      this.debounce = undefined
      void this.enqueue(NO_REQUESTS)
    }, this.config.debounceMs)
    this.debounce.unref?.()
  }

  /**
   * Turn boundary. `running` is the moment a session becomes active, which is
   * what `lazy` waits for; `idle` closes the busy window that idle release
   * watches. A plain notification, so it never delays a turn.
   */
  private onStatus(event: AgentEventLike): void {
    if (this.disposed) return
    const state = this.states.get(event.agent.id)
    if (state === undefined) return
    // Both transitions are an activity boundary: a tool that has not been called
    // for `toolIdleMs` falls out here, before the turn that follows can see it.
    this.pruneActivation(state)
    if (event.status === 'running') {
      this.touch(state, { activate: true, busy: true })
      return
    }
    this.touch(state, { activate: false, busy: false })
  }

  /**
   * Before every step of a turn: keep this session's project mounted, waiting
   * for a pending activation so that the step's request already sees the
   * project's tools. The waterfall always continues — a project MCP server is
   * never a reason to hold up an agent step.
   */
  private async onPreStep(event: AgentEventLike, next: () => Promise<unknown>): Promise<unknown> {
    try {
      const state = this.states.get(event.agent.id)
      if (state !== undefined) {
        // This hook is the harness's own step boundary, so it is where the
        // per-session counter advances: an activation made during this step,
        // and the row a panel reads after it, both carry the number of the step
        // they belong to instead of a placeholder.
        state.step += 1
        if (!this.disposed) {
          this.touch(state, { activate: true })
          await this.awaitActivation(state)
        }
      }
    } catch (error) {
      this.ctx.logger.warn(`project-mcp: activation before a step failed: ${errorText(error)}`)
    }
    return next()
  }

  /** Record activity and, with nothing mounted, ask for an activation pass. */
  private touch(state: AgentState, options: { activate: boolean; busy?: boolean }): void {
    state.lastActivityAt = Date.now()
    if (options.busy !== undefined) state.busy = options.busy
    if (!options.activate || this.mountsOf(state).size > 0) return
    state.activationPending = true
    this.schedule('activity')
  }

  /**
   * Wait (bounded) for the activation pass a turn asked for.
   *
   * The pass carries no operator request on purpose: the caller's
   * `activationPending` is what entitles this session to mount, and leaving the
   * request empty is what keeps the pass from starting servers in every other
   * project whose sessions happen to be live.
   */
  private async awaitActivation(state: AgentState): Promise<void> {
    if (!state.activationPending) return
    const pass = this.enqueue(NO_REQUESTS).catch(() => undefined)
    const waitMs = this.config.activationWaitMs
    if (waitMs <= 0) return
    await Promise.race([pass, delay(waitMs)])
  }

  /**
   * Reconcile every known session once, then the sweep and the watchers.
   * @param requests - the sessions that may mount without their own turn asking.
   */
  private async runPass(requests: PassRequests): Promise<void> {
    if (this.disposed) return
    // A session the host no longer lists is finished: no later event will ever
    // report it, so this pass is the path that hands its mounts back.
    await this.releaseAbandoned()
    // Sessions are independent: one slow connect must not serialize the rest.
    await Promise.all(
      [...this.states.values()].map(async (state) => {
        try {
          await this.syncAgent(state, requests)
        } catch (error) {
          this.ctx.logger.warn(
            `project-mcp: sync failed for session ${state.agent.id}: ${errorText(error)}`,
          )
        }
      }),
    )
    await this.evictIdle()
    this.sweepProjects()
    this.syncWatchers()
    this.notify()
  }

  /**
   * Release the mounts of sessions that have been quiet for `idleTimeoutMs`.
   * Their rows stay visible as `idle`, so the project's declaration remains
   * discoverable while not a single child process is running for it.
   */
  private async evictIdle(): Promise<void> {
    const timeout = this.config.idleTimeoutMs
    if (timeout <= 0) return
    const now = Date.now()
    for (const state of [...this.states.values()]) {
      if (this.mountsOf(state).size === 0 || this.working(state)) continue
      const since = state.lastActivityAt
      if (since === undefined || now - since < timeout) continue
      await this.releaseMounts(
        state,
        (count) => ({
          code: 'idle.releasedInactive',
          text: `released after ${formatSeconds(now - since)} without activity — ${count} server(s) stopped; the next turn mounts them again`,
          params: { seconds: formatSeconds(now - since), count: String(count) },
        }),
        { code: 'unmount.reason.sessionIdle', text: 'the session went idle' },
      )
    }
  }

  /**
   * Give one session's servers back now, or every mounted session's when no id
   * is given. Drives the panel's "release" action; the rows stay as `idle` and
   * the next turn mounts them again. A session that releases the last hold on a
   * project takes the shared instance down with it, and one that releases while
   * another session of the project holds leaves it running for that session.
   */
  async release(agentId?: string): Promise<void> {
    for (const state of [...this.states.values()]) {
      if (agentId !== undefined && state.agent.id !== agentId) continue
      if (this.mountsOf(state).size === 0) continue
      await this.releaseMounts(
        state,
        (count) => ({
          code: 'idle.releasedRequest',
          text: `released on request — ${count} server(s) stopped; the next turn mounts them again`,
          params: { count: String(count) },
        }),
        { code: 'unmount.reason.operatorReleased', text: 'an operator released it' },
      )
    }
    this.notify()
  }

  /**
   * Give one session's hold back, keeping its rows as `idle`.
   *
   * The shared servers themselves follow the last holder: this detaches the
   * session (its scope, wiring and parent link) and releases the project only
   * when no other session holds it, so releasing one session of a project that
   * another session is still working in leaves that session's servers running.
   * @param state - the session releasing.
   * @param describe - reason for its rows, given the number of servers it held.
   */
  private async releaseMounts(
    state: AgentState,
    describe: (count: number) => CodedText,
    reason: CodedText,
  ): Promise<void> {
    const held = this.homeOf(state)
    const mounted = new Set(held === undefined ? [] : held.mounts.keys())
    const diagnostics = new Set(
      [...(held?.mounts.values() ?? [])].flatMap((mount) =>
        mount.detail === undefined ? [] : [mount.detail],
      ),
    )
    state.activationPending = false
    state.busy = false
    await this.detach(state, reason)
    const summary = describe(mounted.size)
    state.rows = state.rows.map((row) => (mounted.has(row.name) ? idleRow(row, summary) : row))
    state.issues = state.issues.filter((issue) => !diagnostics.has(issue.message))
    this.ctx.logger.debug?.(`project-mcp: session ${state.agent.id}: ${summary.text}`)
  }

  /**
   * Re-read one agent's project and reconcile its mounts.
   * @param state - the session to reconcile.
   * @param operatorRequested - an operator pass named this exact session.
   */
  async syncAgent(state: AgentState, requests: PassRequests = NO_REQUESTS): Promise<void> {
    const agent = state.agent
    const cwd = agent.session.header?.cwd
    state.cwd = cwd
    const projectRoot =
      cwd === undefined || cwd === ''
        ? undefined
        : findProjectRoot(cwd, this.config.projectMarkers, this.config.fileMarkers)
    // An operator asks for a session directly, or for a project — the second
    // only matches once the session's own working directory has been read,
    // which is why it is decided here rather than before the pass.
    const operatorRequested =
      requests === 'all' ||
      ('projectRoot' in requests
        ? requests.projectRoot === projectRoot
        : requests.has(state.agent.id))

    if (projectRoot === undefined) {
      // The root was just read and none was found. A session's working directory
      // cannot stop being inside its project without the session changing, so
      // this is a stale read — a concurrent sweep of the working tree, a temp
      // directory removed under a test. Either way the session keeps the hold it
      // has: a release here would tear down live mounts that the next read finds
      // again, and a session that genuinely has no project holds nothing to
      // release. A pending first mount still has to be cleared, because no turn
      // should wait for a pass that has nothing to do.
      state.activationPending = false
      return
    }
    // A session that moved to another project starts from a clean scope.
    if (projectRoot !== state.projectRoot) {
      await this.disposeState(state, { code: 'unmount.reason.sessionMoved', text: 'the session moved to another project' })
      state.projectRoot = projectRoot
    }

    const { entries, issues, documents, sources } = this.readProject(projectRoot)
    const reserved = this.config.profileWins ? this.profileServerNames() : new Set<string>()
    // The local names this project's shadowed declarations would take, resolved
    // once for the whole pass: the row, the mount and the conflict report all
    // read this one answer, so the alias the panel offers is the alias the
    // registry ends up carrying.
    const policy = this.policyFor(projectRoot)
    const aliases = resolveConflictNames({
      entries: entries.map((entry) => ({ name: entry.name, reserved: reserved.has(entry.name) })),
      prefix: this.config.localPrefix,
      projectRoot,
    })
    /**
     * The shadowed names this pass actually mounts, and under which name.
     *
     * A name whose user kept the profile's copy is deliberately absent: it is a
     * conflict report, not a mount. `local` mounts this project's entry under the
     * alias the panel offers; `native` mounts it under the name it declares,
     * where it is the nearer declaration for this project's own sessions and so
     * shadows the profile instance's tools of that name there. The profile
     * instance itself is never touched: it keeps running, and every other project
     * keeps resolving it. A `native` entry is therefore mapped to `undefined` and
     * is still a chosen mount — `has` is the question, never the value.
     */
    const choices = aliasesOf(policy)
    const chosen = new Map<string, string | undefined>()
    for (const [name, alias] of aliases) {
      const choice = choices[name] ?? 'profile'
      if (choice === 'local') chosen.set(name, alias)
      else if (choice === 'native') chosen.set(name, undefined)
    }
    state.conflicts = conflictsFor(entries, sources, reserved, aliases, policy)

    const rows: ServerRow[] = []
    const desired = new Map<string, ParsedEntry>()
    for (const entry of entries) {
      const base = baseRow(entry, projectRoot, documents.get(entry.source))
      if (entry.error !== undefined) {
        rows.push({
          ...base,
          status: 'error',
          detail: entry.error,
          ...(entry.errorCode === undefined ? {} : { detailCode: entry.errorCode }),
          ...(entry.errorParams === undefined ? {} : { detailParams: entry.errorParams }),
        })
        continue
      }
      if (!entry.enabled) {
        rows.push({ ...base, status: 'disabled', detail: 'declared with enabled: false', detailCode: 'idle.disabled' })
        continue
      }
      if (reserved.has(entry.name)) {
        const alias = aliases.get(entry.name)
        // The user chose this project's copy, and the pass has a name to mount it
        // under: the local alias, or the contested name itself when they opted to
        // shadow the profile's instance in this project's sessions. Either way the
        // declaration mounts like any other, and the profile's instance is left
        // running for every other project.
        if (chosen.has(entry.name)) {
          desired.set(entry.name, entry)
          // The row is `active` and carries no detail of its own: `decorate` drops
          // a row's detail while it has a mount, so a line explaining the choice
          // would never reach a surface. The conflict report below is where a
          // mounted name still says which of the three readings it is.
          const detail = conflictDetail(entry.name, alias)
          rows.push({
            ...base,
            detail: detail.text,
            detailCode: detail.code,
            ...(detail.params === undefined ? {} : { detailParams: detail.params }),
          })
          continue
        }
        const detail = conflictDetail(entry.name, alias)
        rows.push({
          ...base,
          status: 'conflict',
          detail: detail.text,
          detailCode: detail.code,
          ...(detail.params === undefined ? {} : { detailParams: detail.params }),
        })
        continue
      }
      desired.set(entry.name, entry)
      rows.push(base)
    }

    const documentIssues: SnapshotIssue[] = issues.map((issue) => ({
      source: issue.source,
      ...(issue.server === undefined ? {} : { server: issue.server }),
      level: issue.level,
      message: issue.message,
      ...(issue.code === undefined ? {} : { code: issue.code }),
      ...(issue.params === undefined ? {} : { params: issue.params }),
    }))

    // The project's shared instance, if it already has one. Its mounts are what
    // this session holds when it is already attached, and what it is about to
    // share when it attaches below — both are read live, never copied.
    const existing = this.projects.get(projectRoot)
    // The mounts whose changes this session's digest tracks: its own home's
    // when it has one, otherwise the project's shared set. A session that holds
    // nothing must still notice another session mounting, settling or dropping
    // a server, because its rows are a rendering of exactly those mounts.
    const mounts = this.visibleMounts(state, projectRoot)

    // Steady state: the documents, their resolved configs, the profile
    // reservations and the published state of the shared mounts are identical
    // and every mount has settled, so this pass has nothing to reconcile — no
    // merge, no tool-catalog scan, no remount. The shared-mount part of the
    // digest matters because another session of this project can have mounted,
    // settled or dropped a server without any document changing, and this
    // session's rows are a rendering of exactly those mounts.
    //
    // One state is *not* settled even so: a session whose project declares
    // something mountable and which `lazy` has mounted nothing for. Its inputs
    // are byte-identical to the pass that only published the declaration, so the
    // digest cannot tell them apart — an operator pass (`syncNow`, `retry`) has
    // to mount it now instead of waiting for a turn that may never come.
    const mountable = desired.size > 0
    // Whether *this* session already holds mounts. The project can be running
    // for another session of it while this one holds nothing, and such a
    // session must not be attached by a pass of its own: holding would make it
    // keep an instance it never asked for alive past its last real holder, and
    // would put the project's tools into a session that never turned.
    const held = this.mountsOf(state).size > 0
    // What this session is allowed to start in this pass, and why. `undefined`
    // is the answer for every session that is not working in its project: it is
    // live, it declares servers, and none of them may run.
    const trigger = mountTrigger({
      lazy: this.config.lazy,
      activationPending: state.activationPending,
      mounted: held,
      operatorRequested,
    })
    const awaitedMount = trigger === 'operator' && this.config.lazy && !held && mountable
    /**
     * Identity of this pass's inputs, recomputed once the mounts settled — a
     * mount created or dropped by this very pass is then part of it, so the
     * next pass recognizes the steady state instead of rebuilding one more time.
     */
    const settle = (): void => {
      state.digest = digestOf(entries, reserved, this.visibleMounts(state, projectRoot), chosen)
    }
    /**
     * The project record; only a session that may run something takes a hold,
     * and minting the record is what lets every other session of the root share
     * the instance it starts.
     */
    const project = trigger === undefined || desired.size === 0 ? existing : this.ensureProject(projectRoot)
    const digest = digestOf(entries, reserved, mounts, chosen)
    if (!awaitedMount && state.digest === digest && this.settled(state) && !state.activationPending) return

    // `lazy` defers a session's *first* mount to its first turn. Removals and
    // edits are always reconciled below; an operator call (`syncNow`, `retry`)
    // and a pending activation mount regardless.
    //
    // `mounted` in the decision above makes `undefined` unreachable while this
    // session holds servers, so publishing rows here never hides a live mount.
    if (trigger === undefined) {
      // Nothing runs for this session: publish what the project declares (it is
      // what the next turn will mount) without starting a single server.
      state.rows = rows.map((row) => (desired.has(row.name) ? idleRow(row, LAZY_DETAIL) : row))
      state.issues = documentIssues
      settle()
      return
    }

    // A session that may mount takes its hold first: the parent link is what
    // makes the project's already running servers visible to it, and minting
    // the session scope is what carries the session wiring. A session whose
    // scope key the harness already parented cannot take that link at all and
    // gets a home of its own, which is why the hold returns the home the pass
    // reconciles instead of the pass assuming the project's. A project that
    // declares nothing mountable mints no session scope at all — the
    // declarations below are published and nothing runs.
    let home: MountHome | undefined
    if (desired.size > 0 && project !== undefined) {
      home = await this.holdProject(state, project)
    } else {
      home = this.homeOf(state) ?? existing
    }

    if (home !== undefined) {
      // One home is reconciled, not one session's share of it: an edit or a
      // removal in the document is every holder's business, and a declaration
      // either exists for all sessions that resolve the home or for none.
      for (const [name, mount] of [...home.mounts]) {
        const entry = desired.get(name)
        if (entry?.config === undefined) {
          // A reserved name this project was mounting leaves for one of two
          // reasons — the declaration is gone, or the user went back to the
          // profile's copy — and the lifecycle log is where a reader tells them
          // apart.
          await this.unmount(
            home,
            name,
            reserved.has(name)
              ? { code: 'unmount.reason.profileShown', text: 'this project shows the profile-level copy instead' }
              : { code: 'unmount.reason.undeclared', text: 'the documents no longer declare it' },
          )
          continue
        }
        // A mount that no longer carries the local name this pass chose is
        // remounted, not kept: the alias is the whole of what the user changed,
        // and a registration is only ever created under one name.
        if (mount.runtimeName !== runtimeNameOf(entry, chosen.get(name))) {
          await this.unmount(home, name, { code: 'unmount.reason.nameChanged', text: 'its local name changed' })
          continue
        }
        if (mount.fingerprint !== fingerprint(entry.config)) {
          await this.unmount(home, name, { code: 'unmount.reason.declarationChanged', text: 'its declaration changed' })
        }
      }

      // Registration only: no `mount` here waits for its server, so this loop
      // is what a pass costs per declaration, not the handshake behind it.
      for (const [name, entry] of desired) {
        if (entry.config === undefined || home.mounts.has(name)) continue
        this.mount(state, home, name, entry, trigger, chosen.get(name))
      }
      if (home.mounts.size === 0) {
        // Nothing is mounted by design: this session keeps no hold, and a
        // shared scope goes with its last holder, so no server outlives the
        // session that asked for it.
        await this.detach(state, { code: 'unmount.reason.nothingMountable', text: 'nothing it declares is mountable any more' })
        if (home.shared && !this.hasHolders(home as ProjectState)) {
          await this.releaseProject(home as ProjectState, { code: 'unmount.reason.nothingMountable', text: 'nothing it declares is mountable any more' })
        }
      }
    }

    // The declarations as the documents give them. A mounted server keeps its
    // declared row here: the mount's own status is applied when the picture is
    // read ({@link liveRows}), so a drop, a new mount or a connect that happens
    // between two passes is visible without waiting for the next one.
    state.rows = rows.map((row) =>
      desired.has(row.name) && home?.mounts.has(row.name) !== true
        // A declaration that `lazy` has not mounted yet, or a newly added one.
        ? idleRow(row, LAZY_DETAIL)
        : row,
    )
    state.issues = documentIssues
    state.activationPending = false
    // Start the idle clock for a session that never reported activity, so an
    // unused one still releases its servers.
    state.lastActivityAt ??= Date.now()
    this.refreshStatuses(agent, state)
    // After the status scan, so a mount the watchdog has just flagged reports
    // its stall in the same pass that turned its row into an error.
    state.issues.push(...this.mountDiagnostics(state, projectRoot))
    settle()
    // The rows this session contributes are what they are now: announce them
    // before the pass moves on, so a mount that needed its full connect window
    // does not hold the whole picture back.
    this.notify()
  }

  /**
   * Start one declared server in the session's mount home and record the mount,
   * which every session that home serves then resolves.
   *
   * Exactly one `info` line is written per created process — never on a rescan
   * that re-derives the same mount, and never when another session of the
   * project attaches to a shared instance that is already running — so an
   * operator can tell which session caused a server to start, in which project,
   * and what asked for it.
   *
   * The registration is the whole of what this pass does here: the fiber's
   * activation is *watched*, never awaited, so a server that never answers
   * costs the pass — and with it every turn waiting on that pass — nothing.
   * The mount is recorded before the wait, so a later pass finds it in place
   * and mounts nothing a second time; the outcome reaches the row through
   * {@link observeActivation} on failure and through {@link refreshStatuses}
   * on success.
   * @param state - the session whose pass creates the instance.
   * @param home - the scope the instance belongs to: the project's shared one,
   * or the session's own when it could not join the project's chain.
   * @param name - declared `serverName`.
   * @param entry - the parsed declaration to mount.
   * @param trigger - why this pass was allowed to start it.
   * @param alias - local name to register under, when a profile instance owns
   * the declared one and the user chose to see the project's copy too.
   */
  private mount(
    state: AgentState,
    home: MountHome,
    name: string,
    entry: ParsedEntry,
    trigger: MountTrigger,
    alias?: string,
  ): void {
    const config = entry.config
    if (config === undefined) return
    const runtimeName = runtimeNameOf(entry, alias)
    const mount: MountedInstance = {
      name,
      runtimeName,
      projectRoot: home.projectRoot,
      fingerprint: fingerprint(config),
      fiber: undefined,
      status: 'connecting',
      detail: undefined,
      detailCode: undefined,
      detailParams: undefined,
      source: entry.source,
      transport: config.transport,
      endpoint: describeEndpoint(config),
      startedAt: Date.now(),
      stalled: false,
      failed: false,
    }
    home.mounts.set(name, mount)
    // The row turns `connecting` the moment the mount exists; announcing it here
    // is what makes a `Retry` visible in the panel while the server is still
    // booting, instead of only when the pass that started it returns.
    this.notify()
    try {
      const scope = this.ensureProjectScope(home as ProjectState)
      if (scope === undefined) {
        throw new Error('the project scope could not be minted, so the instance has no scope to register in')
      }
      const plugin = this.options.plugin ?? mcpClient
      // Call through the receiver: `ctx.plugin` is a context-bound method and
      // an extracted reference would lose `this`.
      const target = scope.ctx as unknown as {
        plugin(plugin: unknown, config: unknown): MountFiber
      }
      const fiber = target.plugin(plugin, clientConfig(runtimeConfigOf(config, runtimeName)))
      mount.fiber = fiber
      const sharing: CodedText = state.parentLinked
        ? { code: 'mount.sharingShared', text: 'one shared instance for every session of this project' }
        : {
            code: 'mount.sharingForwarded',
            text: "one shared instance for this project, forwarded into this session's own layer",
          }
      this.logLifecycle({
        at: Date.now(),
        level: 'info',
        logLevel: 'info',
        projectRoot: mount.projectRoot,
        sessionId: state.agent.id,
        server: name,
        message: `mounting for session ${state.agent.id} (trigger: ${trigger}; ${sharing.text})`,
        code: 'mount.starting',
        params: { sessionId: state.agent.id, trigger, sharingCode: sharing.code },
        line: `mounting ${name}${runtimeName === name ? '' : ` as ${runtimeName}`} for session ${state.agent.id} in ${home.projectRoot} (trigger: ${trigger}; ${sharing.text})`,
      })
      // Not awaited: the pass returns with the mount recorded and `connecting`,
      // and whatever the activation turns out to be is written from behind it.
      this.observeActivation(home, mount, `activation of ${name}`, fiber)
    } catch (error) {
      this.recordMountFailure(home, mount, error)
    }
  }

  /**
   * Publish one lifecycle event, and announce it.
   *
   * The plugin's five lifecycle facts — mounting, `is up`, a stall, a failed
   * mount, unmounting — leave the runtime through this one method and no other,
   * and the snapshot announcement follows every one of them, as it did when each
   * site kept the three writes in step by hand. What the DSH log prints and what
   * the ring holds are the subscribers' business now: the runtime only says what
   * happened (`src/notifications.ts`).
   * @param event - the fact, already carrying its level, session and server.
   */
  private logLifecycle(event: PluginEvent): void {
    emitEvent(event)
    this.notify()
  }

  /**
   * Watch one mount's activation in the background, so the registering pass
   * never waits for it.
   *
   * A failure is the one outcome the pass used to report itself, and it is
   * written exactly as it was when it did: the row turns `error`, `failed`
   * keeps {@link refreshStatuses} from polling a dead fiber, and the detail is
   * {@link failureDetail}. A success and a timeout write nothing — a mount
   * whose tools became visible is turned `active` by the status scan of the
   * next pass, which logs the `is up` line, and a mount that is merely slow is
   * the watchdog's stall to report.
   *
   * Nothing awaits the returned promise, so it must never reject: `waitFor`
   * already answers a rejected fiber with `{ kind: 'failed' }`, and the final
   * `catch` is the backstop for the recorder itself.
   * @param home - the home the mount was recorded in, read to see it is current.
   * @param mount - the mount whose activation this watches.
   * @param label - the wait label, as `waitFor` names it in the debug line.
   * @param fiber - the fiber whose activation this watches.
   */
  private observeActivation(
    home: MountHome,
    mount: MountedInstance,
    label: string,
    fiber: MountFiber,
  ): void {
    void this.settleActivation(home, mount, label, fiber).catch((error: unknown) => {
      this.ctx.logger.warn(
        `project-mcp: watching the activation of ${mount.name} failed: ${errorText(error)}`,
      )
    })
  }

  /**
   * The watched wait itself: one activation to its outcome, then the failure
   * written if it had one.
   * @param home - the home the mount was recorded in.
   * @param mount - the mount whose activation this waits for.
   * @param label - the wait label, as `waitFor` names it in the debug line.
   * @param fiber - the fiber whose activation this waits for.
   */
  private async settleActivation(
    home: MountHome,
    mount: MountedInstance,
    label: string,
    fiber: MountFiber,
  ): Promise<void> {
    const outcome = await this.waitFor(label, activation(fiber))
    // A later pass may already have dropped or replaced this mount — an operator
    // retry, an edited declaration, a teardown. The fiber going down with its
    // home is not a failure of a mount nobody serves any more.
    if (home.mounts.get(mount.name) !== mount) return
    if (outcome.kind === 'failed') {
      this.recordMountFailure(home, mount, outcome.error)
      this.announceHome(home)
      return
    }
    // The server's tools exist as of this moment, so this is where the sessions
    // that read the project through the bridge actually receive them: the mount
    // was registered before its fiber had published anything, and a session whose
    // key predates that registration has no other signal. On a real registry the
    // `tools/change` subscription carries the same news.
    this.syncBridgesOf(home)
    // Success: the tools may have appeared long after the pass that registered
    // the mount returned, and a deployment with `watch: false` and no idle sweep
    // has no rescan timer to notice. Announcing here is what turns `connecting`
    // into `active` — and logs `is up` — the moment it is true, instead of up to
    // `rescanIntervalMs` later.
    this.announceHome(home)
  }

  /**
   * Re-read one home's mounts for every session that holds it, then tell the
   * panels.
   *
   * Called from behind a pass — a mount settles after its pass has returned —
   * so for a deployment without a rescan timer this is the only moment that
   * moves a row off `connecting`. Idempotent: the transition log fires on a
   * change, so a second call for the same mount writes nothing.
   * @param home - the home whose instances settled.
   */
  private announceHome(home: MountHome): void {
    if (this.disposed) return
    for (const state of this.states.values()) {
      if (this.homeOf(state) !== home) continue
      this.refreshStatuses(state.agent, state)
    }
    this.notify()
  }

  /**
   * Record a mount that could not be activated: the row's `error`, the detail
   * an operator reads, and the one warning line. Shared by the synchronous
   * registration failures and the watched activations above, so both report
   * the same three facts in the same words.
   * @param home - the home the failed instance belongs to.
   * @param mount - the mount to mark failed.
   * @param error - what the fiber or the registration failed with.
   */
  private recordMountFailure(home: MountHome, mount: MountedInstance, error: unknown): void {
    mount.status = 'error'
    mount.failed = true
    const failure = failureDetail(mount, error)
    mount.detail = failure.text
    mount.detailCode = failure.code
    mount.detailParams = failure.params
    // The Logs tab gets the same three facts, first line as the row's message and
    // the whole detail for its second line. The instance serves every session of
    // its project, so the failure is a project event and names no session.
    this.logLifecycle({
      at: Date.now(),
      level: 'error',
      logLevel: 'warn',
      projectRoot: mount.projectRoot,
      server: mount.name,
      message: `mount failed — ${errorText(error)}`,
      code: 'mount.failed',
      params: { error: errorText(error) },
      detail: mount.detail,
      detailCode: failure.code,
      ...(failure.params === undefined ? {} : { detailParams: failure.params }),
      line: mount.detail,
    })
  }

  /**
   * The session-scope context the bridge registers through: the minted scope's
   * context carries the session's scope tag, so a registration made through it
   * lands in exactly this session's layer.
   */
  private bridgeContextOf(scope: Pick<Scope, 'ctx' | 'dispose'>): BridgeContextLike {
    if (this.options.bridgeContext !== undefined) return this.options.bridgeContext(scope)
    return {
      get: (name) => (scope.ctx as unknown as { get(service: string): unknown }).get(name),
    }
  }

  /** The registry surface the bridge reads; defaults to the plugin's own. */
  private bridgeRegistry(): BridgeRegistryLike {
    if (this.options.registry !== undefined) return this.options.registry
    const ctx = this.ctx as unknown as {
      tools: {
        get(name: string, scope?: object): ReturnType<BridgeRegistryLike['get']>
        schemas(scope?: object): ReturnType<BridgeRegistryLike['schemas']>
      }
    }
    // Bound through the receiver: an extracted `ctx.tools.get` reference would
    // lose the registry's `this`.
    return {
      get: (name, scope) => ctx.tools.get(name, scope),
      schemas: (scope) => ctx.tools.schemas(scope),
    }
  }

  /**
   * Install the forwarding bridge on one session: thin definitions in the
   * session's own layer over the project's live tools.
   *
   * Idempotent while the session keeps its project. The `tools/change`
   * subscription is what keeps the bridge level with a server that publishes
   * its tools long after the pass that registered the mount returned — the
   * session's layer is brought up to date before the next turn reads it.
   * A failure is contained: the session keeps its hold on the project's servers
   * and gets no tools from them until the next pass retries the sync.
   * @param state - the session taking the bridge.
   * @param project - the project whose tools are forwarded.
   */
  private installBridge(state: AgentState, project: ProjectState): void {
    if (state.bridge !== undefined || state.scope === undefined) return
    const context = this.bridgeContextOf(state.scope)
    const registry = this.bridgeRegistry()
    const servers = (): ReadonlySet<string> => this.runtimeNamesOf(state)
    const batch = new ForwardBatch({
      names: () => {
        try {
          return projectToolNames(
            state.project?.key ?? {},
            (scope) => this.bridgeSchemas(scope),
            servers(),
          )
        } catch (error) {
          // A probe that failed says nothing about the project's set: the batch
          // it could not describe is the batch that stays live.
          this.ctx.logger.warn(
            `project-mcp: reading the tools to forward to session ${state.agent.id} failed: ${errorText(error)}`,
          )
          return undefined
        }
      },
      register: (names) => forwardProjectTools({
        ctx: context,
        project: state.project?.key ?? {},
        names,
        registry,
      }),
    })
    const bridge: BridgeForwarders = {
      batch,
      detach: () => undefined,
    }
    // The listener lives on the session scope and is dropped with it, so a
    // released session never keeps syncing against a project it left.
    const detach = state.scope.ctx.on('tools/change', () => this.syncBridge(state))
    bridge.detach = typeof detach === 'function' ? (detach as () => void) : () => undefined
    state.bridge = bridge
    this.syncBridge(state)
  }

  /**
   * Bring one session's forwarders level with the project's live tools.
   *
   * The pass itself — including the re-entry its own registrations force on it
   * through `tools/change` — belongs to the session's {@link ForwardBatch}; this
   * is where a failure is contained and reported. A failed pass leaves the
   * session with no forwarder until the next pass retries (`namesIn` stays
   * unset), and never takes the session's hold on the project down.
   * @param state - the session whose bridge to sync.
   */
  private syncBridge(state: AgentState): void {
    const bridge = state.bridge
    if (bridge === undefined) return
    try {
      bridge.batch.sync()
    } catch (error) {
      this.ctx.logger.warn(
        `project-mcp: forwarding the tools of ${state.project?.projectRoot ?? 'the project'} into session ${state.agent.id} failed: ${errorText(error)}`,
      )
    }
  }

  /** The project scope's visible schemas, as {@link projectToolNames} reads them. */
  private bridgeSchemas(scope: object): ReturnType<BridgeRegistryLike['schemas']> {
    return this.bridgeRegistry().schemas(scope)
  }

  /** Drop one session's bridge: its forwarders and its subscription. Idempotent. */
  private dropBridge(state: AgentState): void {
    const bridge = state.bridge
    if (bridge === undefined) return
    state.bridge = undefined
    try {
      bridge.batch.drop()
    } catch (error) {
      this.ctx.logger.warn(
        `project-mcp: dropping the forwarded tools of session ${state.agent.id} failed: ${errorText(error)}`,
      )
    }
    try {
      bridge.detach()
    } catch {
      // The scope disposal that follows drops the same subscription; a throw
      // here must not keep the session's hold from being released.
    }
  }

  /**
   * The project's shared scope, minted with its first mount. One scope per
   * project is what makes mcp-client's `serverName` reservation per project
   * rather than per session, and it is disposed when the project's last holder
   * lets go, so the instance lifetime matches a per-session mount's.
   * @param project - the project to mount into.
   * @returns the scope, reused when the project already has one.
   */
  private ensureProjectScope(project: ProjectState): Pick<Scope, 'ctx' | 'dispose'> {
    const existing = project.scope
    if (existing !== undefined) return existing
    const scope = this.mintScope(project.key)
    project.scope = scope
    return scope
  }

  /**
   * Wait for one fiber operation, bounded by `connectTimeoutMs`. A server that
   * never answers must not hold a pass (or a project's teardown) open forever;
   * the fiber stays alive and later passes keep watching it.
   */
  private async waitFor<T>(label: string, wait: Promise<T>): Promise<WaitOutcome<T>> {
    const limit = this.config.connectTimeoutMs
    const settled = wait.then(
      (value): WaitOutcome<T> => ({ kind: 'settled', value }),
      (error): WaitOutcome<T> => ({ kind: 'failed', error }),
    )
    if (limit <= 0) return await settled
    const outcome = await Promise.race([
      settled,
      delay(limit).then((): WaitOutcome<T> => ({ kind: 'timeout' })),
    ])
    if (outcome.kind === 'timeout') {
      this.ctx.logger.debug?.(
        `project-mcp: ${label} did not settle within ${formatSeconds(limit)}; the pass continues without it`,
      )
    }
    return outcome
  }

  /**
   * Whether every mount has settled, so a rescan can return without work. A
   * stalled mount keeps the pass alive on purpose: only a fresh status scan can
   * notice that the client's background retry finally connected.
   */
  private settled(state: AgentState): boolean {
    for (const mount of this.mountsOf(state).values()) {
      if (mount.stalled) return false
      if (mount.status !== 'active' && mount.status !== 'error') return false
    }
    return true
  }

  /**
   * Mint one scope through the injected factory, or through the module itself.
   * The parent link of a session key is established by {@link holdProject} before
   * this runs and deliberately not passed as `createScope`'s own `parent`
   * option: binding twice on one key throws, and the retained binding is what
   * makes a release and a project change re-linkable.
   * @param key - session key or project key the scope's registrations own.
   * @returns the minted scope.
   */
  private mintScope(key: AgentLike | ProjectScopeKey): Pick<Scope, 'ctx' | 'dispose'> {
    if (this.options.createScope !== undefined) return this.options.createScope(this.ctx, key)
    return createScope(this.ctx, key)
  }

  /**
   * Mint the session scope on first use and install the session wiring on it:
   * the project-MCP guidance section and, when activation is on, the wiring
   * that lets a project's MCP tools be *found* (`mcp_search_tools`) and put
   * back into an assembly a presentation plugin filtered.
   *
   * Both are installed once per scope and both read the project's live state, so
   * a rescan that changes the mounted set changes what they say without
   * re-registering anything. `detach` disposes the scope and releases the wiring
   * explicitly, and the next attach installs a fresh one over the surviving
   * session state.
   *
   * A failed mint is contained: the session keeps its hold on the shared mounts
   * (they are registered on the project scope, which is unaffected) and only
   * loses its own wiring, instead of failing the pass.
   */
  private ensureSessionScope(agent: AgentLike, state: AgentState): void {
    if (state.scope !== undefined) return
    let scope: Pick<Scope, 'ctx' | 'dispose'>
    try {
      scope = this.mintScope(state.agent)
    } catch (error) {
      this.ctx.logger.warn(
        `project-mcp: minting the scope of session ${agent.id} failed: ${errorText(error)}`,
      )
      return
    }
    state.scope = scope
    // The guidance section is independent of activation: with activation off
    // every tool is listed and the section only names the mount, so it stays a
    // true statement either way.
    if (this.config.guidanceEnabled ?? DEFAULT_GUIDANCE_ENABLED) {
      try {
        state.guidanceDispose = installGuidance({
          ctx: scope.ctx as unknown as GuidanceContextLike,
          text: () => this.guidanceText(agent, state),
          onError: (error) => {
            this.ctx.logger.warn(
              `project-mcp: guidance section failed for session ${agent.id}: ${errorText(error)}`,
            )
          },
        })
      } catch (error) {
        this.ctx.logger.warn(
          `project-mcp: guidance wiring failed for session ${agent.id}: ${errorText(error)}`,
        )
      }
    }
    if (!(this.config.activationEnabled ?? DEFAULT_ACTIVATION_ENABLED)) return
    try {
      state.activationDispose = installActivation({
        ctx: scope.ctx as unknown as ActivationContextLike,
        state: () => this.seedActivation(state),
        setState: (next) => {
          state.activation = next
        },
        available: () => this.activationCandidates(state),
        visible: () => this.visibleSchemas(state),
        foreign: () => this.foreignNamesOf(state),
        // The policy is read at every assembly rather than captured here, so a
        // mode or pin stored from the panel applies from the next model step on
        // without re-minting the scope the listener lives in.
        policy: () => this.policyFor(state.projectRoot),
        // The step the session is on, read when a search activates names: the
        // wiring keeps no counter of its own, because an activation outlives
        // the scope the wiring lives in and its stamp has to outlive it too.
        step: () => state.step,
        onActivated: (names, step) => {
          for (const name of names) state.steps.set(name, step)
        },
        onCompaction: () => {
          // A step record belongs to the activation it was made for, so the ones
          // a compaction just dropped go with them — while a tool the session
          // really used keeps the step its offer happened on.
          this.pruneStepRecords(state)
        },
        autoState: state.auto ?? createAutoOfferState(),
        setAutoState: (next) => {
          state.auto = next
        },
        ...(this.config.activationAutoLimit === undefined
          ? {}
          : { autoLimit: this.config.activationAutoLimit }),
        ...(this.config.activationAutoStickySteps === undefined
          ? {}
          : { autoStickySteps: this.config.activationAutoStickySteps }),
        ...(this.config.activationToolBudgetChars === undefined
          ? {}
          : { toolBudgetChars: this.config.activationToolBudgetChars }),
        onError: (error) => {
          this.ctx.logger.warn(
            `project-mcp: activation failed for session ${agent.id}: ${errorText(error)}`,
          )
        },
      })
    } catch (error) {
      this.ctx.logger.warn(
        `project-mcp: activation wiring failed for session ${agent.id}: ${errorText(error)}`,
      )
    }
  }

  /**
   * The session's activation state, seeded from its project's counters on first
   * use. Later scopes of the same session keep it; only a project change or a
   * teardown drops it.
   */
  private seedActivation(state: AgentState): ActivationState {
    const existing = state.activation
    if (existing !== undefined) return existing
    const projectRoot = state.projectRoot
    const usage = projectRoot === undefined ? undefined : this.options.usage?.forProject(projectRoot)
    const seeded = createActivationState(
      seedFromUsage(usage, {
        count: this.config.activationSeeded ?? DEFAULT_ACTIVATION_SEEDED,
        minCalls: this.config.activationMinCalls ?? DEFAULT_ACTIVATION_MIN_CALLS,
      }),
    )
    state.activation = seeded
    return seeded
  }

  /**
   * The schemas this plugin may offer this session: exactly the tools whose
   * public name belongs to a server it mounted for this agent's project. A
   * profile-level or other-project tool is never a candidate, and the prefix is
   * never parsed blindly — the runtime's own mount records decide.
   */
  private activationCandidates(state: AgentState): ToolSchemaLike[] {
    const servers = this.runtimeNamesOf(state)
    if (servers.size === 0) return []
    return this.mountedSchemas(state)
      .filter((schema) => matchServer(schema.name, servers) !== undefined)
  }

  /**
   * The schemas the session's own mount home publishes, read through the home's
   * scope key rather than the session's.
   *
   * The two are the same catalog by construction: a session that joined the
   * project's chain resolves the project's layer, and a session that could not
   * gets exactly those tools forwarded into its own layer. Reading the home's
   * view is what keeps this probe independent of the forwarding timing — a
   * server is up as soon as its tools are registered on the project scope, and
   * a bridge sync that has not run yet must not read as "not up".
   * @param state - the session whose home is probed.
   * @returns the visible schemas of its home, or none while it holds nothing.
   */
  private mountedSchemas(state: AgentState): ToolSchemaLike[] {
    const home = this.homeOf(state)
    if (home === undefined) return []
    // A bridge is kept level by the mount, activation and `tools/change`
    // signals; this is the same sync on the read path, so a session's own layer
    // can never lag behind the catalog this probe returns. Unchanged names
    // short-circuit inside, so the cost is one name comparison.
    this.syncBridge(state)
    return this.schemasOf(home, state.agent.id)
  }

  /**
   * The visible catalog of one mount home, read through the home's scope key.
   *
   * The single read both callers share: the activation probe asks for the whole
   * catalog, and the on-demand detail route asks it for one definition — reading
   * through the same key is what makes a deferred name answer exactly like an
   * offered one, because the home's catalog carries the whole mounted surface
   * and the deferral decision only lives in the request.
   *
   * @param home - the mount home whose registrations are read.
   * @param agentId - the session the read is attributed to, for the warning.
   * @returns the home's schemas, or none when the read fails.
   */
  private schemasOf(home: MountHome, agentId: string): ToolSchemaLike[] {
    try {
      return this.ctx.tools.schemas(home.key)
    } catch (error) {
      this.ctx.logger.warn(
        `project-mcp: reading the tool catalog of session ${agentId} failed: ${errorText(error)}`,
      )
      return []
    }
  }

  /**
   * Every MCP schema the session's own scope chain resolves beyond this
   * plugin's project mounts: the profile plane and any F-19 forwarders. Read
   * through the session's key rather than the home's, so the deferral budget
   * and the discovery tool measure the whole surface the request actually
   * carries. Only `mcp__`-prefixed names enter, and the discovery tool is left
   * out by value — not by prefix — so the activation wiring can offer it on its
   * own. The per-server usage counters stay on the project plane: this probe
   * reads the catalog, never the counters.
   *
   * @param state - the session whose visible surface is probed.
   * @returns the visible MCP schemas, or none when the read fails.
   */
  private visibleSchemas(state: AgentState): ToolSchemaLike[] {
    try {
      return this.ctx.tools.schemas(state.agent).filter(
        (schema) => schema.name.startsWith('mcp__') && schema.name !== SEARCH_TOOL_NAME,
      )
    } catch (error) {
      this.ctx.logger.warn(
        `project-mcp: reading the visible MCP surface of session ${state.agent.id} failed: ${errorText(error)}`,
      )
      return []
    }
  }

  /**
   * The MCP tool names this session must never be offered: everything another
   * project mounted in this process publishes. The union is read through each
   * other project's own scope key — not the session's — so a name the host
   * defect leaked into the session's chain is caught here by provenance rather
   * than by prefix. Conservative, so a name the session may legitimately see is
   * never marked foreign: the set subtracts the session's own project's runtime
   * names and every profile-level server name (a profile entry is none of this
   * plugin's business even when another project declares the same name).
   * @param state - the session whose request is being assembled.
   * @returns the foreign tool names, or none when the read fails.
   */
  private foreignNamesOf(state: AgentState): ReadonlySet<string> {
    const own = this.runtimeNamesOf(state)
    const profile = this.profileServerNames()
    const legitimate = new Set<string>([...own, ...profile])
    const foreign = new Set<string>()
    for (const project of this.projects.values()) {
      if (project.projectRoot === state.projectRoot) continue
      let schemas: ToolSchemaLike[]
      try {
        schemas = this.ctx.tools.schemas(project.key)
      } catch (error) {
        this.ctx.logger.warn(
          `project-mcp: reading another project's catalog for session ${state.agent.id} failed: ${errorText(error)}`,
        )
        continue
      }
      for (const schema of schemas) {
        if (!schema.name.startsWith('mcp__')) continue
        if (matchServer(schema.name, legitimate) !== undefined) continue
        foreign.add(schema.name)
      }
    }
    return foreign
  }

  /**
   * The live text of the session's guidance section.
   *
   * It reads the mount records and the registry at every assembly, so a rescan
   * that mounted or dropped a server — and a search that activated a tool — are
   * reflected without re-registering the section. Total: any failure returns the
   * empty string, because a section that throws would fail the model request
   * that asked for the assembly.
   */
  private guidanceText(agent: AgentLike, state: AgentState): string {
    try {
      const projectRoot = state.projectRoot
      if (projectRoot === undefined || this.mountsOf(state).size === 0) return ''
      const activationEnabled = this.config.activationEnabled ?? DEFAULT_ACTIVATION_ENABLED
      // With activation on, the presented set is the session's counter baseline
      // plus its activations; with it off, the registry lists every tool.
      const presented = activationEnabled ? presentedNames(this.seedActivation(state)) : undefined
      // Matched by the name each mount registers under, never by its declared
      // one: a shadowed declaration carries a local alias, and a registry lookup
      // by the contested name would drop its tools from the count.
      const mounted = new Set([...this.mountsOf(state).values()].map((mount) => mount.runtimeName))
      const toolsByServer = new Map<string, string[]>()
      const offered: string[] = []
      const deferred: string[] = []
      for (const schema of this.mountedSchemas(state)) {
        const server = matchServer(schema.name, mounted)
        if (server === undefined) continue
        const name = schema.name.slice(`mcp__${server}__`.length)
        const tools = toolsByServer.get(server)
        if (tools === undefined) toolsByServer.set(server, [name])
        else tools.push(name)
        if (presented === undefined || presented.has(schema.name)) offered.push(name)
        else deferred.push(name)
      }
      const servers: GuidanceServer[] = [...this.mountsOf(state).values()].map((mount) => ({
        name: mount.name,
        status: mount.status,
        ...(mount.transport === undefined ? {} : { transport: mount.transport }),
        tools: toolsByServer.get(mount.runtimeName) ?? [],
      }))
      // The seeded baseline's insertion order is the usage rank order
      // (most-called first); keep it and strip the server prefix, so the
      // guidance names the session's hot tools like every other short name.
      const mostUsed: string[] = []
      if (activationEnabled) {
        for (const fullName of this.seedActivation(state).baseline) {
          const server = matchServer(fullName, mounted)
          if (server !== undefined) mostUsed.push(fullName.slice(`mcp__${server}__`.length))
        }
      }
      return buildGuidance({
        project: projectLabel(projectRoot, homedir()),
        servers,
        offered,
        deferred,
        mostUsed,
        activationEnabled,
      })
    } catch (error) {
      this.ctx.logger.warn(
        `project-mcp: building guidance for session ${agent.id} failed: ${errorText(error)}`,
      )
      return ''
    }
  }

  /**
   * Record a call against the session's activation state: it refreshes the
   * freshness of a session-activated tool, and it is the evidence a later
   * compaction keeps that activation by. It rides the same `tools/result`
   * subscription the counters use, so no second observer exists.
   * @param agentId - calling agent, when the call was agent-scoped.
   * @param toolName - public registry name of the call.
   */
  noteToolUse(agentId: string | undefined, toolName: string): void {
    if (agentId === undefined) return
    const state = this.states.get(agentId)
    if (state?.activation === undefined) return
    state.activation = noteUse(state.activation, toolName, Date.now())
  }

  /** Drop the session-activated tools that outlived `toolIdleMs` without a call. */
  private pruneActivation(state: AgentState): void {
    const current = state.activation
    if (current === undefined) return
    state.activation = pruneIdle(current, Date.now(), this.config.toolIdleMs ?? DEFAULT_TOOL_IDLE_MS)
    // A step record belongs to the activation it was made for, so a name that
    // fell out of the window takes its record with it; one that returns is
    // stamped again with the step it returns on.
    if (state.activation !== current) this.pruneStepRecords(state)
  }

  /**
   * Drop the step records whose activation the session no longer holds.
   *
   * Called wherever activations end — the idle sweep and a compaction — so a
   * record never outlives the offer it was made for, and a name the session
   * still offers keeps the step its offer happened on.
   * @param state - the session whose records are reconciled.
   */
  private pruneStepRecords(state: AgentState): void {
    const active = state.activation?.active
    for (const name of [...state.steps.keys()]) {
      if (active === undefined || !active.has(name)) state.steps.delete(name)
    }
  }

  private async unmount(home: MountHome, name: string, reason: CodedText): Promise<void> {
    const mount = home.mounts.get(name)
    if (mount === undefined) return
    home.mounts.delete(name)
    this.logUnmount(home, mount, reason)
    await this.disposeFiber(mount)
  }

  /**
   * The line that closes a mount's life, the pair of the `mounting` line.
   *
   * The reason is the part a reader cannot infer from the log's order: an edit,
   * an idle release, an operator retry and a session teardown all unmount, and
   * only some of them are followed by a mount of the same server. The run time
   * tells a server that never came up from one that served and was replaced.
   * @param home - the home the instance lived in.
   * @param mount - the instance going away.
   * @param reason - why it is going away: the operator's sentence and its wire
   *   code (F-48), nested two-level into the `unmounting` event as `reasonCode`.
   */
  private logUnmount(home: MountHome, mount: MountedInstance, reason: CodedText): void {
    const now = Date.now()
    const ran = formatDuration(now - mount.startedAt)
    // `unmounting` after a failure is the tail of that failure, so the tab keeps
    // it red; every other release is a warning. The instance serves every session
    // of its project, so its release is a project event that names no session.
    this.logLifecycle({
      at: now,
      level: mount.failed ? 'error' : 'warn',
      logLevel: 'info',
      projectRoot: mount.projectRoot,
      server: mount.name,
      message: `unmounting — ${reason.text} (it ran for ${ran})`,
      code: 'unmounting',
      params: { reasonCode: reason.code, ran },
      ...(mount.detail === undefined ? {} : { detail: mount.detail }),
      ...(mount.detailCode === undefined ? {} : { detailCode: mount.detailCode }),
      ...(mount.detailParams === undefined ? {} : { detailParams: mount.detailParams }),
      line: `unmounting ${mount.name} in ${home.projectRoot} — ${reason.text} (it ran for ${ran})`,
    })
  }

  /**
   * Bring every foreign holder of one home level with its live tools.
   *
   * The mount and unmount sites call this because they are the moments the
   * project's tool set actually changes: a session's own pass can run before the
   * server it shares has published anything (its own mount is only registered
   * after the hold), and this is what fills its forwarders in behind it. The
   * `tools/change` subscription and the read-path sync cover the same event on
   * a real registry; a third trigger costs nothing, because an unchanged name
   * set short-circuits.
   * @param home - the home whose tools changed.
   */
  private syncBridgesOf(home: MountHome): void {
    for (const state of this.states.values()) {
      if (state.bridge !== undefined && state.project === home) this.syncBridge(state)
    }
  }

  private async disposeFiber(mount: MountedInstance): Promise<void> {
    const fiber = mount.fiber
    mount.fiber = undefined
    if (fiber === undefined) return
    const outcome = await this.waitFor(
      `disposal of ${mount.name}`,
      Promise.resolve().then(() => fiber.dispose()),
    )
    if (outcome.kind === 'failed') {
      this.ctx.logger.warn(`project-mcp: disposing ${mount.name} failed: ${errorText(outcome.error)}`)
    }
  }

  /**
   * Refresh `active`/`connecting` from the tools actually visible to the agent,
   * and turn a mount that never produced a tool into a detailed `error` row.
   * The watchdog is strictly read-only: it never disposes a slow server, and a
   * mount that connects later returns to `active` on its own.
   */
  private refreshStatuses(agent: AgentLike, state: AgentState): void {
    const timeout = this.config.connectTimeoutMs
    const now = Date.now()
    for (const mount of this.mountsOf(state).values()) {
      // Activation failed outright: the fiber is dead, so there is nothing to
      // poll and nothing to revive without a new mount (`projectMcp.retry()`).
      if (mount.failed) continue
      if (this.hasTools(state, mount.runtimeName)) {
        if (mount.status !== 'active') {
          const elapsed = formatDuration(now - mount.startedAt)
          // Success is an event of its own level: the tab draws it green, not as
          // one more info line, and the line names the session that sees it.
          this.logLifecycle({
            at: now,
            level: 'up',
            logLevel: 'info',
            projectRoot: mount.projectRoot,
            sessionId: agent.id,
            server: mount.name,
            message: `is up — tools visible to session ${agent.id} after ${elapsed}`,
            code: 'mount.up',
            params: { sessionId: agent.id, elapsed },
            line: `${mount.name} is up in ${state.projectRoot ?? 'the project'} — its tools are visible to session ${agent.id} after ${elapsed}`,
          })
        }
        mount.status = 'active'
        mount.detail = undefined
        mount.detailCode = undefined
        mount.detailParams = undefined
        mount.stalled = false
        continue
      }
      const elapsed = now - mount.startedAt
      if (timeout > 0 && elapsed >= timeout) {
        const firstReport = !mount.stalled
        mount.status = 'error'
        mount.stalled = true
        const stall = stallDetail(mount, elapsed)
        mount.detail = stall.text
        mount.detailCode = stall.code
        mount.detailParams = stall.params
        if (firstReport) {
          // Reported once per stall (the watchdog re-reads it every pass), with
          // the three facts the row shows and no retry advice.
          this.logLifecycle({
            at: now,
            level: 'warn',
            logLevel: 'warn',
            projectRoot: mount.projectRoot,
            sessionId: agent.id,
            server: mount.name,
            message: `no tool appeared in ${formatDuration(elapsed)}`,
            code: 'mount.stalled',
            params: { elapsed: formatDuration(elapsed) },
            detail: stall.text,
            detailCode: stall.code,
            ...(stall.params === undefined ? {} : { detailParams: stall.params }),
            line: stall.text,
          })
        }
        continue
      }
      mount.status = 'connecting'
      mount.stalled = false
      mount.detail = undefined
      mount.detailCode = undefined
      mount.detailParams = undefined
    }
  }

  /**
   * The session's rows with their live mount state applied.
   *
   * Read-time, not stored: a mount that appears, connects or fails between two
   * passes changes what a panel must show, while the row belongs to the pass
   * that last re-derived it. Decorating here is what lets the status channel
   * report a mount the moment the pass creates it, rather than when that pass
   * finally returns.
   * @param state - the session whose rows to read.
   * @returns one row per declaration, in document order.
   */
  private liveRows(state: AgentState): ServerRow[] {
    const mounts = this.mountsOf(state)
    return state.rows.map((row) => decorate(row, mounts.get(row.name)))
  }

  /** Mount failures of this pass, published as first-class snapshot issues. */
  private mountDiagnostics(state: AgentState, projectRoot: string): SnapshotIssue[] {
    const diagnostics: SnapshotIssue[] = []
    for (const mount of this.mountsOf(state).values()) {
      if (mount.status !== 'error' || mount.detail === undefined) continue
      diagnostics.push({
        source: mount.source ?? projectRoot,
        server: mount.name,
        level: 'error',
        message: mount.detail,
        // The detail's wire companions ride along, so the issue translates the
        // same way the event's detail does (F-48).
        ...(mount.detailCode === undefined ? {} : { code: mount.detailCode }),
        ...(mount.detailParams === undefined ? {} : { params: mount.detailParams }),
      })
    }
    return diagnostics
  }

  private hasTools(state: AgentState, serverName: string): boolean {
    const prefix = `mcp__${serverName}__`
    return this.mountedSchemas(state).some((schema) => schema.name.startsWith(prefix))
  }

  /**
   * Global documents of this deployment, lowest priority first. Read before a
   * project's own documents, so a project declaration always wins.
   */
  private globalFiles(): string[] {
    return globalConfigPaths(this.config.globalFiles)
  }

  /**
   * Every document one project is configured to read, in priority order — the
   * order they are read in, which is what the panel's `priority n/total` counts.
   */
  private readFiles(projectRoot: string): ConfiguredFile[] {
    return [
      ...this.globalFiles().map((path): ConfiguredFile => ({ path, scope: 'global' })),
      ...localConfigPaths(projectRoot, this.config.localFiles).map(
        (path): ConfiguredFile => ({ path, scope: 'project' }),
      ),
    ]
  }

  private readProject(projectRoot: string): {
    entries: ParsedEntry[]
    issues: ParseIssue[]
    documents: Map<string, DocumentInfo>
    /**
     * Every document that declared each `serverName`, in declaration order —
     * lowest priority first, exactly the order {@link mergeEntries} applies, so
     * the winner of a duplicated name is the last path recorded here.
     */
    sources: Map<string, string[]>
  } {
    const paths = [...this.globalFiles(), ...localConfigPaths(projectRoot, this.config.localFiles)]
    const resolveContext = this.resolveContext(projectRoot)
    const groups: ParsedEntry[][] = []
    const issues: ParseIssue[] = []
    const documents = new Map<string, DocumentInfo>()
    const sources = new Map<string, string[]>()
    for (const path of paths) {
      const document = this.readDocument(path, resolveContext)
      if (document === undefined) continue
      groups.push(document.entries)
      issues.push(...document.issues)
      documents.set(path, this.documentInfo(path, projectRoot, document, resolveContext))
      for (const entry of document.entries) {
        const declared = sources.get(entry.name)
        if (declared === undefined) sources.set(entry.name, [path])
        else if (!declared.includes(path)) declared.push(path)
      }
    }
    const { entries, overridden } = mergeEntries(groups)
    for (const name of new Set(overridden)) {
      issues.push({
        source: projectRoot,
        server: name,
        level: 'warning',
        message: `serverName "${name}" was declared in more than one document; the highest-priority definition wins`,
        // The code the client's file grouping compares — never the prose,
        // which the client may have translated.
        code: 'parse.server.multiDocument',
        params: { name },
      })
    }
    return { entries, issues, documents, sources }
  }

  /**
   * Everything the editor needs about one declaring document: its revision and
   * write tier, plus the entry body of each server that parsed.
   */
  private documentInfo(
    path: string,
    projectRoot: string,
    document: CachedDocument,
    resolveContext: ResolveContext,
  ): DocumentInfo {
    const entries = new Map<string, EntrySnapshot>()
    const declared = document.raw
    if (declared !== undefined) {
      const byName = new Map<string, unknown>()
      for (const [key, value] of Object.entries(declared)) {
        const name = SERVER_NAME_PATTERN.test(key) ? key : slugifyServerName(key)
        if (name !== '') byName.set(name, value)
      }
      for (const entry of document.entries) {
        if (entry.config === undefined) continue
        const raw = byName.get(entry.name)
        entries.set(entry.name, buildEntrySnapshot(raw, entry.config.transport, credentialKeys(raw, resolveContext)))
      }
    }
    const scope = writeScopeFor(path, projectRoot, {
      projectDocuments: localConfigPaths(projectRoot, this.config.localFiles),
      globalDocuments: this.globalFiles(),
      allowGlobalWrite: this.config.allowGlobalWrite === true,
    })
    return { revision: documentRevision(document.text), entries, ...scope }
  }

  private readDocument(path: string, resolveContext: ResolveContext): CachedDocument | undefined {
    let stats
    try {
      stats = statSync(path)
    } catch {
      this.documents.delete(path)
      return undefined
    }
    const cached = this.documents.get(path)
    if (
      cached !== undefined &&
      cached.mtimeMs === stats.mtimeMs &&
      cached.size === stats.size &&
      cached.stamp === (resolveContext.stamp ?? '')
    ) {
      return cached
    }
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return undefined
    }
    const parsed = parseDocument(text, path, resolveContext)
    let raw: Record<string, unknown> | undefined
    try {
      raw = extractServerMap(JSON.parse(text) as unknown) ?? undefined
    } catch {
      // Invalid JSON: `parseDocument` already reported it per entry.
      raw = undefined
    }
    const document: CachedDocument = {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      text,
      stamp: resolveContext.stamp ?? '',
      raw,
      entries: parsed.entries,
      issues: parsed.issues,
    }
    this.documents.set(path, document)
    return document
  }

  private resolveContext(projectRoot: string): ResolveContext {
    const dotenv = this.readProjectEnv(projectRoot)
    const secrets = this.readSecrets()
    return {
      env: process.env,
      dotenv: dotenv.values,
      inputs: this.config.inputs,
      secrets: secrets.values,
      stamp: `${dotenv.stamp}\u0001${secrets.stamp}`,
      projectRoot,
      toolCallTimeoutMs: this.config.toolCallTimeoutMs,
      failOnStartupError: this.config.failOnStartupError,
    }
  }

  /**
   * The project's own dotenv values, plus the identity of the files they came
   * from. Documents are merged lowest priority first, so `<project>/.dsh/.env`
   * overrides the plain `<project>/.env`; each file is re-read only when its
   * mtime/size changes, and a file that is gone leaves both the map and the
   * stamp (so deleting `.env` un-resolves its references on the next pass).
   */
  private readProjectEnv(projectRoot: string): { values: Record<string, string>; stamp: string } {
    const values: Record<string, string> = {}
    if (this.config.envFiles === false) return { values, stamp: '' }
    const parts: string[] = []
    for (const path of projectEnvPaths(projectRoot)) {
      let stats
      try {
        stats = statSync(path)
      } catch {
        this.envFiles.delete(path)
        continue
      }
      const cached = this.envFiles.get(path)
      const entry =
        cached !== undefined && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size
          ? cached
          : { mtimeMs: stats.mtimeMs, size: stats.size, values: readEnvFile(path) }
      this.envFiles.set(path, entry)
      Object.assign(values, entry.values)
      parts.push(`${path}:${entry.mtimeMs}:${entry.size}`)
    }
    return { values, stamp: parts.join('|') }
  }

  /**
   * Credentials, re-read only when the document changes. Every pass of every
   * session resolves `${input:NAME}` references, so an uncached read here cost
   * one synchronous stat plus YAML parse per session per pass. The stamp is the
   * same identity the document cache compares.
   */
  private readSecrets(): { values: Record<string, string>; stamp: string } {
    const path = this.config.credentialsFile
    let stats
    try {
      stats = statSync(path)
    } catch {
      this.secrets = undefined
      return { values: {}, stamp: '' }
    }
    const stamp = `${stats.mtimeMs}:${stats.size}`
    const cached = this.secrets
    if (cached !== undefined && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return { values: cached.values, stamp }
    }
    const values = readSecrets(path)
    this.secrets = { mtimeMs: stats.mtimeMs, size: stats.size, values }
    return { values, stamp }
  }

  private profileServerNames(): Set<string> {
    const names = new Set<string>()
    let entries: LoaderEntryLike[] = []
    try {
      const loader = (this.ctx as unknown as { get(name: string): unknown }).get('loader') as
        | LoaderLike
        | undefined
      entries = loader?.entries?.() ?? []
    } catch {
      return names
    }
    for (const entry of entries) {
      const options = entry.options ?? {}
      if (options.disabled === true) continue
      if (!MCP_CLIENT_ENTRY_NAMES.has(String(options.name))) continue
      const name = options.config?.serverName
      if (typeof name !== 'string') continue
      if (entry.fiber?.state === FIBER_ACTIVE) names.add(name)
    }
    return names
  }

  /**
   * The other loaded plugin that owns the assembled tool list, if the profile
   * has one.
   *
   * Read from the same `loader.entries()` this plugin already consults for the
   * reserved `serverName`s, for the same reason: the profile is where a second
   * owner is mounted, and a running entry is the only kind that shapes a
   * request. An entry named like a known presentation plugin but not active is
   * mounted-and-stopped, which shapes nothing, so it is reported no more than an
   * absent one is.
   *
   * @returns the owner, or `undefined` when this plugin assembles alone.
   */
  private presentationOwner(): PresentationOwner | undefined {
    let entries: LoaderEntryLike[] = []
    try {
      const loader = (this.ctx as unknown as { get(name: string): unknown }).get('loader') as
        | LoaderLike
        | undefined
      entries = loader?.entries?.() ?? []
    } catch {
      return undefined
    }
    for (const entry of entries) {
      const options = entry.options ?? {}
      if (options.disabled === true) continue
      if (!PRESENTATION_OWNER_ENTRY_NAMES.has(String(options.name))) continue
      if (entry.fiber?.state !== FIBER_ACTIVE) continue
      // The module specifier is what the profile wrote down, so it is the most
      // useful label; the entry id disambiguates two mounts of one module and
      // stands in when a hand-written profile names the plugin by path.
      const name =
        typeof options.name === 'string' && options.name !== ''
          ? options.name
          : typeof options.id === 'string'
            ? options.id
            : ''
      return { name, note: PRESENTATION_OWNER_NOTE, noteCode: 'present.ownerNote' }
    }
    return undefined
  }

  /**
   * Keep one watcher set per project with live agents. Only the project's own
   * document directories are watched recursively: an unrelated file storm
   * (install caches, build output, git metadata) never reaches this plugin, so
   * it costs no events and no passes. A flat watch on the project root notices
   * a config directory appearing or disappearing, and the rescan timer is the
   * safety net for anything else.
   */
  private syncWatchers(): void {
    const roots = new Set<string>()
    for (const state of this.states.values()) {
      if (state.projectRoot !== undefined) roots.add(state.projectRoot)
    }
    for (const [root, watchers] of [...this.watchers]) {
      if (roots.has(root)) continue
      this.closeWatchers(root, watchers)
    }
    if (!this.config.watch) return
    for (const root of roots) {
      const existing = this.watchers.get(root)
      if (existing !== undefined) {
        const desired = this.watchTargets(root)
        if (sameTargets(this.watchedDirs.get(root) ?? [], desired)) continue
        this.closeWatchers(root, existing)
      }
      const targets = this.watchTargets(root)
      const watchers = this.watchProject(root, targets)
      if (watchers.length === 0) continue
      this.watchers.set(root, watchers)
      this.watchedDirs.set(root, targets)
      this.watchedRoots.add(root)
    }
  }

  private closeWatchers(root: string, watchers: FSWatcher[]): void {
    for (const watcher of watchers) watcher.close()
    this.watchers.delete(root)
    this.watchedDirs.delete(root)
    this.watchedRoots.delete(root)
  }

  /** Directories (and document files) worth watching for one root. */
  private watchTargets(root: string): WatchTarget[] {
    const targets: WatchTarget[] = []
    for (const directory of configDirectories(root, this.config.localFiles)) {
      if (directory !== root) targets.push({ path: directory, directory: true })
    }
    // A global document is watched as a file: watching its whole home directory
    // would put the watcher on every unrelated write under `$HOME`.
    for (const file of this.globalFiles()) targets.push({ path: file, directory: false })
    return targets
  }

  private watchProject(root: string, targets: readonly WatchTarget[]): FSWatcher[] {
    const onChange = (): void => this.schedule('watch')
    const watchers: FSWatcher[] = []
    const add = (path: string, recursive: boolean): void => {
      try {
        const watcher = watch(path, { recursive, persistent: false }, onChange)
        watcher.on('error', () => undefined)
        watchers.push(watcher)
      } catch {
        // The target can disappear between the existence check and the watch.
      }
    }
    // Flat: catches a config directory appearing or disappearing.
    add(root, false)
    for (const target of targets) {
      if (!target.directory) {
        add(target.path, false)
        continue
      }
      if (this.recursiveWatch !== false) {
        try {
          const watcher = watch(target.path, { recursive: true, persistent: false }, onChange)
          watcher.on('error', () => undefined)
          watchers.push(watcher)
          this.recursiveWatch = true
          continue
        } catch (error) {
          this.recursiveWatch = false
          this.ctx.logger.debug?.(
            `project-mcp: recursive watch unavailable for ${target.path} (${errorText(error)}); using flat watches`,
          )
        }
      }
      add(target.path, false)
    }
    return watchers
  }
}

/**
 * The real `serverName` conflicts of one reconciled pass, in a stable order.
 *
 * Two declarations fight over a name and only one of them mounts, so a panel
 * that shows the surviving row alone would hide the loss:
 *
 * - `profile` — a profile-level `mcp-client` instance already owns the name. The
 *   project's entry does not mount under it while the profile's copy is the one
 *   shown (the default); it mounts under a name this project chose otherwise —
 *   the local alias, or the contested name itself, where it is the nearer
 *   declaration and shadows the profile instance's tools in this project's
 *   sessions. It is a conflict only where the profile is allowed to win
 *   ({@link RuntimeConfig.profileWins}); the row carries `status: 'conflict'`
 *   for exactly the names this project does not mount.
 * - `duplicate` — two documents of one project declare the same name and
 *   {@link mergeEntries} keeps the highest-priority declaration, so the other
 *   one is silently ignored.
 *
 * Only names defined for this project are reported: a source recorded for a name
 * the merge dropped (a document that reappeared between passes) is a document
 * detail, not a conflict this row set can explain.
 *
 * @param entries - merged entries, one per resolved name.
 * @param sources - declaring documents per name, lowest priority first.
 * @param reserved - profile-reserved names that shadow the project's entry.
 * @param aliases - the local name each shadowed declaration would take, when
 * this project has one to give ({@link resolveConflictNames}); a project with
 * none can still answer `native`, which needs no prefix.
 * @param policy - the project's policy: what the user already chose about each
 * contested name.
 * @returns one report per name, sorted by name; empty when nothing conflicts.
 */
function conflictsFor(
  entries: readonly ParsedEntry[],
  sources: ReadonlyMap<string, string[]>,
  reserved: ReadonlySet<string>,
  aliases: ReadonlyMap<string, string>,
  policy: ToolPolicy,
): ServerConflict[] {
  const conflicts: ServerConflict[] = []
  for (const entry of entries) {
    const name = entry.name
    // The winner is listed first in both kinds: the profile instance that owns
    // the name, or the document the merge kept, which is the last one to
    // declare it.
    const declared = [...(sources.get(name) ?? [])]
    const winner = declared[declared.length - 1] ?? entry.source
    const others = declared.slice(0, -1).reverse()
    if (reserved.has(name)) {
      const alias = aliases.get(name)
      const choice = aliasesOf(policy)[name] ?? 'profile'
      // The choice is published even where this project has no alias to offer:
      // `native` needs no prefix, so an alias-less project still has two answers
      // and a panel that hid the choice would offer it none.
      conflicts.push({
        server: name,
        kind: 'profile',
        sources: [winner, ...others],
        ...(alias === undefined ? {} : { alias }),
        choice,
        // The prose is byte-identical to what the site always emitted; the
        // code and its flat params ride beside it for the client to translate
        // (F-48).
        ...(alias === undefined
          ? { code: 'conflict.profile', params: { name } }
          : { code: 'conflict.profileAlias', params: { name, alias } }),
        message:
          alias === undefined
            ? `"${name}" is owned by a profile-level mcp-client instance, so the project entry does not mount under it; remove the profile entry to use the project one everywhere, or let this project's copy take the name in this project's sessions alone.`
            : `"${name}" is owned by a profile-level mcp-client instance; this project's copy mounts as "${alias}" when chosen beside it, or under the contested name when chosen to shadow it in this project's sessions, and does not mount at all while the profile's copy is the one shown.`,
      })
      continue
    }
    if (others.length === 0) continue
    conflicts.push({
      server: name,
      kind: 'duplicate',
      sources: [winner, ...others],
      code: 'conflict.documents',
      // Numbers stringify at emission: params are flat strings end to end.
      params: { name, count: String(declared.length), winner },
      message: `"${name}" is declared in ${declared.length} documents; ${winner} wins and the other declaration is not mounted.`,
    })
  }
  // Code-unit order, the same rule the rest of the plugin sorts tool names by.
  return conflicts.sort((left, right) =>
    left.server < right.server ? -1 : left.server > right.server ? 1 : 0,
  )
}

function baseRow(entry: ParsedEntry, projectRoot: string, document: DocumentInfo | undefined): ServerRow {
  const snapshot = document?.entries.get(entry.name)
  return {
    name: entry.name,
    status: 'error',
    projectRoot,
    source: entry.source,
    ...(entry.config === undefined ? {} : { transport: entry.config.transport }),
    ...(document === undefined
      ? {}
      : {
          ...(snapshot === undefined ? {} : { entry: snapshot }),
          writeScope: document.scope,
          ...(document.reason === undefined ? {} : { writeBlockedReason: document.reason }),
          // The wire companions ride beside the prose: the client translates
          // the code and falls back to the byte-identical reason.
          ...(document.blockedCode === undefined ? {} : { blockedCode: document.blockedCode }),
          ...(document.blockedParams === undefined ? {} : { blockedParams: document.blockedParams }),
          documentRevision: document.revision,
        }),
  }
}

/** `env`/`headers` keys of one declared entry whose value comes from credentials. */
function credentialKeys(declared: unknown, resolveContext: ResolveContext): CredentialKeys {
  const record = isRecord(declared) ? declared : {}
  return { env: credentialKeySet(record.env, resolveContext), headers: credentialKeySet(record.headers, resolveContext) }
}

function credentialKeySet(section: unknown, resolveContext: ResolveContext): ReadonlySet<string> {
  const keys = new Set<string>()
  if (!isRecord(section)) return keys
  for (const [key, value] of Object.entries(section)) {
    if (typeof value === 'string' && referencesCredentials(value, resolveContext)) keys.add(key)
  }
  return keys
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Row of a declared server that is not mounted, with the reason in `detail`. */
function idleRow(row: ServerRow, reason: CodedText): ServerRow {
  // Strip a previous detail's companions too, or a recycled error row would
  // keep a stale code under the new prose.
  const { detail: _stale, detailCode: _staleCode, detailParams: _staleParams, ...rest } = row
  return {
    ...rest,
    status: 'idle',
    detail: reason.text,
    detailCode: reason.code,
    ...(reason.params === undefined ? {} : { detailParams: reason.params }),
  }
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * Duration as an operator reads it: milliseconds under a second, seconds under
 * a minute, then minutes and seconds. A watchdog that fires at 40 ms must not
 * print `0.0s`, and a mount that has been waiting for four and a half minutes
 * should not print `266.7s`.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms - minutes * 60_000) / 1000)
  return seconds === 60 ? `${minutes + 1}m` : `${minutes}m ${seconds}s`
}

/** Unref'd timer, so a bounded wait never keeps a process alive on its own. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * Endpoint label for an error message. Arguments and query strings are the two
 * places a declared entry can carry a secret (`--api-key=…`, `?token=…`), so
 * neither ever reaches a row, a log line or the snapshot.
 */
function describeEndpoint(config: NonNullable<ParsedEntry['config']>): string {
  if (config.transport === 'streamable-http') return `streamable-http ${visibleUrl(config.url)}`
  return `stdio ${config.command}`
}

/**
 * Detail of a mount whose activation failed, including the underlying error and
 * the exact declaration to look at.
 *
 * Multi-line on purpose: the row's detail is the only place an operator sees
 * why a server is not there, and a run-on sentence that starts with the error
 * and ends with the file path reads as prose instead of the three facts it is.
 */
function failureDetail(mount: MountedInstance, error: unknown): CodedText {
  const params = {
    name: mount.name,
    error: errorText(error),
    endpoint: mount.endpoint,
    // The `{source}` fallback stays English under zh/ru: params are flat strings,
    // so a translatable fragment would need the wire extension Ruling 4 names.
    // Accepted partial — F-48 ledger Ruling 5 (same class as parse.ref.failedInKey).
    source: mount.source ?? 'the project document',
  }
  return {
    code: 'mount.failedDetail',
    text: [
      `${params.name}: mount failed — ${params.error}`,
      `endpoint: ${params.endpoint}`,
      `declared in: ${params.source}`,
    ].join('\n'),
    params,
  }
}

/**
 * Detail of a mount that has produced no tool inside `connectTimeoutMs`. The
 * server is left running: a slow start (an `npx` cold fetch, a container pull)
 * is not an error, only a condition the operator needs to see.
 *
 * Facts only — the name and the wait, the endpoint, the declaring document. The
 * row already carries the status, the transport chip and a `Retry` button, and
 * a stdio server's own reason is on its stderr, in the DSH log; anything more
 * here is text an operator has to read past to find the three lines that matter.
 */
function stallDetail(mount: MountedInstance, elapsedMs: number): CodedText {
  const params = {
    name: mount.name,
    elapsed: formatDuration(elapsedMs),
    endpoint: mount.endpoint,
    // See failureDetail: the `{source}` fallback is an accepted English fragment
    // under zh/ru (F-48 ledger Ruling 5).
    source: mount.source ?? 'the project document',
  }
  return {
    code: 'mount.stalledDetail',
    text: [
      `${params.name}: no tool appeared in ${params.elapsed}`,
      `endpoint: ${params.endpoint}`,
      `declared in: ${params.source}`,
    ].join('\n'),
    params,
  }
}

/** Row + live mount state; the mount is authoritative for `status` and `detail`. */
function decorate(row: ServerRow, mount: MountedInstance | undefined): ServerRow {
  if (mount === undefined) return row
  // Drop any detail a previous pass wrote, so a mount that recovered stops
  // reporting a stale stall — companions included, or a recycled row would
  // keep a code under prose it does not belong to.
  const { detail: _stale, detailCode: _staleCode, detailParams: _staleParams, ...rest } = row
  return {
    ...rest,
    status: mount.status,
    ...(mount.detail === undefined ? {} : { detail: mount.detail }),
    ...(mount.detailCode === undefined ? {} : { detailCode: mount.detailCode }),
    ...(mount.detailParams === undefined ? {} : { detailParams: mount.detailParams }),
    ...(mount.transport === undefined ? {} : { transport: mount.transport }),
  }
}

/**
 * Which of two rows describing the same server a project-level merge keeps. The
 * most actionable state wins, so a session that mounted the server — or failed
 * to — is never hidden behind a session that has not started a turn yet.
 */
const STATUS_PRIORITY: Record<ServerStatus, number> = {
  error: 5,
  active: 4,
  connecting: 3,
  conflict: 2,
  idle: 1,
  disabled: 0,
}

/**
 * Merge one session's rows into a project's merged list. The first session to
 * declare a server fixes its position (document order); the status with the
 * highest {@link STATUS_PRIORITY} seen so far supplies the row itself.
 */
function mergeRows(target: ServerRow[], rows: readonly ServerRow[]): void {
  for (const row of rows) {
    const index = target.findIndex((existing) => existing.name === row.name)
    if (index === -1) {
      target.push(row)
      continue
    }
    const current = target[index]
    if (current !== undefined && STATUS_PRIORITY[row.status] > STATUS_PRIORITY[current.status]) {
      target[index] = row
    }
  }
}

/**
 * Identity of one reconciliation input set: the declarations, the profile
 * reservations, and the published state of the project's shared mounts. Equal
 * digests mean this session has nothing to reconcile.
 *
 * The shared mounts belong in it because a project's servers are one instance
 * for all of its sessions: another session's pass can mount, settle, stall or
 * drop one of them without touching any document, and this session's rows are a
 * rendering of exactly that instance.
 * @param entries - parsed declarations of the session's project.
 * @param reserved - `serverName`s a profile-level instance already owns.
 * @param mounts - the session's current shared mounts, live.
 * @param chosen - shadowed names this pass mounts, and under which name: a local
 * alias, or `undefined` for the contested name itself.
 * @returns a stable identity string.
 */
function digestOf(
  entries: ParsedEntry[],
  reserved: ReadonlySet<string>,
  mounts: ReadonlyMap<string, MountedInstance>,
  chosen: ReadonlyMap<string, string | undefined>,
): string {
  const parts = entries.map(
    (entry) =>
      `${entry.name}\u0000${entry.enabled ? '1' : '0'}\u0000${entry.error ?? ''}\u0000${
        entry.config === undefined ? '' : fingerprint(entry.config)
      }`,
  )
  parts.push(`reserved:${[...reserved].sort().join(',')}`)
  // The local names this pass chose. They belong in the identity because a
  // choice the user just made moves a declaration between "conflict report" and
  // "mount", with no document and no mount touched yet — without them, the pass
  // that follows the click would find its inputs unchanged and do nothing.
  for (const [name, mountedAs] of [...chosen].sort(([left], [right]) => (left < right ? -1 : 1))) {
    // `native` is its own part rather than a `local` with an empty name: a choice
    // that mounts under the declared name has to move this identity exactly as a
    // choice that mounts under a local one does, or the pass after the click finds
    // its inputs unchanged and mounts nothing.
    parts.push(mountedAs === undefined ? `native:${name}` : `local:${name}\u0000${mountedAs}`)
  }
  for (const [name, mount] of mounts) {
    parts.push(
      `mount:${name}\u0000${mount.status}\u0000${mount.detail ?? ''}\u0000${mount.stalled ? '1' : '0'}\u0000${mount.runtimeName}`,
    )
  }
  return parts.join('\u0001')
}

function fingerprint(config: unknown): string {
  return JSON.stringify(config)
}

/**
 * The name one declaration registers under this pass: its local alias, or the
 * name it declared.
 *
 * @param entry - parsed declaration.
 * @param alias - local name the pass chose, when it chose one.
 * @returns the `serverName` to hand `@deepseek-ai/dsh-mcp-client`.
 */
function runtimeNameOf(entry: ParsedEntry, alias: string | undefined): string {
  return alias ?? entry.name
}

/**
 * One declaration's config as it is mounted: the same body, under the name this
 * registration actually takes.
 *
 * A fresh object on purpose — the parsed entry is shared with every other
 * session and with the editor, and rewriting its `serverName` in place would
 * make the alias look like the declared name everywhere else.
 *
 * @param config - the parsed mcp-client config.
 * @param runtimeName - the `serverName` to reserve.
 * @returns the config to mount.
 */
function runtimeConfigOf(
  config: NonNullable<ParsedEntry['config']>,
  runtimeName: string,
): NonNullable<ParsedEntry['config']> {
  if (config.serverName === runtimeName) return config
  return { ...config, serverName: runtimeName }
}

/**
 * The one line a shadowed declaration carries.
 *
 * Two readings, and the row has to say which one it is: the profile's copy is the
 * one shown and this project's entry is a conflict, or the entry has a local name
 * to be mounted under and the choice is the question. A mounted row carries no
 * detail at all ({@link decorate}), so a chosen answer is explained by the
 * conflict report, which a mounted name still publishes.
 *
 * @param name - the contested `serverName`.
 * @param alias - the local name this project could give it, when it has one.
 * @returns the row's detail line, with its wire code and params (F-48).
 */
function conflictDetail(name: string, alias: string | undefined): CodedText {
  const base = `serverName "${name}" is already provided by a profile-level mcp-client instance`
  return alias === undefined
    ? {
        text: `${base} — remove that entry from the profile to use the project one everywhere, or choose this project's copy to let it take the name in this project's sessions`,
        code: 'conflict.profileDetail',
        params: { name },
      }
    : {
        text: `${base} — choose this project's copy to mount it as "${alias}", or under the contested name to shadow the profile instance here`,
        code: 'conflict.profileAliasDetail',
        params: { name, alias },
      }
}

async function activation(fiber: MountFiber): Promise<void> {
  if (typeof fiber.await === 'function') {
    await fiber.await()
    return
  }
  await Promise.resolve(fiber as unknown)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The fields one tool definition accepts, read from its top-level
 * `parameters.properties` in schema order.
 *
 * A declared object or array is drawn as its own `type` and never expanded:
 * the record answers "what does this tool take", and a nested graph is what the
 * model-facing schema already carries. A property published without a `type` —
 * the JSON Schema case of `oneOf` or `$ref` — reads as `any`, the same word the
 * row vocabulary uses for "the schema names none". A property's `default` is
 * deliberately not part of the record: it is the host's own default for a call,
 * never a value the tool publishes.
 *
 * @param parameters - the definition's JSON Schema object arguments.
 * @returns one field per declared property; empty when the schema declares none.
 */
function toolFieldsOf(parameters: Record<string, unknown>): ToolField[] {
  const properties = parameters.properties
  if (!isRecord(properties)) return []
  const required = new Set(stringArray(parameters.required))
  return Object.entries(properties).map(([name, declared]) => {
    const field = isRecord(declared) ? declared : {}
    const type = field.type
    const description = field.description
    return {
      name,
      type: typeof type === 'string' && type !== '' ? type : 'any',
      required: required.has(name),
      ...(typeof description === 'string' && description !== '' ? { description } : {}),
    }
  })
}

/** The strings of one array value; empty for anything that is not one. */
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/**
 * One path the watcher stack covers and what kind it is.
 *
 * The kind comes from the config, not from the name: a document is watched as a
 * file — watching its whole directory would put the watcher on unrelated writes
 * — while a directory that holds a project document is watched (recursively when
 * the platform allows) so a document appearing there is seen.
 */
interface WatchTarget {
  /** Absolute path. */
  readonly path: string
  /** `true` for a directory, `false` for a document file. */
  readonly directory: boolean
}

/** Same targets, in the same order — what decides a watcher rebuild. */
function sameTargets(left: readonly WatchTarget[], right: readonly WatchTarget[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value.path === right[index]?.path && value.directory === right[index]?.directory)
  )
}
