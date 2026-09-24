/**
 * Shared row/snapshot vocabulary for `dsh-project-mcp`.
 *
 * The host half publishes a {@link ProjectSnapshot} through the `projectMcp`
 * service so a future Web UI (or a test) can read what is mounted without
 * importing the runtime.
 *
 * @module dsh-project-mcp/types
 */

/**
 * Type-only, and imported for its effect on the ambient types rather than for
 * anything this module uses: `@deepseek-ai/dsh-tools` declares `Context.tools`
 * and the `tools/change` / `tools/result` events as module augmentation of
 * `@deepseek-ai/cordis`, and TypeScript applies an augmentation only when the
 * augmenting module is part of the compilation. Nothing of the package reaches
 * the runtime — the import is erased by the compiler, and the plugin still
 * takes the service off the context it is handed instead of importing the
 * module.
 */
import type {} from '@deepseek-ai/dsh-tools'

/** Runtime state of one project-declared MCP server. */
export type ServerStatus =
  /** Mounted and its tools are visible in the owning scope. */
  | 'active'
  /** Mounted; activation or the initial connection has not settled yet. */
  | 'connecting'
  /**
   * Declared, parsed, and not mounted: either `lazy` has not seen this
   * session's first turn yet, or the session went idle and its mounts were
   * released (`idleTimeoutMs`). The next turn mounts it again.
   */
  | 'idle'
  /** Declared with `enabled: false` — never mounted. */
  | 'disabled'
  /** The same `serverName` is reserved by a live profile-level instance. */
  | 'conflict'
  /** The entry or its mount failed; `detail` carries the reason. */
  | 'error'

/** One server row of a project snapshot. */
export interface ServerRow {
  /** `serverName` (the `mcpServers` key, sanitized). */
  name: string
  /** Current lifecycle state. */
  status: ServerStatus
  /** Project root the entry was read from. */
  projectRoot: string
  /** Absolute path of the declaring document. */
  source?: string
  /** `stdio` or `streamable-http`, when the entry parsed. */
  transport?: 'stdio' | 'streamable-http'
  /**
   * Failure, stall or conflict explanation. Redacted on purpose: it names the
   * command but never its arguments, and an HTTP endpoint keeps its path but
   * drops the query string, because both can carry credentials.
   */
  detail?: string
  /**
   * Stable wire code of `detail` (`projectMcp.host` namespace), for
   * client-side translation. Optional and additive, exactly like
   * {@link blockedCode}: the prose field keeps its byte-identical English and
   * stays the fallback, so a client and a host of different builds degrade
   * rather than break.
   */
  detailCode?: string
  /**
   * Flat params of {@link detailCode}; a name ending in `Code` is itself a
   * wire code the client resolves two-level.
   */
  detailParams?: Record<string, string>
  /**
   * Parsed body of the entry, for the editor. Absent when the entry did not
   * parse — there is nothing to edit then.
   */
  entry?: EntrySnapshot
  /** Where this row may be written back, when it may be written at all. */
  writeScope?: WriteScope
  /** One line saying why writing is unavailable; always set for `readonly`. */
  writeBlockedReason?: string
  /**
   * Stable wire code of `writeBlockedReason` (`projectMcp.host` namespace),
   * for client-side translation. Optional and additive: the prose field keeps
   * its byte-identical English and stays the fallback, so a client and a host
   * of different builds degrade rather than break.
   */
  blockedCode?: string
  /**
   * Flat params of {@link blockedCode}; a name ending in `Code` is itself a
   * wire code the client resolves two-level.
   */
  blockedParams?: Record<string, string>
  /**
   * Opaque content revision of the declaring document at snapshot time. A save
   * must carry the revision it was built from: a mismatch means the document
   * changed underneath the editor, and the write is refused rather than merged.
   */
  documentRevision?: string
}

/**
 * How one `env` or `headers` entry is known to the host.
 *
 * A value can come from the declaring document, be answered outside it (the
 * project's own `.env` or the credentials file), or be withheld because it is a
 * credential. {@link EntryField.masked} is the field
 * that changes how a write treats it: a masked key submitted without a `value` is
 * kept exactly as the document declares it, so an editor that cannot see a secret
 * can never erase or replace one.
 */
export interface EntryField {
  /** Key exactly as declared. */
  readonly key: string
  /** Literal value; absent when the host withholds it. */
  readonly value?: string
  /** `true` when `value` is absent because the value is a secret. */
  readonly masked?: true
  /**
   * `true` when the key is answered outside the document — by the project's
   * `.env` or by the credentials file. The name predates the project dotenv
   * sources; the meaning the write path reads is "never write this value back".
   */
  readonly fromCredentials?: true
}

/**
 * One server entry as the host parsed it, for an editor.
 *
 * Every field is what the declaring document holds — a resolved default is never
 * folded in, because a save replaces the declaration, not the runtime config.
 */
export interface EntrySnapshot {
  /** Transport the entry declares. */
  readonly transport: 'stdio' | 'streamable-http'
  /** `stdio`: the program to run. */
  readonly command?: string
  /** `stdio`: its arguments, verbatim. */
  readonly args?: readonly string[]
  /** `stdio`: working directory, when the entry declares one. */
  readonly cwd?: string
  /** `stdio`: declared environment, secrets masked. */
  readonly env?: readonly EntryField[]
  /** `streamable-http`: the endpoint, with a credential-bearing query dropped. */
  readonly url?: string
  /** `streamable-http`: declared headers, secrets masked. */
  readonly headers?: readonly EntryField[]
  /** `false` when the declaration disables the server; absent means enabled. */
  readonly enabled?: boolean
  /** Declared connect timeout in milliseconds, when the entry sets one. */
  readonly connectTimeoutMs?: number
  /**
   * Keys the editor does not present, kept in their declared order and written
   * back untouched. A save replaces the entry wholesale, so dropping them would
   * delete configuration the panel never showed.
   */
  readonly extra?: Readonly<Record<string, unknown>>
}

/**
 * Whether one row's declaring document may be rewritten.
 *
 * - `project` — one of the deployment's project documents (`localFiles`,
 *   `<project>/.dsh/mcp.json` out of the box);
 * - `global` — one of its global documents (`globalFiles`), written only with an
 *   explicit per-write consent;
 * - `readonly` — the profile, `<DSH_HOME>` or a bundled document: never written.
 */
export type WriteScope = 'project' | 'global' | 'readonly'

/**
 * One document a project is configured to read.
 *
 * The list a project publishes is exactly its read order — global documents
 * first, then the project's own — so the panel's priority number is an index
 * into it and never a table of hardcoded file names.
 */
export interface ConfiguredFile {
  /** Absolute path of the document. */
  readonly path: string
  /**
   * `global` — read for every project, before its own documents; `project` —
   * read from the project root.
   */
  readonly scope: 'global' | 'project'
}

/** Diagnostics surfaced alongside the rows. */
export interface SnapshotIssue {
  /** Absolute path of the declaring document. */
  source: string
  /** Server the diagnostic belongs to, when entry-scoped. */
  server?: string
  /** `error` or `warning`. */
  level: 'error' | 'warning'
  /** Human-readable text. */
  message: string
  /**
   * Stable wire code of `message` (`projectMcp.host` namespace), for
   * client-side translation. Optional and additive: `message` keeps its
   * byte-identical English and stays the fallback. Behavioural matches key on
   * this field — never on the prose, which the client may have translated.
   */
  code?: string
  /**
   * Flat params of {@link SnapshotIssue.code}; a name ending in `Code` is
   * itself a wire code the client resolves two-level.
   */
  params?: Record<string, string>
}

/**
 * One session's own view of the project it works in.
 *
 * Sessions of one project are independent: each mounts its own servers, and one
 * may have them running while another has not started a turn yet. The panel
 * needs that split, because a project-level merge alone cannot say *which*
 * session holds a mount.
 */
export interface SessionSnapshot {
  /** Agent (session) id. */
  id: string
  /** Rows for this session alone, in document order. */
  rows: ServerRow[]
  /** Diagnostics this session surfaced. */
  issues: SnapshotIssue[]
  /** What this session offers the model, when the host has mounted for it. */
  tools?: SessionTools
  /**
   * How many events of the project's ring belong to this session. Absent for a
   * session that produced none, so the tab's log badge reads a real `0`.
   */
  logCount?: number
  /**
   * `serverName` conflicts this session last reconciled: a profile-level
   * instance that already owns a name, or one name two project documents
   * declare. Published even when empty, so a reader can tell "this session
   * reported none" from a host that does not report conflicts at all.
   */
  conflicts?: readonly ServerConflict[]
}

/** One tool a session offers the model, and what put it in the request. */
export interface OfferedTool {
  /** Public registry name, eg `mcp__tglider__workspace`. */
  readonly name: string
  /**
   * The tier that offered it: `session` activated on demand through the search
   * tool, `context` ranked from the task text of the current conversation. The
   * counter-seeded baseline is not this shape — it is a plain name list in
   * {@link SessionTools.baseline}.
   */
  readonly via: 'session' | 'context'
  /**
   * Epoch milliseconds of the last offer or call. Absent for the context tier,
   * whose live state stamps an advance rather than a clock reading.
   */
  readonly at?: number
  /**
   * Number of the agent step (from `1`) the tool was offered at, or `undefined`
   * for a host that does not count steps. A panel that reads no number draws no
   * step tag at all rather than a made-up one.
   */
  readonly step?: number
}

/**
 * Another loaded plugin that owns the assembled tool list.
 *
 * The plugin and such an owner cannot shape one request together: the outer
 * listener of whoever assembles last rewrites `assembly.tools`, so the plugin's
 * own deferral would be re-applied over an already-trimmed list. The host
 * reports the owner instead of silently composing with it, and a panel prints
 * the coexistence note only when this record is published.
 */
export interface PresentationOwner {
  /** Loader entry name, for example `dsh-progressive-tools`. */
  readonly name: string
  /** One line saying why coexisting in one request is impossible. */
  readonly note: string
  /**
   * The `projectMcp.host` code of {@link note} (F-48): the client translates
   * by it and falls back to `note`'s English, byte-identical, when the code is
   * absent or unknown. No params — the note is one fixed sentence.
   */
  readonly noteCode?: string
}

/**
 * One `serverName` two declarations fight over.
 *
 * `profile` is the profile-level `mcp-client` instance that already owns the
 * name: the project entry mounts only through the local alias the user chose,
 * and never under the contested name itself. `duplicate` is one name declared by
 * more than one project document: the highest-priority document wins and the
 * others are ignored.
 */
export interface ServerConflict {
  /** `serverName` the declarations share. */
  readonly server: string
  /** `profile` — a profile-level instance owns the name; `duplicate` — two documents. */
  readonly kind: 'profile' | 'duplicate'
  /** Declaring documents, the winner first. */
  readonly sources: readonly string[]
  /** One line: who wins, and why. */
  readonly message: string
  /**
   * The `projectMcp.host` code of {@link message} (F-48): the client translates
   * by it and falls back to `message`'s English, byte-identical, when the code
   * is absent (a host older than the field) or unknown to its dictionaries.
   */
  readonly code?: string
  /**
   * Flat params of {@link code}; numbers stringify at emission. A name ending
   * in `Code` is itself a wire code, resolved two-level through the same
   * namespace and substituted under the plain name.
   */
  readonly params?: Record<string, string>
  /**
   * The local name this project's entry mounts under when the user chose
   * `local`, as `mcp__<alias>__<tool>` in the model's own list. Published on a
   * `profile` conflict even while the choice is still the profile's, so the
   * panel can offer the alias it would use rather than inventing one.
   */
  readonly alias?: string
  /**
   * What the project's policy says about this name. Absent on a `duplicate`,
   * which no choice resolves, and on a host older than this field.
   */
  readonly choice?: ConflictChoice
}

/**
 * What one live session currently offers the model.
 *
 * Measured from the session's own state, not from the project: two sessions of
 * one project differ as soon as one of them has called a tool, and the panel's
 * promise is to show what *this* session's model sees.
 */
export interface SessionTools {
  /** Live agent (session) id this row describes. */
  readonly sessionId: string
  /**
   * Names offered because the durable counters proved them hot, plus the pins;
   * empty in `off`, which offers none of the project's tools.
   */
  readonly baseline: readonly string[]
  /** Names this session activated on demand, oldest first; empty in `off`. */
  readonly activated: readonly OfferedTool[]
  /** Names the task context offered, oldest first; empty in `off`. */
  readonly context: readonly OfferedTool[]
  /**
   * Names mounted for the project but not offered by this plugin, sorted. In
   * `disclosure` these are the names the budget pushed out of the request; in
   * `direct` the list is empty, because nothing is filtered; in `off` it is the
   * whole mounted surface, because a project that is switched off is offered not
   * at all. Its length is exactly the count a panel shows as hidden — and such a
   * panel has to read {@link ToolPolicy.mode} first, since tools another
   * presentation plugin leaves in the request are not this one's offers.
   */
  readonly deferred: readonly string[]
  /** Tools mounted for the project in total. */
  readonly mounted: number
  /** Serialized size of the mounted surface, in characters. */
  readonly surfaceChars: number
  /**
   * Serialized size of the offered set — {@link SessionTools.baseline} plus the
   * `activated` and `context` names — in characters. Absent from a host that
   * does not split the surface, and then a panel prints no request estimate
   * rather than inventing one.
   */
  readonly visibleChars?: number
  /**
   * Serialized size of {@link SessionTools.deferred}, in characters: exactly the
   * part of the mounted surface this plugin leaves out of the request. `0` when
   * nothing is deferred, so a panel that found this field may divide it by four
   * for a token estimate.
   */
  readonly deferredChars?: number
  /**
   * Configured deferral budget in characters. `0` means there is no threshold at
   * all: every surface counts as over budget, so tools are deferred however small
   * the project is. Read {@link SessionTools.deferring} rather than comparing this
   * with {@link SessionTools.surfaceChars} — the host owns the rule.
   */
  readonly budgetChars: number
  /**
   * `true` while the surface is over the budget, so tools really are deferred.
   * Only `disclosure` can defer: `direct` filters nothing and `off` offers
   * nothing, so both report `false` however large the mounted surface is.
   */
  readonly deferring: boolean
}

/** How one project's MCP tools are offered to the model. */
export type ToolMode =
  /** Offer the baseline and the on-demand tiers (the shipped behaviour). */
  | 'disclosure'
  /** Never defer: every mounted tool is listed in every request. */
  | 'direct'
  /** Do not offer this project's MCP tools at all. */
  | 'off'

/**
 * How one `serverName` a project shares with a live profile instance is shown.
 *
 * The profile's instance owns the name in every scope, so the two declarations
 * cannot both mount under it. `profile` keeps the profile's tools exactly as
 * they are and leaves the project's entry unmounted; `local` mounts the
 * project's entry under a local namespace (see `src/naming.ts`) so both toolsets
 * reach the model — the only difference being the names they carry; `native`
 * mounts the project's entry under the name it declares, which is the nearer
 * declaration in this project's own sessions and so shadows the profile's tools
 * of that name there, while every other project keeps seeing the profile's.
 */
export type ConflictChoice =
  /** The profile instance keeps the name; the project entry does not mount. */
  | 'profile'
  /** The project entry mounts under its local alias, next to the profile's. */
  | 'local'
  /** The project entry mounts under the declared name, shadowing the profile's in this project. */
  | 'native'

/**
 * One project's tool policy.
 *
 * The mode decides whether tools are deferred, the pins are the names the user
 * insists on — a pinned tool is offered from the first step of every request, is
 * never dropped by idle pruning or by a compaction, and is not counted against
 * the deferral budget's reading of what is hidden — and the aliases remember, per
 * conflicting `serverName`, which of the two declarations the user chose to see.
 */
export interface ToolPolicy {
  /** Mode in force. */
  readonly mode: ToolMode
  /**
   * Public registry names pinned for this project, in the order the user pinned
   * them. A name the project no longer mounts is kept: the declaration may come
   * back, and a pin that silently disappeared would be a surprise.
   */
  readonly pins: readonly string[]
  /**
   * Choice per contested `serverName`. Optional so every fixture, host and
   * stored document written before this field existed keeps meaning exactly
   * what it meant: a name that is absent is one the user never chose about,
   * and the shipped answer is the profile's instance. The store publishes an
   * empty map rather than dropping the field, so a reader may treat `undefined`
   * and `{}` alike.
   */
  readonly aliases?: Readonly<Record<string, ConflictChoice>>
}

/** The policy every project follows until one is configured. */
export const DEFAULT_TOOL_POLICY: ToolPolicy = { mode: 'disclosure', pins: [], aliases: {} }

/**
 * How much one MCP server of one project has been used.
 *
 * Counted on the host from the tool registry's own events, so it is exact rather
 * than sampled, and keyed by project root: sessions come and go, the numbers
 * stay, which is what makes them usable for later decisions about a project.
 */
export interface ServerUsage {
  /** Calls dispatched through the registry, successful or not. */
  calls: number
  /** Calls whose result carried an error. */
  errors: number
  /** ISO timestamp of the most recent call. */
  lastUsedAt?: string
  /**
   * Per tool counts, keyed by the tool name as declared by the server, i.e.
   * without the `mcp__<serverName>__` prefix the registry publishes it under.
   */
  tools: Record<string, number>
  /**
   * The same readings split by session, keyed by the session (agent) id the
   * panel already uses everywhere else.
   *
   * Additive since F-34: a document written before this field existed is read as
   * it is — `USAGE_VERSION` does not move, because a reader that meets an unknown
   * version refuses the whole document and every counter would start from zero.
   * Absent means "counted before the split", never "no calls".
   */
  sessions?: Record<string, SessionUsage>
}

/**
 * One session's share of a server's counters.
 *
 * A server is mounted for a project and a project's sessions share it, so the
 * project total says what the project used while this says what *this* session
 * did; the two differ exactly when other sessions of the project called the
 * server, which is the case a panel scoped to one session could not show.
 */
export interface SessionUsage {
  /** Calls this session dispatched through the registry. */
  calls: number
  /** Of those, the ones whose result carried an error. */
  errors: number
  /** ISO timestamp of this session's most recent call. */
  lastUsedAt?: string
  /** This session's counts, keyed by the tool name as the server declares it. */
  tools: Record<string, number>
}

/**
 * How serious one plugin event is, as the Logs tab colours it.
 *
 * Four levels, mapped from the lifecycle line the host already writes: `info`
 * for a mount being registered, `up` for one whose tools became visible, `warn`
 * for a stall or a release, `error` for a failed mount and the unmount that
 * follows it. They are the labels the tab draws, not a host severity scale.
 */
export type LogLevel =
  /** The instance is being registered (`project-mcp: mounting …`). */
  | 'info'
  /** The instance's tools are visible (`… is up …`). */
  | 'up'
  /** A stall, a repeated pass, or a release the operator did not ask for. */
  | 'warn'
  /** The mount failed, or a failed mount is being torn down. */
  | 'error'

/**
 * One lifecycle event, as the Logs tab lists it.
 *
 * The plugin's own events only — a mount, a start, a stop, a failure — mirroring
 * the lines the host writes to the DSH log, so the two readers see the same
 * facts. Events live in a per-project ring (`src/logs.ts`); the newest ones ride
 * in the snapshot, the rest are paged over the route.
 */
export interface LogEvent {
  /** When the event happened, epoch ms. */
  readonly at: number
  /** How serious it is, as the tab colours it. */
  readonly level: LogLevel
  /** Project root the event belongs to; the ring is keyed by it. */
  readonly projectRoot: string
  /**
   * Session the event is attributed to. Set exactly when the lifecycle line it
   * mirrors names one — `mounting`, `is up`, a stall — and absent on a
   * project-level event such as a shared instance's unmount.
   */
  readonly sessionId?: string
  /** `serverName` the event is about; absent for an event with no server. */
  readonly server?: string
  /** One line, without a newline: one event is one row of the tab. */
  readonly message: string
  /**
   * The three facts an error carries — the failure, the endpoint, the declaring
   * document — and no advice: the server row already offers the retry.
   */
  readonly detail?: string
  /**
   * Wire code of {@link LogEvent.message} (F-48), into the `projectMcp.host`
   * namespace. Optional: a host older than the field sends prose only, and the
   * client falls back to {@link LogEvent.message}.
   */
  readonly code?: string
  /** Flat params of {@link LogEvent.code}; numbers are stringified at emission. */
  readonly params?: Record<string, string>
  /** Wire code of {@link LogEvent.detail}, the same additive companion. */
  readonly detailCode?: string
  /** Flat params of {@link LogEvent.detailCode}. */
  readonly detailParams?: Record<string, string>
}

/** Everything one project contributes to the live runtime. */
export interface ProjectSnapshot {
  /** Project root the agents below resolved to. */
  projectRoot: string
  /**
   * Documents this project is configured to read, in priority order — global
   * ones first, then the project's own. Published even when empty, so a panel
   * can tell "this deployment reads nothing" from a host that does not report
   * its documents at all. Absent only from a snapshot a host older than this
   * field produced, and then a reader falls back to the shipped names rather
   * than inventing a priority.
   */
  files?: readonly ConfiguredFile[]
  /**
   * The tool policy in force for this project. Absent only from a snapshot a host
   * older than the policy store produced; a reader treats that as the shipped
   * default, {@link DEFAULT_TOOL_POLICY}.
   */
  policy?: ToolPolicy
  /** Live agent (session) ids currently bound to this project. */
  sessionIds: string[]
  /**
   * Merged rows for every declared server, in document order. When sessions
   * disagree about one server, the more actionable state wins, so a mounted or
   * broken server is never hidden behind a session that has not turned yet.
   */
  rows: ServerRow[]
  /** Parse and lifecycle diagnostics, deduplicated across the sessions. */
  issues: SnapshotIssue[]
  /** The same data split per session, in session-registration order. */
  sessions: SessionSnapshot[]
  /**
   * Usage counters keyed by `serverName`, remembered across sessions. Absent
   * while the host half has counted nothing for this project yet.
   */
  usage?: Record<string, ServerUsage>
  /**
   * Another loaded plugin that owns the assembled tool list, when the profile
   * has one. Absent means this plugin is the only owner — a panel that reads no
   * record draws no coexistence notice.
   */
  presentation?: PresentationOwner
  /**
   * Real `serverName` conflicts of this project: a profile-level instance that
   * already owns a name, or one name two project documents declare. The list is
   * always published — an empty one is the honest answer "no conflicts", which
   * is what lets a panel report that instead of offering a disabled button.
   */
  conflicts?: readonly ServerConflict[]
  /**
   * The newest events of this project's ring, oldest first, at most the page
   * size (50). Absent for a project that has recorded nothing, so a tab draws
   * its empty state rather than an empty list.
   */
  logs?: readonly LogEvent[]
  /**
   * How many events the project's ring holds right now, `0…200`. Absent exactly
   * when {@link ProjectSnapshot.logs} is: no events, nothing to count.
   */
  logCount?: number
}

/** Whole-plugin snapshot: one entry per project with live agents. */
export interface McpSnapshot {
  /** `true` while the agents service has been observed. */
  ready: boolean
  /** Projects with at least one live agent. */
  projects: ProjectSnapshot[]
  /**
   * Documents this deployment is configured to read, exactly as the config
   * spells them — `local` relative to a project root, `global` relative to
   * `$HOME` (or absolute). Published for the surfaces that must speak about the
   * deployment itself, with no project at hand: the empty state names what would
   * be read instead of a file name baked into the client. Absent from a snapshot
   * a host older than this field produced.
   */
  sources?: { readonly local: readonly string[]; readonly global: readonly string[] }
  /** Absolute paths currently watched for config edits. */
  watchedFiles: string[]
}

/**
 * One pushed picture: what the status channel sends.
 *
 * The snapshot travels whole rather than as a delta, so a frame that arrives
 * after a gap is still a complete answer — the panel can apply it without
 * asking for anything back. `revision` counts the changes the host has announced
 * and is what a late or repeated frame is judged by.
 */
export interface SnapshotChange {
  /** Monotonic change counter, starting at `0` for the picture a stream opens on. */
  revision: number
  /** The whole picture at that revision. */
  snapshot: McpSnapshot
}
