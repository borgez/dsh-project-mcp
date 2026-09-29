/**
 * The pictures the design surfaces draw.
 *
 * `./design.ts` mounts the three browser surfaces with **no host half at all**:
 * nothing is mounted, no route is called, and the sidebar tab, its settings
 * popover and the settings page are rendered from the fixtures below. That keeps
 * the interface reviewable on a machine with no live project and no MCP server,
 * which is the whole point of the mode.
 *
 * Every field here is the shape the host really publishes (`src/types.ts`), and
 * the `full` picture is the same one the parity gate feeds the live panel
 * (`scripts/design-parity.mjs`): seven servers covering all four status tones, a
 * session that disagrees with its project, a failure with its detail, four
 * events in the ring and a tool offer with pinned, disclosed and hidden names.
 * The other pictures isolate one state each, so a designer can look at it alone.
 *
 * @module dsh-project-mcp/client/design-fixtures
 */

import type {
  LogEvent,
  McpSnapshot,
  ProjectSnapshot,
  ServerRow,
  ServerStatus,
  ServerUsage,
  SessionSnapshot,
  SessionTools,
  ToolFacts,
  ToolPolicy,
} from '../types.ts'
import type { ToastDraft } from './toasts.ts'
import { STATUS_HINT, seedToolFacts } from './view.ts'

/** Session the fixtures belong to; `shortSessionId` renders it as `8fce1c`. */
export const DESIGN_SESSION = 'session-8fce1c-4a3f-4d0b-9c11-2f6a7b8c9d10'

/** Neutral placeholder project, as the repository's conventions require. */
export const DESIGN_PROJECT_ROOT = '/example/service'

/** The declaring document of every fixture row. */
export const DESIGN_DOCUMENT = `${DESIGN_PROJECT_ROOT}/.dsh/mcp.json`

/** The detail a failed mount carries: three facts, no advice (`F-03`). */
export const DESIGN_FAILURE =
  `no tool appeared within 60.2s; endpoint stdio docker; declared in ${DESIGN_DOCUMENT}`

/** How long the quiet fixture server has been unused, as the stand shows it. */
const DESIGN_IDLE_MS = 3 * 24 * 60 * 60 * 1000

/**
 * The host's usage counters for the picture (`ProjectSnapshot.usage`).
 *
 * The three states the panel can draw are all here, because a stand that shows
 * only the happy one hides the rule that matters: `tglider` has counts for both
 * its tools, `grafana-local` has a record whose `tools` came back empty — the
 * row prints `never called` rather than a zero nobody counted — and every other
 * server has no record at all, so its rows carry no figure. `graph` is quiet
 * with a three-day-old date, which is the one row that draws `idle 3d`; the
 * figure is computed at module load so the stand always shows the same reading.
 *
 * The split is the other half of the rule (F-34): this session called
 * `workspace` 3 times while the project counted 182, so the row shows both, and
 * it never called `catalog`, so that row reads `never called · 96 in the
 * project`. A project whose host publishes no split draws one number, which is
 * what the other pictures show.
 */
export const DESIGN_USAGE: Record<string, ServerUsage> = {
  tglider: {
    calls: 182,
    errors: 0,
    lastUsedAt: new Date(Date.now() - DESIGN_IDLE_MS / 3).toISOString(),
    tools: { workspace: 182, catalog: 96 },
    sessions: {
      [DESIGN_SESSION]: {
        calls: 3,
        errors: 0,
        lastUsedAt: new Date(Date.now() - DESIGN_IDLE_MS / 3).toISOString(),
        tools: { workspace: 3 },
      },
    },
  },
  'grafana-local': {
    calls: 0,
    errors: 0,
    lastUsedAt: new Date(Date.now() - DESIGN_IDLE_MS).toISOString(),
    tools: {},
  },
  context7: {
    calls: 12,
    errors: 1,
    lastUsedAt: new Date(Date.now() - DESIGN_IDLE_MS * 2).toISOString(),
    tools: { docs: 12 },
  },
}

/**
 * The definitions the stand's own host publishes (F-56).
 *
 * The body of an opened row is answered by `GET tool`, a route the stand has no
 * host behind: without these records every open row of the design surfaces would
 * sit on a read that never lands. The records are the picture's own — they agree
 * with {@link DESIGN_USAGE} (`workspace` was called, `catalog` never) and with
 * {@link designTools} — so the stand draws the real body: a description, a field
 * list with one required field and one nested object drawn as its type, and the
 * reason a deferred name is not in the request.
 *
 * They are seeded into the panel's own cache ({@link designProject} calls
 * {@link seedDesignToolFacts}), not branched on inside the row: `view.ts` has no
 * code path that knows whether an answer came from a socket, and the stand must
 * render the product's body rather than a second drawing of it.
 */
export const DESIGN_TOOL_FACTS: Record<string, ToolFacts> = {
  'mcp__tglider__workspace': {
    name: 'mcp__tglider__workspace',
    description:
      'Workspace overview: changed symbols, diagnostics and the files that carry them, as one page.',
    fields: [
      {
        name: 'path',
        type: 'string',
        required: true,
        description: 'Directory to read, relative to the project root.',
      },
      {
        name: 'depth',
        type: 'number',
        required: false,
        description: 'How deep the dependency walk may go.',
      },
      {
        // An object field is drawn as its own type and not expanded: the panel
        // lists what a call takes, it does not mirror the schema.
        name: 'filters',
        type: 'object',
        required: false,
        description: 'Per-file overrides; the server documents their shape.',
      },
    ],
  },
  // No fields at all, so the stand also shows the rule that an empty group draws
  // no heading rather than an empty list under it.
  'mcp__tglider__catalog': {
    name: 'mcp__tglider__catalog',
    description: 'Every tool the server declares, with the size of each definition.',
    fields: [],
  },
  'mcp__grafana-local__query': {
    name: 'mcp__grafana-local__query',
    description: 'Run one PromQL query against a dashboard’s data source.',
    fields: [
      { name: 'query', type: 'string', required: true, description: 'The PromQL expression.' },
      { name: 'range', type: 'string', required: false },
    ],
  },
  'mcp__context7__docs': {
    name: 'mcp__context7__docs',
    description: 'Documentation pages for one library, ranked by the question asked.',
    fields: [],
  },
  'mcp__playwright__navigate': {
    name: 'mcp__playwright__navigate',
    description: 'Open a URL in the browser and wait for the page to settle.',
    fields: [{ name: 'url', type: 'string', required: true, description: 'Absolute URL to open.' }],
    // Every figure is one the picture's own host measured, which is the whole
    // point of the reason line: the panel prints no size it computed itself.
    reason: { kind: 'budget', chars: 1_240, budget: 8_000, used: 6_900 },
  },
  'mcp__rider__open': {
    name: 'mcp__rider__open',
    description: 'Open one file in the IDE at a line.',
    fields: [{ name: 'path', type: 'string', required: true }],
    reason: { kind: 'budget', chars: 640, budget: 8_000 },
  },
}

/**
 * Publish the picture's definitions into the panel's cache.
 *
 * Idempotent and cheap: called from {@link designProject}, which every design
 * surface renders through, so a fixture body is always seeded before the first
 * row can be opened. Seeding the same record twice is the same record.
 */
export function seedDesignToolFacts(): void {
  for (const [name, facts] of Object.entries(DESIGN_TOOL_FACTS)) seedToolFacts(name, facts)
}

/** One lifecycle event, as the ring stores it. */
function event(
  at: number,
  level: LogEvent['level'],
  server: string,
  message: string,
  detail?: string,
): LogEvent {
  return detail === undefined
    ? { at, level, projectRoot: DESIGN_PROJECT_ROOT, sessionId: DESIGN_SESSION, server, message }
    : { at, level, projectRoot: DESIGN_PROJECT_ROOT, sessionId: DESIGN_SESSION, server, message, detail }
}

/** The four events the `full` picture holds, oldest first. */
export const DESIGN_EVENTS: readonly LogEvent[] = [
  event(1_789_000_000_000, 'info', 'tglider', `mounting for session ${DESIGN_SESSION} (trigger: turn)`),
  event(1_789_000_001_000, 'up', 'tglider', `is up — tools visible to session ${DESIGN_SESSION} after 812ms`),
  event(1_789_000_002_000, 'warn', 'grafana-local', 'unmounting — the session went idle (it ran for 8m 03s)'),
  event(1_789_000_003_000, 'error', 'gateway', 'no tool appeared in 4m 27s', `endpoint: stdio docker · declared in ${DESIGN_DOCUMENT}`),
]

/** The one event the `tools-absent` picture holds: a declaration waiting for a turn. */
export const DESIGN_PENDING_EVENT: readonly LogEvent[] = [
  event(1_789_000_030_000, 'info', 'tglider', 'declared, waiting for the session’s first step'),
]

/** One row of a picture. */
function row(
  name: string,
  status: ServerStatus,
  transport: 'stdio' | 'streamable-http',
  detail?: string,
): ServerRow {
  return detail === undefined
    ? { name, status, projectRoot: DESIGN_PROJECT_ROOT, source: DESIGN_DOCUMENT, transport }
    : { name, status, projectRoot: DESIGN_PROJECT_ROOT, source: DESIGN_DOCUMENT, transport, detail }
}

/**
 * Every picture the design mode can draw.
 *
 * `full` is the default and the one the docs' own mock (`mockups/harness.html`)
 * mirrors; the rest isolate a single state so it can be reviewed on its own.
 */
export type DesignVariant =
  /** All states at once: four tones, a disagreement, a failure, a full tool offer. */
  | 'full'
  /** The quiet project: sessions agree, nothing failed, the ring is empty. */
  | 'quiet'
  /** The project declares nothing. */
  | 'empty'
  /** The session declares one server and the host published no offer yet. */
  | 'tools-absent'
  /** The tools page is switched off for this project. */
  | 'off'
  /** Nothing is deferred: every mounted tool goes into the request. */
  | 'direct'
  /** The session's folder is not inside a project. */
  | 'no-project'
  /** No session is attached to the tab. */
  | 'no-session'

/** The variants, in the order the docs present them. */
export const DESIGN_VARIANTS: readonly DesignVariant[] = [
  'full',
  'quiet',
  'empty',
  'tools-absent',
  'off',
  'direct',
  'no-project',
  'no-session',
]

/** Narrow `unknown` to a variant, so a stored string can never switch the mode blind. */
export function isDesignVariant(value: unknown): value is DesignVariant {
  return typeof value === 'string' && (DESIGN_VARIANTS as readonly string[]).includes(value)
}

/** The merged rows of the project, per picture. */
function mergedRows(variant: DesignVariant): ServerRow[] {
  switch (variant) {
    case 'full':
      return [
        row('tglider', 'active', 'streamable-http'),
        row('grafana-local', 'active', 'streamable-http'),
        row('gateway', 'error', 'stdio', DESIGN_FAILURE),
        row('playwright', 'connecting', 'stdio'),
        row('context7', 'conflict', 'streamable-http', 'the name is taken by a live profile-level instance'),
        row('rider', 'idle', 'stdio', 'not mounted yet — this session has not started a turn (lazy mounting is on)'),
        row('legacy-gh', 'disabled', 'stdio'),
      ]
    case 'quiet':
    case 'off':
      return [row('tglider', 'active', 'streamable-http'), row('grafana-local', 'active', 'streamable-http')]
    case 'direct':
      return [row('tglider', 'active', 'streamable-http')]
    case 'tools-absent':
      return [row('tglider', 'idle', 'streamable-http', 'not mounted yet — this session has not started a turn (lazy mounting is on)')]
    case 'empty':
    case 'no-project':
    case 'no-session':
      return []
  }
}

/**
 * This session's own rows.
 *
 * The `full` picture is the one the panel's project-first view exists for: the
 * project merges `grafana-local` as `active`, while this session — whose ring
 * says it went idle — reads it as `idle`. Every other picture agrees with its
 * project, so the panel draws no `sessions` section at all.
 */
function sessionOwnRows(variant: DesignVariant): ServerRow[] {
  const rows = mergedRows(variant)
  if (variant !== 'full') return rows
  return rows.map((entry) =>
    entry.name === 'grafana-local' ? { ...entry, status: 'idle' as const } : entry,
  )
}

/** The tool policy in force for the picture. */
export function designPolicy(variant: DesignVariant): ToolPolicy {
  switch (variant) {
    case 'off':
      return { mode: 'off', pins: [] }
    case 'direct':
      return { mode: 'direct', pins: ['mcp__tglider__workspace'] }
    case 'quiet':
      return { mode: 'disclosure', pins: ['mcp__tglider__workspace', 'mcp__grafana-local__query'] }
    default:
      return { mode: 'disclosure', pins: ['mcp__tglider__workspace'] }
  }
}

/**
 * One session's tool offer, or `undefined` for the pictures where the host has
 * published none.
 *
 * `undefined` is the host's only "not mounted yet" signal, and it is a different
 * state from an offer whose counters are real zeroes — the panel prints two
 * different blocks for the two.
 */
export function designTools(variant: DesignVariant): SessionTools | undefined {
  const base = { sessionId: DESIGN_SESSION, mounted: 5, budgetChars: 20_000, deferring: false }
  switch (variant) {
    case 'full':
      return {
        ...base,
        baseline: ['mcp__tglider__workspace', 'mcp__tglider__catalog'],
        activated: [{ name: 'mcp__grafana-local__query', via: 'session', at: 1_789_000_004_000, step: 3 }],
        context: [{ name: 'mcp__context7__docs', via: 'context' }],
        deferred: ['mcp__playwright__navigate', 'mcp__rider__open'],
        surfaceChars: 12_800,
        visibleChars: 4_200,
        deferredChars: 8_600,
        deferring: true,
      }
    case 'quiet':
      return {
        ...base,
        mounted: 2,
        baseline: ['mcp__tglider__workspace', 'mcp__grafana-local__query'],
        activated: [],
        context: [],
        deferred: [],
        surfaceChars: 6_400,
        visibleChars: 6_400,
        deferredChars: 0,
      }
    case 'off':
      return {
        ...base,
        mounted: 1,
        baseline: [],
        activated: [],
        context: [],
        deferred: ['mcp__tglider__workspace'],
        surfaceChars: 3_200,
        visibleChars: 0,
        deferredChars: 3_200,
      }
    case 'direct':
      return {
        ...base,
        mounted: 1,
        baseline: ['mcp__tglider__workspace'],
        activated: [],
        context: [],
        deferred: [],
        surfaceChars: 3_200,
        visibleChars: 3_200,
        deferredChars: 0,
      }
    case 'empty':
    case 'tools-absent':
    case 'no-project':
    case 'no-session':
      return undefined
  }
}

/** One session of the picture, or `undefined` when the picture has no session. */
function sessionOf(variant: DesignVariant): SessionSnapshot[] {
  if (variant === 'no-project' || variant === 'no-session') return []
  const rows = sessionOwnRows(variant)
  const tools = designTools(variant)
  const logs = variant === 'full' ? DESIGN_EVENTS : variant === 'tools-absent' ? DESIGN_PENDING_EVENT : []
  const session: SessionSnapshot = {
    id: DESIGN_SESSION,
    rows,
    issues: [],
    logCount: logs.length,
    ...(tools === undefined ? {} : { tools }),
  }
  return [session]
}

/**
 * The one project of the picture, or `undefined` for the two that resolve to
 * none — a folder that is not inside a project, and a tab with no session at
 * all (the panel reads the project of the session it is open in, so neither
 * resolves).
 */
export function designProject(variant: DesignVariant): ProjectSnapshot | undefined {
  if (variant === 'no-project' || variant === 'no-session') return undefined
  // The stand's own host answers (F-56): an opened row reads the definitions
  // from the cache the product reads, seeded here because there is no route.
  seedDesignToolFacts()
  const rows = mergedRows(variant)
  const logs = variant === 'full' ? DESIGN_EVENTS : variant === 'tools-absent' ? DESIGN_PENDING_EVENT : []
  const sessions = sessionOf(variant)
  return {
    projectRoot: DESIGN_PROJECT_ROOT,
    policy: designPolicy(variant),
    sessionIds: [DESIGN_SESSION],
    // The read order of this deployment, as the host publishes it: the fixture
    // project is declared in the DSH document, and no global document is read.
    files: [{ path: DESIGN_DOCUMENT, scope: 'project' }],
    rows,
    issues: [],
    sessions,
    conflicts: [],
    ...(logs.length === 0 ? {} : { logs, logCount: logs.length }),
    // The counters belong to the two pictures that publish a tool offer: a
    // project the host never counted (every other picture) draws no figures at
    // all, which is a state worth being able to look at.
    ...(variant === 'full' || variant === 'quiet' ? { usage: DESIGN_USAGE } : {}),
  }
}

/** The whole picture, in the envelope's own shape. */
export function designPicture(variant: DesignVariant): McpSnapshot {
  const project = designProject(variant)
  return {
    ready: true,
    projects: project === undefined ? [] : [project],
    sources: { local: ['.dsh/mcp.json'], global: [] },
    watchedFiles: project === undefined ? [] : [DESIGN_DOCUMENT],
  }
}

/**
 * The session id the tab should read for this picture.
 *
 * `no-session` is the state the shell itself can be in — a tab with no session
 * attached — and the one the panel answers with its own empty state.
 * @param variant - the picture on screen.
 * @returns the fixture session id, or `undefined` for `no-session`.
 */
export function designSessionId(variant: DesignVariant): string | undefined {
  return variant === 'no-session' ? undefined : DESIGN_SESSION
}

/**
 * The banners the design toast stack shows, one per lifecycle moment. Keyed
 * like the real drafts (`src/client/toasts.ts`), so the stand repaints its
 * banners in the shell's active language the same way the product does.
 */
export const DESIGN_TOASTS: readonly ToastDraft[] = [
  {
    level: 'up',
    server: 'playwright',
    project: 'service',
    textKey: 'toastUp',
    textParams: { server: 'playwright' },
    detail: 'service',
  },
  {
    level: 'error',
    server: 'gateway',
    project: 'service',
    textKey: 'toastFailed',
    textParams: { server: 'gateway' },
    detailKey: STATUS_HINT.error,
    detail: DESIGN_FAILURE,
  },
  {
    level: 'released',
    server: 'rider',
    project: 'service',
    textKey: 'toastReleased',
    textParams: { server: 'rider' },
    detailKey: STATUS_HINT.idle,
  },
]
