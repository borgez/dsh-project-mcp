/**
 * Browser half of the panel: the tab shows one surface for the project of the
 * session it is open in — the session's declared servers, the sessions that read
 * differently from the project, what the model sees, and the problems and the
 * event ring under their own disclosures — while the settings popup, opened from
 * the tab's actions menu, keeps the whole picture across every project with a
 * live session. The native Settings page (`settings.section`, see
 * `./settings.ts`) is the third surface and shares this module's fetch/poll path,
 * status colours and storage helpers.
 *
 * Data comes from the host over `/project-mcp/*` (see `src/ui.ts`): the browser
 * half has nothing to call in process. The host half's types are imported
 * type-only, which the bundler erases — the client bundle stays free of host
 * code.
 *
 * @module dsh-project-mcp/client/view
 */

import { createElement as h, useCallback, useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { ROUTE_ACTIONS, ROUTE_PREFIX, TAB_ID } from '../shared.ts'
import type { LogEvent, McpSnapshot, ProjectSnapshot, ServerRow, ServerStatus, SessionTools, SnapshotChange, ToolFacts, ToolField, ToolMode, ToolPolicy, ToolReason } from '../types.ts'
import { hostTranslate, resolveHost } from './locales/host.ts'
import { operatorBody, pinBody, policyOf } from './policy.ts'
import { MCP_TOOL_PREFIX, idleOf, serverOfToolName, toolCalls } from './usage-view.ts'
import type { ProjectUsage, ToolCalls } from './usage-view.ts'

// The registry-name vocabulary is defined in `./usage-view.ts` — the counter
// reader, which must not import this module back — and re-exported here: the
// panel and every caller outside it (`settings-tools.ts`, the tests) have always
// read `MCP_TOOL_PREFIX` and `serverOfToolName` from this module.
export { MCP_TOOL_PREFIX, serverOfToolName, toolCalls }
export type { ToolCalls }

/**
 * The panel's own English copy.
 *
 * The tab is created through the sidebar service rather than through a slot, so
 * it carries its English table here and reaches the render functions through
 * {@link Translate}; `./tab-locale.ts` binds that table to the shell's locale
 * service and repaints the tab when the language changes. The settings page
 * registers the same table with `ctx.locale.register` (see
 * `./settings.ts`), which is why both halves share one namespace: one plugin,
 * one dictionary.
 */
export const en = {
  // The tab itself: its label in the sidebar and the line under it.
  tab: 'Project MCP',
  tabDescription:
    'MCP servers each project declares, and what is mounted for its sessions',
  sync: 'Sync',
  retryFailed: 'Retry failed',
  // Tool presentation: the tab's tools block and the settings page's Tools rows.
  toolsSeeModel: 'what the model sees',
  toolsPinned: 'pinned',
  toolsByCounters: 'by the counters',
  toolsDisclosed: 'disclosed',
  toolsHidden: 'hidden',
  toolsNotMounted: 'Nothing to hide yet',
  toolsNotMountedHint:
    'lazy mounting: the project’s servers come up on the session’s first step, so the catalog is empty until then',
  toolsNotMountedCode: 'tools[] = built-ins only · mcp__* not registered yet',
  // The declared servers of this session, on the tools block: the reason an
  // apparently empty catalog is empty.
  toolsServers: 'Servers',
  toolsServersUp: '{up}/{total} up',
  toolsGroupPinned: 'pinned · always in the request',
  toolsGroupCounters: 'offered by the counters',
  toolsGroupDisclosed: 'disclosed by the model · until the session ends',
  toolsGroupHidden: 'hidden',
  toolsPin: 'Pin',
  toolsPinHint: 'Keep this tool in every request of this project',
  toolsUnpin: 'Unpin',
  toolsUnpinHint: 'Stop pinning this tool in every request of this project',
  toolsHide: 'Hide',
  toolsHideHint: 'Drop this disclosure and stop offering the tool',
  toolsHiddenVia: 'available to the model through mcp_search_tools only',
  // The tools block's own filter (F-43): the counter chips above the list stop
  // being a reading and become the tier switch, and a query narrows by name.
  toolsFilterPlaceholder: 'filter by name…',
  toolsFilterLabel: 'filter this session’s tools by registry name',
  toolsFilterTier: 'Show this tier alone; press again for every tier',
  toolsFilterClear: 'Clear',
  toolsFilterClearHint: 'Show every tier and drop the query',
  toolsFilterShown: 'showing {shown} of {total}',
  toolsFilterNone: 'No tool of this session matches the filter.',
  // The server-level pin (F-44): one press for a whole server's names, since a
  // server is how the hidden tier and the settings page both group them.
  toolsPinAll: 'Pin all',
  toolsPinAllHint: 'Pin every hidden tool of this server in every request',
  // The other direction of the same press, said by both surfaces when the set is
  // already wholly pinned. A tier's names are usually unpinned, but the snapshot
  // can hold a pin that is still listed as deferred — a pin written between two
  // assemblies, or one the host itself defers — and a button that read `Pin all`
  // while it released it would be a lie.
  toolsUnpinAll: 'Unpin all',
  toolsUnpinAllHint: 'Stop pinning every hidden tool of this server',
  // The same press on the pinned tier, where the names it releases are the ones
  // the user pinned rather than the ones the host hid.
  toolsUnpinServerHint: 'Stop pinning every tool of this server',
  toolsBudget: '{used} chars of {total} · ≈ {tokens} tokens',
  toolsBudgetExhausted: 'the budget is spent: further disclosures are rejected with a reason',
  toolsBudgetFree: 'free room in the budget or pin the tool in the project settings',
  toolsBudgetGateOff: 'the disclosure gate is off: every mounted tool goes into the request',
  toolsBudgetBreakdown: '{used} of {total} ({percent}%)',
  toolsModeOff: 'this project’s MCP tools are switched off',
  toolsModeOffCounters: '{mounted} mounted · none offered',
  toolsModeOffHint:
    'Nothing from this project is offered to the model. Set the mode to “Disclosure” on the Tools page to offer them again.',
  toolsModeDirect: 'nothing is deferred: every mounted tool goes into the request',
  toolsPresentationOwner: 'Another plugin is shaping the request',
  toolsOtherOwner: 'Another presentation owner',
  toolsDemo: 'demo',
  toolsStep: 'step {step}',
  // The host's own usage counters (`ProjectSnapshot.usage`), read as two quiet
  // labels: how often one tool was called, and how long one server has gone
  // unused. Both are drawn only where the host published a record — no data, no
  // label — so `never called` means "the server is in the counters and this tool
  // is not", never "the host said nothing".
  callsOne: '1 call',
  callsMany: '{count} calls',
  callsNone: 'never called',
  callsProject: '{count} in the project',
  idleDay: 'idle {count}d',
  idleHour: 'idle {count}h',
  idleMinute: 'idle {count}m',
  // One tool row's detail block (F-56): the server the name was registered
  // under with the state it is in, the tier said as a sentence, the two counter
  // readings apart, and then what only the host can answer — the definition's
  // own description, its fields, and why a hidden name is not in the request.
  // The name, the clock and the step stay in the header; a body that repeated
  // them was the copy this unit removed. The host publishes no size for a single
  // tool, so the budget estimate stays in the group line above — the only figure
  // the reason line prints is a measurement the host sent it.
  toolServer: 'server {server}',
  toolServerState: '{server} · {state}',
  toolTierPinned: 'pinned — always in the request',
  toolTierSession: 'offered by this session',
  toolTierContext: 'offered by the context ranking',
  showTool: 'show this tool’s server, description, fields and how it was offered',
  hideTool: 'hide this tool’s detail',
  toolCallsSession: '{count} this session',
  toolLoading: 'reading this definition from the host…',
  toolFailed: 'the host did not answer for this definition',
  toolFieldsLabel: 'takes',
  toolFieldRequiredHint: 'required field',
  toolReasonBudget: 'not offered: {chars} chars over the {budget}-char budget',
  toolReasonChars: '{chars} chars',
  toolReasonBudgetOnly: '{budget}-char budget',
  toolReasonUsed: '{used} already offered',
  toolReason: 'not offered',
  // The errors and logs blocks, under their own disclosures: the event ring is
  // the plugin's own, one project at a time.
  errorsSection: 'Problems',
  showErrors: 'show the servers that need a look',
  hideErrors: 'hide the servers that need a look',
  logsSection: 'Logs',
  showLogs: 'show this project’s events',
  hideLogs: 'hide this project’s events',
  logsThisSession: 'this session',
  logsAllSessions: 'all sessions',
  logsAllLevels: 'all levels',
  logsErrorsOnly: 'errors',
  logsLevelInfo: 'info',
  logsLevelUp: 'up',
  logsLevelWarn: 'warn',
  logsLevelError: 'error',
  logsClear: 'Clear',
  logsClearHint: 'Hide every event recorded so far; new ones still appear',
  logsEmptyTitle: 'No events yet',
  logsEmptyHint:
    'This project’s servers come up on the session’s first step or when you press Sync; mounting, start and stop will show up here.',
  logsNoErrorsTitle: 'No errors',
  logsNoErrorsHint:
    'This project’s ring holds other events; switch the level filter to “all levels” to read them.',
  logsMore: 'Show older',
  logsMoreHint: 'Load the events older than the ones on screen',
  logsShown: 'showing {shown} of {total}',
  logsProjectCount: '{count} in this project',
  logsLoading: 'loading older events…',
  logsLoadFailed: 'older events could not be read',
  // The tab's own states, in the same table for the same reason.
  noSession: 'No session is attached to this tab.',
  noSessionHint: 'The panel reads the project of the session it is open in.',
  noProject: 'This session’s folder is not inside a project yet.',
  noProjectHint:
    'The host walks up from the session cwd looking for .git · .dsh · .kimi-code · package.json · *.sln.',
  nothingNeedsAttention: 'Nothing needs attention.',
  noServersDeclared: 'This project declares no MCP servers.',
  noServersDeclaredHint: 'Add {documents}.',
  noServersDeclaredUnknown: 'Add an MCP document to the project.',
  noServersDeclaredNowhere:
    'This deployment reads no project document, so there is nowhere to declare one — list one in the plugin config (`localFiles`).',
  // Surface A's own header and the vocabulary its rows are built from. The
  // segment bar is gone (F-26): the toolbar names the project and carries one
  // phrase on its right edge, and every count a mode segment used to badge lives
  // on the block it describes.
  thisSession: 'this session',
  noProjectLabel: 'no project',
  retry: 'Retry',
  retryHint: 'Retry this project’s failed mounts now',
  sessionsSection: 'sessions',
  // The `sessions` section is the project's *disagreement* view: its chip counts
  // the sessions whose own reading differs from the merged rows, not the
  // sessions that exist. The count of existing sessions lives on the toolbar's
  // right edge, which keeps `sessionsOne` / `sessionsMany` for itself.
  differsOne: '1 differs',
  differsMany: '{count} differ',
  sessionsOne: '1 session',
  sessionsMany: '{count} sessions',
  serversOne: '1 server',
  serversMany: '{count} servers',
  mergedAcrossSessions: 'merged across sessions',
  release: 'Release',
  nothingDeclared: 'nothing declared',
  showSessions: 'show the sessions of this project',
  hideSessions: 'hide the sessions of this project',
  showSession: 'show this session’s servers',
  hideSession: 'hide this session’s servers',
  mountedPerProject: 'Mounted per project',
  projectsCount: '{count} project(s)',
  nothingMounted: 'Nothing is mounted yet.',
  // The status vocabulary (F-47): the word a row wears and the one-line
  // explanation its tooltip carries. Both are read through `STATUS_KEYS` /
  // `STATUS_HINT` — `Record<ServerStatus, LocaleKey>` tables — so a new enum
  // member without a key is a compile error, never a raw token on screen.
  statusActive: 'active',
  statusConnecting: 'connecting',
  statusConflict: 'conflict',
  statusError: 'error',
  statusIdle: 'idle',
  statusDisabled: 'disabled',
  statusHintActive: 'mounted, its tools are visible in this session',
  statusHintConnecting: 'mounted, no tool published yet',
  statusHintIdle: 'declared but not mounted — mounts on the next turn',
  statusHintDisabled: 'declared with enabled: false',
  statusHintConflict: 'the same serverName is reserved by a profile-level instance',
  statusHintError: 'see the detail',
  // One project's or session's status line (`2 active, 1 idle`): one template
  // per status, so the count is a `{count}` placeholder in every language and
  // never a concatenation. `summarize` names no `disabled` count today; the
  // template is here so the day it does, the word is too.
  summaryActive: '{count} active',
  summaryConnecting: '{count} connecting',
  summaryIdle: '{count} idle',
  summaryDisabled: '{count} disabled',
  summaryError: '{count} error',
  summaryConflict: '{count} conflict',
  summaryNone: 'nothing declared',
  close: 'Close',
  // The frame-wide toasts (F-47): drafts carry these keys, and the stack
  // resolves them at render, so a language switch repaints the banners on
  // screen. The quieter line weaves the project around the fact behind the
  // moment — the host's own detail sentence, or a status hint.
  toastUp: '{server} is up',
  toastFailed: '{server} failed',
  toastReleased: '{server} released',
  toastDetail: '{project} · {detail}',
  // The poll interval's row in the settings panel, read live through the seat
  // on every render.
  refreshTitle: 'Refresh interval',
  refreshDesc: 'How often the panel re-reads the host snapshot',
  // The tab's actions menu (the chip's own menu): the row that opens the
  // settings popup, which used to be the sidebar's side card.
  settingsMenuItem: 'Panel settings…',
  // The design stand's own tab title and description (design.ts).
  designTitle: 'Project MCP · design ({variant})',
  designDesc: 'design mode: the {variant} fixture, no host behind it',
}

/** A dictionary key of this namespace. */
export type LocaleKey = keyof typeof en

/** Translate one key, with optional `{name}` template params (the DSH seat). */
export type Translate = (key: string, params?: Record<string, unknown>) => string

/**
 * Bind the translate seat a surface was given, falling back to this module's own
 * English dictionary when it renders outside a DSH shell (tests, or a browser
 * half newer than the host).
 * @param t - the injected `t` seat, when there is one.
 * @returns a translate function that always answers.
 */
export function translateOf(t?: Translate): Translate {
  return t ?? fallbackTranslate
}

/** The panel's own English copy, same shape as the settings page's fallback. */
export function fallbackTranslate(key: string, params?: Record<string, unknown>): string {
  const template = (en as Record<string, string>)[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  )
}

/** Name of the poll interval inside {@link REFRESH_STORAGE_KEY}. */
export const REFRESH_KEY = 'refreshMs'

/**
 * `localStorage` key the poll interval is persisted under.
 *
 * The interval used to ride the side card's own settings blob
 * (`prefs.pluginSettings[TAB_ID]` of `dsh-better-sidebar`). That surface is gone
 * with the dependency, so the interval is a browser-local preference beside the
 * view, the log filters and the Clear mark — same lifetime, same hostile-storage
 * rule, one less service to read it from.
 */
export const REFRESH_STORAGE_KEY = `${TAB_ID}:${REFRESH_KEY}`

/** Poll interval used until the setting is read. */
export const DEFAULT_REFRESH_MS = 5_000

/**
 * Status colours, taken from the design system's alias layer
 * (`packages/client/ui-theme/src/styles/design-platform.css` in the DSH
 * checkout): `state-*` for the lifecycle, `label-tertiary` for the two quiet
 * states. The fallbacks only ever fire outside the DSH web client, where that
 * alias layer is not loaded.
 */
export const STATUS_COLOR: Record<ServerStatus, string> = {
  active: 'var(--dsw-alias-state-success-primary, #22c55e)',
  connecting: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
  conflict: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
  error: 'var(--dsw-alias-state-error-primary, #ec1313)',
  idle: 'var(--dsw-alias-label-tertiary, #81858c)',
  disabled: 'var(--dsw-alias-label-tertiary, #81858c)',
}

/**
 * The dictionary key of the word each status wears on its row, so the panel
 * never prints the enum token itself: a `ServerStatus` member without a key
 * here is a compile error, not a silent English leak in another language.
 */
export const STATUS_KEYS: Record<ServerStatus, LocaleKey> = {
  active: 'statusActive',
  connecting: 'statusConnecting',
  conflict: 'statusConflict',
  error: 'statusError',
  idle: 'statusIdle',
  disabled: 'statusDisabled',
}

/**
 * The dictionary key of each status's one-line explanation, so the panel needs
 * no legend. Readers translate through their own seat —
 * `t(STATUS_HINT[row.status])` — which keeps the sentence the tooltip or the
 * toast shows in the reader's language.
 */
export const STATUS_HINT: Record<ServerStatus, LocaleKey> = {
  active: 'statusHintActive',
  connecting: 'statusHintConnecting',
  idle: 'statusHintIdle',
  disabled: 'statusHintDisabled',
  conflict: 'statusHintConflict',
  error: 'statusHintError',
}

const BORDER = '1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.25))'

/**
 * The alias layer's own tones, named once.
 *
 * The mockup's vocabulary has two levels of quiet text — `.muted` (secondary)
 * and `.dim` (tertiary) — and this surface used to paint both by dropping the
 * opacity of the primary colour, which is close to the token but not the same
 * value. Reading the token keeps the two tones distinguishable in both themes.
 */
const TONE = {
  /** `.muted`: the secondary label tone, for text the user reads next. */
  secondary: 'var(--dsw-alias-label-secondary, inherit)',
  /** `.dim`: the tertiary label tone, for captions and quiet states. */
  tertiary: 'var(--dsw-alias-label-tertiary, #81858c)',
} as const

/** The alias layer's layer-3 fill — the mockup's chip and the ring's filters. */
const LAYER_3 = 'var(--dsw-alias-bg-layer-3, rgba(127, 127, 127, 0.12))'

/**
 * The counter chip's plate, named once because it has two readers now: the
 * reading chip of {@link STYLE.tag} and the pressable tier chip of the tools
 * block's filter (F-43). The two differ only in the three resets a `<button>`
 * needs and in the fill the pressed one takes, so the words and the count read
 * the same whether the tier is a label or a switch.
 */
const LAYER_3_CHIP = {
  background: LAYER_3,
  fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
  fontSize: '0.85em',
  borderRadius: 4,
  padding: '0 5px',
  color: TONE.secondary,
} satisfies CSSProperties

/**
 * One step of the Servers surface's indentation ladder, in pixels.
 *
 * Surface A nests four levels and every one sits exactly one step right of the
 * one above it — `project 0 → sessions 12 → session 24 → that session's servers
 * 36`. The `sessions` rung is conditional: it exists only while at least one
 * session disagrees with the project's merged rows, so a project whose sessions
 * all agree stops at rung `0`. The scale lives here, once, and each level asks
 * for its rung through {@link STYLE.indent}; the hand-picked `paddingLeft`
 * values this replaced had drifted out of step with one another.
 */
export const INDENT = 12

/**
 * The panel's own inline styles.
 *
 * Exported for the design-only render mode (`./design.ts`), which composes the
 * same `PanelHeader` / `tabBody` from a fixture and must therefore frame them
 * with the very same root and body — a second copy of these two objects is
 * exactly how a mockup drifts from the product.
 */
export const STYLE = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
    color: 'inherit',
  } satisfies CSSProperties,
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    // The mock's `.panel-bar` (`docs/design/mockups/harness.html`) — the panel's own inset, so the
    // chips and the project name start on the picture's margin.
    padding: '7px 9px',
    borderBottom: BORDER,
    flexWrap: 'wrap',
  } satisfies CSSProperties,
  body: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    // The one surface's blocks are direct children of this container (F-26), so
    // the inset the old per-mode wrapper used to supply is here now — the
    // mock's `.body { padding: 9px 10px }` (`docs/design/mockups/harness.html`).
    padding: '9px 10px',
  } satisfies CSSProperties,
  /** The rows' own inset: the mock's `.body` (`docs/design/mockups/harness.html`). */
  project: { padding: '9px 10px', borderBottom: BORDER } satisfies CSSProperties,
  projectHead: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
    justifyContent: 'space-between',
  } satisfies CSSProperties,
  /**
   * `.muted`: the secondary tone, at the text's own size.
   *
   * The mock's `.muted` states a colour and nothing else (`docs/design/mockups/harness.html`),
   * and the dictionary's obligation is "a muted colour, not a blindly reduced
   * size" — so the tone is here and the size is the neighbouring text's.
   */
  muted: { color: TONE.secondary } satisfies CSSProperties,
  /** `.dim`: the tertiary tone, one step quieter than `.muted`. */
  dim: { color: TONE.tertiary, fontSize: '0.9em' } satisfies CSSProperties,
  row: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
    padding: '2px 0',
  } satisfies CSSProperties,
  sessions: {
    marginTop: 4,
    paddingTop: 4,
    borderTop: BORDER,
  } satisfies CSSProperties,
  session: { padding: '2px 0' } satisfies CSSProperties,
  sessionHead: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
    flexWrap: 'wrap',
  } satisfies CSSProperties,
  sessionToggle: {
    padding: 0,
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    font: 'inherit',
    fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
    textAlign: 'left',
  } satisfies CSSProperties,
  /**
   * `tag`: the mockup's chip is a short plate on a layer fill in mono type — not
   * a word in the row, and not a bordered box either (`docs/design/mockups/harness.html`,
   * dictionary line 13).
   */
  tag: { ...LAYER_3_CHIP } satisfies CSSProperties,
  /** The `idle` / `disabled` chip: the mockup's `.dim` tone, one step quieter. */
  tagQuiet: {
    color: TONE.tertiary,
  } satisfies CSSProperties,
  /** The `up/total` chip once a declared server is failing: red, not quiet. */
  tagWarn: {
    color: 'var(--dsw-alias-state-error-primary, #ec1313)',
  } satisfies CSSProperties,
  /**
   * One counter chip of the tools block, as the filter's tier switch (F-43).
   *
   * The same plate {@link STYLE.tag} draws — the words and the count do not
   * change with the tier — with the resets a `<button>` needs to sit in a row of
   * spans without becoming a form control the shell styles. The chip is a leaf
   * holding its text directly, which is also what lets the parity gate read
   * `{count} pinned` off it.
   *
   * `font: inherit` comes **before** the plate, and the order is the whole
   * point: `font` is a shorthand that resets `font-family` and `font-size` too,
   * and React writes the inline style in this object's own order — behind the
   * plate it silently turned the chips into the shell's sans face, which is the
   * one thing a chip of this vocabulary is not (see the neighbouring
   * `STYLE.logFilter`, where the shorthand is the last word on purpose because
   * that chip is the shell's own type).
   */
  filterChip: {
    font: 'inherit',
    cursor: 'pointer',
    border: 'none',
    ...LAYER_3_CHIP,
  } satisfies CSSProperties,
  /** The pressed tier chip: the applied filter is the one that reads as active. */
  filterChipOn: {
    background: 'var(--dsw-alias-interactive-bg-active, rgba(127, 127, 127, 0.18))',
    color: 'var(--dsw-alias-label-primary, inherit)',
  } satisfies CSSProperties,
  /**
   * The filter's query field: the shell's own input plate, one size down and
   * full width, so the field reads as the panel's own row rather than a form
   * control borrowed from the settings page.
   */
  filterInput: {
    flex: 1,
    minWidth: 0,
    border: BORDER,
    borderRadius: 4,
    padding: '2px 6px',
    background: 'var(--dsw-alias-bg-layer-1, transparent)',
    color: 'inherit',
    font: 'inherit',
    fontSize: '0.85em',
  } satisfies CSSProperties,
  /**
   * A group label that shares its line with a chip. {@link STYLE.group} owns a
   * whole line at the tertiary tone, which would bleach the chip with it.
   */
  groupInline: {
    color: TONE.tertiary,
    fontSize: '0.8em',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  } satisfies CSSProperties,
  /** The session's declared-servers block, the single surface's first block. */
  serversBlock: {
    margin: '0 0 6px',
    paddingBottom: 4,
    borderBottom: BORDER,
  } satisfies CSSProperties,
  /**
   * One rung of the Servers surface's indentation ladder: `level` steps right of
   * the project's own rows, so `0` is the project, `1` the `sessions` section,
   * `2` one session of it, `3` that session's own servers. The only left padding
   * the surface has; nothing else may hand-pick one.
   */
  indent: (level: number): CSSProperties => ({ paddingLeft: level * INDENT }),
  // An identifier is one unbreakable token (`mcp__tglider__workspace`), and the
  // panel is 330px wide at its narrowest: without a break opportunity the name
  // overflows its own row button instead of wrapping inside it. `anywhere` rather
  // than `break-word` because only `anywhere` shrinks the item's own min-content
  // width, which is what the flex row measures.
  name: {
    fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
    overflowWrap: 'anywhere',
  } satisfies CSSProperties,
  detail: { opacity: 0.7, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' } satisfies CSSProperties,
  button: {
    padding: '2px 8px',
    borderRadius: 4,
    border: BORDER,
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  } satisfies CSSProperties,
  error: { padding: 8, color: STATUS_COLOR.error } satisfies CSSProperties,
  /**
   * The poll interval's row in the settings panel: a label that stacks the
   * toggle's own title and hint, the field it points at, and the unit beside it.
   * Laid out as one row so the panel reads like the side card the row came from.
   */
  settingRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 8px 0',
  } satisfies CSSProperties,
  settingLabel: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1 } satisfies CSSProperties,
  settingTitle: { fontSize: 12 } satisfies CSSProperties,
  settingDesc: { fontSize: 11, color: TONE.tertiary } satisfies CSSProperties,
  settingInput: {
    width: 72,
    padding: '2px 6px',
    borderRadius: 4,
    border: BORDER,
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
  } satisfies CSSProperties,
  settingUnit: { fontSize: 11, color: TONE.tertiary } satisfies CSSProperties,
  /**
   * One disclosure of the single surface (F-26): a block of the scrolling body
   * whose head is a button and whose body exists only while it is open. The
   * parity gate finds it as a `div` with a `button[aria-expanded]` child, so the
   * head is the block's first child and the body its second — the shape the
   * mockup's `.disclosure` declares.
   */
  disclosure: { marginTop: 5 } satisfies CSSProperties,
  disclosureHead: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
    width: '100%',
    padding: '2px 0',
    border: 'none',
    background: 'transparent',
    font: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
    // `.disclosure-head`: the label is the control's word, read in the quiet
    // tone (`docs/design/mockups/harness.html`, F-26 block).
    color: TONE.tertiary,
  } satisfies CSSProperties,
  disclosureBody: { paddingLeft: 12 } satisfies CSSProperties,
  /**
   * One tool row: the line the user reads with its one action beside it, and the
   * detail block on its own line while it is open. The line is the disclosure's
   * `button[aria-expanded]` and a direct child of this wrapper, so a parity probe
   * that looks for `div > button[aria-expanded]` finds the row, and the action
   * stays a sibling — a button inside a button is not a thing HTML has.
   */
  tool: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: 6,
  } satisfies CSSProperties,
  /** The tool row's own line: the tier dot, the name, and the time and step. */
  toolLine: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
    flex: 1,
    minWidth: 0,
    padding: '2px 0',
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    font: 'inherit',
    textAlign: 'left',
  } satisfies CSSProperties,
  /**
   * The open detail of one tool (F-56): the server it was registered under with
   * the state it is in, the tier as a sentence, the counter readings this row does
   * not show, and then the host's own on-demand answer about the definition — its
   * description, the fields it takes, and why a hidden name is not in the request.
   * One rung in from the row, like every other body of a disclosure.
   */
  toolDetail: {
    flexBasis: '100%',
    padding: '2px 0 4px 12px',
  } satisfies CSSProperties,
  /** One accepted field of a definition: its mono name, type, marker and description. */
  field: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: 5,
    padding: '1px 0',
    overflowWrap: 'anywhere',
  } satisfies CSSProperties,
  fieldName: {
    fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
    overflowWrap: 'anywhere',
  } satisfies CSSProperties,
  fieldDesc: { color: TONE.secondary, opacity: 0.75 } satisfies CSSProperties,
  group: {
    opacity: 0.6,
    fontSize: '0.8em',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    margin: '7px 0 1px',
  } satisfies CSSProperties,
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 6,
    padding: '14px 10px',
    textAlign: 'center',
  } satisfies CSSProperties,
  emptyTitle: { opacity: 0.9 } satisfies CSSProperties,
  hint: { opacity: 0.6, fontSize: '0.85em', overflowWrap: 'anywhere' } satisfies CSSProperties,
  dot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    display: 'inline-block',
    flex: 'none',
    alignSelf: 'center',
  } satisfies CSSProperties,
  codeLine: {
    margin: 8,
    padding: '5px 8px',
    border: BORDER,
    borderRadius: 5,
    background: 'var(--dsw-alias-markdown-code-block, transparent)',
    color: 'var(--dsw-alias-link, inherit)',
    fontSize: '0.8em',
    fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
    overflowWrap: 'anywhere',
  } satisfies CSSProperties,
  budget: {
    height: 4,
    margin: '4px 0 2px',
    borderRadius: 2,
    background: 'var(--dsw-alias-interactive-bg-active, rgba(127, 127, 127, 0.18))',
    overflow: 'hidden',
  } satisfies CSSProperties,
  budgetUsed: {
    display: 'block',
    height: '100%',
    background: 'var(--dsw-alias-state-business-primary, currentColor)',
  } satisfies CSSProperties,
  warnNote: {
    margin: '8px 0',
    padding: '5px 7px',
    borderLeft: '2px solid var(--dsw-alias-state-warn-primary, #f59e0b)',
    background: 'var(--dsw-alias-state-warn-tertiary, transparent)',
    fontSize: '0.85em',
    overflowWrap: 'anywhere',
  } satisfies CSSProperties,
  /** A quiet row — `idle` or `disabled` — reads at the same size, dimmed. */
  rowQuiet: { opacity: 0.6 } satisfies CSSProperties,
  /** A row of chips: the hidden-by-server tags the tools block draws. */
  chips: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    flexWrap: 'wrap',
  } satisfies CSSProperties,
  /** The header row of the collapsed sessions section. */
  sessionsHead: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
    flexWrap: 'wrap',
  } satisfies CSSProperties,
  /** A failure banner: the coloured left rule carries the severity, not a word. */
  banner: {
    margin: '2px 0 4px',
    padding: '4px 7px',
    borderRadius: '0 5px 5px 0',
    borderLeft: '2px solid var(--dsw-alias-state-error-primary, #ec1313)',
    background: 'var(--dsw-alias-interactive-bg-hover-danger, transparent)',
    color: 'var(--dsw-alias-label-primary, inherit)',
    fontSize: '0.85em',
    overflowWrap: 'anywhere',
    // A mount detail is a multi-line diagnostic (error, endpoint, declaration,
    // next step); collapsing its line breaks is what made it unreadable.
    whiteSpace: 'pre-wrap',
  } satisfies CSSProperties,
  /** Laid over {@link STYLE.banner} for a restriction rather than a failure. */
  bannerWarn: {
    borderLeftColor: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
    background: 'var(--dsw-alias-state-warn-tertiary, transparent)',
  } satisfies CSSProperties,
  /**
   * One log event's first line: time, level, server, message.
   *
   * `flexWrap` is the point of this row. A sidebar is narrow, and a message kept
   * in a trailing column turns into a staircase of two-word fragments; wrapping
   * the row lets the message take the rest of the line and the whole of the next
   * one, which is how the mockup reads.
   */
  logRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
    padding: '2px 0',
    flexWrap: 'wrap',
  } satisfies CSSProperties,
  /** The event's clock: mono, tertiary, fixed width so the column aligns. */
  logTime: {
    fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
    color: TONE.tertiary,
    fontSize: '0.85em',
    flex: 'none',
  } satisfies CSSProperties,
  /**
   * The level chip. It reuses {@link STYLE.tag}'s plate and is only coloured on
   * top of it, so `info` reads as the quiet chip it is and `error` as the alarm.
   */
  logLevel: { flex: 'none', textTransform: 'none', fontWeight: 500 } satisfies CSSProperties,
  /**
   * A filter chip of the Logs toolbar: a button that reads like {@link STYLE.tag}
   * but keeps the interface font, since it is a control rather than a value.
   */
  logFilter: {
    padding: '1px 6px',
    border: 'none',
    borderRadius: 4,
    background: LAYER_3,
    color: TONE.secondary,
    cursor: 'pointer',
    font: 'inherit',
    fontSize: '0.85em',
  } satisfies CSSProperties,
  /** The filter currently applied: one pressed chip per pair. */
  logFilterOn: {
    background: 'var(--dsw-alias-interactive-bg-active, rgba(127, 127, 127, 0.18))',
    color: 'var(--dsw-alias-label-primary, inherit)',
  } satisfies CSSProperties,
  /** Server name of the event, in the same mono face as every other name. */
  logName: {
    fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
    color: TONE.secondary,
    flex: 'none',
  } satisfies CSSProperties,
  /** The message: its own width, so it never becomes a two-word column. */
  logMessage: {
    flex: '1 1 100%',
    marginTop: 1,
    overflowWrap: 'anywhere',
    color: 'var(--dsw-alias-label-primary, inherit)',
  } satisfies CSSProperties,
  /** One fact line under a failing event; `marginLeft` sits it under the text. */
  logDetail: {
    margin: '0 0 3px',
    paddingLeft: 7,
    borderLeft: '2px solid var(--dsw-alias-state-error-primary, #ec1313)',
    color: 'var(--dsw-alias-label-primary, inherit)',
    fontSize: '0.85em',
    overflowWrap: 'anywhere',
  } satisfies CSSProperties,
  /** `error` chip: the alarm tone of {@link STATUS_COLOR}. */
  logError: { color: STATUS_COLOR.error } satisfies CSSProperties,
  /** `warn` chip: the same tone a stalled server row uses. */
  logWarn: { color: STATUS_COLOR.connecting } satisfies CSSProperties,
  /** `up` chip: a successful mount reads like an active server. */
  logUp: { color: STATUS_COLOR.active } satisfies CSSProperties,
}

interface Envelope<T> {
  ok: boolean
  value?: T
  error?: { code?: string; message?: string }
}

/**
 * Call one host route, unwrapping the `{ ok, value }` envelope.
 *
 * Exported so a surface that needs the snapshot outside the tab's own polling
 * hook reads the same route the same way.
 * @param path - route action under `ROUTE_PREFIX`.
 * @param body - JSON body for a `POST` action; omitted for a `GET`.
 * @returns the unwrapped snapshot.
 */
export async function request(path: string, body?: unknown): Promise<McpSnapshot> {
  const response = await fetch(`${ROUTE_PREFIX}/${path}`, routeInit(path, body))
  const payload = (await response.json()) as Envelope<McpSnapshot>
  if (payload.ok !== true || payload.value === undefined) {
    throw new Error(payload.error?.message ?? `request failed (${response.status})`)
  }
  return payload.value
}

/**
 * The `fetch` init for one route call.
 *
 * The method follows the **action**, never whether a payload happened to be
 * passed: the reads — the snapshot, the status channel and a page of logs — are
 * `GET`, and every other action is a `POST` the host refuses for `GET`. Deciding
 * this from the body was a real defect — `Sync` and `Retry` pass no payload, so
 * they were sent as `GET` and answered `404` from both panels, while `Release`
 * (which sends a session id) worked.
 *
 * @param path - route action under `ROUTE_PREFIX`.
 * @param body - JSON body; an action without one sends `{}` rather than nothing.
 * @returns the init to hand to `fetch`.
 */
export function routeInit(path: string, body?: unknown): RequestInit {
  // `logs` is read out of the registry rather than repeated as a literal: the
  // contract gives the route one owner, and this stays correct once it lands.
  const logs = (ROUTE_ACTIONS as Record<string, string | undefined>).logs
  const reads = [ROUTE_ACTIONS.snapshot, ROUTE_ACTIONS.events, ...(logs === undefined ? [] : [logs])]
  if (reads.includes(path)) return {}
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }
}

interface SnapshotState {
  snapshot: McpSnapshot | undefined
  error: string | undefined
  busy: boolean
}

/**
 * Poll the host snapshot while the panel is visible; the Settings page polls it
 * unconditionally. Exported so both surfaces share one fetch/unwrap/poll path.
 *
 * The poll is the **fallback**: the host pushes every change over the status
 * channel (`GET /project-mcp/events`, see `createEventStream` in `src/ui.ts`),
 * and a panel whose stream is open polls nothing. A host half older than the
 * route, a browser without `EventSource`, or a dropped connection all land in the
 * same place — the poll keeps the picture fresh, and `EventSource` reconnects on
 * its own until the stream is back.
 * @param visible - false suspends polling (the sidebar tab does this while hidden).
 * @param refreshMs - poll interval while the status channel is not connected.
 * @param path - route action to poll; the snapshot unless a surface asks for another.
 * @returns the latest snapshot, the last error, the in-flight flag and `run`.
 */
export function useSnapshot(visible: boolean, refreshMs: number, path: string = 'snapshot') {
  const [state, setState] = useState<SnapshotState>({ snapshot: undefined, error: undefined, busy: false })
  const [pushed, setPushed] = useState(false)
  const load = useCallback(async () => {
    try {
      const snapshot = await request(path)
      setState((previous) => ({ ...previous, snapshot, error: undefined }))
    } catch (error) {
      setState((previous) => ({ ...previous, error: messageOf(error) }))
    }
  }, [path])
  /**
   * Apply one pushed frame. Every frame carries the whole picture, so one that
   * arrived after a gap is still a complete answer — nothing to refetch.
   */
  const apply = useCallback((change: SnapshotChange) => {
    setState((previous) => ({ snapshot: change.snapshot, error: undefined, busy: previous.busy }))
  }, [])
  useEffect(() => {
    if (!visible || typeof EventSource === 'undefined') return
    const source = new EventSource(`${ROUTE_PREFIX}/${ROUTE_ACTIONS.events}`)
    const onFrame = (event: Event): void => {
      try {
        apply(JSON.parse(String((event as MessageEvent).data)) as SnapshotChange)
      } catch {
        // A frame the panel cannot read is one poll away; the connection stays.
      }
    }
    source.addEventListener('hello', onFrame)
    source.addEventListener('change', onFrame)
    source.addEventListener('open', () => setPushed(true))
    source.addEventListener('error', () => setPushed(false))
    return () => {
      source.close()
      setPushed(false)
    }
  }, [visible, apply])
  useEffect(() => {
    if (!visible || pushed) return
    void load()
    const timer = setInterval(() => void load(), Math.max(1_000, refreshMs))
    return () => clearInterval(timer)
  }, [visible, pushed, refreshMs, load])
  /**
   * Run one action. The method comes from {@link routeInit}, so an action with
   * no payload is still a `POST`.
   * @param path - route action under `ROUTE_PREFIX`.
   * @param body - JSON body, when the action takes one.
   */
  const run = useCallback(async (path: string, body?: unknown) => {
    setState((previous) => ({ ...previous, busy: true }))
    try {
      setState({ snapshot: await request(path, body), error: undefined, busy: false })
    } catch (error) {
      setState((previous) => ({ ...previous, busy: false, error: messageOf(error) }))
    }
  }, [])
  /**
   * Run one action once per body, and set the picture once.
   *
   * The pin route writes exactly one name per call (`PinRequest`), so a server's
   * worth of names is a fan-out rather than one request — and a server-level
   * press is one intent, so it deserves one repaint: the requests go out
   * together and the last body's answer becomes the picture, instead of the
   * panel painting itself once per name and racing its own writes.
   *
   * That answer is the state *after* the last write of the batch, not
   * necessarily after the last one to settle: the host answers every call with
   * the whole picture, so a straggler's effect arrives with the next pushed
   * frame or poll, and the panel's own error line reports a refusal either way.
   * @param path - route action under `ROUTE_PREFIX`.
   * @param bodies - one body per write; nothing is sent for an empty batch.
   */
  const runAll = useCallback(async (path: string, bodies: readonly unknown[]) => {
    if (bodies.length === 0) return
    setState((previous) => ({ ...previous, busy: true }))
    try {
      const answers = await Promise.all(bodies.map((body) => request(path, body)))
      const fresh = answers[answers.length - 1]
      setState((previous) =>
        fresh === undefined
          ? { ...previous, busy: false }
          : { snapshot: fresh, error: undefined, busy: false },
      )
    } catch (error) {
      setState((previous) => ({ ...previous, busy: false, error: messageOf(error) }))
    }
  }, [])
  return { ...state, run, runAll, reload: load }
}

/**
 * Just enough of `Storage` for the log-filter and Clear-mark helpers, so tests
 * need no DOM. The tab has no mode to remember since F-26: one surface means one
 * screen, and browser-local storage only carries the ring's own filters.
 */
export interface PanelStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** The browser's storage, or undefined when this half runs without one. */
export function browserStorage(): PanelStorage | undefined {
  try {
    return (globalThis as { localStorage?: PanelStorage }).localStorage
  } catch {
    // Reading the property itself throws when a policy blocks storage.
    return undefined
  }
}

/**
 * Read one preference out of browser-local storage.
 *
 * Both the tab and the Settings page persist a single small choice; every
 * storage access is guarded, so a policy that blocks storage (or a browser
 * without one) only costs the choice at the next reload.
 * @param key - storage key.
 * @param storage - storage to read; defaults to the browser's own.
 * @returns the stored string, or undefined when absent or unavailable.
 */
export function storedString(
  key: string,
  storage: PanelStorage | undefined = browserStorage(),
): string | undefined {
  try {
    return storage?.getItem(key) ?? undefined
  } catch {
    // Reading the property itself throws when a policy blocks storage.
    return undefined
  }
}

/**
 * Persist one preference; a storage that refuses the write only costs the
 * choice at the next reload.
 * @param key - storage key.
 * @param value - value to store.
 * @param storage - storage to write; defaults to the browser's own.
 */
export function storeString(
  key: string,
  value: string,
  storage: PanelStorage | undefined = browserStorage(),
): void {
  try {
    storage?.setItem(key, value)
  } catch {
    // Storage disabled: the value still applies until the page is reloaded.
  }
}

/**
 * Read the poll interval out of browser-local storage.
 *
 * A missing, unreadable or nonsensical value is not an error: the panel falls
 * back to {@link DEFAULT_REFRESH_MS}, exactly as it did when the value arrived
 * in an untyped plugin-settings blob.
 * @param storage - storage to read; defaults to the browser's own.
 * @returns the stored interval in milliseconds, or the default.
 */
export function storedRefreshMs(storage: PanelStorage | undefined = browserStorage()): number {
  const raw = storedString(REFRESH_STORAGE_KEY, storage)
  if (raw === undefined) return DEFAULT_REFRESH_MS
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_REFRESH_MS
}

/**
 * The poll interval as a live preference.
 *
 * Two surfaces read it — the panel it paces and the settings that change it —
 * and they are not in one tree (the settings live in the tab's actions menu), so
 * the value needs a seat both can subscribe to. The store is the same shape the
 * toast stack uses: a value, a setter, and listeners for whoever renders it.
 * Writes go to browser storage first, so a reload keeps the interval even when
 * no surface is left to re-render.
 */
export interface RefreshStore {
  /** The current interval in milliseconds. */
  get(): number
  /** Persist and publish a new interval; a value the surface cannot render is the caller's business. */
  set(value: number): void
  /** Subscribe to changes; the returned function unsubscribes. */
  subscribe(listener: () => void): () => void
}

/**
 * Build a {@link RefreshStore} on top of browser storage.
 * @param storage - storage to read and write; defaults to the browser's own.
 * @returns the store, seeded from what is already persisted.
 */
export function createRefreshStore(
  storage: PanelStorage | undefined = browserStorage(),
): RefreshStore {
  let value = storedRefreshMs(storage)
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (next: number): void => {
      if (!Number.isFinite(next) || next <= 0 || next === value) return
      value = next
      storeString(REFRESH_STORAGE_KEY, String(next), storage)
      for (const listener of listeners) listener()
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/**
 * Read the store as a re-rendering hook.
 * @param store - the store to follow.
 * @returns the current interval, re-read after every change.
 */
export function useRefreshMs(store: RefreshStore): number {
  const [value, setValue] = useState(() => store.get())
  useEffect(() => store.subscribe(() => setValue(store.get())), [store])
  return value
}

/**
 * Which sessions the Logs tab reads: the tab's own session, or every session of
 * the project. The mockup offers exactly these two.
 */
export type LogScope = 'session' | 'all'

/** Which levels the Logs tab reads: everything, or the failures only. */
export type LogLevelFilter = 'all' | 'error'

/** `localStorage` key of the Logs tab's session-scope filter. */
export const LOG_SCOPE_KEY = `${TAB_ID}:logsScope`

/** `localStorage` key of the Logs tab's level filter. */
export const LOG_LEVEL_KEY = `${TAB_ID}:logsLevel`

/**
 * `localStorage` key of the Logs tab's **client-side** Clear mark.
 *
 * `Clear` has no route (see the frozen contract, C1): the tab remembers the
 * moment and stops drawing events at or before it. The host's ring is untouched,
 * so a later `Sync` still answers with the whole buffer.
 */
export const LOGS_CLEARED_KEY = `${TAB_ID}:logsClearedAt`

/** Scope read when nothing valid is persisted: this tab's own session. */
export const DEFAULT_LOG_SCOPE: LogScope = 'session'

/**
 * Level read when nothing valid is persisted: errors only.
 *
 * The ring records the whole lifecycle, and at a project's first step that is a
 * wall of `mounting`/`is up` lines; the owner asked for the tab to answer "did
 * anything break" before it answers anything else. Every level is one click
 * away, and a level the user chose is persisted and wins over this default.
 */
export const DEFAULT_LOG_LEVEL: LogLevelFilter = 'error'

/**
 * Events one snapshot carries and one `GET logs` page answers with.
 *
 * A mirror of the host's `LOG_PAGE_SIZE` (`src/logs.ts`), not a second owner of
 * the rule: the client asks for a page and reads what it is handed.
 */
export const LOG_PAGE_SIZE = 50

/**
 * Read the persisted session-scope filter.
 * @param storage - storage to read; defaults to the browser's own.
 * @returns the stored scope, or {@link DEFAULT_LOG_SCOPE}.
 */
export function logScopeOf(storage: PanelStorage | undefined = browserStorage()): LogScope {
  return storedString(LOG_SCOPE_KEY, storage) === 'all' ? 'all' : DEFAULT_LOG_SCOPE
}

/**
 * Read the persisted level filter.
 *
 * Both stored values are answered as themselves; only an unknown or absent
 * entry falls back to {@link DEFAULT_LOG_LEVEL}. Testing against the default
 * instead would silently swallow the other valid value whenever the default
 * changes — the filter has two states, so both are named here.
 * @param storage - storage to read; defaults to the browser's own.
 * @returns the stored filter, or {@link DEFAULT_LOG_LEVEL}.
 */
export function logLevelOf(storage: PanelStorage | undefined = browserStorage()): LogLevelFilter {
  const stored = storedString(LOG_LEVEL_KEY, storage)
  return stored === 'all' || stored === 'error' ? stored : DEFAULT_LOG_LEVEL
}

/**
 * Read the Clear mark.
 * @param storage - storage to read; defaults to the browser's own.
 * @returns the epoch ms of the last Clear, or undefined when none was pressed.
 */
export function logsClearedAt(storage: PanelStorage | undefined = browserStorage()): number | undefined {
  const stored = storedString(LOGS_CLEARED_KEY, storage)
  if (stored === undefined) return undefined
  const at = Number(stored)
  return Number.isFinite(at) ? at : undefined
}

/**
 * Persist one of the Logs tab's own choices.
 * @param key - {@link LOG_SCOPE_KEY} or {@link LOG_LEVEL_KEY}.
 * @param value - the choice to store.
 * @param storage - storage to write; defaults to the browser's own.
 */
export function persistLogFilter(
  key: string,
  value: string,
  storage: PanelStorage | undefined = browserStorage(),
): void {
  storeString(key, value, storage)
}

/**
 * Record a Clear: events at or before `at` stop being drawn from now on.
 * @param at - the moment Clear was pressed, in epoch ms.
 * @param storage - storage to write; defaults to the browser's own.
 */
export function persistLogsClearedAt(
  at: number,
  storage: PanelStorage | undefined = browserStorage(),
): void {
  storeString(LOGS_CLEARED_KEY, String(at), storage)
}

/** One page of events as `GET logs` answers it (contract C1). */
export interface LogPage {
  /** Events, oldest first. */
  readonly events: readonly LogEvent[]
  /** How many events the project's ring holds in total. */
  readonly total: number
  /** Whether the ring holds events older than the last one on this page. */
  readonly more: boolean
}

/** Build the `GET logs` query for one page request. */
function logsQuery(projectRoot: string, before: number | undefined, limit: number): URLSearchParams {
  const query = new URLSearchParams({ projectRoot, limit: String(limit) })
  if (before !== undefined) query.set('before', String(before))
  return query
}

/**
 * Read one page of older events over the contract's `GET logs` route.
 *
 * The snapshot carries the newest {@link LOG_PAGE_SIZE} events; "show older"
 * asks the route for the page before the oldest one on screen. `before` is the
 * exclusive cursor the host pages on (`at < before`).
 * @param projectRoot - project the page belongs to.
 * @param before - epoch ms to page before; the snapshot page is requested without one.
 * @param limit - page size; {@link LOG_PAGE_SIZE} unless a test asks otherwise.
 * @param fetchImpl - `fetch` to use; defaults to the browser's.
 * @returns the page, or `undefined` when the host refused or the answer was unreadable.
 */
export async function fetchLogs(
  projectRoot: string,
  before?: number,
  limit: number = LOG_PAGE_SIZE,
  fetchImpl: typeof fetch | undefined = (globalThis as { fetch?: typeof fetch }).fetch,
): Promise<LogPage | undefined> {
  if (fetchImpl === undefined) return undefined
  // The action is read out of the shared registry, so this route has one owner:
  // adding it there (contract C1) is what makes this line compile.
  const action = (ROUTE_ACTIONS as Record<string, string | undefined>).logs
  if (action === undefined) return undefined
  try {
    const query = logsQuery(projectRoot, before, limit)
    const response = await fetchImpl(`${ROUTE_PREFIX}/${action}?${query.toString()}`)
    const payload = (await response.json()) as Envelope<LogPage>
    if (payload.ok !== true || payload.value === undefined) return undefined
    return payload.value
  } catch {
    return undefined
  }
}

/**
 * What one opened row's definition costs to answer, and what is already known
 * about it: the one place a `GET tool` answer is held (F-56).
 *
 * One cache for the module, keyed by the route's own three parameters, rather
 * than one per mount. The answer is a fact about the name, not about a render —
 * folding a row and opening it again must not re-read the host, and the design
 * stand seeds this map directly instead of mounting a host to fake one. The key
 * carries the project and the session because the route takes them and two
 * surfaces of the panel may read different ones in one process.
 *
 * An entry is written **only** by answers that arrived: a fetch in flight is in
 * {@link toolFactsPending} and a failed one in {@link toolFactsFailed}, so a
 * mount that skipped the tool routes pulls in no fixture code and draws no
 * invented answer.
 */
interface ToolFactsEntry {
  readonly projectRoot: string
  readonly sessionId: string
  readonly name: string
}

const TOOL_FACTS_SEPARATOR = '\u0000'
const toolFacts = new Map<string, ToolFacts>()
const toolFactsPending = new Set<string>()
const toolFactsFailed = new Set<string>()

/** The cache key of one `GET tool` answer. */
function toolFactsKey(projectRoot: string, sessionId: string, name: string): string {
  return [projectRoot, sessionId, name].join(TOOL_FACTS_SEPARATOR)
}

/** Build the `GET tool` query for one opened row's definition. */
function toolFactsQuery(projectRoot: string, sessionId: string, name: string): URLSearchParams {
  return new URLSearchParams({ projectRoot, sessionId, name })
}

/**
 * Read one tool's facts over the contract's `GET tool` route.
 *
 * The snapshot carries no definition, and cannot: a description and a schema are
 * the expensive part of a tool, while every change frame and every poll carries
 * the whole snapshot. This route is therefore read once per row the reader
 * opens, exactly as `GET logs` is read once per page — and it answers a
 * **deferred** name the same way as an offered one, because the definition is
 * read from the scope the bridge registered it in and not from the offer.
 * Unknown names answer `ok: false` and are indistinguishable here from a refusal,
 * which is the route's own decision: the panel draws its one failure line.
 * @param projectRoot - project the definition belongs to.
 * @param sessionId - session the row is open in; the host scopes the read to it.
 * @param name - public registry name, eg `mcp__tglider__workspace`.
 * @param fetchImpl - `fetch` to use; defaults to the browser's.
 * @returns the facts, or `undefined` when the host refused or the answer was unreadable.
 */
export async function fetchToolFacts(
  projectRoot: string,
  sessionId: string,
  name: string,
  fetchImpl: typeof fetch | undefined = (globalThis as { fetch?: typeof fetch }).fetch,
): Promise<ToolFacts | undefined> {
  if (fetchImpl === undefined) return undefined
  // Read out of the shared registry like `logs`, so a build whose contract has
  // no `tool` action asks for nothing rather than for a route nobody serves.
  const action = (ROUTE_ACTIONS as Record<string, string | undefined>).tool
  if (action === undefined) return undefined
  try {
    const query = toolFactsQuery(projectRoot, sessionId, name)
    const response = await fetchImpl(`${ROUTE_PREFIX}/${action}?${query.toString()}`)
    const payload = (await response.json()) as Envelope<ToolFacts>
    if (payload.ok !== true || payload.value === undefined) return undefined
    return payload.value
  } catch {
    return undefined
  }
}

/**
 * The facts known about one name, asked for at most once per route.
 *
 * Called from the render of a row that is open — the only moment the answer is
 * wanted — so a folded row costs nothing. A synchronous answer already in the
 * map is returned now; otherwise the read starts once and the caller draws
 * {@link toolFactsLoading}'s line until the promise settles and re-renders. The
 * name-only entry is read first because that is where a seeded stand writes, and
 * a definition is the same record whichever panel asked for it.
 * @param entry - the route's own parameters.
 * @returns the facts while they are held; `undefined` while the read is on its way.
 */
function toolFactsOf(entry: ToolFactsEntry): ToolFacts | undefined {
  const seeded = toolFacts.get(entry.name)
  if (seeded !== undefined) return seeded
  const key = toolFactsKey(entry.projectRoot, entry.sessionId, entry.name)
  const held = toolFacts.get(key)
  if (held !== undefined || toolFactsPending.has(key) || toolFactsFailed.has(key)) return held
  toolFactsPending.add(key)
  void fetchToolFacts(entry.projectRoot, entry.sessionId, entry.name).then((facts) => {
    toolFactsPending.delete(key)
    if (facts === undefined) toolFactsFailed.add(key)
    else toolFacts.set(key, facts)
  })
  return undefined
}

/** `true` once the host refused to answer for this name. */
function toolFactsUnreadable(entry: ToolFactsEntry): boolean {
  return toolFactsFailed.has(toolFactsKey(entry.projectRoot, entry.sessionId, entry.name))
}

/**
 * Publish one definition into the panel's cache, as the design mode's own host
 * would answer.
 *
 * The stand renders the same components with no host at all, so the body of an
 * opened row would sit on a read that never resolves. Seeding the very map the
 * product reads — rather than a second "fixture mode" branch inside the row —
 * is what keeps the product's drawing and the stand's one drawing: `view.ts`
 * has no code path that knows whether the answer came from a socket. The entry is
 * written under the name alone, which is the key a row with no route of its own
 * looks up; a panel that does hold one looks there first, for the same reason.
 * @param name - the public registry name the record answers about.
 * @param facts - the record the fixture host publishes for that name.
 */
export function seedToolFacts(name: string, facts: ToolFacts): void {
  toolFacts.set(name, facts)
}

/**
 * Forget every held definition.
 *
 * Exported for the specs: one process renders several panels for several
 * projects, and an answer held for one of them must not decide another's body.
 * The product never calls this — a definition does not change while a panel is
 * mounted.
 */
export function clearToolFacts(): void {
  toolFacts.clear()
  toolFactsPending.clear()
  toolFactsFailed.clear()
}

/**
 * The events one session's ring holds, as the logs disclosure's badge counts them.
 *
 * The snapshot field is the **session's** own count (contract C1) — not the
 * project's — so the badge answers "how much happened here" rather than "how
 * busy is this folder".
 * @param session - the session, or undefined when the tab has none.
 * @returns the session's event count, `0` when the field is absent.
 */
export function sessionLogCount(session: { readonly logCount?: number } | undefined): number {
  return session?.logCount ?? 0
}

/**
 * Keep the newest `at`-time first, and drop the duplicates a page overlap can
 * produce, so "show older" appends rather than repeats.
 * @param older - the page just read.
 * @param shown - what is already on screen.
 * @returns the merged list, newest first.
 */
export function mergeLogs(older: readonly LogEvent[], shown: readonly LogEvent[]): LogEvent[] {
  const seen = new Set(shown.map((event) => `${event.at}:${event.level}:${event.message}`))
  const fresh = older.filter((event) => !seen.has(`${event.at}:${event.level}:${event.message}`))
  return [...shown, ...fresh]
}

/**
 * Whether the ring holds events older than the ones on screen, and where the
 * next page starts.
 *
 * The exclusive cursor is the oldest event drawn, which is what the host pages
 * on. A cursor already asked for is spent: a page that added nothing the filters
 * let through must not ask for itself again, or a short session inside a busy
 * project would loop. Absent a project total the client trusts the snapshot's
 * own length, so a host half that predates `logCount` simply draws no button.
 * @param props - the visible events, the project's total, and the cursors already asked for.
 * @returns `more` and the `cursor` the next page starts at.
 */
export function logsPaging(props: {
  visible: readonly LogEvent[]
  total: number
  attempted: readonly number[]
}): { more: boolean; cursor: number | undefined } {
  const cursor = props.visible.at(-1)?.at
  return {
    more: props.visible.length < props.total && cursor !== undefined && !props.attempted.includes(cursor),
    cursor,
  }
}

/**
 * The empty state of the Logs tab: nothing recorded yet, and where to look.
 * @param t - translate seat.
 * @returns the element, so the copy can be asserted without a DOM.
 */
export function logsEmptyState(t: Translate): ReactNode {
  return emptyState(t('logsEmptyTitle'), t('logsEmptyHint'), 'logs-empty')
}

/**
 * The empty state of the level filter, not of the ring.
 *
 * The tab opens on `errors`; a project whose ring holds only `mounting`/`is up`
 * lines would otherwise read "no events yet" while the counter beside the
 * disclosure's badge says it holds several. Saying so is the difference between a quiet
 * project and a hidden list.
 * @param t - translate seat.
 * @returns the element, keyed for the array {@link logList} returns.
 */
export function logsNoErrorsState(t: Translate): ReactNode {
  return emptyState(t('logsNoErrorsTitle'), t('logsNoErrorsHint'), 'logs-empty')
}

/**
 * The one project this tab belongs to: the project whose live sessions include
 * the tab's session. A tab never shows another project — the settings popup and
 * the native settings page are the surfaces with the whole picture.
 * @param snapshot - host snapshot, or undefined before the first poll lands.
 * @param sessionId - the session this tab is open in.
 * @returns the matching project, or undefined when there is none (yet).
 */
export function currentProject(
  snapshot: McpSnapshot | undefined,
  sessionId: string | undefined,
): ProjectSnapshot | undefined {
  if (snapshot === undefined || sessionId === undefined) return undefined
  return snapshot.projects.find(
    (project) =>
      project.sessionIds.includes(sessionId) ||
      (project.sessions ?? []).some((session) => session.id === sessionId),
  )
}

/**
 * Statuses the "Problems" view lists, most actionable first. The quiet states —
 * `active`, `idle`, `disabled` — are answers, not problems.
 */
export const PROBLEM_STATUSES = ['error', 'conflict', 'connecting'] as const

/** One status and the rows currently in it. */
export interface StatusGroup {
  status: ServerStatus
  rows: ServerRow[]
}

/**
 * Split merged rows into the groups the "Problems" view shows.
 * @param rows - merged project rows, in document order.
 * @returns one entry per non-empty group, in {@link PROBLEM_STATUSES} order.
 */
export function statusGroups(rows: readonly ServerRow[]): StatusGroup[] {
  const groups: StatusGroup[] = []
  for (const status of PROBLEM_STATUSES) {
    const matching = rows.filter((row) => row.status === status)
    if (matching.length > 0) groups.push({ status, rows: matching })
  }
  return groups
}

/**
 * Tab body: the project this session works in, and nothing else.
 *
 * The whole picture — every project with a live session — lives in the side card
 * settings popup, not in a tab that belongs to one conversation.
 */
export function ProjectMcpPanel(props: {
  visible: boolean
  sessionId: string | undefined
  refreshMs: number
  /**
   * The shell's translate seat for this namespace. Required on purpose: the
   * panel is one of the surfaces whose copy must follow the language
   * preference, so `./index.ts` composes it with the seat from `./tab-locale.ts`
   * rather than letting a missing prop silently fall back to English.
   */
  t: Translate
  /**
   * Host-namespace seat for the Logs tab's coded events (F-48); without one
   * the events render their payload's English, byte-identical to before codes.
   */
  hostT?: Translate | undefined
}): ReactNode {
  const t = props.t
  const { snapshot, error, busy, run, runAll } = useSnapshot(props.visible, props.refreshMs)
  const project = currentProject(snapshot, props.sessionId)
  const groups = project === undefined ? [] : statusGroups(project.rows)
  const policy = project === undefined ? undefined : policyOf(project)
  // The Logs disclosure counts this session's own events, not the project's: the
  // number the contract puts on `SessionSnapshot.logCount` (C1). A host half
  // without the field reports `0`, which the block prints as a real `0`.
  const session = (project?.sessions ?? []).find((entry) => entry.id === props.sessionId)
  const logsSession = sessionLogCount(session)
  // The pin keeps its own route and answers with the fresh snapshot, so the
  // panel's own `run` carries it: a refusal lands in the same line as every
  // other host refusal instead of being swallowed by a silent refresh.
  const onPin = useCallback(
    (tool: string, pinned: boolean): void => {
      if (project === undefined) return
      void run(ROUTE_ACTIONS.pin, pinBody(project.projectRoot, tool, pinned))
    },
    [project, run],
  )
  // A server's worth of names is one intent and one press (F-44): the names come
  // from the surface that showed them, the direction from what the project
  // already pins, and the writes go out as one batch.
  const onPinServer = useCallback(
    (server: string, names: readonly string[]): void => {
      if (project === undefined) return
      const press = serverPinPress(names, policy?.pins ?? [])
      void runAll(
        ROUTE_ACTIONS.pin,
        press.names.map((name) => pinBody(project.projectRoot, name, press.pinned)),
      )
    },
    [project, policy, runAll],
  )
  // Both operator actions are scoped to the project this tab shows: the panel
  // answers with that project's slice, and the host never starts a server for
  // another project because a row here was retried. Without a project there is
  // nothing to scope, so the request stays the global one it always was.
  const retry = useCallback(
    (): void => void run(ROUTE_ACTIONS.retry, operatorBody(project?.projectRoot)),
    [project, run],
  )
  const sync = useCallback(
    (): void => void run(ROUTE_ACTIONS.sync, operatorBody(project?.projectRoot)),
    [project, run],
  )
  const release = useCallback(
    (sessionId: string): void => void run(ROUTE_ACTIONS.release, { sessionId }),
    [run],
  )
  return h(
    'div',
    { style: STYLE.root },
    h(PanelHeader, {
      project,
      sessions: project?.sessionIds.length ?? 0,
      busy,
      onSync: sync,
      t,
    }),
    h(
      'div',
      { style: STYLE.body },
      // The host's refusal is the body's first line, so the toolbar is the
      // body's immediate sibling in the panel (the contract's own gate anchor)
      // whatever the read did.
      error === undefined ? null : h('div', { style: STYLE.error }, error),
      tabBody({
        project,
        sessionId: props.sessionId,
        groups,
        busy,
        policy,
        onPin,
        onPinServer,
        onRelease: release,
        onRetry: retry,
        sessionLogCount: logsSession,
        t,
        hostT: props.hostT,
      }),
    ),
  )
}

/**
 * The one-phrase reading of the toolbar's right edge.
 *
 * F-26 left the surface with one screen and no mode to branch on, so the phrase
 * answers the one question no block above it answers on its own: how many
 * sessions the project has. The problems block badges its own groups, the logs
 * block its own events, and the tools block its own counters, so nothing here
 * repeats them.
 * @param props - the project's session count.
 * @param t - translate seat.
 * @returns the phrase the toolbar's right edge prints.
 */
export function panelSummary(props: { sessions: number }, t: Translate): string {
  return sessionCount(props.sessions, t)
}

/** Everything the tab's toolbar reads. */
export interface PanelHeaderProps {
  /** The tab's own project, or undefined when its session has none. */
  project: ProjectSnapshot | undefined
  /** Sessions attached to the project; what the right edge counts. */
  sessions: number
  busy: boolean
  onSync: () => void
  t: Translate
}

/**
 * The tab's one toolbar row.
 *
 * The project's own header — the folder, the `this session` chip that says whose
 * tab this is, the summary phrase and the action at the right edge. The segment
 * bar that used to be the second row is gone (F-26): there is one screen, so
 * there is nothing to switch. Pure and exported: the panel around it owns the
 * poll and the state.
 * @param props - see {@link PanelHeaderProps}.
 * @returns the toolbar row.
 */
export function PanelHeader(props: PanelHeaderProps): ReactNode {
  const { t, project } = props
  return h(
    'div',
    { style: STYLE.bar },
    project === undefined
      ? h('span', { style: STYLE.muted }, t('noProjectLabel'))
      : h(
          'span',
          { style: STYLE.name, title: project.projectRoot },
          basename(project.projectRoot),
        ),
    project === undefined ? null : h('span', { style: STYLE.tag }, t('thisSession')),
    h('span', { style: { flex: 1 } }),
    h('button', { style: STYLE.button, disabled: props.busy, onClick: props.onSync }, t('sync')),
    // The toolbar's right edge is the mockup's `.dim`
    // (`docs/design/mockups/harness.html`, `.dim` — the tertiary tone):
    // one phrase, at the tertiary tone, and the only summary reading in the bar.
    h('span', { style: STYLE.dim }, panelSummary({ sessions: props.sessions }, t)),
  )
}

/** Everything the tab renders under its toolbar. */
export interface TabBodyProps {
  /** The tab's own project, or undefined when this session has none. */
  project: ProjectSnapshot | undefined
  /** Session this tab is open in. */
  sessionId: string | undefined
  /** Problem groups of {@link project}, precomputed by the panel. */
  groups: StatusGroup[]
  busy: boolean
  /** The project's policy, precomputed by the panel; read from the project when absent. */
  policy?: ToolPolicy | undefined
  /** Pin or unpin one tool of {@link project}; absent while nothing can be written. */
  onPin?: ((tool: string, pinned: boolean) => void) | undefined
  /**
   * Pin every name of one server in one press (F-44); absent while nothing can
   * be written. The names are the ones the surface that called it lists — the
   * hidden tier's own names — and the expansion into names is the whole
   * meaning: the host stores no server pin (`docs/design/contracts/policy.md`).
   */
  onPinServer?: ((server: string, names: readonly string[]) => void) | undefined
  /**
   * Retry every failed mount of {@link project}; absent while nothing can be
   * written. The host route is project-scoped, so a row's own `Retry` sends the
   * request the errors block's button sends.
   */
  onRetry?: (() => void) | undefined
  onRelease: (sessionId: string) => void
  /** Events of this tab's own session, at the moment the snapshot was taken. */
  sessionLogCount?: number
  /** Storage the Logs block persists its filters and Clear mark in. */
  storage?: PanelStorage | undefined
  /** Translate seat; falls back to this module's English copy without one. */
  t?: Translate
  /** Host-namespace seat for the Logs block's coded events (F-48). */
  hostT?: Translate | undefined
}

/**
 * What to add where, said from the host's own document list.
 *
 * The files a project is read from are a config fact — `ProjectSnapshot.files`,
 * published in read order — so the empty state names the project's own documents
 * instead of a path baked into this bundle, and says plainly when the deployment
 * reads none at all. A host older than the field reports nothing, and then no
 * file name is promised: the hint speaks about declaring one, not about a path
 * that host may never read.
 */
function declaredHint(project: ProjectSnapshot, t: Translate): string {
  const files = project.files
  // No list at all is a host older than the field, and then no file name is
  // promised: the hint asks for a document without naming a path that host may
  // never read.
  if (files === undefined) return t('noServersDeclaredUnknown')
  const documents = files.filter((file) => file.scope === 'project').map((file) => file.path)
  if (documents.length === 0) return t('noServersDeclaredNowhere')
  return t('noServersDeclaredHint', { documents: documents.join(' · ') })
}

/**
 * The tab body: one screen, its blocks in the contract's order.
 *
 * F-26 folded the four modes into one surface, so the body is a list of blocks
 * rather than a branch: the session's declared servers, the sessions that
 * disagree with the project (F-24's section, still only while some do), the tool
 * offer, and the two disclosures — the problems, only while there are any, and
 * the event ring, always. Every situation where a surface has nothing to list
 * still answers for itself above the blocks.
 * @param props - see {@link TabBodyProps}.
 * @returns the blocks below the toolbar, in order.
 */
export function tabBody(props: TabBodyProps): ReactNode {
  const t = translateOf(props.t)
  if (props.sessionId === undefined) {
    return emptyState(t('noSession'), t('noSessionHint'))
  }
  const { project } = props
  if (project === undefined) {
    return emptyState(t('noProject'), t('noProjectHint'))
  }
  // This session's own rows, not the merged project view: what this conversation
  // resolves is the first thing the screen answers (`sessionRowsOf`).
  const rows = sessionRowsOf(project, props.sessionId)
  const sessions = sessionBreakdown(project, props.sessionId, t)
  const disagreeing = sessions.filter((session) => session.deviates)
  return [
    rows.length === 0
      ? emptyState(t('noServersDeclared'), declaredHint(project, t), 'servers')
      : h(ServersBlock, {
          key: 'servers',
          rows,
          usage: project.usage,
          t,
          hostT: props.hostT,
          onRetry: props.onRetry,
          busy: props.busy,
        }),
    // The F-24 disagreement view. The merged project rows are no longer drawn
    // here — the block above is this session's own reading — but `Release` for a
    // single session still lives only in this section.
    h(SessionList, {
      key: 'sessions',
      sessions: disagreeing,
      busy: props.busy,
      onRelease: props.onRelease,
      merged: sessions.length > 1,
      t: props.t,
      hostT: props.hostT,
    }),
    h(ToolsSection, {
      key: 'tools',
      project,
      sessionId: props.sessionId,
      policy: props.policy,
      onPin: props.onPin,
      onPinServer: props.onPinServer,
      pending: props.busy,
      t,
      hostT: props.hostT,
    }),
    // The errors disclosure exists only while there are problem groups; there is
    // no "all quiet" copy to draw, because an absent block is the quiet answer.
    props.groups.length === 0
      ? null
      : h(
          Disclosure,
          {
            key: 'errors',
            label: t('errorsSection'),
            count: props.groups.length,
            showHint: t('showErrors'),
            hideHint: t('hideErrors'),
            body: [
              h(IssueView, {
                key: 'issues',
                project,
                groups: props.groups,
                onRetry: props.onRetry,
                busy: props.busy,
                t,
                hostT: props.hostT,
              }),
              // `Retry failed` used to sit on the mode bar; the errors block is
              // where the action belongs now that the bar is gone.
              props.onRetry === undefined
                ? null
                : h(
                    'button',
                    {
                      key: 'retry',
                      style: STYLE.button,
                      title: t('retryHint'),
                      disabled: props.busy,
                      onClick: props.onRetry,
                    },
                    t('retryFailed'),
                  ),
            ],
            t,
          },
        ),
    h(Disclosure, {
      key: 'logs',
      label: t('logsSection'),
      count: props.sessionLogCount ?? 0,
      showHint: t('showLogs'),
      hideHint: t('hideLogs'),
      body: h(LogsView, {
        project,
        sessionId: props.sessionId,
        t,
        hostT: props.hostT,
        storage: props.storage,
      }),
      t,
    }),
  ]
}

/**
 * The tools block of the one surface.
 *
 * {@link ToolsView} stays pure — the pure specs resolve it directly — so the
 * row whose detail block is open lives here, one state for the section, the way
 * {@link SessionList} keeps one session open at a time. Exported like the other
 * stateful block so {@link tabBody}'s block order can be asserted by type.
 *
 * The filter panel's query and pressed tiers (F-43) live here for the same
 * reason and outlive a snapshot
 * refresh: a poll repaints the block, and a filter that reset itself every five
 * seconds would be unusable.
 *
 * The filter is this component's own state and is not persisted anywhere: a
 * query is a reading aid for the minute, and the two filters the panel does
 * store — the log ring's — are stored because a page of that ring costs a
 * request. Nothing here does.
 * @param props - what {@link ToolsView} takes.
 * @returns the session's tool offer, with one row open at most.
 */
export function ToolsSection(props: {
  project: ProjectSnapshot
  sessionId: string
  policy?: ToolPolicy | undefined
  onPin?: ((tool: string, pinned: boolean) => void) | undefined
  /** Pin every hidden name of one server in one press (F-44). */
  onPinServer?: ((server: string, names: readonly string[]) => void) | undefined
  pending?: boolean
  t: Translate
  /** Host-namespace seat for the presentation owner's coded note (F-48). */
  hostT?: Translate | undefined
}): ReactNode {
  const [openTool, setOpenTool] = useState<string | undefined>(undefined)
  // Three states, not two: `undefined` is "nobody has pressed the head", and it
  // is what lets the filter open the hidden tier on its own without stealing the
  // press that follows (see {@link ToolsView}'s own `openHidden`).
  const [openHidden, setOpenHidden] = useState<boolean | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [tiers, setTiers] = useState<readonly ToolTier[]>([])
  // The filter this section hands to the block, built once here because the
  // hidden head's own toggle has to know it: the press inverts the state the
  // user is *looking at*, and while a filter is live that state may be the one
  // the filter opened the tier in (`undefined`), not `false`.
  const filter: ToolFilter = { query, tiers }
  const filterActive = toolFilterActive(filter)
  const onToggleTool = useCallback((name: string): void => {
    setOpenTool((current) => (current === name ? undefined : name))
  }, [])
  const onToggleHidden = useCallback((): void => {
    setOpenHidden((value) => !(value ?? filterActive))
  }, [filterActive])
  const onQuery = useCallback((value: string): void => setQuery(value), [])
  const onTier = useCallback((tier: ToolTier): void => {
    setTiers((held) => toggledTier(held, tier))
  }, [])
  const onClearFilter = useCallback((): void => {
    setQuery('')
    setTiers([])
  }, [])
  return h(ToolsView, {
    ...props,
    openTool,
    onToggleTool,
    openHidden,
    onToggleHidden,
    filter,
    onQuery,
    onTier,
    onClearFilter,
  })
}

/**
 * One disclosure of the single surface: a head button and, while it is open, its
 * body.
 *
 * The `div`/`button[aria-expanded]` pair is the shape the parity gate reads a
 * disclosure by, which is why the head is a button of its own and the body is
 * the only thing that appears when it opens. The state is local on purpose: what
 * is folded away is this block's, not the panel's, so the panel keeps rendering
 * one pure tree per snapshot.
 */
/**
 * The head one disclosure draws: toggled marker, label and the count badge.
 *
 * A pure function of its props on purpose. {@link Disclosure} is a component
 * with state, and the tools block is a pure tree of elements resolved by tests
 * without a React runtime — a stateful child in that tree would be invoked
 * outside a component and break the walk. The tiers that must be pure (the
 * hidden list) draw this head themselves and keep their open state one level up,
 * which is why the head exists apart from the wrapper that usually wears it.
 * @param props - label, count, open state and the head's tooltip.
 * @returns the `button[aria-expanded]` the parity gate reads a disclosure by.
 */
export function disclosureHead(props: {
  label: string
  count?: number | undefined
  open: boolean
  hint?: string | undefined
  onToggle: () => void
}): ReactNode {
  return h(
    'button',
    {
      style: STYLE.disclosureHead,
      'aria-expanded': props.open,
      title: props.hint,
      onClick: props.onToggle,
    },
    `${props.open ? '▾' : '▸'} ${props.label}`,
    props.count === undefined ? null : h('span', { style: STYLE.tag }, String(props.count)),
  )
}

export function Disclosure(props: {
  /** The head's word-label; the marker is drawn beside it, not stored. */
  label: string
  /** The number the head's badge prints, when it has one. */
  count?: number | undefined
  /** The head's tooltip while the block is open. */
  showHint?: string | undefined
  /** The head's tooltip while the block is closed. */
  hideHint?: string | undefined
  /** What the head reveals; rendered only while the disclosure is open. */
  body: ReactNode
  /** Translate seat; falls back to this module's English copy without one. */
  t?: Translate | undefined
}): ReactNode {
  const [open, setOpen] = useState(false)
  return h(
    'div',
    { style: STYLE.disclosure },
    disclosureHead({
      label: props.label,
      count: props.count,
      open,
      hint: open ? props.hideHint : props.showHint,
      onToggle: (): void => setOpen((value) => !value),
    }),
    open ? h('div', { style: STYLE.disclosureBody }, props.body) : null,
  )
}

/**
 * The session's own tool offer, when the host half published one.
 * @param project - the project this tab belongs to.
 * @param sessionId - the tab's session.
 * @returns the per-session `tools`, or undefined when the host has none yet.
 */
export function sessionToolsOf(
  project: ProjectSnapshot,
  sessionId: string | undefined,
): SessionTools | undefined {
  if (sessionId === undefined) return undefined
  const sessions = (project.sessions ?? []) as readonly { id: string; tools?: SessionTools }[]
  return sessions.find((session) => session.id === sessionId)?.tools
}

/**
 * The declared servers of the session this tab belongs to: the session's own
 * rows when the host published that session, the project's merged rows
 * otherwise.
 *
 * Per-session rows, not the merged project view: with the own-scope fallback a
 * session can run its own instance of a declaration, so its state — running,
 * stalled or released — is what this conversation actually has, and another
 * session of the same project may be in a different one.
 * @param project - the project snapshot the tab read.
 * @param sessionId - the conversation the tab is open in.
 * @returns the declared servers this session resolves.
 */
export function sessionRowsOf(
  project: ProjectSnapshot,
  sessionId: string | undefined,
): readonly ServerRow[] {
  if (sessionId === undefined) return []
  const sessions = (project.sessions ?? []) as readonly { id: string; rows?: ServerRow[] }[]
  const session = sessions.find((entry) => entry.id === sessionId)
  return session === undefined ? project.rows : (session.rows ?? [])
}

/** The three counts the tools block answers for. */
export interface ToolCounts {
  /** Offered because the durable counters proved them hot. */
  pinned: number
  /** Offered because this session disclosed them, from either on-demand tier. */
  disclosed: number
  /** Mounted for the project but not offered in the request. */
  hidden: number
  /** Every tool the model would see: pins plus disclosures. */
  offering: number
}

/**
 * Count one session's offer into the three tiers the mockup names.
 *
 * Real data throughout — it reads only {@link SessionTools} — so every figure it
 * returns is a fact, not an invention.
 * @param tools - one session's tool offer.
 * @returns the pinned, disclosed and hidden counts.
 */
export function toolCounts(tools: SessionTools): ToolCounts {
  const pinned = tools.baseline.length
  const disclosed = tools.activated.length + tools.context.length
  return {
    pinned,
    disclosed,
    hidden: tools.deferred.length,
    offering: pinned + disclosed,
  }
}

/** One server's share of one list of registry names. */
export interface ServerNames {
  /** Registry names one list holds for this server, in that list's own order. */
  readonly names: readonly string[]
  /** Server the tools belong to, or `unknown` when the name is not prefixed. */
  server: string
  /** How many names of that list are this server's. */
  count: number
}

/**
 * The hidden tier's reading of {@link ServerNames}, under the name its callers
 * know it by: the grouping is the same one, only the list differs.
 */
export type HiddenServer = ServerNames

/**
 * Split hidden tool names by the server they were mounted from.
 *
 * The registry's own naming is `mcp__<server>__<tool>` (a project-level prefix
 * is added by `mcp-client` only on a collision), so the server is the second
 * `__`-separated segment. A name that does not follow that shape is counted
 * under `unknown` rather than dropped: the hidden count must stay exact.
 * @param deferred - names the session mounted but did not offer.
 * @returns one entry per server, by descending count, then by name.
 */
export function hiddenByServer(deferred: readonly string[]): HiddenServer[] {
  return byServer(deferred)
}

/**
 * Split the pinned names by the server each one came from (F-44).
 *
 * The pinned tier reads its names per server for the same reason the hidden tier
 * does: a server is the unit a user thinks in when the list gets long, and it is
 * what the one press that releases a whole server acts on. The grouping is
 * {@link hiddenByServer}'s own, so the two tiers of one block order their groups
 * alike — biggest first, then by name — while each keeps its own list's order
 * inside a group.
 * @param pins - the project's pin list, as the host published it.
 * @returns one entry per server, each holding the names it contributed.
 */
export function pinnedByServer(pins: readonly string[]): ServerNames[] {
  return byServer(pins)
}

/**
 * One list of registry names, grouped by the server each name carries.
 *
 * A name without the registry's prefix belongs to no server and is filed under
 * `unknown` rather than dropped or attributed to a made-up one: the group is
 * real even when the name cannot be traced, and a row that vanished would hide a
 * pin the user wrote.
 * @param list - the names to group, in the order they are read in.
 * @returns one entry per server, biggest group first, then by server name.
 */
function byServer(list: readonly string[]): ServerNames[] {
  const names = new Map<string, string[]>()
  for (const name of list) {
    const server = serverOfToolName(name) ?? 'unknown'
    const held = names.get(server)
    if (held === undefined) names.set(server, [name])
    else held.push(name)
  }
  return [...names.entries()]
    .map(([server, held]) => ({ server, count: held.length, names: held }))
    .sort((left, right) => right.count - left.count || left.server.localeCompare(right.server))
}

/**
 * The prefix the registry publishes project MCP tools under, and the server part
 * of one such name — defined in `./usage-view.ts` and re-exported at the top of
 * this module, where the panel's callers have always found them.
 */

/** How much of the disclosure budget the session has spent. */
export interface BudgetSplit {
  /** Tools the model sees. */
  used: number
  /** Tools mounted for the project. */
  total: number
  /** `used / total` as a whole percentage, `0` when nothing is mounted. */
  percent: number
  /** `true` while the surface is over its configured budget. */
  exhausted: boolean
}

/**
 * Split the session's tool offer against the mounted surface: the bar and the
 * tooltip of the budget line. Both numbers are real counts the host published.
 * @param tools - one session's tool offer.
 * @returns the offering against the mounted total.
 */
export function budgetSplit(tools: SessionTools): BudgetSplit {
  const used = toolCounts(tools).offering
  const total = tools.mounted
  return {
    used,
    total,
    percent: total === 0 ? 0 : Math.min(100, Math.round((used / total) * 100)),
    exhausted: tools.deferring,
  }
}

/**
 * One tier of the tools block: the four parts its counter chips count, and the
 * four the filter panel switches between (F-43).
 */
export type ToolTier = 'pinned' | 'counters' | 'disclosed' | 'hidden'

/**
 * The tools block's filter: one query over the registry names, and the tiers the
 * user narrowed the list to.
 *
 * The two halves answer different questions and are kept apart because of it: a
 * query asks "where is this name", a tier asks "show me this rung alone", and
 * the block draws the names that pass both. The filter is the tools block's own
 * state rather than a persisted one — unlike the log ring's filters, which are
 * stored because a page of the ring costs a request — because a query is a
 * reading aid for the minute, and a panel that reopened onto a stale one would
 * read as an empty catalogue.
 */
export interface ToolFilter {
  /** Free text, matched against the registry name; empty passes every name. */
  query: string
  /** Tiers to draw; empty — every tier — is the state the block opens in. */
  tiers: readonly ToolTier[]
}

/** The filter of a block nobody has narrowed, where everything passes. */
export const NO_TOOL_FILTER: ToolFilter = { query: '', tiers: [] }

/**
 * `true` when `name` passes the query.
 *
 * A case-insensitive substring, so `grafana` finds `mcp__grafana-local__query`:
 * the registry name carries its server as its own prefix, and one field answers
 * both readings. The query is trimmed first, because a search field with a
 * trailing space would otherwise match nothing and look broken.
 * @param name - the registry name of the row.
 * @param query - what the user typed.
 * @returns whether the name passes.
 */
export function matchesToolQuery(name: string, query: string): boolean {
  const needle = query.trim().toLowerCase()
  return needle === '' || name.toLowerCase().includes(needle)
}

/**
 * `true` while the filter narrows anything at all — a query, a tier, or both.
 *
 * The block asks this to decide whether it is showing a filtered list: the
 * counts line, the empty state and the hidden tier's own opening all turn on it.
 * @param filter - the block's filter.
 * @returns whether the filter is doing something.
 */
export function toolFilterActive(filter: ToolFilter): boolean {
  return filter.query.trim() !== '' || filter.tiers.length > 0
}

/**
 * `true` when the filter lets this tier through: no tier pressed means every
 * tier, which is the reading the block opens in.
 * @param filter - the block's filter.
 * @param tier - the tier being drawn.
 * @returns whether the tier is drawn.
 */
export function tierVisible(filter: ToolFilter, tier: ToolTier): boolean {
  return filter.tiers.length === 0 || filter.tiers.includes(tier)
}

/**
 * The rows of one tier that pass the query, in the order they were given.
 * @param rows - the tier's rows, already in the block's own order.
 * @param query - what the user typed.
 * @returns the rows to draw.
 */
export function filterToolRows<T extends { name: string }>(rows: readonly T[], query: string): T[] {
  return rows.filter((row) => matchesToolQuery(row.name, query))
}

/**
 * The hidden names that pass the query, grouped by server as they were.
 *
 * A server whose every hidden name is filtered out goes with its count: the
 * group head prints `{server} · {count}` of what is drawn under it, and a head
 * over an empty list would be a number the user cannot spend.
 * @param servers - the hidden names, grouped by server ({@link hiddenByServer}).
 * @param query - what the user typed.
 * @returns the groups that kept at least one name, their counts renumbered.
 */
export function filterHiddenServers(
  servers: readonly HiddenServer[],
  query: string,
): HiddenServer[] {
  const kept: HiddenServer[] = []
  for (const entry of servers) {
    const names = entry.names.filter((name) => matchesToolQuery(name, query))
    if (names.length > 0) kept.push({ server: entry.server, names, count: names.length })
  }
  return kept
}

/**
 * The tier list with one tier toggled: a press adds it, a second press releases
 * it. An empty list means every tier, so releasing the last one hands the block
 * its full list back.
 * @param tiers - the tiers currently pressed.
 * @param tier - the tier the user pressed.
 * @returns the new tier list, in the order the presses happened.
 */
export function toggledTier(tiers: readonly ToolTier[], tier: ToolTier): ToolTier[] {
  return tiers.includes(tier) ? tiers.filter((held) => held !== tier) : [...tiers, tier]
}

/** How much of one server's tool set a project already pins. */
export type ServerPinState = 'all' | 'some' | 'none'

/**
 * How much of one server's names the project already pins (F-44).
 *
 * The question a server-level control answers is about a *set* of names — the
 * ones its own surface lists — so the reading is a proportion and not a flag:
 * `all`, a part, or none. Both surfaces ask it before they draw their switch and
 * again before they write.
 * @param names - the names this control speaks for, as its surface lists them.
 * @param pins - the project's own pin list.
 * @returns the proportion of `names` the pin list holds.
 */
export function serverPinState(
  names: readonly string[],
  pins: readonly string[],
): ServerPinState {
  const held = new Set(pins)
  const pinned = names.filter((name) => held.has(name)).length
  if (pinned === 0) return 'none'
  return pinned === names.length ? 'all' : 'some'
}

/**
 * What one press of a server-level control writes (F-44).
 *
 * A server pin is the names themselves — the same list, the same route — and not
 * a rule of its own: this unit expands a server into its names, so a tool the
 * server mounts later is covered by no earlier press (the limits are in
 * `docs/design/contracts/policy.md`).
 *
 * The direction is the reading's own: a set that is wholly pinned is released,
 * and any other set is completed. A half-pinned server therefore *adds* the
 * names it is missing rather than throwing the pinned ones away, so one press
 * ever moves the set towards a state the user asked for and never loses a pin
 * nobody touched.
 * @param names - the names this control speaks for.
 * @param pins - the project's own pin list.
 * @returns the names to write and the state to write them in. The names are
 * empty only when the set is empty: a set that is wholly pinned is released
 * whole, and any other set has at least one name missing.
 */
export function serverPinPress(
  names: readonly string[],
  pins: readonly string[],
): { pinned: boolean; names: string[] } {
  const held = new Set(pins)
  if (serverPinState(names, pins) === 'all') {
    return { pinned: false, names: names.filter((name) => held.has(name)) }
  }
  return { pinned: true, names: names.filter((name) => !held.has(name)) }
}

/** One counter of the tools vocabulary: which tier, its label, and the count. */
export interface CounterPart {
  /** Tier the counter answers for. */
  key: ToolTier
  /** Locale label of the tier, already translated. */
  label: string
  count: number
}

/**
 * The four counters, one part each.
 *
 * Two of them are tiers of one list and have to be told apart: `pinned` is the
 * user's own pin list, `counters` is the rest of the baseline — the names the
 * durable usage counters proved hot. As one number they could say "2 pinned"
 * over a pin list of one, which is exactly what the block drew before: the
 * sentence promised an action on rows that carried none. The budget still counts
 * both, because both are offered in every request ({@link toolCounts}).
 *
 * One source for every reading of these numbers: the tools block draws one chip
 * per part, and the settings page's Tools rows read the same parts, so the two
 * surfaces can never disagree. A part whose count is zero is not a chip — the
 * block prints numbers, not the absence of them.
 * @param tools - one session's tool offer.
 * @param policy - the project's tool policy, which owns the pin list.
 * @param t - translate seat.
 * @returns pinned, counters, disclosed and hidden, in that order.
 */
export function counterParts(
  tools: SessionTools,
  policy: ToolPolicy,
  t: Translate,
): CounterPart[] {
  const counts = toolCounts(tools)
  const byCounters = tools.baseline.filter((name) => !policy.pins.includes(name)).length
  return [
    { key: 'pinned', label: t('toolsPinned'), count: policy.pins.length },
    { key: 'counters', label: t('toolsByCounters'), count: byCounters },
    { key: 'disclosed', label: t('toolsDisclosed'), count: counts.disclosed },
    { key: 'hidden', label: t('toolsHidden'), count: counts.hidden },
  ]
}

/** A tool row the tools block draws, with the action it offers. */
export interface ToolRow {
  /** Registry name. */
  name: string
  /** `true` when the project's own pin list holds this name, not the counters. */
  pinned?: boolean
  /** Clock time of the last offer or call, as `HH:MM`, when the host published one. */
  time?: string | undefined
  /** Short label shown on the row, when there is one. */
  note?: string | undefined
  /**
   * Both of the host's readings for this row: the project's counter and this
   * session's, and whether the host recorded the row's server at all.
   *
   * The property is absent where the host published nothing for the project,
   * which is what keeps a row the counters never saw from reading as a row of
   * zeroes.
   */
  calls?: ToolCalls | undefined
}

/**
 * The pinned rows to draw: the user's own pin list, then the counter-seeded
 * remainder of the baseline tier.
 *
 * The pin list is the only durable user choice here, so it comes first and is
 * the only part with an `Unpin` action. The rest of `baseline` is offered for
 * the same reason the counters say "pinned": the durable usage counters proved
 * those names hot, and a name that disappeared from the list would make the
 * toolbar's own badge disagree with what is under it. Those rows carry no
 * action — unpinning a name the user never pinned is not a thing this panel
 * offers — and get {@link ToolRow.pinned} `false`.
 * @param tools - one session's tool offer.
 * @param policy - the project's policy, whose `pins` are the user's own list.
 * @returns one row per offered name, user-pinned first, in list order.
 */
export function pinnedRows(tools: SessionTools, policy: ToolPolicy): ToolRow[] {
  const pinned = policy.pins.map((name) => ({ name, pinned: true }))
  const pinnedNames = new Set(policy.pins)
  const counted = tools.baseline
    .filter((name) => !pinnedNames.has(name))
    .map((name) => ({ name, pinned: false }))
  return [...pinned, ...counted]
}

/**
 * The clock time of one offer, as a disclosed row shows it.
 *
 * Only the `session` tier carries `at`; the `context` tier records a step, not a
 * time, so a row without one renders no clock at all.
 * @param at - epoch milliseconds of the last offer or call.
 * @returns `HH:MM` in the viewer's own zone.
 */
export function toolTime(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Surface A's budget line, one branch per state the host can publish.
 *
 * `deferring` decides first, because it is the same flag that fills `deferred`:
 * a line that claimed the gate was off while the list below it showed hidden
 * tools would contradict itself. With nothing deferred, `budgetChars: 0` means
 * the gate is switched off in this deployment — the contract's own reading of a
 * zero budget — and any other budget means the surface simply fits, which is
 * not a state: a fitting surface gets no line at all, because the chips above
 * already carry `0 hidden` and a sentence repeating that is the empty row the
 * block stopped drawing.
 *
 * The figure is the host's own measurement in **characters** (`surfaceChars` /
 * `budgetChars`, contract C7), with the token count derived from it at the
 * contract's own rate of four characters per token. There are no slots here:
 * the host has never modelled them, so the line no longer invents them.
 * @param tools - one session's tool offer.
 * @param t - translate seat.
 * @returns the budget row, `null` when there is nothing to say, without the
 * exhausted note above it.
 */
export function budgetLine(tools: SessionTools, t: Translate): ReactNode {
  if (tools.deferring) {
    const split = budgetSplit(tools)
    const tokens = Math.round(tools.surfaceChars / 4)
    return h(
      'div',
      null,
      h(
        'div',
        {
          style: STYLE.budget,
          title: t('toolsBudgetBreakdown', {
            used: split.used,
            total: split.total,
            percent: split.percent,
          }),
        },
        h('span', { style: { ...STYLE.budgetUsed, width: `${split.percent}%` } }),
      ),
      h(
        'div',
        { style: STYLE.muted },
        t('toolsBudget', {
          used: tools.surfaceChars,
          total: tools.budgetChars,
          tokens,
        }),
      ),
    )
  }
  if (tools.budgetChars === 0) return h('div', { style: STYLE.muted }, t('toolsBudgetGateOff'))
  return null
}

/**
 * What one tool row's detail block is opened with (F-26, F-56).
 *
 * The block prints only what the host published about this one name. `SessionTools`
 * measures the whole set (`surfaceChars` / `visibleChars` / `deferredChars`), not
 * a single tool, so there is no per-tool size here to print and none is derived:
 * the group's own budget line is where an estimate is real.
 *
 * What F-56 removed from the block is what the header already carries: the
 * registry name, the clock and the step. The tier stays here, but as the one
 * thing the header's dot cannot say while nobody hovers — and it reads as a
 * sentence rather than as the wire word.
 */
export interface ToolDetail {
  /** Tier that offered the name: the pin list, this session, or context ranking. */
  via: 'pin' | 'session' | 'context'
  /** The host's own step counter, when it published one (contract C2). */
  step?: number | undefined
  /** Epoch milliseconds of the last offer or call, when the host published one. */
  at?: number | undefined
  /** `true` while this row's detail block is open. */
  open: boolean
  /** Toggle this row's detail block. */
  onToggle: () => void
  /**
   * The session's own declared rows, read for the serving server's state — the
   * same {@link ServerRow} the block above draws. Absent on a surface that has no
   * servers to hand down (a unit test of the row, the design stand's own rows),
   * and then the state is simply not printed: the panel never guesses a status.
   */
  rows?: readonly ServerRow[] | undefined
  /**
   * Both counter readings the row's header was seeded with, so the block can
   * print the two of them apart: the header keeps the lead figure
   * ({@link callsLabel}'s choice) and the body adds the reading the header had no
   * room for. Absent where the host published no record for the row's server.
   */
  calls?: ToolCalls | undefined
  /**
   * Project the definition belongs to — the route's own first parameter.
   *
   * Absent together with {@link ToolDetail.sessionId} on a surface that is not
   * reading a host at all (the design stand's fixtures are seeded straight into
   * the cache, and a unit test of the row composes it without a route): the body
   * then draws no line rather than asking an address it was never given.
   */
  projectRoot?: string | undefined
  /** Session the row is open in — the route's own second parameter. */
  sessionId?: string | undefined
}

/**
 * The state of the server one registry name was registered under, as the row's
 * own block prints it.
 *
 * The rows handed down are the session's declared ones — `sessionRowsOf`'s list
 * — so a name whose server the host never declared gets no status, and neither
 * does a name without the `mcp__` prefix. "The server is not in the list" and
 * "the server is idle" are different facts, and only the second is printable.
 * @param name - the registry name on the row.
 * @param rows - the session's declared rows; absent draws no state at all.
 * @param t - translate seat.
 * @returns the sentence, or `undefined` when there is no server row to read.
 */
export function toolServerState(
  name: string,
  rows: readonly ServerRow[] | undefined,
  t: Translate,
): string | undefined {
  const server = serverOfToolName(name)
  if (server === undefined) return undefined
  const row = (rows ?? []).find((entry) => entry.name === server)
  if (row === undefined) return undefined
  return t('toolServerState', { server, state: t(STATUS_KEYS[row.status]) })
}

/** The tier one row was offered by, said as a sentence (F-56). */
export function toolTierSentence(via: ToolDetail['via'], t: Translate): string {
  return via === 'pin'
    ? t('toolTierPinned')
    : via === 'session'
      ? t('toolTierSession')
      : t('toolTierContext')
}

/**
 * The two counter readings of one row's block (F-56), one line, each figure
 * labelled by what it counts.
 *
 * The block no longer repeats what the header shows — the header keeps the lead
 * figure, `callsLabel`'s own choice — so the project's total comes back only when
 * the host published it, and the session's own only when the session's slice
 * exists. A server the host never recorded draws nothing at all: this is the same
 * "no data, no label" rule the row obeys, one level down.
 * @param calls - the two readings, absent when the host published no record.
 * @param t - translate seat.
 * @returns the line, or `undefined` when there is no figure to print.
 */
export function toolCallsLine(calls: ToolCalls | undefined, t: Translate): string | undefined {
  if (calls === undefined || !calls.recorded) return undefined
  const project = calls.project
  const session = calls.session
  const parts = [
    project === undefined ? undefined : t('callsProject', { count: project }),
    session === undefined ? undefined : t('toolCallsSession', { count: session }),
  ].filter((part): part is string => part !== undefined)
  return parts.length === 0 ? undefined : parts.join(' · ')
}

/**
 * Why one name is not in this session's request, in the host's own figures
 * (F-56).
 *
 * Every number here arrived in `ToolFacts.reason`; a figure the host did not
 * measure leaves its phrase out rather than printing a zero, which is the same
 * discipline as contract C2's step tag. The whole sentence uses the complete
 * template while all three figures are there, so a reader of any language gets
 * its own grammar; a shorter answer falls back to the phrases that did arrive.
 * @param reason - the host's reason, or `undefined` for an offered name.
 * @param t - translate seat.
 * @returns the sentence, or `undefined` when there is nothing to print.
 */
export function toolReasonLine(reason: ToolReason | undefined, t: Translate): string | undefined {
  if (reason === undefined) return undefined
  const { chars, budget, used } = reason
  if (chars !== undefined && budget !== undefined && used !== undefined) {
    return t('toolReasonBudget', { chars, budget, used })
  }
  return [
    chars === undefined ? undefined : t('toolReasonChars', { chars }),
    budget === undefined ? undefined : t('toolReasonBudgetOnly', { budget }),
    used === undefined ? undefined : t('toolReasonUsed', { used }),
  ].filter((part): part is string => part !== undefined)
    .join(', ') || t('toolReason')
}

/**
 * The view model one opened row's body is drawn from.
 *
 * `loading` is the state of a read that has started and not landed, and it is
 * drawn as its own muted line rather than as an empty body: the answer is on its
 * way, and a block that drew nothing would read as "there is nothing to say".
 * `failure` is the host's refusal — an unknown name, or an older host without the
 * route — and it is drawn as a muted line too. Neither state invents a fact.
 */
export interface ToolFactsView {
  readonly state: 'loading' | 'failure' | 'facts'
  readonly facts?: ToolFacts | undefined
}

/**
 * What one opened row currently knows, read from the module's own cache.
 *
 * This is the **only** place the row's body asks for the definition: one call per
 * open row, from the row's own render, so a folded row costs nothing and a
 * refolded one is answered from {@link toolFacts}. A row with no route to ask —
 * the stand's seeded rows carry one, a unit test's may not — still reads the
 * cache, so a seeded answer is answered synchronously and an unseeded one draws
 * the loading line instead of contacting an address nobody gave.
 * @param name - the registry name on the row.
 * @param detail - the row's disclosure state and the session's own rows.
 * @returns the view model for the body; `loading` while the read is in flight.
 */
export function toolFactsView(name: string, detail: ToolDetail): ToolFactsView {
  const { projectRoot, sessionId } = detail
  // No route to ask: read what the cache already holds and start nothing. This
  // is the design stand's and a unit test's own path — a seeded answer is drawn,
  // an unseeded one waits, and neither opens a connection nobody asked for.
  if (projectRoot === undefined || sessionId === undefined) {
    // With no route in hand the panel reads the cache the way the seeded stand
    // does: a name is looked up as itself, so "no route" costs a definition
    // nothing rather than hiding it behind parameters nobody has.
    const failed = toolFactsFailed.has(name)
    const held = failed ? undefined : toolFacts.get(name)
    if (held !== undefined) return { state: 'facts', facts: held }
    return failed ? { state: 'failure' } : { state: 'loading' }
  }
  const entry: ToolFactsEntry = { projectRoot, sessionId, name }
  const held = toolFactsOf(entry)
  if (held !== undefined) return { state: 'facts', facts: held }
  return toolFactsUnreadable(entry) ? { state: 'failure' } : { state: 'loading' }
}

/** One accepted field, as the block lists it: mono name, type, marker, description. */
function fieldLine(field: ToolField, index: number, t: Translate): ReactNode {
  return h(
    'div',
    { key: `${field.name}-${String(index)}`, style: STYLE.field },
    // The marker rides with the type rather than with the name: `name*` reads as
    // part of the identifier, and a `*` the schema did not mean would be a
    // requirement the tool never declared.
    h('span', { style: STYLE.fieldName }, field.name),
    h('span', { style: STYLE.muted }, field.type),
    field.required ? h('span', { title: t('toolFieldRequiredHint') }, '*') : null,
    field.description === undefined
      ? null
      : h('span', { style: STYLE.fieldDesc }, `— ${field.description}`),
  )
}

/**
 * The body of one opened tool row: the facts the header does not hold.
 *
 * The header already carries the registry name, the clock and the step, so this
 * block carries what it cannot: the server and the state it is in, the tier as a
 * sentence, the two counter readings, and then the host's own answer about the
 * definition — its model-facing description verbatim, the fields it accepts, and
 * the reason a hidden name is not in the request. Empty groups are not printed,
 * which is this file's rule everywhere: no fields, no field list.
 *
 * The reason leads the block for a **hidden** row: there, it is the answer to the
 * question the reader opened the row with, while for an offered name the same
 * block is a definition rather than an apology.
 * @param name - the registry name on the row.
 * @param detail - the tier, the disclosure state and the session's own rows.
 * @param view - what the cache holds for this name right now.
 * @param t - translate seat.
 * @returns the body's lines, in order.
 */
export function toolFactsBody(
  name: string,
  detail: ToolDetail,
  view: ToolFactsView,
  t: Translate,
): ReactNode {
  if (view.state === 'loading') return h('div', { style: STYLE.dim }, t('toolLoading'))
  if (view.state === 'failure') return h('div', { style: STYLE.dim }, t('toolFailed'))
  const facts = view.facts
  if (facts === undefined) return null
  const reason = toolReasonLine(toolReasonOf(name, facts), t)
  const reasonLine = reason === undefined ? null : h('div', { style: STYLE.muted }, reason)
  const description =
    facts.description === undefined
      ? null
      : // The host's own model-facing text, exactly as it arrived: not
        // translated, not shortened, and not passed through a dictionary.
        h('div', { style: STYLE.detail }, facts.description)
  const title = facts.description === undefined ? name : `${name} — ${facts.description}`
  const fields =
    facts.fields.length === 0
      ? null
      : [
          h('div', { key: 'fields', style: STYLE.group }, t('toolFieldsLabel')),
          ...facts.fields.map((field, index) => fieldLine(field, index, t)),
        ]
  const server = toolServerState(name, detail.rows, t)
  const calls = toolCallsLine(detail.calls, t)
  // Every group is drawn only while it has something to say: a fact the host did
  // not publish gets no line at all, not an empty one.
  const lines: ReactNode[] = [
    ...(server === undefined ? [] : [h('div', { key: 'server', style: STYLE.muted }, server)]),
    ...(calls === undefined ? [] : [h('div', { key: 'calls', style: STYLE.muted }, calls)]),
  ]
  return [
    // The reason leads a hidden row's body: there it is the answer to the
    // question the reader opened the row with, while for an offered name the same
    // block is a definition rather than an apology.
    ...(detail.via === 'pin' ? [reasonLine] : []),
    h('div', { key: 'tier', style: STYLE.muted }, toolTierSentence(detail.via, t)),
    ...lines,
    description,
    ...(detail.via === 'pin' ? [] : [reasonLine]),
    fields,
  ].filter((line): line is Exclude<ReactNode, null> => line !== null)
}

/**
 * The host's reason for one name, read from the record the row is holding.
 *
 * A record whose `name` is not the row's own is a host bug, and the panel draws
 * no reason rather than another tool's: the fact belongs to the definition the
 * body was asked about.
 * @param name - the registry name on the row.
 * @param facts - the record the cache holds.
 * @returns the reason, or `undefined` for an offered name.
 */
function toolReasonOf(name: string, facts: ToolFacts): ToolReason | undefined {
  return facts.name === name ? facts.reason : undefined
}

/**
 * One row of the one surface's tools block: a header button that opens the
 * registry name and how the tool was offered, and the row's one action beside it.
 *
 * F-26 turned the row into a disclosure. The header keeps what it always showed
 * — the tier dot, the name, the time and the step the host gave, and the pin
 * action — and lives in a `button[aria-expanded]` so the row itself is the parity
 * gate's tool line. The action stays a sibling: a button inside a button is not a
 * thing HTML has.
 * @param row - the name, its time and its note.
 * @param action - the row's one action, when it has one.
 * @param tier - which tier offered the row; `pinned` when not given.
 * @param detail - the disclosure state and the facts it opens.
 * @param t - translate seat; falls back to this module's English copy.
 * @returns the row element.
 */
export function toolRow(
  row: ToolRow,
  action: { label: string; hint: string; onClick: () => void; disabled?: boolean } | undefined,
  tier: 'pinned' | 'disclosed' | 'hidden',
  detail: ToolDetail,
  t: Translate = translateOf(),
): ReactNode {
  const open = detail.open
  const calls = callsLabel(row.calls, t)
  // Read once, and only while this row is the open one (F-56): the host route
  // answers one definition at a time, and a folded row asks for nothing.
  const facts = open
    ? toolFactsBody(row.name, { ...detail, calls: row.calls }, toolFactsView(row.name, detail), t)
    : null
  return h(
    'div',
    { key: row.name, style: STYLE.tool },
    h(
      'button',
      {
        style: STYLE.toolLine,
        'aria-expanded': open,
        title: open ? t('hideTool') : t('showTool'),
        onClick: detail.onToggle,
      },
      h('span', {
        style: { ...STYLE.dot, background: STATUS_COLOR[tier === 'pinned' ? 'active' : 'idle'] },
      }),
      h('span', { style: STYLE.name }, row.name),
      // The host's own counter, immediately after the name it counts: the one
      // reading on the row that is about how the tool has been used rather than
      // about what it is.
      calls === undefined ? null : h('span', { style: STYLE.dim }, calls),
      row.time === undefined ? null : h('span', { style: STYLE.muted }, row.time),
      row.note === undefined ? null : h('span', { style: STYLE.muted }, row.note),
    ),
    action === undefined
      ? null
      : h(
          'button',
          { style: STYLE.button, title: action.hint, disabled: action.disabled === true, onClick: action.onClick },
          action.label,
        ),
    open
      ? h(
          'div',
          { style: STYLE.toolDetail },
          // What the header cannot hold (F-56). The name, the clock and the step
          // are **not** repeated here — the header is where the reader already
          // read them, and printing them twice was the copy this unit removed.
          // Everything below the tier is the host's own answer, read once, on
          // demand, while this row is the one that is open.
          facts,
        )
      : null,
  )
}

/**
 * The declared servers of this session, in document order, with the state each
 * one is in.
 *
 * The first block of the one surface answers "what is declared, and what is it
 * doing right now", and a server that is declared but not serving is exactly why
 * an apparently empty catalog is empty: without this list `Nothing to hide yet`
 * reads as "nothing is wrong" while a stalled process quietly withholds all of
 * its tools.
 *
 * The row is the status and nothing else — the dot, the name, the status word
 * and the transport chip. Its `title` still carries the host's own multi-line
 * diagnostic, so hovering answers "why" without a click, but the diagnostic is
 * not drawn under the rows: F-26 hid it behind the errors disclosure, which
 * prints the same host text through {@link IssueView}'s rows. Drawing it in both
 * places put an amber wall between the model's tools and the reader.
 * @param props - the rows to list and the translate seat.
 * @returns the section, or `null` when the session declares nothing.
 */
export function ServersBlock(props: {
  rows: readonly ServerRow[]
  /** The project's usage counters, when the host published any (`idle {n}d`). */
  usage?: ProjectUsage
  t: Translate
  /** Host-namespace seat for the rows' coded details (F-48). */
  hostT?: Translate | undefined
  /**
   * The project's retry, handed down to the failing rows so a broken server can
   * be pressed where it shows instead of behind the errors disclosure (F-55).
   */
  onRetry?: (() => void) | undefined
  /** `true` while a host action is in flight; the row button goes still with it. */
  busy?: boolean | undefined
}): ReactNode {
  const { rows, t } = props
  if (rows.length === 0) return null
  const up = rows.filter((row) => row.status === 'active').length
  const failed = rows.filter((row) => row.status === 'error').length
  return h(
    'div',
    { style: STYLE.serversBlock },
    h(
      'div',
      { style: STYLE.row },
      h('span', { style: STYLE.groupInline }, t('toolsServers')),
      h('span', { style: { flex: 1 } }),
      h(
        'span',
        {
          style: failed === 0 ? STYLE.tag : { ...STYLE.tag, ...STYLE.tagWarn },
          title: rows.map((row) => `${row.name}: ${t(STATUS_KEYS[row.status])}`).join('\n'),
        },
        t('toolsServersUp', { up, total: rows.length }),
      ),
    ),
    ...rows.map((row) => {
      // The host's own record of this server; a row the counters never saw has
      // no `lastUsedAt` to read and the quiet word is simply not drawn.
      const idle = idleNote(row.status, props.usage?.[row.name]?.lastUsedAt, t)
      // The one job a row here can carry: a failing server gets the project's
      // retry, at the row's right edge, and nothing else does.
      const retry = row.status === 'error' ? props.onRetry : undefined
      return h(
        'div',
        {
          style: STYLE.row,
          key: `tools#server#${row.name}`,
          title: rowDetail(row, props.hostT) ?? t(STATUS_HINT[row.status]),
        },
        h('span', {
          style: { ...STYLE.dot, background: STATUS_COLOR[row.status] },
          'aria-hidden': true,
        }),
        h('span', { style: STYLE.name }, row.name),
        // The status as a word, not only as the dot's colour: the question this
        // block answers is asked by someone who may not know the palette.
        h('span', { style: { ...STYLE.muted, color: STATUS_COLOR[row.status] } }, t(STATUS_KEYS[row.status])),
        idle === undefined ? null : h('span', { style: STYLE.dim }, idle),
        row.transport === undefined
          ? null
          : h('span', { style: STYLE.tag }, shortTransport(row.transport)),
        retry === undefined ? null : h('span', { style: { flex: 1 } }),
        retryButton(t, retry, props.busy),
      )
    }),
  )
}

/**
 * The hidden tier of the tools block: the names the model does not see, in a
 * list the user can open and act on.
 *
 * Hidden is the one tier whose contents are a list rather than a reading. The
 * counters already say how many names are left out, so this block adds the two
 * things they cannot: the names themselves, grouped by the server they were
 * mounted from, and the `Pin` that pulls one back into every request. The open
 * state arrives from the parent, so the tier is a pure function of its props —
 * the same reason the head is drawn by {@link disclosureHead} rather than by
 * {@link Disclosure}.
 * @param props - the hidden names, the requested `Pin` write and the open state.
 * @returns the head and, while open, one row per server and name.
 */
export function HiddenTier(props: {
  /** How many names the head's badge prints, the counters' own hidden figure. */
  count: number
  /** The hidden names, grouped by server, in the host's order. */
  servers: readonly HiddenServer[]
  /** `true` while the list is open. */
  open: boolean
  /** Toggle the list. */
  onToggle: () => void
  /** Pin one name, or absent while there is nothing to write to. */
  onChange?: ((tool: string, pinned: boolean) => void) | undefined
  /**
   * Pin every name of one server in one press (F-44), or absent while there is
   * nothing to write to. The names are this group's own: the list is what the
   * user is reading, and a server action that wrote names the tier does not show
   * would be a press with a hidden meaning.
   */
  onPinServer?: ((server: string, names: readonly string[]) => void) | undefined
  /**
   * The project's own pin list, read for one thing only: whether a server's group
   * is already wholly pinned, which decides whether the line says `Pin all` or
   * `Unpin all`. A tier's names are usually unpinned, but nothing in the snapshot
   * forbids a pinned name to sit in `deferred` — a pin written between two
   * assemblies, or one the host itself still defers — and the label may not
   * promise the opposite of what the press does.
   */
  pins?: readonly string[] | undefined
  /** `true` while a pin write is in flight, so the buttons stay still. */
  pending: boolean
  /**
   * The one name of this tier whose body is open (F-56), as {@link ToolsView}
   * holds it, plus the writer that toggles it.
   *
   * Until F-56 every row here was handed `onToggle: () => undefined`: the tier
   * drew a disclosure that had nothing to disclose. The very reason a name is
   * hidden is what its body now prints, so the press that opens it is real.
   */
  openTool?: string | undefined
  /** Toggle one row's body. */
  onToggleTool?: ((name: string) => void) | undefined
  /**
   * The project the definitions belong to and the session the tier is read in —
   * the `GET tool` route's own two parameters, handed down by {@link ToolsView}.
   */
  projectRoot?: string | undefined
  sessionId?: string | undefined
  /** The session's own declared rows, for each open body's server state. */
  rows?: readonly ServerRow[] | undefined
  t: Translate
}): ReactNode {
  const { t } = props
  /**
   * One server line's own press.
   *
   * The words follow the reading both surfaces share ({@link serverPinState}): a
   * group that is wholly pinned says `Unpin all`, anything else says `Pin all` —
   * and the direction the parent writes is {@link serverPinPress}'s, which is the
   * same rule. In the ordinary case a group's names are unpinned and the second
   * word never appears: it exists for the snapshot where a name is pinned and
   * still deferred — a pin written between two assemblies, or a hidden name the
   * user pinned from this very list — because there the first word would be the
   * opposite of what the press does.
   * @param entry - one server's hidden names.
   * @returns the press of that line.
   */
  const serverPress = (entry: HiddenServer): ReactNode => {
    const all = serverPinState(entry.names, props.pins ?? []) === 'all'
    return h(
      'button',
      {
        type: 'button',
        style: STYLE.button,
        title: all ? t('toolsUnpinAllHint') : t('toolsPinAllHint'),
        disabled: props.pending,
        onClick: () => props.onPinServer?.(entry.server, entry.names),
      },
      all ? t('toolsUnpinAll') : t('toolsPinAll'),
    )
  }
  return h(
    'div',
    { style: STYLE.disclosure },
    disclosureHead({
      label: t('toolsGroupHidden'),
      count: props.count,
      open: props.open,
      hint: t('toolsHiddenVia'),
      onToggle: props.onToggle,
    }),
    props.open
      ? h(
          'div',
          { style: STYLE.disclosureBody },
          ...props.servers.flatMap((entry) => [
            // The server's own line, with the one press that takes all of it
            // (F-44): the label stays the reading it was, and the action sits at
            // the right edge the way every other action in the block does.
            h(
              'div',
              { key: `${entry.server}-group`, style: STYLE.row },
              h('span', { style: STYLE.group }, `${entry.server} · ${entry.count}`),
              h('span', { style: { flex: 1 } }),
              props.onPinServer === undefined ? null : serverPress(entry),
            ),
            // One row per name, the full `mcp__<server>__<tool>` the registry
            // carries, with the pin that moves it into the always-offered list.
            // Since F-56 the row is a real disclosure: its body carries the
            // reason the name is not in the request, which is the question this
            // list is open to answer.
            ...entry.names.map((name) =>
              toolRow(
                { name },
                {
                  label: t('toolsPin'),
                  hint: t('toolsPinHint'),
                  onClick: () => props.onChange?.(name, true),
                  disabled: props.pending,
                },
                'hidden',
                {
                  via: 'pin',
                  open: props.openTool === name,
                  onToggle: () => props.onToggleTool?.(name),
                  rows: props.rows,
                  projectRoot: props.projectRoot,
                  sessionId: props.sessionId,
                },
                t,
              ),
            ),
          ]),
        )
      : null,
  )
}

/**
 * The tools block's filter row (F-43): one query over the registry names, the
 * count of what is left on screen, and the `Clear` that hands the whole list
 * back.
 *
 * The tier half of the filter is not here but in the counter chips of the row
 * above, which stop being a reading and become the switch. The block prints one
 * number per tier (F-28) and says it once (F-37), so a second row of the same
 * four words without their counts would be a copy of a figure the chips already
 * carry.
 *
 * Nothing is drawn while the caller hands in no writer: a pure tree composed by
 * a spec keeps the block it had — an input whose value could never change is the
 * worse half of a control. The design-only render mode is not that caller: it
 * composes {@link tabBody}, so its panel is the product's own. The caption is
 * the exception: a filter the block was handed still hides rows, and hiding them
 * without saying so is the one thing the row exists to prevent.
 * @param props - the filter, what it kept, and the writers behind it.
 * @returns the panel's row with its own caption; the caption alone without a
 * writer, and `null` when a filter nobody applied has no writer either.
 */
export function ToolsFilter(props: {
  filter: ToolFilter
  /** Names passing the filter, and every name the block holds before it. */
  shown: number
  total: number
  /** Replace the query; absent leaves the field out of the tree. */
  onQuery?: ((query: string) => void) | undefined
  /** Drop the query and every pressed tier. */
  onClear?: (() => void) | undefined
  t: Translate
}): ReactNode {
  const { t } = props
  const active = toolFilterActive(props.filter)
  // The caption is the only place the filter's own effect is readable: the chips
  // above it count the tiers, not what the query left of them.
  const caption = active
    ? h(
        'div',
        { style: STYLE.dim },
        props.shown === 0
          ? t('toolsFilterNone')
          : t('toolsFilterShown', { shown: props.shown, total: props.total }),
      )
    : null
  if (props.onQuery === undefined) return caption
  return h(
    'div',
    null,
    h(
      'div',
      { style: STYLE.row },
      h('input', {
        type: 'search',
        style: STYLE.filterInput,
        value: props.filter.query,
        placeholder: t('toolsFilterPlaceholder'),
        'aria-label': t('toolsFilterLabel'),
        onChange: (event: { target: { value: string } }) => props.onQuery?.(event.target.value),
      }),
      active && props.onClear !== undefined
        ? h(
            'button',
            {
              type: 'button',
              style: STYLE.button,
              title: t('toolsFilterClearHint'),
              onClick: () => props.onClear?.(),
            },
            t('toolsFilterClear'),
          )
        : null,
    ),
    caption,
  )
}

/**
 * The tools block of the single surface: what this session's model sees now.
 *
 * Answers with the three counters, the pinned list, the tools the session
 * disclosed, and the hidden remainder grouped by the server it was mounted from.
 * Every reading is the host's own: `policy.pins` for the list a user wrote by
 * hand, `SessionTools` for the offer counters, `OfferedTool.step` for the
 * disclosure step (contract C2), and `ProjectSnapshot.presentation` for a second
 * owner of the request (contract C3). Pure and without state: the row whose
 * detail block is open is handed in by {@link ToolsSection}, which keeps one
 * open at a time.
 *
 * The filter (F-43) arrives the same way, from {@link ToolsSection}: the query,
 * the pressed tiers and the three writers. Without them the block draws every
 * tier and every name, exactly as it did before the panel existed.
 */
export function ToolsView(props: {
  project: ProjectSnapshot
  sessionId: string
  /** Policy to read the pin list from; the project's own when omitted. */
  policy?: ToolPolicy | undefined
  /** Pin or unpin one name; absent while there is nothing to write to. */
  onPin?: ((tool: string, pinned: boolean) => void) | undefined
  /**
   * Pin every hidden name of one server in one press (F-44). The names travel
   * with the call because this block is what grouped them; the writer above
   * expands them into the pin list the host stores.
   */
  onPinServer?: ((server: string, names: readonly string[]) => void) | undefined
  /** `true` while a pin request is in flight, so the buttons stay still. */
  pending?: boolean
  /** The one row whose detail block is open, when a row is open. */
  openTool?: string | undefined
  /** Toggle one row's detail block. */
  onToggleTool?: ((name: string) => void) | undefined
  /**
   * The hidden list's own state: `true` / `false` once the user has pressed its
   * head, `undefined` while nobody has — which is the state the filter is
   * allowed to open the tier in. Held by {@link ToolsSection} and not by the
   * tier itself, so this block stays a pure tree of elements: its tests resolve
   * it without a React runtime.
   */
  openHidden?: boolean | undefined
  /** Toggle the hidden list. */
  onToggleHidden?: (() => void) | undefined
  /** The filter the panel shows; absent means every tier, every name. */
  filter?: ToolFilter | undefined
  /** Replace the query. */
  onQuery?: ((query: string) => void) | undefined
  /** Fold one tier in or out of the filter. */
  onTier?: ((tier: ToolTier) => void) | undefined
  /** Drop the query and every pressed tier. */
  onClearFilter?: (() => void) | undefined
  t: Translate
  /** Host-namespace seat for the presentation owner's coded note (F-48). */
  hostT?: Translate | undefined
}): ReactNode {
  const { t } = props
  const tools = sessionToolsOf(props.project, props.sessionId)
  /**
   * One row's disclosure state: the tier, the host's own step and time, this
   * session's declared rows (so the open body can name the serving server's
   * state) and the route the body's definition is read from (F-56).
   */
  const detailOf = (
    name: string,
    via: ToolDetail['via'],
    step?: number | undefined,
    at?: number | undefined,
  ): ToolDetail => ({
    via,
    step,
    at,
    open: props.openTool === name,
    onToggle: () => props.onToggleTool?.(name),
    rows: serverRows,
    projectRoot: props.project.projectRoot,
    sessionId: props.sessionId,
  })
  // This session's own declared rows, read once for the open body's server state
  // — the same list `tabBody` draws above this block (`sessionRowsOf`).
  const serverRows = sessionRowsOf(props.project, props.sessionId)
  // `tools` absent is the host's only "not mounted yet" signal: a session with a
  // published offer that happens to be empty has real zeroes to print, and the
  // two states must not be conflated. The declared servers of the session are not
  // part of this block any more — the one surface draws them above it (F-26).
  if (tools === undefined) {
    return h(
      'div',
      { style: STYLE.project },
      emptyState(t('toolsNotMounted'), t('toolsNotMountedHint')),
      h('div', { style: STYLE.codeLine }, t('toolsNotMountedCode')),
    )
  }
  const counts = toolCounts(tools)
  const split = budgetSplit(tools)
  const policy = props.policy ?? policyOf(props.project)
  // A mode the owner chose is not this plugin hiding tools, and the counters
  // cannot say which it is: `deferred` is the whole surface under `off` and empty
  // under `direct`, so printing them raw would report a switched-off project as
  // `0 pinned` and `N hidden` — the plugin taking credit for a decision it did not
  // make, and inviting the user to free slots that would change nothing.
  if (policy.mode === 'off') {
    return h(
      'div',
      { style: STYLE.project },
      h(
        'div',
        { style: STYLE.row },
        h('span', { style: STYLE.muted }, t('toolsSeeModel')),
        h('span', { style: { flex: 1 } }),
        h('span', null, t('toolsModeOffCounters', { mounted: tools.mounted })),
      ),
      h('div', { style: STYLE.warnNote }, t('toolsModeOff')),
      h('div', { style: STYLE.muted }, t('toolsModeOffHint')),
    )
  }
  // The host's own counters for this project and for the session the block is
  // open in: one row reads its server's record by registry name, and a row whose
  // server the host never recorded carries a value that draws nothing (no data,
  // no label) rather than a zero.
  const usage = props.project.usage
  const withCalls = (row: ToolRow): ToolRow => ({
    ...row,
    calls: toolCalls(row.name, usage, props.sessionId),
  })
  const rows = pinnedRows(tools, policy).map(withCalls)
  // The filter arrives from {@link ToolsSection}; a block nobody can write a
  // filter to draws the unfiltered tree it always did.
  const filter = props.filter ?? NO_TOOL_FILTER
  const active = toolFilterActive(filter)
  const everyPinned = rows.filter((row) => row.pinned)
  const everyCounted = rows.filter((row) => !row.pinned)
  const everyHidden = hiddenByServer(tools.deferred)
  // Only the `session` tier carries `at`; the `context` tier has no timestamp to
  // render, and the step tag both tiers show comes from the host's counter
  // (contract C2). The detail block prints the step and the time only while the
  // host published them, so each raw value is kept beside the row it belongs to;
  // the header keeps the note and the clock it always had.
  const everyDisclosed: { row: ToolRow; detail: ToolDetail }[] = [
    ...tools.activated.map((tool) => ({
      row: withCalls({
        name: tool.name,
        time: tool.at === undefined ? undefined : toolTime(tool.at),
        // The step is real once the host stamps it (contract C2). Absent, the row
        // shows no tag at all — no invented `step 4`.
        note: tool.step === undefined ? undefined : t('toolsStep', { step: tool.step }),
      }),
      detail: detailOf(tool.name, 'session', tool.step, tool.at),
    })),
    ...tools.context.map((tool) => ({
      row: withCalls({
        name: tool.name,
        note: tool.step === undefined ? undefined : t('toolsStep', { step: tool.step }),
      }),
      detail: detailOf(tool.name, 'context', tool.step),
    })),
  ]
  // What each tier draws once the filter has had its say: a tier the filter left
  // out draws nothing at all, a tier it kept draws the rows the query kept, and
  // the two figures below answer for exactly those rows. `total` is every row the
  // block holds before the filter — the denominator counts rows, not distinct
  // names, because rows are what the block draws: a name the session both pinned
  // and disclosed is two lines, and the caption answers for the lines.
  const pinned = tierVisible(filter, 'pinned') ? filterToolRows(everyPinned, filter.query) : []
  const counted = tierVisible(filter, 'counters') ? filterToolRows(everyCounted, filter.query) : []
  const disclosed = tierVisible(filter, 'disclosed')
    ? everyDisclosed.filter(({ row }) => matchesToolQuery(row.name, filter.query))
    : []
  const hidden = tierVisible(filter, 'hidden') ? filterHiddenServers(everyHidden, filter.query) : []
  const hiddenShown = hidden.reduce((sum, entry) => sum + entry.count, 0)
  const shown = pinned.length + counted.length + disclosed.length + hiddenShown
  const total =
    everyPinned.length +
    everyCounted.length +
    everyDisclosed.length +
    everyHidden.reduce((sum, entry) => sum + entry.names.length, 0)
  const onChange = props.onPin
  // The counters as chips, and only the ones that carry a number: `0 pinned` is
  // the empty row this block no longer draws, one chip at a time. With all four
  // at zero the row keeps its label and stops there, rather than printing four
  // zeroes at a panel that has nothing to count.
  //
  // One exception, and it is the price of the chip having become a control: a
  // tier the user pressed keeps its chip even after a host refresh drove its
  // count to zero, because a filter whose switch vanished would leave an empty
  // list nobody can explain — `Clear` is reachable, the chip that caused it is
  // not. It prints `0 {label}` while it is pressed, and the moment it is
  // released the zero is not drawn again.
  const chips = counterParts(tools, policy, t).filter(
    (part) => part.count > 0 || filter.tiers.includes(part.key),
  )
  // One pinned row per name, so a server's group can draw the row it stands for
  // without searching the list again.
  const pinnedByName = new Map(pinned.map((row) => [row.name, row]))
  // The chips are the filter's tier half (F-43): the same plate, the same
  // `{count} {label}` words, a button instead of a span while the block can write
  // the filter to something. A pressed chip means "this tier alone", and pressing
  // it again hands every tier back — an empty tier list is what "every tier"
  // means, so there is no fifth `all` chip to press and no state where none of
  // the four reads as applied.
  const tierChip = (part: CounterPart): ReactNode => {
    const on = filter.tiers.includes(part.key)
    const label = `${part.count} ${part.label}`
    if (props.onTier === undefined) return h('span', { key: part.key, style: STYLE.tag }, label)
    return h(
      'button',
      {
        key: part.key,
        type: 'button',
        style: on ? { ...STYLE.filterChip, ...STYLE.filterChipOn } : STYLE.filterChip,
        'aria-pressed': on,
        title: t('toolsFilterTier'),
        onClick: () => props.onTier?.(part.key),
      },
      label,
    )
  }
  return h(
    'div',
    { style: STYLE.project },
    h(
      'div',
      { style: STYLE.row },
      h('span', { style: STYLE.muted }, t('toolsSeeModel')),
      h('span', { style: { flex: 1 } }),
      chips.length === 0 ? null : h('span', { style: STYLE.chips }, chips.map(tierChip)),
    ),
    policy.mode === 'direct'
      ? h('div', { style: STYLE.muted }, t('toolsModeDirect'))
      : budgetLine(tools, t),
    split.exhausted
      ? h('div', { style: STYLE.warnNote }, `${t('toolsBudgetExhausted')} — ${t('toolsBudgetFree')}`)
      : null,
    // The filter sits between the head's readings and the list it narrows: the
    // counters above it say what the session offers, this row says what is left
    // of it on screen. Without a writer it draws nothing at all.
    h(ToolsFilter, {
      key: 'filter',
      filter,
      shown,
      total,
      onQuery: props.onQuery,
      onClear: props.onClearFilter,
      t,
    }),
    // A tier with nothing in it is not a heading over an apology, it is nothing:
    // each group below is drawn only while it has rows, and the zero it would
    // have printed lives in the chips above. One number per block (F-28), said
    // once (F-37). A tier the filter left out is nothing too — the chip that
    // pressed it is what says so.
    pinned.length === 0
      ? null
      : [
          h('div', { key: 'pinned', style: STYLE.group }, t('toolsGroupPinned')),
          // Since F-44 the pinned list is grouped by the server each name came
          // from, and each group carries the press that releases that whole
          // server — the counterpart of pinning one from the hidden tier or from
          // the settings page. The rows keep their own order inside a group: the
          // order the user pinned them in.
          ...pinnedByServer(pinned.map((row) => row.name)).flatMap((group) => [
            h(
              'div',
              { key: `${group.server}-pinned`, style: STYLE.row },
              h('span', { style: STYLE.group }, `${group.server} · ${group.count}`),
              h('span', { style: { flex: 1 } }),
              props.onPinServer === undefined
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      style: STYLE.button,
                      title: t('toolsUnpinServerHint'),
                      disabled: props.pending === true,
                      onClick: () => props.onPinServer?.(group.server, group.names),
                    },
                    t('toolsUnpinAll'),
                  ),
            ),
            // The only real user choice on this surface: it is the host's pin list
            // that decides the row, so the action writes it back.
            ...group.names.map((name) => {
              const row = pinnedByName.get(name)
              return row === undefined
                ? null
                : toolRow(
                    row,
                    {
                      label: t('toolsUnpin'),
                      hint: t('toolsUnpinHint'),
                      onClick: () => onChange?.(row.name, false),
                      disabled: props.pending === true,
                    },
                    'pinned',
                    detailOf(row.name, 'pin'),
                    t,
                  )
            }),
          ]),
        ],
    counted.length === 0
      ? null
      : [
          h('div', { key: 'counters', style: STYLE.group }, t('toolsGroupCounters')),
          // Offered by the counters rather than chosen by the user, which is why
          // the action here is the pin that turns one into a user pin: the host's
          // own `POST pin` writes the very list the pinned group above reads.
          ...counted.map((row) =>
            toolRow(
              row,
              {
                label: t('toolsPin'),
                hint: t('toolsPinHint'),
                onClick: () => onChange?.(row.name, true),
                disabled: props.pending === true,
              },
              'pinned',
              detailOf(row.name, 'pin'),
              t,
            ),
          ),
        ],
    disclosed.length === 0
      ? null
      : [
          h('div', { key: 'disclosed', style: STYLE.group }, t('toolsGroupDisclosed')),
          ...disclosed.map(({ row, detail }) =>
            toolRow(
              row,
              { label: t('toolsHide'), hint: t('toolsHideHint'), onClick: () => undefined },
              'disclosed',
              detail,
              t,
            ),
          ),
        ],
    hidden.length === 0
      ? null
      : [
          // The one tier whose contents are a list rather than a reading: the
          // counters can say how many names are hidden, but only the names
          // themselves let a user pull one back. So the head opens, and the
          // sentence that used to sit under it as a caption became the head's own
          // tooltip — nothing hidden draws no head at all.
          h(HiddenTier, {
            key: 'hidden',
            // While the filter is on, the head counts what is under it, so the
            // number and the list agree: the chip above keeps the tier's own
            // total, which is why the two read differently and neither lies.
            count: active ? hiddenShown : counts.hidden,
            servers: hidden,
            // A query that found hidden names is a question about them: the tier
            // opens itself rather than leaving the matches behind a fold the user
            // has to guess at. The user's own press outranks that, which is why
            // `openHidden` has three states and not two: `undefined` — nobody has
            // pressed the head — is where the filter may open the tier, and the
            // first press replaces it with a choice that stands, filter or not.
            open: props.openHidden ?? active,
            onToggle: () => props.onToggleHidden?.(),
            onChange,
            onPinServer: props.onPinServer,
            pins: policy.pins,
            pending: props.pending === true,
            // One open body at a time across the whole block (F-56), and the
            // route its definition is read from: the hidden list's own rows are
            // rows of this same surface, so they open on the same writer.
            openTool: props.openTool,
            onToggleTool: props.onToggleTool,
            projectRoot: props.project.projectRoot,
            sessionId: props.sessionId,
            rows: serverRows,
            t,
          }),
        ],
    // Another plugin owning `assembly.tools` is the host's finding, not the
    // mockup's (contract C3). No field, no banner; the banner is a fact the host
    // reported.
    props.project.presentation === undefined
      ? null
      : h(
          'div',
          { style: STYLE.warnNote },
          `${t('toolsPresentationOwner')}: ${props.project.presentation.name}. ${resolveHost(props.hostT ?? hostTranslate(undefined), props.project.presentation.noteCode, undefined, props.project.presentation.note)}`,
        ),
  )
}

/**
 * "Problems" body: the rows that need a look, grouped by status.
 *
 * This is the body of the errors disclosure (F-26), so nothing above it repeats
 * the groups: the block starts at the first group — `error`, then `conflict`,
 * then `connecting`, in the order {@link statusGroups} triage puts them in —
 * and the disclosure's own badge is what says how many groups there are.
 * @param props - the project, its problem groups and the row action.
 * @returns the grouped rows.
 */
export function IssueView(props: {
  project: ProjectSnapshot
  groups: StatusGroup[]
  /** Retry the project's failed mounts; absent while nothing can be written. */
  onRetry?: (() => void) | undefined
  /** `true` while a host action is in flight, so the row buttons stay still. */
  busy?: boolean | undefined
  /** Translate seat; falls back to this module's English copy without one. */
  t?: Translate | undefined
  /** Host-namespace seat for the rows' coded details (F-48). */
  hostT?: Translate | undefined
}): ReactNode {
  const t = translateOf(props.t)
  return h(
    'div',
    { style: STYLE.project },
    props.groups.map((group) =>
      h(
        'div',
        { key: group.status },
        h('div', { style: STYLE.group }, `${t(STATUS_KEYS[group.status])} · ${group.rows.length}`),
        group.rows.flatMap((row) =>
          serverRow(row, `problem-${group.status}`, {
            onRetry: props.onRetry,
            busy: props.busy,
            t: props.t,
            hostT: props.hostT,
          }),
        ),
      ),
    ),
  )
}

/**
 * Centred message for a state that has nothing to list.
 * @param title - the headline.
 * @param hint - the line under it.
 * @param key - React key, for the callers that place the result inside an array
 * (React requires one there); variadic callers leave it out.
 */
export function emptyState(title: string, hint: string, key?: string): ReactNode {
  return h(
    'div',
    key === undefined ? { style: STYLE.empty } : { key, style: STYLE.empty },
    h('div', { style: STYLE.emptyTitle }, title),
    h('div', { style: STYLE.hint }, hint),
  )
}

/** `info` and `up` are the quiet half of the level vocabulary. */
const LOG_CHIP: Record<LogEvent['level'], CSSProperties> = {
  info: {},
  up: { color: STATUS_COLOR.active },
  warn: { color: STATUS_COLOR.connecting },
  error: { color: STATUS_COLOR.error },
}

/** `12:41:31` — the clock the mockup's log rows carry, seconds included. */
function logTime(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * The three facts of a failure, one per line.
 *
 * The host hands the facts over as separate lines — the endpoint, the document
 * that declared the server, and what did not appear — so they are relayed as
 * they are: split, trimmed, and with anything labelled as advice dropped. The
 * hint and the reminder about `Retry` are not facts, and `Retry` is already a
 * button on the server's own row.
 * @param detail - the event's `detail`, when it has one.
 * @returns the lines to draw under the event, empty when there is nothing to say.
 */
export function logFacts(detail: string | undefined): string[] {
  if (detail === undefined) return []
  return detail
    .split('\n')
    .map((line) => line.trim())
    // The host's own advice is not a fact: the row above already carries the
    // reason, and `Retry` is a button on the server's row, not a sentence here.
    .filter((line) => !/^(hint|note|next step)\s*:/i.test(line))
    .filter((line) => line.length > 0)
}

/**
 * One line of the event list.
 *
 * The message takes its own width (see {@link STYLE.logRow}) rather than a right
 * column, which is what keeps the row readable in a sidebar. A coded event is
 * resolved through the host seat (F-48): the translated template wins, and a
 * code the namespace does not know — or an event that carries none — renders
 * the payload's English exactly as before.
 * @param event - the event to draw.
 * @param key - React key for the row.
 * @param t - translate seat.
 * @param hostT - host-namespace seat; without one the payload's English shows.
 * @returns the row, plus the failure's fact lines under it.
 */
export function logRow(event: LogEvent, key: string, t: Translate, hostT?: Translate | undefined): ReactNode {
  const host = hostT ?? hostTranslate(undefined)
  const detail = resolveHost(host, event.detailCode, event.detailParams, event.detail)
  const facts = logFacts(detail === '' ? undefined : detail)
  return h(
    'div',
    { key },
    h(
      'div',
      { style: STYLE.logRow },
      h('span', { style: STYLE.logTime }, logTime(event.at)),
      h(
        'span',
        { style: { ...STYLE.tag, ...STYLE.logLevel, ...LOG_CHIP[event.level] ?? {} } },
        t(`logsLevel${event.level.charAt(0).toUpperCase()}${event.level.slice(1)}`),
      ),
      event.server === undefined ? null : h('span', { style: STYLE.logName }, event.server),
      h('span', { style: STYLE.logMessage }, resolveHost(host, event.code, event.params, event.message)),
    ),
    facts.map((fact, index) => h('div', { key: `${key}#fact${index}`, style: STYLE.logDetail }, fact)),
  )
}

/**
 * The events the toolbar's two filters let through, newest first.
 *
 * Scope and level first, then the Clear mark: a cleared event is one the user
 * has said they are done with, whatever the filters say. The ring holds oldest
 * first, so the result is reversed to read newest first, like every log view.
 * @param props - the events and the three filters.
 * @returns the visible events, newest first.
 */
export function logVisible(props: {
  logs: readonly LogEvent[]
  scope: LogScope
  level: LogLevelFilter
  sessionId: string | undefined
  clearedAt: number | undefined
}): LogEvent[] {
  return props.logs
    .filter(
      (event) =>
        (props.level === 'all' || event.level === 'error') &&
        (props.scope === 'all' || event.sessionId === props.sessionId) &&
        (props.clearedAt === undefined || event.at > props.clearedAt),
    )
    .sort((left, right) => right.at - left.at)
}

/**
 * The event ring, as the logs block reads it.
 *
 * The snapshot carries the newest page (contract C1); everything older is one
 * route call behind "Show older". The two filters and the Clear mark are the
 * tab's own, stored locally — Clear has no route, by contract, so it only
 * remembers a moment and stops drawing events at or before it.
 * Exported and pure (no hooks) so a test can drive the toolbar and the list
 * directly; {@link LogsView} is the stateful wrapper around it.
 * @param project - the project whose ring is shown.
 * @param logs - events to draw, newest first.
 * @param props - the filters, the paging state and the callbacks behind them.
 * @returns the toolbar and the list.
 */
export function logList(
  project: ProjectSnapshot,
  logs: readonly LogEvent[],
  props: {
    scope: LogScope
    level: LogLevelFilter
    total: number
    loading: boolean
    failed: boolean
    t: Translate
    /** Host-namespace seat for the coded events (F-48); the payload's English shows without one. */
    hostT?: Translate | undefined
    onScope: (scope: LogScope) => void
    onLevel: (level: LogLevelFilter) => void
    onClear: () => void
    onOlder: () => void
    more: boolean
  },
): ReactNode {
  const { t } = props
  const chip = (
    filter: { label: string; on: boolean; onClick: () => void },
  ): ReactNode =>
    h(
      'button',
      {
        key: filter.label,
        style: filter.on ? { ...STYLE.logFilter, ...STYLE.logFilterOn } : STYLE.logFilter,
        // The applied chip of each pair is the pressed one. The mode switch is
        // what F-26 took away, and with it every `[aria-pressed]` outside a
        // disclosure; these two pairs live inside the logs body, where the gate
        // reads them as such.
        'aria-pressed': filter.on,
        onClick: filter.on ? undefined : filter.onClick,
      },
      filter.label,
    )
  return [
    h(
      'div',
      { style: STYLE.bar, key: 'logs-toolbar' },
      chip({
        label: t('logsThisSession'),
        on: props.scope === 'session',
        onClick: () => props.onScope('session'),
      }),
      chip({
        label: t('logsAllSessions'),
        on: props.scope === 'all',
        onClick: () => props.onScope('all'),
      }),
      h('span', { style: { flex: 1 } }),
      chip({
        label: t('logsAllLevels'),
        on: props.level === 'all',
        onClick: () => props.onLevel('all'),
      }),
      chip({
        label: t('logsErrorsOnly'),
        on: props.level === 'error',
        onClick: () => props.onLevel('error'),
      }),
      h(
        'button',
        { style: STYLE.button, title: t('logsClearHint'), onClick: props.onClear },
        t('logsClear'),
      ),
    ),
    logs.length === 0
      ? props.level === 'error' && props.total > 0
        ? logsNoErrorsState(t)
        : logsEmptyState(t)
      : h(
          'div',
          { key: 'logs-events' },
          h('div', { style: STYLE.group }, t('logsProjectCount', { count: props.total })),
          logs.map((event, index) => logRow(event, `${event.at}-${index}`, t, props.hostT)),
        ),
    props.failed ? h('div', { style: STYLE.muted, key: 'logs-failed' }, t('logsLoadFailed')) : null,
    props.loading
      ? h('div', { style: STYLE.muted, key: 'logs-loading' }, t('logsLoading'))
      : props.more
        ? h(
            'div',
            { key: 'logs-more' },
            h(
              'button',
              { style: STYLE.button, title: t('logsMoreHint'), onClick: props.onOlder },
              t('logsMore'),
            ),
            h(
              'span',
              { style: STYLE.muted },
              t('logsShown', { shown: logs.length, total: props.total }),
            ),
          )
        : null,
  ]
}

/**
 * The logs block of the tab: this plugin's own event ring, one project's
 * worth of it, with the two filters the mockup shows.
 * @param props - the project, the tab's session, that session's event count and
 *   the storage the filters live in.
 * @returns the toolbar plus the newest events.
 */
export function LogsView(props: {
  project: ProjectSnapshot
  sessionId: string | undefined
  /** Storage seam for tests; defaults to the browser's own. */
  storage?: PanelStorage | undefined
  t: Translate
  /** Host-namespace seat for the coded events (F-48). */
  hostT?: Translate | undefined
}): ReactNode {
  const { t, project } = props
  const [scope, setScope] = useState<LogScope>(() => logScopeOf(props.storage))
  const [level, setLevel] = useState<LogLevelFilter>(() => logLevelOf(props.storage))
  const [clearedAt, setClearedAt] = useState<number | undefined>(() => logsClearedAt(props.storage))
  const [older, setOlder] = useState<readonly LogEvent[]>([])
  const [request, setRequest] = useState<number | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  // Cursors already paged for. A page whose events the filters hide still
  // advances the buffer, so this only ever stops a genuinely spent cursor.
  const [attempted, setAttempted] = useState<readonly number[]>([])
  const projectRoot = project.projectRoot
  const snapshot = project.logs ?? []
  // The page buffer is unfiltered on purpose: the filters decide what is drawn,
  // not what is buffered, so a page whose events the filters hide still moves
  // the cursor past itself instead of being asked for again.
  const buffered = [...older, ...snapshot]
  const visible = logVisible({ logs: buffered, scope, level, sessionId: props.sessionId, clearedAt })
  const total = project.logCount ?? snapshot.length
  const { more, cursor } = logsPaging({ visible, total, attempted })
  useEffect(() => {
    if (request === undefined) return
    let live = true
    setAttempted((seen) => (seen.includes(request) ? seen : [...seen, request]))
    setFailed(false)
    void fetchLogs(projectRoot, request).then((page) => {
      if (!live) return
      if (page === undefined) setFailed(true)
      else setOlder((shown) => mergeLogs(page.events, shown))
      setRequest(undefined)
    })
    return () => {
      live = false
    }
  }, [request, projectRoot])
  const changeScope = (next: LogScope): void => {
    setScope(next)
    persistLogFilter(LOG_SCOPE_KEY, next, props.storage)
  }
  const changeLevel = (next: LogLevelFilter): void => {
    setLevel(next)
    persistLogFilter(LOG_LEVEL_KEY, next, props.storage)
  }
  const clear = (): void => {
    // One millisecond back, so the next event landing in the same millisecond as
    // the click is not swallowed with the ones the user cleared.
    const at = Date.now() - 1
    setClearedAt(at)
    persistLogsClearedAt(at, props.storage)
  }
  return h(
    'div',
    { style: STYLE.project },
    logList(project, visible, {
      scope,
      level,
      total,
      loading: request !== undefined,
      failed,
      t,
      hostT: props.hostT,
      onScope: changeScope,
      onLevel: changeLevel,
      onClear: clear,
      onOlder: () => setRequest(cursor),
      more,
    }),
  )
}

/**
 * Side card settings panel: the poll interval, the declaration detail and
 * per-project release.
 *
 * The interval row used to be drawn by the sidebar itself, out of the tab
 * descriptor's `pluginToggles`; the surface that drew it went with
 * `dsh-better-sidebar`, so the row is part of this panel now, next to the state
 * it paces. Everywhere else the panel is read-only.
 */
export function ProjectMcpSettings(props: {
  refreshMs: number
  /** Write a new interval; absent makes the row read-only (the design stand). */
  onRefreshMs?: ((value: number) => void) | undefined
  onClose?: (() => void) | undefined
  /** Translate seat; the popup follows the shell's language when it is given one. */
  t?: Translate | undefined
  /** Host-namespace seat for the wire-coded payload fields (F-48). */
  hostT?: Translate | undefined
}): ReactNode {
  const t = translateOf(props.t)
  const { snapshot, error, busy, run } = useSnapshot(true, props.refreshMs)
  const projects = snapshot?.projects ?? []
  return h(
    'div',
    { style: STYLE.root },
    h(
      'div',
      { style: STYLE.bar },
      h('span', { style: STYLE.name }, t('mountedPerProject')),
      h('span', { style: STYLE.muted }, t('projectsCount', { count: projects.length })),
      h('span', { style: { flex: 1 } }),
      h(
        'button',
        { style: STYLE.button, disabled: busy, onClick: () => void run(ROUTE_ACTIONS.sync) },
        t('sync'),
      ),
      props.onClose === undefined
        ? null
        : h('button', { style: STYLE.button, onClick: () => props.onClose?.() }, t('close')),
    ),
    h(RefreshRow, { refreshMs: props.refreshMs, onRefreshMs: props.onRefreshMs, t }),
    error === undefined ? null : h('div', { style: STYLE.error }, error),
    h(
      'div',
      { style: STYLE.body },
      projects.length === 0
        ? h('div', { style: { ...STYLE.muted, padding: 8 } }, t('nothingMounted'))
        : projects.map((project) =>
            h(ProjectBlock, {
              key: project.projectRoot,
              project,
              busy,
              onRelease: (sessionId) => void run('release', { sessionId }),
              hostT: props.hostT,
            }),
          ),
    ),
  )
}

/** Bounds the row offers, the steps a press moves it by, and the unit it prints. */
export const REFRESH_MIN_MS = 1_000
export const REFRESH_MAX_MS = 60_000
export const REFRESH_STEP_MS = 500
/** The unit symbol beside the field; a symbol, not copy, so it is not translated. */
export const REFRESH_UNIT = 'ms'
/** The field's id, so the row's label can point at it. */
export const REFRESH_INPUT_ID = 'dsh-project-mcp-refresh-ms'

/**
 * The poll interval as one labelled row: the copy the sidebar's toggle used,
 * the number field that replaces it, and the unit beside it.
 *
 * One implementation for both renderers — the product's settings panel and the
 * design stand's popup draw this same row — so the two cannot drift. Without a
 * writer the field is `readOnly` rather than absent: the stand shows the control
 * the product shows, it just does not pretend a press changed anything.
 */
export function RefreshRow(props: {
  refreshMs: number
  onRefreshMs?: ((value: number) => void) | undefined
  t?: Translate | undefined
}): ReactNode {
  const t = translateOf(props.t)
  return h(
    'div',
    { style: STYLE.settingRow },
    h(
      'label',
      { style: STYLE.settingLabel, htmlFor: REFRESH_INPUT_ID },
      h('span', { style: STYLE.settingTitle }, t('refreshTitle')),
      h('span', { style: STYLE.settingDesc }, t('refreshDesc')),
    ),
    h('input', {
      id: REFRESH_INPUT_ID,
      style: STYLE.settingInput,
      type: 'number',
      min: REFRESH_MIN_MS,
      max: REFRESH_MAX_MS,
      step: REFRESH_STEP_MS,
      value: props.refreshMs,
      readOnly: props.onRefreshMs === undefined,
      'aria-label': t('refreshTitle'),
      onChange: (event: { target: { value: string } }) => {
        const next = Number(event.target.value)
        if (Number.isFinite(next)) props.onRefreshMs?.(next)
      },
    }),
    h('span', { style: STYLE.settingUnit }, REFRESH_UNIT),
  )
}

/**
 * One project block: the merged rows (what the project as a whole reports) plus
 * the per-session breakdown underneath — but only for the sessions whose own
 * reading differs from the merge.
 *
 * The project is the subject now that one project-level mount serves every
 * session: a session that reads exactly like the merged rows adds no answer, so
 * the section is left out entirely and the block is just the project. A session
 * that mounts something else, or has not turned yet, is the only reason to show
 * the breakdown under it.
 */
export function ProjectBlock(props: {
  project: ProjectSnapshot
  /** Session this tab belongs to; missing in the settings popup. */
  currentSessionId?: string | undefined
  /** True while a host action is in flight. */
  busy: boolean
  /** Called with the id of the session whose servers should be released. */
  onRelease: (sessionId: string) => void
  /** Retry the project's failed mounts; absent while nothing can be written. */
  onRetry?: (() => void) | undefined
  /**
   * `false` when the surface above already names the project and carries its
   * `this session` chip — the sidebar tab's own header does. Defaults to `true`.
   */
  showName?: boolean | undefined
  /** Translate seat; falls back to this module's English copy without one. */
  t?: Translate | undefined
  /**
   * Host-namespace seat for the wire-coded payload fields (F-48); without one
   * the echo seat applies and every coded field shows its payload's English.
   */
  hostT?: Translate | undefined
}): ReactNode {
  const t = translateOf(props.t)
  const hostT = props.hostT ?? hostTranslate(undefined)
  const { project } = props
  const totals = countStatuses(project.rows)
  const sessions = sessionBreakdown(project, props.currentSessionId, t)
  const current = sessions.some((session) => session.current)
  // Project-first: the section is the disagreement view, so it is handed only
  // the sessions that read differently. An empty list makes it render nothing at
  // all — the header included — which is the quiet case this exists for.
  const deviating = sessions.filter((session) => session.deviates)
  return h(
    'div',
    { style: STYLE.project, key: project.projectRoot },
    props.showName === false
      ? null
      : h(
          'div',
          { style: STYLE.projectHead },
          h(
            'span',
            { style: STYLE.name, title: project.projectRoot },
            basename(project.projectRoot),
          ),
          current ? h('span', { style: STYLE.tag }, t('thisSession')) : null,
          h('span', { style: { flex: 1 } }),
          h('span', { style: STYLE.muted }, summarize(totals, t)),
        ),
    h(
      'div',
      // Rung 0: the project's merged rows are the ladder's baseline.
      { style: STYLE.indent(0) },
      project.rows.flatMap((row) =>
        serverRow(row, 'merged', { onRetry: props.onRetry, busy: props.busy, t: props.t, hostT: props.hostT }),
      ),
    ),
    projectIssueLines(project).map((issue, index) =>
      h(
        'div',
        { style: STYLE.detail, key: `${issue.source}#${index}` },
        `${issue.level}: ${resolveHost(hostT, issue.code, issue.params, issue.message)}`,
      ),
    ),
    h(SessionList, {
      key: `${project.projectRoot}#sessions`,
      sessions: deviating,
      busy: props.busy,
      onRelease: props.onRelease,
      // The note is about the rows above, which stay the merge of *all* the
      // project's sessions even when only one of them is out of step.
      merged: sessions.length > 1,
      t: props.t,
      hostT: props.hostT,
    }),
  )
}

/**
 * The issues the rows below do not already carry.
 *
 * A failing mount is reported twice by the host: once as the row's own `detail`,
 * which the row renders in its banner, and once as a snapshot issue naming the
 * same server. Only the issues that no banner repeats belong under the rows —
 * the document-level ones.
 * @param project - one project from the host snapshot.
 * @returns the issues left to print, in host order.
 */
export function projectIssueLines(project: ProjectSnapshot): ProjectSnapshot['issues'] {
  return project.issues.filter(
    (issue) =>
      issue.server === undefined ||
      !project.rows.some((row) => row.name === issue.server && row.detail !== undefined),
  )
}

/** Per-session view model the panel renders under one project. */
export interface SessionBreakdown {
  /** Agent (session) id; shown truncated, in full in the tooltip. */
  id: string
  /** True when this is the session the tab is open in. */
  current: boolean
  /** This session's own rows, in document order. */
  rows: ServerRow[]
  /** One-line status summary. */
  summary: string
  /**
   * True when this session's own reading disagrees with the project's merged
   * rows. The `sessions` section exists only for these sessions: the project's
   * rows come first, and a session that reads exactly like them says nothing.
   */
  deviates: boolean
}

/**
 * Whether one session's own rows disagree with the project's merged rows.
 *
 * The project's `rows` are the merge of every session, so one that mounts a
 * different set, or that has not turned yet, reads differently from them. The
 * comparison is per server and order-insensitive: each side is read as a
 * `name → set of statuses` map, so the same rows in another order are not a
 * disagreement. A name declared twice counts only for what it says — the same
 * status twice collapses into one, while two different statuses are a
 * disagreement whichever order the two sides list them in. A session whose own
 * `rows` are empty claims nothing and therefore never disagrees — a host half
 * older than the per-session field must not make the section appear.
 * @param merged - the project's merged rows.
 * @param own - one session's own rows.
 * @returns `true` when the two readings differ.
 */
export function sessionDeviates(merged: readonly ServerRow[], own: readonly ServerRow[]): boolean {
  if (own.length === 0) return false
  const projectStatus = statusesByName(merged)
  const sessionStatus = statusesByName(own)
  if (projectStatus.size !== sessionStatus.size) return true
  for (const [name, statuses] of projectStatus) {
    const ownStatuses = sessionStatus.get(name)
    if (ownStatuses === undefined || ownStatuses.size !== statuses.size) return true
    for (const status of statuses) {
      if (!ownStatuses.has(status)) return true
    }
  }
  return false
}

/** One side's rows as `name → the statuses that name was declared with`. */
function statusesByName(rows: readonly ServerRow[]): Map<string, Set<ServerRow['status']>> {
  const byName = new Map<string, Set<ServerRow['status']>>()
  for (const row of rows) {
    const statuses = byName.get(row.name)
    if (statuses === undefined) byName.set(row.name, new Set([row.status]))
    else statuses.add(row.status)
  }
  return byName
}

/**
 * Split a project's snapshot into its per-session view.
 *
 * Sessions of one project mount independently, so the merged `rows` cannot say
 * which session holds a server. Each entry also carries whether that session's
 * own reading {@link sessionDeviates} from the merge: the panel prints the
 * project's rows first and the section only for the sessions that differ, so the
 * answer to "is anything not as the project says" is computed once, here.
 * `sessions`, and each entry's `rows` with it, are read defensively: the browser
 * half hot-reloads while the host half only picks up a new build at restart, so
 * a newer panel can meet a host that predates either field.
 * @param project - one project from the host snapshot.
 * @param currentSessionId - the session this tab belongs to, if known.
 * @param t - translate seat for the summary line; English without one.
 * @returns one entry per session, in host order.
 */
export function sessionBreakdown(
  project: ProjectSnapshot,
  currentSessionId: string | undefined,
  t?: Translate,
): SessionBreakdown[] {
  return (project.sessions ?? []).map((session) => {
    const rows = session.rows ?? []
    return {
      id: session.id,
      current: currentSessionId !== undefined && session.id === currentSessionId,
      rows,
      summary: summarize(countStatuses(rows), translateOf(t)),
      deviates: sessionDeviates(project.rows, rows),
    }
  })
}

/**
 * The deviating sessions' own rows, read as one summary line.
 *
 * The collapsed `sessions` section answers "who is not holding this project the
 * way the rows above say", so its header counts the statuses across the sessions
 * it lists — the deviating ones — not across the whole project.
 * @param sessions - the deviating part of the project's per-session breakdown.
 * @param t - translate seat; falls back to this module's English copy.
 * @returns the merged status summary, e.g. `2 active, 1 idle`.
 */
export function sessionsSummary(sessions: readonly SessionBreakdown[], t?: Translate): string {
  return summarize(countStatuses(sessions.flatMap((session) => session.rows)), translateOf(t))
}

/**
 * The header row of the collapsed sessions section.
 *
 * Collapsed is the default: the section is a disclosure, so the header has to
 * carry the whole answer on its own — the label, how many sessions are out of
 * step, and their merged status. The list handed to it is already the deviating
 * one, so the count chip counts those, never how many sessions the project has
 * (the toolbar's right edge is where that count lives). Exported and pure so
 * the shape is asserted without a renderer; {@link SessionList} owns the open
 * state and the rows below it.
 * @param props - the deviating sessions, the open flag and the toggle.
 * @returns the header row.
 */
export function sessionsHeader(props: {
  sessions: readonly SessionBreakdown[]
  open: boolean
  onToggle: () => void
  /** `true` when the rows above are a merge of these sessions, not one session's own. */
  merged?: boolean | undefined
  t?: Translate | undefined
}): ReactNode {
  const t = translateOf(props.t)
  return h(
    'div',
    // Rung 1: the `sessions` section sits one step right of the project rows.
    { style: { ...STYLE.sessionHead, ...STYLE.indent(1) } },
    h(
      'button',
      {
        // The mockup draws the section label in the tertiary tone
        // (`docs/design/mockups/harness.html`) — it names the seam, it is not the content.
        style: { ...STYLE.sessionToggle, ...STYLE.dim },
        'aria-expanded': props.open,
        title: props.open ? t('hideSessions') : t('showSessions'),
        onClick: props.onToggle,
      },
      `${props.open ? '▾' : '▸'} ${t('sessionsSection')}`,
    ),
    h('span', { style: STYLE.tag }, deviationCount(props.sessions.length, t)),
    h('span', { style: STYLE.muted }, sessionsSummary(props.sessions, t)),
    h('span', { style: { flex: 1 } }),
    props.merged === true ? h('span', { style: STYLE.muted }, t('mergedAcrossSessions')) : null,
  )
}

/**
 * The list of the sessions that read differently from the project.
 *
 * Project-first: the rows above are the project's own reading, and a session
 * that reads exactly like them adds nothing, so the panel hands this component
 * only the sessions whose own rows disagree. An empty list therefore means the
 * whole project agrees with itself — the quiet case — and the section renders
 * nothing at all: no header, no rows. When there is something to explain, the
 * section still starts collapsed so a single out-of-step session does not push
 * the project's rows out of the way; opening it lists one row per deviating
 * session, and each of those opens its own rows.
 */
export function SessionList(props: {
  sessions: SessionBreakdown[]
  busy: boolean
  onRelease: (sessionId: string) => void
  /** `true` when the rows above are a merge of the project's sessions, not one session's own. */
  merged?: boolean | undefined
  /** Translate seat; falls back to this module's English copy without one. */
  t?: Translate | undefined
  /** Host-namespace seat for the rows' coded details (F-48). */
  hostT?: Translate | undefined
}): ReactNode {
  const [section, setSection] = useState(false)
  const [open, setOpen] = useState<string | undefined>(undefined)
  // Nothing to explain: the section is the whole disagreement view, header
  // included, and a project that reads like every one of its sessions gets none.
  if (props.sessions.length === 0) return null
  return h(
    'div',
    { style: STYLE.sessions },
    sessionsHeader({
      sessions: props.sessions,
      open: section,
      merged: props.merged,
      onToggle: () => setSection((value) => !value),
      t: props.t,
    }),
    section
      ? props.sessions.map((session) =>
          h(sessionEntry, {
            key: session.id,
            session,
            expanded: open === session.id,
            onToggle: () => setOpen((value) => (value === session.id ? undefined : session.id)),
            busy: props.busy,
            onRelease: props.onRelease,
            t: props.t,
            hostT: props.hostT,
          }),
        )
      : null,
  )
}

/**
 * One session's block inside the expanded `sessions` section: its own header row
 * (the short id, `this session` when it is, the summary, `Release`) and, when it
 * is open, the servers that session holds.
 *
 * Pure, with the disclosure state given to it rather than owned, so the ladder it
 * draws — rung `2` for the header, rung `3` for the rows under it — is asserted
 * without rendering {@link SessionList}.
 * @param props - the session, its open state and the row action.
 * @returns the session's block.
 */
export function sessionEntry(props: {
  session: SessionBreakdown
  expanded: boolean
  onToggle: () => void
  busy: boolean
  onRelease: (sessionId: string) => void
  t?: Translate | undefined
  /** Host-namespace seat for the rows' coded details (F-48). */
  hostT?: Translate | undefined
}): ReactNode {
  const t = translateOf(props.t)
  const { session } = props
  return h(
    'div',
    // Rung 2: one session of the section, one step right of its header.
    { style: { ...STYLE.session, ...STYLE.indent(2) } },
    h(
      'div',
      { style: STYLE.sessionHead },
      h(
        // The marker belongs to a **collapsed** row only (mockup `:323`): an
        // expanded session already shows its servers, so a turned-down triangle
        // beside them would be a second, redundant marker. The button stays
        // either way, so the row is still the control that folds it back up.
        'button',
        {
          // A collapsed session's id is the mock's `.dim` (`docs/design/mockups/harness.html`):
          // once open, the id is content and reads in the primary tone.
          style: props.expanded ? STYLE.sessionToggle : { ...STYLE.sessionToggle, ...STYLE.dim },
          title: props.expanded ? t('hideSession') : t('showSession'),
          'aria-expanded': props.expanded,
          onClick: props.onToggle,
        },
        props.expanded ? shortSessionId(session.id) : `▸ ${shortSessionId(session.id)}`,
      ),
      session.current ? h('span', { style: STYLE.tag }, t('thisSession')) : null,
      h('span', { style: STYLE.muted }, session.summary),
      h('span', { style: { flex: 1 } }),
      h(
        'button',
        {
          style: STYLE.button,
          disabled: props.busy,
          title: session.id,
          onClick: () => props.onRelease(session.id),
        },
        t('release'),
      ),
    ),
    props.expanded ? sessionRows(session, props.t, props.hostT) : null,
  )
}

/**
 * One session's own server rows, or the placeholder when that session declared
 * nothing, at rung `3` — the deepest level of the surface's indentation ladder.
 * Exported so the panel tests can assert what a session block shows without a
 * DOM.
 * @param session - one entry of {@link sessionBreakdown}.
 * @param t - translate seat; falls back to this module's English copy.
 * @param hostT - host-namespace seat for the rows' coded details (F-48).
 * @returns the rows element tree for that session.
 */
export function sessionRows(session: SessionBreakdown, t?: Translate, hostT?: Translate): ReactNode {
  return h(
    'div',
    // Rung 3: the servers a session holds, one step right of the session row.
    { style: STYLE.indent(3) },
    session.rows.length === 0
      ? h('div', { style: STYLE.muted }, translateOf(t)('nothingDeclared'))
      : session.rows.map((row) => serverRow(row, session.id, { t, hostT })),
  )
}

/** `session-8fce1c` reads better as `8fce1c` in a narrow sidebar. */
function shortSessionId(id: string): string {
  const trimmed = id.replace(/^session-/, '')
  return trimmed.length > 8 ? `${trimmed.slice(0, 8)}…` : trimmed
}

/**
 * `1 session` / `3 sessions`, through the locale table.
 *
 * The toolbar's right edge answers how many sessions the project has; the
 * `sessions` section counts something else and uses
 * {@link deviationCount} instead.
 */
export function sessionCount(count: number, t: Translate): string {
  return count === 1 ? t('sessionsOne') : t('sessionsMany', { count })
}

/**
 * `1 differs` / `3 differ` — how many sessions are out of step with the project.
 *
 * A chip of its own phrase rather than `{count} sessions`: the section lists the
 * deviating sessions only, and "1 session" beside one row would read as the
 * project having a single session, which the toolbar already says.
 */
export function deviationCount(count: number, t: Translate): string {
  return count === 1 ? t('differsOne') : t('differsMany', { count })
}

/** `1 server` / `3 servers`, through the locale table. */
export function serverCount(count: number, t: Translate): string {
  return count === 1 ? t('serversOne') : t('serversMany', { count })
}

/**
 * The short form of a transport: the mockup's rows carry `http` / `stdio`.
 * @param transport - the transport the host reported.
 * @returns the chip's label.
 */
export function shortTransport(transport: string): string {
  return transport === 'streamable-http' ? 'http' : transport
}

/** Everything one server row needs beyond the row itself. */
export interface ServerRowOptions {
  /** Retry the project's failed mounts; absent while nothing can be written. */
  onRetry?: (() => void) | undefined
  /** `true` while a host action is in flight, so the row's button stays still. */
  busy?: boolean | undefined
  /**
   * The host's own `lastUsedAt` for this server, when it published a record for
   * it: the quiet row then reads `idle 3d` beside its status word
   * ({@link idleNote}).
   */
  lastUsedAt?: string | undefined
  /** Translate seat; falls back to this module's English copy without one. */
  t?: Translate | undefined
  /**
   * Host-namespace seat for the row's coded detail (F-48); without one the
   * payload's English shows, byte-identical to before codes existed.
   */
  hostT?: Translate | undefined
}

/**
 * A row's detail line as the screen shows it (F-48): the coded companions
 * resolved through the host seat, and the payload's English prose when they
 * are absent (an old host) or the seat does not know the code (a client older
 * than the host). `undefined` stays `undefined`, so a detail-less row keeps
 * its status hint as the tooltip.
 * @param row - the server row.
 * @param hostT - the host-namespace seat, when the surface has one.
 * @returns the sentence to render, or `undefined` for a row with no detail.
 */
export function rowDetail(row: ServerRow, hostT?: Translate | undefined): string | undefined {
  if (row.detail === undefined) return undefined
  return resolveHost(hostT ?? hostTranslate(undefined), row.detailCode, row.detailParams, row.detail)
}

/**
 * The quiet `idle {n}d` word a server row shows beside its status word.
 *
 * Only the two quiet statuses get one: `active`, `connecting`, `error` and
 * `conflict` already say what the server is doing, and a figure of inactivity
 * beside them would be a second answer to a question nobody asked. The word is
 * the span since the host's own `lastUsedAt` (`ProjectSnapshot.usage`), and it
 * is drawn only while that record exists and parses: no data, no word — never a
 * `0`.
 * @param status - the row's status.
 * @param lastUsedAt - ISO timestamp of the server's most recent call.
 * @param t - translate seat; falls back to this module's English copy.
 * @param now - epoch milliseconds to measure against; `Date.now()` by default.
 * @returns the label, or undefined when this row shows none.
 */
export function idleNote(
  status: ServerStatus,
  lastUsedAt: string | undefined,
  t: Translate = translateOf(),
  now: number = Date.now(),
): string | undefined {
  if (status !== 'idle' && status !== 'disabled') return undefined
  const span = idleOf(lastUsedAt, now)
  if (span === undefined) return undefined
  const key = span.unit === 'day' ? 'idleDay' : span.unit === 'hour' ? 'idleHour' : 'idleMinute'
  return t(key, { count: span.count })
}

/**
 * How often one tool was called, as its row writes it.
 *
 * The counters belong to the host's record of the tool's server, and there are
 * two of them: the project's, which is what proved the tool hot, and the reading
 * session's own share of it (F-34). The row leads with the session's figure —
 * the question a reader at one session asks — and names the project's when the
 * two disagree, because that disagreement is the whole point: tools are mounted
 * for the project and used inside a session. Three states are told apart: a
 * figure to print, a server the host recorded whose counter for this tool is
 * absent (`never called`), and no record at all, which draws nothing.
 * @param calls - the two readings, absent when the host published no record.
 * @param t - translate seat; falls back to this module's English copy.
 * @returns the label, or undefined when the row shows none.
 */
export function callsLabel(calls: ToolCalls | undefined, t: Translate = translateOf()): string | undefined {
  if (calls === undefined || !calls.recorded) return undefined
  // The session's own reading leads whenever the host splits its counters by
  // session; without a split the project total is the only figure there is.
  const lead = calls.split ? calls.session : calls.project
  const figure =
    lead === undefined ? t('callsNone') : lead === 1 ? t('callsOne') : t('callsMany', { count: lead })
  const project = calls.project
  // The project's figure rides along exactly while it adds something: it is
  // published, and the session's own reading does not already say it. Two numbers
  // that agree are one number, and `never called · 182 in the project` says what
  // "never called" alone would leave unsaid.
  const adds = project !== undefined && project !== lead
  return adds ? `${figure} · ${t('callsProject', { count: project })}` : figure
}

/**
 * The one `Retry` a failing server row carries.
 *
 * Two surfaces draw a server row — the errors disclosure's {@link serverRow} and
 * the tab's own {@link ServersBlock} — and both offer the same action: the host
 * route drops this project's failed mounts and re-mounts them. The button is
 * built here once, so its label, its hint and the `disabled` flag that keeps
 * every press still while one host action is in flight cannot drift apart
 * between them. A surface that hands no action down gets no button at all,
 * which is what makes a read-only panel read-only instead of drawing a dead
 * press.
 * @param t - translate seat.
 * @param onRetry - the project's retry, or undefined where nothing can be written.
 * @param busy - `true` while a host action is in flight.
 * @returns the button, or `null` where there is no action to press.
 */
function retryButton(
  t: Translate,
  onRetry: (() => void) | undefined,
  busy: boolean | undefined,
): ReactNode {
  return onRetry === undefined
    ? null
    : h(
        'button',
        {
          style: STYLE.button,
          title: t('retryHint'),
          disabled: busy === true,
          onClick: onRetry,
        },
        t('retry'),
      )
}

/**
 * One server, as the tab draws it.
 *
 * The status is the dot, not a word: its colour comes from the shared
 * {@link STATUS_COLOR} table and its tooltip through {@link STATUS_HINT}, so the
 * row reads at a glance and still explains itself on hover. The transport and
 * the quiet states (`idle`, `disabled`) are chips, and the quiet rows are dimmed
 * rather than recoloured. A row the host reported a failure for carries its own
 * `Retry` — the host route is project-scoped, so it sends exactly the request
 * the toolbar's button sends — and its detail in a banner underneath, with the
 * coloured left rule the mockup uses for a failure.
 * @param row - the server row.
 * @param keyPrefix - prefix for the two element keys of this row.
 * @param options - the row action and the translate seat.
 * @returns the row and, when it has one, its detail banner.
 */
export function serverRow(
  row: ServerRow,
  keyPrefix: string,
  options: ServerRowOptions = {},
): ReactNode[] {
  const t = translateOf(options.t)
  const quiet = row.status === 'idle' || row.status === 'disabled'
  // The host's detail line, translated when the row carries its wire code.
  const detail = rowDetail(row, options.hostT)
  // The span since the host's own `lastUsedAt`, drawn beside the quiet status
  // word and only there: `idle 3d` says how long a quiet server has been quiet,
  // which is a fact the status word alone cannot carry.
  const idle = idleNote(row.status, options.lastUsedAt, t)
  return [
    h(
      'div',
      {
        style: quiet ? { ...STYLE.row, ...STYLE.rowQuiet } : STYLE.row,
        key: `${keyPrefix}#${row.name}`,
        title: detail ?? t(STATUS_HINT[row.status]),
      },
      h('span', {
        style: { ...STYLE.dot, background: STATUS_COLOR[row.status] },
        'aria-hidden': true,
      }),
      h('span', { style: STYLE.name }, row.name),
      row.transport === undefined
        ? null
        : h('span', { style: STYLE.tag }, shortTransport(row.transport)),
      // The quiet chip takes the mock's `.dim` tone (`docs/design/mockups/harness.html`),
      // one step below the transport chip beside it.
      quiet ? h('span', { style: { ...STYLE.tag, ...STYLE.tagQuiet } }, t(STATUS_KEYS[row.status])) : null,
      idle === undefined ? null : h('span', { style: STYLE.dim }, idle),
      h('span', { style: { flex: 1 } }),
      retryButton(t, row.status === 'error' ? options.onRetry : undefined, options.busy),
    ),
    // A quiet row's detail ("not mounted yet — this session has not started a
    // turn") is a fact about a *normal* state, and the mockup draws `idle` as a
    // chip with no note under it (`docs/design/mockups/harness.html`): a warning banner per
    // idle server turns a calm list into a wall of amber. The reason stays on
    // the row's own `title`, and the errors disclosure (error / conflict /
    // connecting only) is where the host's text is read out in full.
    row.detail === undefined || quiet
      ? null
      : h(
          'div',
          {
            style:
              row.status === 'error'
                ? STYLE.banner
                : { ...STYLE.banner, ...STYLE.bannerWarn },
            key: `${keyPrefix}#${row.name}#detail`,
          },
          detail,
        ),
  ]
}

function countStatuses(rows: readonly ServerRow[]): Partial<Record<ServerStatus, number>> {
  const totals: Partial<Record<ServerStatus, number>> = {}
  for (const row of rows) totals[row.status] = (totals[row.status] ?? 0) + 1
  return totals
}

/** The statuses a summary line names, in the order it names them. */
const SUMMARY_ORDER = ['active', 'connecting', 'idle', 'error', 'conflict'] as const

/**
 * The `{count}` template key of every status — a full `ServerStatus` record,
 * so a status the order above ever names without a template is a compile
 * error, not a raw token in the summary line.
 */
const SUMMARY_KEYS: Record<ServerStatus, LocaleKey> = {
  active: 'summaryActive',
  connecting: 'summaryConnecting',
  idle: 'summaryIdle',
  disabled: 'summaryDisabled',
  error: 'summaryError',
  conflict: 'summaryConflict',
}

/**
 * One line of status counts (`2 active, 1 idle`), every count a `{count}`
 * placeholder of its status's template so no language reads a concatenation.
 * @param totals - the counted rows.
 * @param t - translate seat; falls back to this module's English copy.
 * @returns the summary, or the `summaryNone` answer when nothing was counted.
 */
function summarize(
  totals: Partial<Record<ServerStatus, number>>,
  t: Translate = fallbackTranslate,
): string {
  const parts: string[] = []
  for (const status of SUMMARY_ORDER) {
    const count = totals[status]
    if (count !== undefined && count > 0) parts.push(t(SUMMARY_KEYS[status], { count }))
  }
  return parts.length === 0 ? t('summaryNone') : parts.join(', ')
}

/** Last path segment; used for every project and document label. */
export function basename(path: string): string {
  const parts = path.split('/').filter((part) => part !== '')
  return parts[parts.length - 1] ?? path
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
