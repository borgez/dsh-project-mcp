/**
 * Contract shared by the host half and the browser half of the panel.
 *
 * Import-free on purpose: the client bundle must not pull host code in, and
 * `ctx.betterSidebar` exists only in the browser, so the two halves meet at
 * these routes over HTTP.
 *
 * @module dsh-project-mcp/shared
 */

import type { ConflictChoice, EntrySnapshot, ToolMode } from './types.ts'

/** Route prefix the host serves and the sidebar panel fetches. */
export const ROUTE_PREFIX = '/project-mcp'

/** Sidebar tab id; also the `SidebarTab.type` the panel opens as. */
export const TAB_ID = 'dsh-project-mcp:servers'

/** Plugin name, shared by both halves. */
export const PACKAGE_NAME = 'dsh-project-mcp'

/** Actions the host serves under {@link ROUTE_PREFIX}, and the panel fetches. */
export const ROUTE_ACTIONS = {
  /** `GET`: the current snapshot. */
  snapshot: 'snapshot',
  /** `POST`: ask for a rescan; answers as soon as the request is accepted. */
  sync: 'sync',
  /** `POST`: drop this project's failed mounts and re-mount them; answers once they are dropped. */
  retry: 'retry',
  /** `GET`: the status channel — one pushed frame per change, held open. */
  events: 'events',
  /** `GET`: one page of a project's log ring, oldest first, for "show older". */
  logs: 'logs',
  /** `POST`: release this session's mounts. */
  release: 'release',
  /** `POST`: write one edited entry back to its declaring document. */
  save: 'save',
  /** `POST`: pin or unpin one tool of one project. */
  pin: 'pin',
  /** `POST`: set one project's tool mode. */
  policy: 'policy',
  /** `POST`: choose which declaration of a contested `serverName` shows. */
  conflict: 'conflict',
} as const

/**
 * One operator request: the body of `POST sync` and `POST retry`.
 *
 * `projectRoot` scopes the action, so a surface that shows one project never
 * starts or restarts a server for another. `full` is the answer shape: a
 * single-project surface leaves it out and gets that project's slice back, while
 * a surface that lists every project — the settings page — asks for the whole
 * snapshot, since narrowing would empty the list it renders.
 */
export interface OperatorRequest {
  /** Project the action applies to; omitted covers every project. */
  readonly projectRoot?: string
  /** Answer with the whole snapshot rather than `projectRoot`'s slice. */
  readonly full?: boolean
}

/** Pin or unpin one tool of one project. */
export interface PinRequest {
  /** Project root the tool belongs to. */
  readonly projectRoot: string
  /** Public registry name, eg `mcp__tglider__workspace`. */
  readonly tool: string
  /** `true` pins it, `false` unpins it. */
  readonly pinned: boolean
}

/** Set one project's tool mode. Pins travel in their own request. */
export interface PolicyRequest {
  /** Project root the mode applies to. */
  readonly projectRoot: string
  /** The mode to store. */
  readonly mode: ToolMode
}

/**
 * Choose which declaration of one contested `serverName` a project shows.
 *
 * The name stays the profile's either way; the answer decides whether the
 * project's own entry mounts beside it under a local namespace. The name is
 * carried as declared — the sanitized `mcpServers` key — because that is what
 * the conflict report names, and the local name is the plugin's to compute.
 */
export interface ConflictRequest {
  /** Project root the name belongs to. */
  readonly projectRoot: string
  /** Contested `serverName`, as the project declared it. */
  readonly server: string
  /** The declaration to show. */
  readonly choice: ConflictChoice
}

/**
 * One entry a save writes.
 *
 * The panel submits the {@link EntrySnapshot} it was given, with the fields the
 * user changed. A masked `env`/`headers` key submitted without a `value` keeps
 * whatever the document declares for it; a key the submission omits is removed.
 */
export interface SaveRequest {
  /** Project root the edited row belongs to. */
  readonly projectRoot: string
  /** `serverName` being edited. */
  readonly server: string
  /** Absolute path of the document the entry came from. */
  readonly document: string
  /** `documentRevision` the edit was built from; a mismatch refuses the write. */
  readonly revision: string
  /** `true` acknowledges a write to the global tier; required only there. */
  readonly consent?: boolean
  /** The entry body to write. */
  readonly entry: EntrySnapshot
}

/** Error codes a save answers with, each with its own sentence in the panel. */
export type SaveErrorCode =
  /** The entry is not one this plugin would mount; nothing was written. */
  | 'invalid'
  /** The document may not be written: profile, `<DSH_HOME>`, or no consent. */
  | 'blocked'
  /** The document changed since the snapshot was taken; nothing was written. */
  | 'conflict'
  /** The document or the server is no longer there. */
  | 'not-found'
  /** The write itself failed; the document is left as it was. */
  | 'failed'