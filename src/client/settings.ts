/**
 * The plugin's page inside DSH's native Settings.
 *
 * A sidebar tab belongs to one conversation, so it deliberately shows **only**
 * that session's project. This page is the other half of the picture: every
 * project with a live session, one selected at a time, with two remembered
 * views — `Table` (a dense overview) and `By files` (the plugin's own model:
 * documents read in priority order, a later document overriding an earlier
 * entry) — plus the split editor.
 *
 * The editor writes, and only within the frozen contract of
 * `docs/design/contracts/write-path.md`: the form edits the parsed {@link EntrySnapshot}
 * the row carries, the JSON pane shows that entry against the snapshot as a
 * line diff, and a save goes through a confirmation that names the document,
 * the `.bak` copy and the format normalization. A row whose
 * {@link ServerRow.writeScope} is `readonly` keeps the old blocked rendering,
 * with `writeBlockedReason` on every control. Secrets stay out of the editor's
 * reach: a masked `env`/`headers` key submitted untouched carries `masked: true`
 * and no value, so the document keeps the secret the form never saw.
 *
 * Registration contract (DSH `settings.section`, kind `list`, scope
 * `root`, owner copy intentionally empty):
 *
 * ```ts
 * ctx.slots.inject('settings.section', () => ctx.slots.register({
 *   name: 'settings.section', id, order, label: () => t('tab'), locale: NS,
 *   inject: () => ({}),
 * }, SettingsTab))
 * ```
 *
 * `slots.inject` is not decoration: the slot is declared by the Plugins
 * settings section at runtime, and `slots.register` **throws** on an undeclared
 * slot. Data comes from the host over `/project-mcp/snapshot` (see
 * `src/ui.ts`), through the same poll path the sidebar tab uses.
 *
 * The DSH client packages (`@deepseek-ai/dsh-client-ui-slots`, `-locale`,
 * `-ui-settings`) are provided by the web shell and are not dependencies of
 * this package, so the contract is mirrored structurally here: the composed
 * props type is `PropsRuntime<'settings.section'> & PropsLocale<NS> &
 * InjectFace<SettingsTabInjected>`, which for this slot means "no owner props,
 * the namespace-bound `t` seat, and the inject factory's members".
 *
 * @module dsh-project-mcp/client/settings
 */

import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactHTML, ReactNode } from 'react'
import { PACKAGE_NAME, ROUTE_ACTIONS, ROUTE_PREFIX } from '../shared.ts'
import type { SaveErrorCode, SaveRequest } from '../shared.ts'
import type {
  ConflictChoice,
  EntryField,
  EntrySnapshot,
  McpSnapshot,
  ProjectSnapshot,
  ServerRow,
  ServerStatus,
  ToolMode,
} from '../types.ts'
import {
  DEFAULT_REFRESH_MS,
  STATUS_COLOR,
  STATUS_HINT,
  STATUS_KEYS,
  basename,
  browserStorage,
  emptyState,
  idleNote,
  rowDetail,
  serverCount,
  storeString,
  storedString,
  useSnapshot,
} from './view.ts'
import type { PanelStorage } from './view.ts'
import { DEFAULT_SETTINGS_PAGE, SettingsPageSwitch, ToolsPage, choiceKey } from './settings-tools.ts'
import type { SettingsPageKey } from './settings-tools.ts'
import {
  conflictBody,
  operatorBody,
  pinBody,
  policyBody,
  postConflict,
  requestMode,
  requestPin,
} from './policy.ts'
import type { PolicyRefusal } from './policy.ts'
import { projectPolicyRows } from './settings-tools.ts'
import { uiTranslate } from './locales/ui.ts'
import { hostTranslate, resolveHost } from './locales/host.ts'

/** Locale namespace the page's copy is registered under. */
export const NS = 'settings.projectMcp'

/**
 * The settings page's own English copy, half of the namespace's dictionary.
 *
 * Keys only; the language switch stays with the shell, which re-registers
 * nothing here — a second language is one more dictionary, not a code change.
 * `./locales/ui.ts` adds the panel's half for the one
 * `ctx.locale.register(NS, { zh, en, ru })` call the plugin makes.
 */
export const EN = {
  project: 'Project',
  projectsOne: '1 project with a live session',
  projectsMany: '{count} projects with live sessions',
  viewTable: 'Table',
  viewFiles: 'By files',
  sync: 'Sync',
  syncHint: 'Re-read the host snapshot now',
  server: 'Server',
  transport: 'Transport',
  status: 'Status',
  source: 'Source',
  on: 'On',
  servers: 'Servers',
  paneEntry: 'Entry',
  name: 'Name',
  detail: 'Detail',
  loading: 'Reading the host snapshot…',
  loadingHint: 'The page polls /project-mcp/snapshot as soon as it opens.',
  hostUnavailable: 'The page did not get an answer from the plugin host.',
  hostUnavailableHint:
    'The host half serves {route}; it picks up changes only after a dsh web restart — check the log.',
  noSessions: 'No session is attached to a project yet.',
  noSessionsHint:
    'Servers come up when a session starts working inside a project folder — nothing is mounted for a project without one.',
  noSessionsPaths: 'read: {paths}',
  noSessionsNoPaths:
    'this deployment reads no MCP document — list the documents to read in the plugin config (`localFiles`, `globalFiles`)',
  noServers: 'This project declares no MCP servers.',
  noServersHint: 'Nothing is declared, so nothing is mounted for its sessions.',
  noServersNoPath: 'This deployment reads no project document, so there is nowhere to declare one.',
  documentUnknown: 'declaration document unknown',
  global: 'global',
  priority: 'priority {tier}/{total}',
  overrideFrom: '↳ overrides {name} from {from}',
  overrideUnpinned: '↳ overrides {name} declared in a lower-priority document',
  nameReason: 'Read-only: the server name is the declaration key the host reports.',
  statusReason: 'Read-only: the status comes from the running host, not from a document.',
  sourceReason: 'Read-only: the declaring document path comes from the host.',
  detailReason: 'Read-only: the host redacts this text and never includes arguments.',
  openToEdit: 'Read-only here: open the server to edit its entry.',
  rowActionsMore: '…',
  rowActionsHint: 'Open this entry in the editor',
  retry: 'Retry',
  retryHint: 'Retry this project’s failed mounts now',
  showJson: 'Show JSON',
  hideJson: 'Hide JSON',
  jsonPreview: 'snapshot JSON',
  jsonPreviewHint: 'Read from the host snapshot; the document on disk is not touched.',
  back: 'Back to the list',
  backHint: 'Return to the overview without changing anything',
  // Editor: the fields of the parsed entry.
  entryUnavailable: 'The host did not parse this entry, so there is nothing to edit.',
  commandField: 'Command',
  argsField: 'Args',
  cwdField: 'CWD',
  urlField: 'URL',
  envField: 'Env',
  headersField: 'Headers',
  enabledField: 'Enabled',
  timeoutField: 'Timeout',
  keyField: 'Key',
  valueField: 'Value',
  argsHint: 'One argument per line; every line is written verbatim.',
  envHint: 'One value per key; a key the form drops is removed from the entry.',
  headersHint: 'One value per header; a key the form drops is removed from the entry.',
  timeoutHint: 'Milliseconds; empty means the declaration sets no timeout.',
  enabledValue: 'enabled: {value}',
  absent: 'absent',
  maskedValue: '•••• unchanged — type to replace',
  valuePlaceholder: 'value',
  keyPlaceholder: 'KEY',
  credentialsNote:
    'Comes from an external source — the project .env or the credentials file — not from this document: it is shown and written back untouched.',
  credentialValue: 'from the project .env or the credentials file',
  addKey: 'Add key',
  addKeyHint: 'Append an empty key; an unnamed key is not written.',
  removeKey: '✕',
  removeKeyHint: 'Drop this key; a dropped key is removed from the entry.',
  // Writing.
  editableNote:
    'Editing {document}: Save asks for confirmation, keeps {backup} and rewrites the entry wholesale.',
  writeBlocked: 'Read-only: {reason}',
  writeBlockedUnknown: 'the host did not report why this document may not be written.',
  save: 'Save…',
  saveHint: 'Open the confirmation for this write',
  saveNoChange: 'No change to save yet.',
  saveUnavailable: 'The snapshot carries no declaring document or revision to write back to.',
  saveTimeoutInvalid: 'The timeout is not a whole number of milliseconds.',
  saving: 'Writing…',
  discard: 'Discard',
  discardHint: 'Restore every field from the snapshot and write nothing',
  discardReason: 'No change to restore yet.',
  unsaved: 'unsaved',
  jsonDiff: 'diff',
  jsonClean: 'no change',
  jsonUnavailable: 'no parsed entry',
  jsonInvalid: 'The JSON does not parse into an entry: {reason}',
  jsonEditHint: 'Edit the entry as the document declares it',
  saveJsonInvalid: 'Fix the JSON pane first: it does not parse into an entry.',
  footerWrite: '→ {document} · .bak copy · confirmation',
  footerReadonly: '→ {document} · read-only',
  confirmTitle: 'Write {document}?',
  confirmBackup: 'The current document is copied to {backup} first.',
  confirmFormat:
    'The entry replaces mcpServers[{server}] wholesale. The document is re-serialized with two-space indentation and a trailing newline, so the indentation and the key order of the rest of the document are normalized.',
  confirmConsent:
    'This is a global document: every project reads it, so the write needs explicit consent.',
  consentLabel: 'I understand this rewrites a global document shared by every project.',
  confirmWrite: 'Write the document',
  confirmWriteHint: 'Write the document after the checks above',
  confirmBlocked: 'Tick the consent box first: a global write without it is refused.',
  cancel: 'Cancel',
  saveOk: 'Saved: the document was written and re-read.',
  saveErrorInvalid:
    'The host refused the entry: it is not one this plugin would mount. Nothing was written.',
  saveErrorBlocked:
    'The document may not be written on this tier, or the consent is missing. Nothing was written.',
  saveErrorConflict: 'The document changed since this snapshot was taken. Nothing was written.',
  saveErrorNotFound: 'The document or the server is no longer there. Nothing was written.',
  saveErrorFailed: 'The write itself failed; the document is left as it was. Nothing was written.',
  hostMessage: 'The host said: {message}',
  reRead: 'Re-read',
  reReadHint: 'Refetch the host snapshot and rebuild the form from it',
  // Our own two pages, and the disclosure policy page next to `Servers`.
  tabServers: 'Servers',
  tabTools: 'Tools',
  policyNote: 'the mode this project follows, and the tools pinned for it',
  checkConflicts: 'Check conflicts',
  checkConflictsHint:
    'the conflicting server names the host reports for this project, read from its snapshot; the button re-reads it now',
  conflictsNone: 'no conflicting server name in this project',
  conflictProfile: 'profile name',
  conflictDuplicate: 'duplicate declaration',
  conflictSources: 'declared in {sources}',
  choiceLabel: 'show',
  choiceLocal: 'this project\u2019s copy as {alias}',
  choiceProfileHint: 'keep the profile instance\u2019s tools exactly as they are',
  choiceLocalHint:
    'mount this project\u2019s own declaration beside the profile one, under the local name {alias}',
  choiceNative: 'this project\u2019s declaration under its own name',
  choiceNativeHint:
    'mount this project\u2019s own declaration under the name it declares: it is the nearer one in this project, so it shadows the profile instance\u2019s tools here while every other project keeps seeing them',
  choiceRefused: 'The host refused the choice:',
  toolsCount: 'tools',
  pinned: 'Pinned',
  mode: 'Mode',
  modeDisclosure: 'disclosure',
  modeDirect: 'all direct',
  modeOff: 'off',
  modeHint: 'written straight away, on the request the host assembles next',
  modeRefused: 'The host refused the mode:',
  pinRefused: 'The host refused the pin:',
  pinList: 'pinned · written by hand, offered in every request',
  pinListEmpty: 'no pins yet — switch one on in the tool list below',
  serverAllOffered: 'all {count} of its tools are offered directly',
  serverPartlyOffered: '{offered} of {total} tools offered directly',
  // The server-level pin (F-44): one switch for the whole server row, above the
  // per-name rows it stands for.
  serverPin: 'pin this server’s tools',
  serverPinHint: 'Pin every tool this server mounts — the hidden ones too — so every request carries them',
  serverUnpin: 'unpin this server’s tools',
  serverUnpinHint: 'Stop pinning the tools of this server',
  prefixFact: 'mcp__<server>__<tool>; the registry applies the prefix, not this page',
  pinTag: 'pin',
  moreTools: '… {count} more',
  requestPreview: 'request preview',
  requestPreviewTools: 'tools[] = {count}',
  requestPreviewTokens: '≈ {tokens} tokens',
  requestPreviewHidden: 'hidden {count}',
  requestPreviewSaved: 'hidden {count} · ≈ {tokens} tokens saved',
  requestPreviewNoOffer: 'no offer published by this session yet',
  // The host's own usage counters, the same six keys and the same words the
  // panel's table holds: the settings page draws its server rows and its pin
  // picker itself, and one namespace means one spelling of `never called`
  // (merged with the panel's half in `./locales/ui.ts`, panel last).
  callsOne: '1 call',
  callsMany: '{count} calls',
  callsNone: 'never called',
  idleDay: 'idle {count}d',
  idleHour: 'idle {count}h',
  idleMinute: 'idle {count}m',
} satisfies Record<string, string>

/** A dictionary key of this namespace. */
export type LocaleKey = keyof typeof EN

/** Translate one key, with optional `{name}` template params (the DSH seat). */
export type Translate = (key: string, params?: Record<string, unknown>) => string

/**
 * Bind the translate seat the framework injects, falling back to this module's
 * own English dictionary when the page renders outside a DSH shell (tests, or a
 * browser half newer than the host).
 * @param t - the `t` seat of the composed props, when the framework passes one.
 * @returns a translate function that always answers.
 */
export function translateOf(t?: Translate): Translate {
  return t ?? fallbackTranslate
}

function fallbackTranslate(key: string, params?: Record<string, unknown>): string {
  const template = (EN as Record<string, string>)[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  )
}

/**
 * Slot key the page contributes to.
 *
 * `settings.section` is the settings navigation itself: one entry per settings
 * page, rendered as the content column when it is selected. The plugin's page is
 * a page in its own right — it has a project selector, its own view switch and a
 * write path — not a detail tab of the plugin inventory, so it belongs here
 * rather than inside the Plugins section.
 */
export const SETTINGS_SLOT = 'settings.section'

/** Section id inside the navigation: the package name, so the row reads like the plugin. */
export const SETTINGS_TAB_ID = PACKAGE_NAME

/**
 * Navigation position. The in-box sections run from `0` (General) to `25`
 * (Archived sessions), and installed plugins fill the rows after them; a page
 * about this plugin's own project data belongs at the end of that list.
 */
export const SETTINGS_TAB_ORDER = 900

/** Options a `list` slot accepts for one registration. */
export interface SlotRegistration<Slot extends string = string> {
  name: Slot
  id: string
  order: number
  /** The shell re-reads this per render, so a language switch needs no re-register. */
  label?: () => string
  locale: string
  /** The registrant's business face; empty while the page reads the host over HTTP. */
  inject?: () => Record<string, never>
}

/** Options the settings page registers with; the slot it may claim is fixed. */
export type SettingsTabRegistration = SlotRegistration<typeof SETTINGS_SLOT>

/** Injected business face of the settings tab. Nothing yet: the page fetches. */
export type SettingsTabInjected = Record<never, never>

/**
 * Composed component props, mirroring
 * `PropsRuntime<'settings.section'> & PropsLocale<NS> & InjectFace<SettingsTabInjected>`:
 * the slot's owner passes no props, the framework contributes the
 * namespace-bound `t` seat, and the inject face's members arrive flattened.
 *
 * `t` is optional so the page still renders its own English copy outside a DSH
 * shell, which is also what the no-DOM view tests rely on.
 */
export interface SettingsTabProps {
  t?: Translate
  /**
   * The `projectMcp.host` seat, injected by {@link registerSettingsTab} from
   * the locale service the framework's own `t` cannot reach: `t` is bound to
   * the UI namespace, while host messages resolve through their own. Absent in
   * tests and outside a shell — the resolver then falls back to the payload's
   * English message.
   */
  hostT?: Translate | undefined
}

/**
 * The two client services the settings contribution needs. Both are optional in
 * a composition, which is exactly why registration goes through `ctx.inject`
 * rather than a module-level `inject` list: dropping either one must not take
 * the sidebar tab down with it.
 */
export interface SlotLocale {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
  bind(namespace: string): Translate
  /**
   * Add a language the shell does not ship, so dictionaries registered under
   * its id resolve. Optional: a shell whose locale service predates the method
   * must not break this plugin's boot — its keys then fall back to English.
   */
  addLanguage?(input: { id: string; label: string; fallback: string }): () => void
}

/**
 * The slot service, as a registrant uses it.
 *
 * `register`'s component seat is the slots package's own generic (a component of
 * the slot's composed props), which this package mirrors structurally: each
 * registrant supplies the props type it reads, so the settings page keeps its
 * `SettingsTabProps` and nothing else has to share it.
 */
export interface SlotSlots<Slot extends string = string> {
  inject(slot: string, callback: () => unknown): unknown
  register<Props>(
    options: SlotRegistration<Slot>,
    component: (props: Props) => ReactNode,
  ): unknown
}

/**
 * The two client services a contribution needs. Both are optional in a
 * composition, which is exactly why registration goes through `ctx.inject`
 * rather than a module-level `inject` list: dropping either one must not take
 * the sidebar tab down with it.
 */
export interface SettingsSlotServices {
  effect(execute: () => unknown, label?: string): unknown
  locale: SlotLocale
  slots: SlotSlots<typeof SETTINGS_SLOT>
}

/**
 * Contribute the page to the Plugins settings section.
 *
 * Two steps, because the slot is declared by the section at runtime:
 * `slots.inject` waits for the declaration (and re-registers after a collapse,
 * so a settings-section reload does not leave the tab missing), and the callback
 * calls `slots.register`, which would throw if the slot were not declared yet.
 * @param services - the injected `slots` and `locale` services.
 * @param component - the page to register; the real one by default. The
 *   design-only render mode passes its fixture-fed page (`./design.ts`) so the
 *   slot, the id and the order stay a single implementation.
 */
export function registerSettingsTab(
  services: SettingsSlotServices,
  component: (props: SettingsTabProps) => ReactNode = SettingsTab,
): void {
  // The one translator both seats share: the bound namespace answers first,
  // the merged English table answers a key the active language lacks, and the
  // raw key shows only when even English has nothing for it. The slot keeps
  // `locale: NS` so the framework's own seat stays consistent.
  const t = uiTranslate(services.locale)
  // The second namespace's seat: the framework binds `t` to `NS` only, so the
  // host messages' translator is bound here and handed to the page as a prop.
  const hostT = hostTranslate(services.locale)
  services.slots.inject(SETTINGS_SLOT, () =>
    services.slots.register(
      {
        name: SETTINGS_SLOT,
        id: SETTINGS_TAB_ID,
        order: SETTINGS_TAB_ORDER,
        label: () => t('tab'),
        locale: NS,
        inject: () => ({}),
      },
      (props: SettingsTabProps) => component({ ...props, hostT }),
    ),
  )
}

/** Which overview the page shows; the choice is remembered. */
export type SettingsView = 'table' | 'files'

/** View shown when nothing valid is persisted. */
export const DEFAULT_SETTINGS_VIEW: SettingsView = 'table'

/**
 * `localStorage` key the page persists its view under.
 *
 * The settings page has no `pluginSettings` blob of its own — that helper
 * belongs to a sidebar tab descriptor — so the view is a browser-local
 * preference rather than a synced one.
 */
export const SETTINGS_VIEW_STORAGE_KEY = `${PACKAGE_NAME}:settings-view`

/**
 * Read the persisted view.
 * @param storage - storage to read; defaults to the browser's own.
 * @returns the stored view, or {@link DEFAULT_SETTINGS_VIEW}.
 */
export function settingsViewOf(storage: PanelStorage | undefined = browserStorage()): SettingsView {
  return storedString(SETTINGS_VIEW_STORAGE_KEY, storage) === 'files'
    ? 'files'
    : DEFAULT_SETTINGS_VIEW
}

/**
 * Persist the view; hostile storage only costs the choice at the next reload.
 * @param view - view to store.
 * @param storage - storage to write; defaults to the browser's own.
 */
export function persistSettingsView(
  view: SettingsView,
  storage: PanelStorage | undefined = browserStorage(),
): void {
  storeString(SETTINGS_VIEW_STORAGE_KEY, view, storage)
}

/**
 * The project the page shows.
 *
 * The page is the one surface that lists every project with a live session, but
 * it renders exactly one project's rows at a time: an unknown or stale
 * selection falls back to the first project, never to a mix.
 * @param snapshot - host snapshot, or undefined before the first poll lands.
 * @param projectRoot - the selected project root, when known.
 * @returns the selected project, or undefined while there is none.
 */
export function selectedProject(
  snapshot: McpSnapshot | undefined,
  projectRoot: string | undefined,
): ProjectSnapshot | undefined {
  if (snapshot === undefined || snapshot.projects.length === 0) return undefined
  if (projectRoot !== undefined) {
    const match = snapshot.projects.find((project) => project.projectRoot === projectRoot)
    if (match !== undefined) return match
  }
  return snapshot.projects[0]
}

/**
 * Display label of a declaring document: relative to the project root, or
 * home-shortened when it is a global document.
 * @param source - absolute document path.
 * @param projectRoot - the project the document belongs to.
 * @returns the label shown on a card or in the Source column.
 */
export function documentLabel(source: string, projectRoot: string): string {
  if (source.startsWith(`${projectRoot}/`)) return source.slice(projectRoot.length + 1)
  return source.replace(/^(\/Users\/[^/]+|\/home\/[^/]+)/, '~')
}

/**
 * Where one declaring document sits in the read order of its project.
 *
 * The order is the host's to publish (`ProjectSnapshot.files`): global documents
 * first, then the project's own, so a tier is the 1-based place in that list and
 * `total` is how many it holds — a deployment that reads one document prints
 * `priority 1/1` instead of a `3` it cannot have. A host older than the field
 * reports nothing, and then the shipped names answer: the global documents, then
 * `<project>/.kimi-code/mcp.json`, then `<project>/.dsh/mcp.json`. A document
 * outside either table has no priority, and the panel says nothing rather than
 * inventing one.
 */
export interface DocumentPriority {
  /** 1-based place in the read order of this project. */
  readonly tier: number
  /** How many documents that read order holds. */
  readonly total: number
  /** True for a global document, read before the project's own. */
  readonly global: boolean
}

/** Documents this version reads when the host reports none — the shipped names. */
const SHIPPED_LOCAL_FILES = ['.kimi-code/mcp.json', '.dsh/mcp.json'] as const

/** The one project document this version ships with, for a host that says none. */
const DEFAULT_LOCAL_SPECS = ['.dsh/mcp.json'] as const

/**
 * Priority of a declaring document, per {@link DocumentPriority}.
 * @param source - absolute document path, or `''` when the host reported none.
 * @param project - the project the document belongs to.
 * @returns the tier, or `undefined` when the document is not one this project reads.
 */
export function documentPriority(source: string, project: ProjectSnapshot): DocumentPriority | undefined {
  if (source === '') return undefined
  const files = project.files
  if (files !== undefined) {
    const index = files.findIndex((file) => file.path === source)
    const file = files[index]
    if (file === undefined) return undefined
    return { tier: index + 1, total: files.length, global: file.scope === 'global' }
  }
  const projectRoot = project.projectRoot
  if (!source.startsWith(`${projectRoot}/`)) {
    return /(\.dsh|\.kimi-code)\/mcp\.json$/.test(source)
      ? { tier: 1, total: SHIPPED_LOCAL_FILES.length + 1, global: true }
      : undefined
  }
  const index = SHIPPED_LOCAL_FILES.findIndex((relative) => source === `${projectRoot}/${relative}`)
  return index < 0 ? undefined : { tier: index + 2, total: SHIPPED_LOCAL_FILES.length + 1, global: false }
}

/** A spec that already names where it lives, so the panel prints it as written. */
function isRootedSpec(spec: string): boolean {
  return spec.startsWith('/') || spec.startsWith('~') || spec.startsWith('$') || /^[A-Za-z]:[\\/]/.test(spec)
}

/**
 * Documents of the deployment itself, written the way a person would write them
 * in the config: `<project>/…` for a local spec, `~/…` for a relative global one.
 * A host older than `sources` reported nothing, and then this version's shipped
 * names answer — the same ones its own default reads.
 */
function deploymentDocuments(snapshot: McpSnapshot): string[] {
  const sources = snapshot.sources
  if (sources === undefined) return DEFAULT_LOCAL_SPECS.map((relative) => `<project>/${relative}`)
  return [
    ...sources.global.map((spec) => (isRootedSpec(spec) ? spec : `~/${spec}`)),
    ...sources.local.map((spec) => (isRootedSpec(spec) ? spec : `<project>/${spec}`)),
  ]
}

/**
 * The `read: …` code line under an empty state, said from the config rather than
 * from a file name baked into this bundle.
 */
function readPaths(snapshot: McpSnapshot, t: Translate): string {
  const documents = deploymentDocuments(snapshot)
  return documents.length === 0 ? t('noSessionsNoPaths') : t('noSessionsPaths', { paths: documents.join(' · ') })
}

/** One overridden declaration, as the host's merge warning reports it. */
export interface OverrideNote {
  /** `serverName` that was declared in more than one document. */
  name: string
  /**
   * The overridden document, when the snapshot pins it; `undefined` when more
   * than one lower-priority document could have carried the losing entry.
   */
  from: string | undefined
}

/** One card of the "By files" view: a document and the servers it declares. */
export interface DocumentGroup {
  /** Absolute document path, or `''` when the host reported no source. */
  source: string
  /** Path relative to the project (or `~`-shortened); `''` when source is `''`. */
  label: string
  /** Where the document sits in the read order, per {@link documentPriority}. */
  priority: DocumentPriority | undefined
  /** The surviving rows that this document declares. */
  rows: ServerRow[]
  /** Declarations of this document's servers that a later document replaced. */
  overrides: OverrideNote[]
}

/**
 * Group a project's rows per declaring document, in priority order.
 *
 * The plugin's native model is the document, not the server: a document read
 * later overrides an earlier entry with the same `serverName`, so the earlier
 * declaration is a property of the file that won. The host reports the
 * overridden *name* in a merge warning (`project.issues`) and the winner's
 * document in the row's `source`; this function pairs the two. Which earlier
 * document carried the losing entry is only knowable when a single
 * lower-priority document is in the picture, so {@link OverrideNote.from} stays
 * `undefined` otherwise and the view says so instead of guessing.
 * @param project - one project from the host snapshot.
 * @returns one group per declaring document, lowest priority first.
 */
export function fileGroups(project: ProjectSnapshot): DocumentGroup[] {
  const groups: DocumentGroup[] = []
  for (const row of project.rows) {
    const source = row.source ?? ''
    let group = groups.find((candidate) => candidate.source === source)
    if (group === undefined) {
      group = {
        source,
        label: source === '' ? '' : documentLabel(source, project.projectRoot),
        priority: source === '' ? undefined : documentPriority(source, project),
        rows: [],
        overrides: [],
      }
      groups.push(group)
    }
    group.rows.push(row)
  }
  // Stable in modern engines: documents keep their first-appearance order inside
  // one tier, and documents the read order does not know come last.
  groups.sort((left, right) => (left.priority?.tier ?? Number.MAX_SAFE_INTEGER) - (right.priority?.tier ?? Number.MAX_SAFE_INTEGER))
  for (const issue of project.issues) {
    // The merge warning is recognised by its wire code, never by its prose:
    // the client translates the payload, so an English string-match would both
    // miss under another language and misread a translated message.
    if (issue.server === undefined || issue.code !== 'parse.server.multiDocument') continue
    const winnerIndex = groups.findIndex((group) =>
      group.rows.some((row) => row.name === issue.server),
    )
    if (winnerIndex < 0) continue
    const winner = groups[winnerIndex]
    if (winner === undefined) continue
    const earlier = groups
      .slice(0, winnerIndex)
      .filter(
        (group) =>
          group.priority === undefined ||
          winner.priority === undefined ||
          group.priority.tier < winner.priority.tier,
      )
    winner.overrides.push({
      name: issue.server,
      from: earlier.length === 1 ? earlier[0]?.label : undefined,
    })
  }
  return groups
}

/** The `1 project …` / `3 projects …` toolbar summary. */
function liveProjectCount(count: number, t: Translate): string {
  return count === 1 ? t('projectsOne') : t('projectsMany', { count })
}

// ── styles ────────────────────────────────────────────────────────────────────
// Same vocabulary as `view.ts`: only the DSH alias layer's own custom
// properties, each with the fallback a non-DSH page needs.

const BORDER = '1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.25))'
const BORDER_L2 = '1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.4))'

/**
 * The longest a line of copy is allowed to run before it wraps.
 *
 * The settings panel is a modal `min(800px, 100vw - 48px)` wide, so a hint laid
 * out at full width runs to ~110 characters and the eye loses the line. The
 * mockups cap their prose at 74–84ch for the same reason; this is the cap the
 * page's own copy uses.
 */
const COPY_COLUMN = '72ch'

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
    padding: '6px 8px',
    borderBottom: BORDER,
    flexWrap: 'wrap',
  } satisfies CSSProperties,
  muted: { opacity: 0.9, fontSize: '0.9em' } satisfies CSSProperties,
  title: {
    fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
    marginRight: 4,
  } satisfies CSSProperties,
  body: { flex: 1, minHeight: 0, overflow: 'auto', padding: '2px 2px 18px' } satisfies CSSProperties,
  segment: {
    display: 'flex',
    gap: 2,
    border: BORDER,
    borderRadius: 6,
    padding: 1,
  } satisfies CSSProperties,
  segmentItem: {
    padding: '1px 8px',
    border: 'none',
    borderRadius: 4,
    background: 'transparent',
    color: 'inherit',
    opacity: 0.65,
    cursor: 'pointer',
    font: 'inherit',
    fontSize: '0.9em',
  } satisfies CSSProperties,
  segmentItemActive: {
    background: 'var(--dsw-alias-interactive-bg-active, rgba(127, 127, 127, 0.18))',
    opacity: 1,
  } satisfies CSSProperties,
  button: {
    padding: '2px 8px',
    borderRadius: 4,
    border: BORDER,
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    font: 'inherit',
  } satisfies CSSProperties,
  buttonPrimary: {
    padding: '2px 8px',
    borderRadius: 4,
    border: '1px solid transparent',
    background: 'var(--dsw-alias-button-primary-fill, currentColor)',
    color: 'var(--dsw-alias-label-primary-foreground, inherit)',
    cursor: 'pointer',
    font: 'inherit',
  } satisfies CSSProperties,
  select: {
    border: BORDER,
    borderRadius: 4,
    padding: '2px 4px',
    background: 'var(--dsw-alias-bg-layer-2, transparent)',
    color: 'inherit',
    font: 'inherit',
    fontSize: '0.9em',
  } satisfies CSSProperties,
  card: {
    border: BORDER,
    borderRadius: 7,
    marginBottom: 7,
    background: 'var(--dsw-alias-bg-layer-1, transparent)',
    overflow: 'hidden',
  } satisfies CSSProperties,
  cardHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    padding: '6px 9px',
    color: 'var(--dsw-alias-label-tertiary, inherit)',
    background: 'var(--dsw-alias-bg-layer-2, transparent)',
    borderBottom: BORDER,
  } satisfies CSSProperties,
  cardPath: {
    fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
    fontSize: '0.9em',
  } satisfies CSSProperties,
  tag: {
    opacity: 0.75,
    fontSize: '0.8em',
    border: BORDER,
    borderRadius: 4,
    padding: '0 5px',
    color: 'var(--dsw-alias-label-secondary, inherit)',
    whiteSpace: 'nowrap',
  } satisfies CSSProperties,
  /** The `warn` chip of the mockups: the same rule, in the warning tone. */
  tagWarn: {
    opacity: 1,
    borderColor: 'var(--dsw-alias-state-warn-label, #b45309)',
    color: 'var(--dsw-alias-state-warn-label, #b45309)',
  } satisfies CSSProperties,
  /**
   * The choice control of a conflict card: the label, then the two answers side
   * by side. Four pixels apart like the mockups' own switch, and one row that
   * wraps rather than a column, because a long local name widens its button.
   */
  choiceRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
    marginTop: 6,
  } satisfies CSSProperties,
  /** One answer of that control, while it is the one in force. */
  choiceOn: {
    padding: '2px 8px',
    borderRadius: 4,
    border: '1px solid var(--dsw-alias-state-warn-label, #b45309)',
    background: 'var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.08))',
    color: 'inherit',
    cursor: 'pointer',
    font: 'inherit',
  } satisfies CSSProperties,
  /** One answer of that control, while the other one is in force. */
  choiceOff: {
    padding: '2px 8px',
    borderRadius: 4,
    border: BORDER,
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary, inherit)',
    cursor: 'pointer',
    font: 'inherit',
  } satisfies CSSProperties,
  /** The `error` chip of the mockups, for the conflicts the host reports. */
  tagError: {
    opacity: 1,
    borderColor: 'var(--dsw-alias-state-error-primary, #ec1313)',
    color: 'var(--dsw-alias-state-error-primary, #ec1313)',
  } satisfies CSSProperties,
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 9px',
    borderTop: BORDER,
  } satisfies CSSProperties,
  dot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    display: 'inline-block',
    flex: 'none',
    alignSelf: 'center',
  } satisfies CSSProperties,
  serverButton: {
    padding: 0,
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    font: 'inherit',
    fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
    textAlign: 'left',
  } satisfies CSSProperties,
  serverButtonActive: {
    color: 'var(--dsw-alias-state-business-primary, inherit)',
  } satisfies CSSProperties,
  overrideNote: {
    padding: '3px 8px 3px 22px',
    borderTop: BORDER,
    opacity: 0.75,
    fontSize: '0.85em',
    color: 'var(--dsw-alias-label-tertiary, inherit)',
  } satisfies CSSProperties,
  note: {
    marginTop: 8,
    padding: '5px 7px',
    borderLeft: '2px solid var(--dsw-alias-state-warn-primary, #f59e0b)',
    background: 'var(--dsw-alias-state-warn-tertiary, transparent)',
    fontSize: '0.85em',
    overflowWrap: 'anywhere',
    maxWidth: COPY_COLUMN,
    // The failing-mount notes reuse this style and carry a multi-line detail.
    whiteSpace: 'pre-wrap',
  } satisfies CSSProperties,
  table: { width: '100%', borderCollapse: 'collapse' } satisfies CSSProperties,
  th: {
    textAlign: 'left',
    fontWeight: 500,
    fontSize: '0.75em',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    // A header cell is a label, not prose: letting it wrap turns a column into a
    // one-word sliver at the panel's width.
    whiteSpace: 'nowrap',
    color: 'var(--dsw-alias-label-tertiary, inherit)',
    padding: '0 8px 5px 0',
  } satisfies CSSProperties,
  td: {
    padding: '6px 8px 6px 0',
    borderTop: BORDER,
    verticalAlign: 'baseline',
    // A cell is a value, not a heading: without this the browser's own `th`/`td`
    // default would render every name in the table bolder than the mockups do.
    fontWeight: 400,
  } satisfies CSSProperties,
  /** The editor's own checkboxes: a real input, so it only needs the reset. */
  switch: { margin: 0 } satisfies CSSProperties,
  /** The On column: the mockups' switch, drawn from the tokens they name. */
  switchOn: {
    display: 'inline-flex',
    alignItems: 'center',
    width: 26,
    height: 15,
    borderRadius: 8,
    padding: 0,
    border: 'none',
    background: 'var(--dsw-alias-state-business-primary, var(--dsw-alias-state-success-primary, #22c55e))',
    cursor: 'pointer',
    verticalAlign: '-2px',
  } satisfies CSSProperties,
  switchOff: { background: 'var(--dsw-alias-border-l3, #d0d3d8)' } satisfies CSSProperties,
  /** The knob inside {@link STYLE.switchOn}, pushed right when the row is on. */
  switchKnob: {
    width: 11,
    height: 11,
    borderRadius: '50%',
    background: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
    marginLeft: 2,
    pointerEvents: 'none',
  } satisfies CSSProperties,
  switchKnobOn: { marginLeft: 13 } satisfies CSSProperties,
  // The vertical setting rows the `Tools` page is built from — the shape DSH's
  // own settings pages use (one row per setting: text column left, control
  // right, rule under). The `split` / `pane*` styles below belong to the entry
  // editor, whose three panes are deliberately not reused by a policy form:
  // its panes are far too narrow for a sentence, so the copy has nowhere to go
  // but a one-word-wide sliver.
  /** One setting row: label and description left, control right, rule under. */
  settingRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    padding: '16px 0',
    borderBottom: BORDER,
  } satisfies CSSProperties,
  /** The last row of a group or a block, which carries no trailing rule. */
  lastRow: { borderBottom: 'none' } satisfies CSSProperties,
  /** The row's text column: the wide one, and the one copy wraps in. */
  settingRowText: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
  } satisfies CSSProperties,
  settingRowLabel: { fontWeight: 600 } satisfies CSSProperties,
  settingRowDesc: {
    fontSize: '0.85em',
    color: 'var(--dsw-alias-label-tertiary, inherit)',
    overflowWrap: 'anywhere',
  } satisfies CSSProperties,
  /** The control column: sized to its content, never the column that wraps. */
  settingRowControl: {
    flex: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  } satisfies CSSProperties,
  /** A titled group of rows below the first one. */
  settingGroup: { marginTop: 16 } satisfies CSSProperties,
  settingGroupHead: {
    fontSize: '0.75em',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--dsw-alias-label-tertiary, inherit)',
    marginBottom: 6,
  } satisfies CSSProperties,
  /** The pinned names: chips that wrap across the row, not a column of their own. */
  tagList: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 4,
  } satisfies CSSProperties,
  /** A table too wide for the panel scrolls instead of colliding with it. */
  tableScroll: { maxWidth: '100%', overflowX: 'auto' } satisfies CSSProperties,
  split: {
    display: 'flex',
    alignItems: 'stretch',
    minHeight: 260,
    border: BORDER,
    borderRadius: 7,
    overflow: 'hidden',
  } satisfies CSSProperties,
  /** Laid on top of {@link STYLE.split} while the panes stack. */
  splitNarrow: { flexDirection: 'column' } satisfies CSSProperties,
  splitBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
    flexWrap: 'wrap',
  } satisfies CSSProperties,
  splitFooter: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
    flexWrap: 'wrap',
  } satisfies CSSProperties,
  paneList: {
    flex: '1 1 168px',
    minWidth: 0,
    borderRight: BORDER,
    overflow: 'auto',
  } satisfies CSSProperties,
  /** The server list stacked: full width, its rule on the bottom edge. */
  paneListNarrow: {
    flex: 'none',
    width: '100%',
    maxHeight: 180,
    borderRight: 'none',
    borderBottom: BORDER,
  } satisfies CSSProperties,
  paneHead: {
    padding: '5px 8px',
    fontSize: '0.75em',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--dsw-alias-label-tertiary, inherit)',
    borderBottom: BORDER,
  } satisfies CSSProperties,
  listItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 8px',
    borderBottom: BORDER,
  } satisfies CSSProperties,
  listItemActive: {
    background: 'var(--dsw-alias-interactive-bg-active, rgba(127, 127, 127, 0.18))',
  } satisfies CSSProperties,
  /**
   * The right column: the entry's form, and the JSON body under it.
   *
   * The JSON used to be a third column beside the form, which made both narrow
   * and put the entry in two places at once. Under the form it is the same entry
   * — the form's fields on top, the document body below — and the list keeps the
   * only fixed width.
   */
  paneColumn: {
    flex: '1 1 240px',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
  } satisfies CSSProperties,
  /** The form on top of the column: its own height, its rule on the bottom edge. */
  paneForm: {
    flex: 'none',
    minWidth: 0,
    padding: '8px 10px',
    borderBottom: BORDER,
  } satisfies CSSProperties,
  /** The column stacked: full width, no rules left over from the row. */
  paneColumnNarrow: {
    flex: 'none',
    width: '100%',
  } satisfies CSSProperties,
  paneFormNarrow: {
    width: '100%',
  } satisfies CSSProperties,
  paneJson: {
    flex: '1 1 auto',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--dsw-alias-markdown-code-block, transparent)',
  } satisfies CSSProperties,
  /** The JSON pane stacked: full width, its own height under the form. */
  paneJsonNarrow: {
    flex: 'none',
    width: '100%',
    minHeight: 200,
  } satisfies CSSProperties,
  json: {
    margin: 0,
    padding: '8px 10px',
    fontSize: '0.8em',
    whiteSpace: 'pre',
    overflowX: 'auto',
    fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
  } satisfies CSSProperties,
  /**
   * The editable body: the pane's own `pre`, as a control.
   *
   * `pre-wrap` rather than `pre`: the pane is a column of the settings panel and
   * a long `args` line would otherwise scroll sideways inside it. `resize` is on
   * because the entry is read as a whole and a wrapped line is not always the
   * shape someone wants.
   */
  jsonArea: {
    flex: '1 1 auto',
    minHeight: 160,
    margin: 0,
    padding: '8px 10px',
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    fontSize: '0.8em',
    fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
    lineHeight: '1.5',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    overflowY: 'auto',
    resize: 'vertical',
    boxSizing: 'border-box',
    width: '100%',
  } satisfies CSSProperties,
  field: {
    display: 'grid',
    gridTemplateColumns: '90px 1fr',
    gap: '5px 9px',
    alignItems: 'center',
    marginBottom: 4,
  } satisfies CSSProperties,
  fieldLabel: {
    fontSize: '0.75em',
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    color: 'var(--dsw-alias-label-tertiary, inherit)',
  } satisfies CSSProperties,
  input: {
    border: BORDER,
    borderRadius: 4,
    padding: '2px 6px',
    background: 'var(--dsw-alias-bg-layer-1, transparent)',
    color: 'inherit',
    font: 'inherit',
    fontSize: '0.85em',
    minWidth: 0,
  } satisfies CSSProperties,
  /**
   * The read-only Detail row. A mount detail is a multi-line diagnostic, and an
   * `<input>` collapses its line breaks — the operator would lose exactly the
   * structure that makes the message readable.
   */
  fieldText: {
    border: BORDER,
    borderRadius: 4,
    padding: '2px 6px',
    background: 'var(--dsw-alias-bg-layer-1, transparent)',
    color: 'inherit',
    font: 'inherit',
    fontSize: '0.85em',
    minWidth: 0,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  } satisfies CSSProperties,
  fieldHint: {
    margin: '-2px 0 6px 99px',
    fontSize: '0.8em',
    opacity: 0.6,
    overflowWrap: 'anywhere',
  } satisfies CSSProperties,
  fieldGroup: {
    display: 'grid',
    gridTemplateColumns: '90px 1fr',
    gap: '4px 9px',
    alignItems: 'start',
    marginBottom: 5,
  } satisfies CSSProperties,
  fieldRow: { display: 'flex', gap: 4, alignItems: 'center', marginBottom: 3 } satisfies CSSProperties,
  fieldKey: {
    flex: 'none',
    minWidth: 90,
    fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
    fontSize: '0.8em',
    overflowWrap: 'anywhere',
  } satisfies CSSProperties,
  iconButton: {
    flex: 'none',
    padding: '1px 5px',
    borderRadius: 4,
    border: BORDER,
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: '0.8em',
  } satisfies CSSProperties,
  confirm: {
    marginTop: 6,
    padding: '7px 9px',
    border: BORDER,
    borderRadius: 6,
    background: 'var(--dsw-alias-bg-layer-2, transparent)',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  } satisfies CSSProperties,
  noteOk: {
    marginTop: 8,
    padding: '5px 7px',
    borderLeft: '2px solid var(--dsw-alias-state-success-primary, #22c55e)',
    background: 'var(--dsw-alias-state-success-tertiary, transparent)',
    fontSize: '0.85em',
    overflowWrap: 'anywhere',
  } satisfies CSSProperties,
  noteError: {
    marginTop: 8,
    padding: '5px 7px',
    borderLeft: '2px solid var(--dsw-alias-state-error-primary, #ec1313)',
    background: 'var(--dsw-alias-interactive-bg-hover-danger, var(--dsw-alias-state-error-tertiary, transparent))',
    borderRadius: '0 5px 5px 0',
    fontSize: '0.85em',
    overflowWrap: 'anywhere',
    maxWidth: COPY_COLUMN,
  } satisfies CSSProperties,
  errorState: { padding: '10px 12px' } satisfies CSSProperties,
  stateTitle: { opacity: 0.9, marginBottom: 4 } satisfies CSSProperties,
  /** Muted one-liner under a row or a card: a short label, never a paragraph. */
  hint: {
    opacity: 0.6,
    fontSize: '0.85em',
    overflowWrap: 'anywhere',
    maxWidth: COPY_COLUMN,
  } satisfies CSSProperties,
  codeLine: {
    margin: '6px auto 0',
    maxWidth: 560,
    padding: '5px 8px',
    border: BORDER,
    borderRadius: 5,
    background: 'var(--dsw-alias-markdown-code-block, transparent)',
    color: 'var(--dsw-alias-link, inherit)',
    fontSize: '0.8em',
    fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
    textAlign: 'left',
  } satisfies CSSProperties,
} as const

// ── layout adaptivity ─────────────────────────────────────────────────────────

/**
 * The query the page stacks its split editor's panes on.
 *
 * The editor lives inside DSH's settings panel, not in the viewport: the panel
 * is `min(800px, 100vw - 48px)` wide, its navigation rail is 188px and its
 * options column pads 24px per side, so the page is given `min(564px, 100vw -
 * 284px)`. Three panes need all 564px of that, which is why they are flexible;
 * a viewport below 848px starts shrinking the panel itself, and three panes
 * there are slivers. The query sits at that break, so the panes stack whenever
 * the settings panel is not at its full 800px width.
 */
export const NARROW_SETTINGS_QUERY = '(max-width: 850px)'

/** Just enough of `MediaQueryList` for the detector, so tests need no DOM. */
export interface MediaQueryLike {
  /** `true` while the query matches the current viewport. */
  matches: boolean
  /** Optional, so a test double can drive the flag by hand. */
  addEventListener?(type: 'change', listener: () => void): void
  /** Optional, for the same reason. */
  removeEventListener?(type: 'change', listener: () => void): void
}

/** One `matchMedia` query, as the detector asks for it. */
export type MediaQueryMatcher = (query: string) => MediaQueryLike

/**
 * The browser's media-query matcher, or undefined when this half runs without
 * one — a non-browser host, or a policy that blocks the property.
 * @returns a matcher bound to the host, or undefined.
 */
export function browserMatchMedia(): MediaQueryMatcher | undefined {
  try {
    const host = globalThis as { matchMedia?: MediaQueryMatcher }
    if (typeof host.matchMedia !== 'function') return undefined
    const match = host.matchMedia
    return (query) => match.call(host, query)
  } catch {
    // Reading the property itself throws when a policy blocks it.
    return undefined
  }
}

/**
 * Resolve the narrow layout against a media-query matcher.
 * @param match - the browser's matcher, or undefined outside a browser.
 * @returns `true` when the panes must stack; `false` without a matcher.
 */
export function narrowSettingsLayout(match: MediaQueryMatcher | undefined): boolean {
  return match?.(NARROW_SETTINGS_QUERY).matches === true
}

/**
 * The narrow flag the page renders with, tracked across viewport resizes.
 *
 * Only the shell reads the media query: everything below it takes the flag as a
 * prop, which is what lets the no-DOM tests render both layouts.
 * @returns `true` while the viewport is at or below {@link NARROW_SETTINGS_QUERY}.
 */
export function useNarrowSettings(): boolean {
  const [narrow, setNarrow] = useState(() => narrowSettingsLayout(browserMatchMedia()))
  useEffect(() => {
    const match = browserMatchMedia()
    if (match === undefined) return undefined
    const list = match(NARROW_SETTINGS_QUERY)
    const sync = (): void => setNarrow(list.matches === true)
    sync()
    list.addEventListener?.('change', sync)
    return () => list.removeEventListener?.('change', sync)
  }, [])
  return narrow
}

// ── entry draft ───────────────────────────────────────────────────────────────

/**
 * One `env`/`headers` row as the editor holds it.
 *
 * The row is the key plus what the input shows, never a copy of the declared
 * value: a masked key the user did not touch carries no value at all, which is
 * exactly what {@link draftEntry} has to submit for it.
 */
export interface FieldDraft {
  /** Key exactly as the document declares it, or the key being typed. */
  key: string
  /** What the value input shows; empty for a masked key until it is replaced. */
  text: string
  /** `true` when the host withheld the declared value as a secret. */
  masked: boolean
  /** `true` when the key resolves through the credentials file, not the document. */
  fromCredentials: boolean
  /** `true` once the user typed into a masked input, even back to empty. */
  replaced: boolean
  /** `true` for a row the user added; only its key is still editable. */
  added: boolean
}

/**
 * The form state of one open row.
 *
 * Optional entry fields hold exactly what the snapshot reported — `undefined`
 * means the document declares nothing — so an untouched draft rebuilds the
 * declared entry field for field and the editor opens clean instead of
 * announcing a change the user never made.
 */
export interface EntryDraft {
  /** Server the draft belongs to; a draft built for another row is ignored. */
  server: string
  /** `documentRevision` the draft was built from. */
  revision: string | undefined
  transport: 'stdio' | 'streamable-http'
  command: string | undefined
  args: readonly string[] | undefined
  cwd: string | undefined
  url: string | undefined
  /** `stdio`: declared environment, with the masked keys among them. */
  env: FieldDraft[]
  /** `true` when the declaration carried an `env`, so an emptied list still writes one. */
  envDeclared: boolean
  /** `streamable-http`: declared headers, with the masked keys among them. */
  headers: FieldDraft[]
  /** `true` when the declaration carried `headers`. */
  headersDeclared: boolean
  /** `enabled` exactly as declared: `undefined` means the document sets nothing. */
  enabled: boolean | undefined
  /** Milliseconds as typed; `''` means the declaration sets no timeout. */
  connectTimeoutMs: string
  /** Declared keys the editor never presents, written back untouched. */
  extra: Readonly<Record<string, unknown>>
}

/** Build the editable rows of one `env`/`headers` list. */
export function fieldDrafts(fields: readonly EntryField[] | undefined): FieldDraft[] {
  return (fields ?? []).map((field) => ({
    key: field.key,
    text: field.value ?? '',
    masked: field.masked === true,
    fromCredentials: field.fromCredentials === true,
    replaced: false,
    added: false,
  }))
}

/**
 * The draft the editor opens on: the snapshot's own entry, field for field.
 * @param row - the row being edited.
 * @returns the draft, or undefined when the host did not parse the entry.
 */
export function draftOf(row: ServerRow): EntryDraft | undefined {
  const entry = row.entry
  if (entry === undefined) return undefined
  return {
    server: row.name,
    revision: row.documentRevision,
    transport: entry.transport,
    command: entry.command,
    args: entry.args,
    cwd: entry.cwd,
    url: entry.url,
    env: fieldDrafts(entry.env),
    envDeclared: entry.env !== undefined,
    headers: fieldDrafts(entry.headers),
    headersDeclared: entry.headers !== undefined,
    enabled: entry.enabled,
    connectTimeoutMs: entry.connectTimeoutMs === undefined ? '' : String(entry.connectTimeoutMs),
    extra: entry.extra ?? {},
  }
}

/**
 * The draft actually shown: the stored one while it still belongs to this row
 * and this document revision, otherwise a fresh one.
 *
 * A background poll that re-reads a changed document therefore drops a stale
 * edit instead of writing it back on the snapshot's revision: the save would be
 * refused as `conflict` anyway.
 * @param row - the row being edited.
 * @param stored - the draft the shell still holds, if any.
 * @returns the draft to render, or undefined when there is nothing to edit.
 */
export function activeDraft(row: ServerRow, stored: EntryDraft | undefined): EntryDraft | undefined {
  const fresh = draftOf(row)
  if (fresh === undefined) return undefined
  if (stored === undefined || stored.server !== row.name || stored.revision !== row.documentRevision) {
    return fresh
  }
  return stored
}

/** One declared key as the save request carries it; undefined when it is not ours to write. */
function fieldOf(row: FieldDraft): EntryField | undefined {
  if (row.key === '') return undefined
  // A key the credentials file answers is not editable, but it must still be
  // submitted: the host replaces the whole `env`/`headers` object with what this
  // request carries, so a dropped key is a key deleted from the document — the
  // reference to the credential would vanish on any unrelated edit. The host
  // writes the declared text back for a `fromCredentials` field and never a value
  // from here.
  if (row.fromCredentials) return { key: row.key, masked: true, fromCredentials: true }
  // Untouched and masked: no value at all, so the document keeps its secret.
  if (row.masked && !row.replaced) return { key: row.key, masked: true }
  return { key: row.key, value: row.text }
}

function fieldsOf(rows: readonly FieldDraft[]): EntryField[] {
  const fields: EntryField[] = []
  for (const row of rows) {
    const field = fieldOf(row)
    if (field !== undefined) fields.push(field)
  }
  return fields
}

/** The timeout as typed, or undefined when the field is empty or not a duration. */
export function timeoutOf(text: string): number | undefined {
  if (text.trim() === '') return undefined
  const value = Number(text)
  return Number.isInteger(value) && value >= 0 ? value : undefined
}

/** `true` when the timeout field holds something that is not a duration. */
export function timeoutInvalid(text: string): boolean {
  return text.trim() !== '' && timeoutOf(text) === undefined
}

/**
 * The entry a save writes: the whole declaration, rebuilt from the draft.
 *
 * Everything the editor presents is taken from the draft; `extra` rides along
 * untouched, because a save replaces `mcpServers[server]` wholesale and dropping
 * the keys the form never showed would delete configuration.
 * @param draft - the open row's form state.
 * @returns the entry body of a {@link SaveRequest}.
 */
export function draftEntry(draft: EntryDraft): EntrySnapshot {
  const env = fieldsOf(draft.env)
  const headers = fieldsOf(draft.headers)
  const timeout = timeoutOf(draft.connectTimeoutMs)
  const body: EntrySnapshot =
    draft.transport === 'stdio'
      ? {
          transport: 'stdio',
          ...(draft.command === undefined ? {} : { command: draft.command }),
          ...(draft.args === undefined ? {} : { args: draft.args }),
          ...(draft.cwd === undefined ? {} : { cwd: draft.cwd }),
          ...(env.length === 0 && !draft.envDeclared ? {} : { env }),
        }
      : {
          transport: 'streamable-http',
          ...(draft.url === undefined ? {} : { url: draft.url }),
          ...(headers.length === 0 && !draft.headersDeclared ? {} : { headers }),
        }
  return {
    ...body,
    ...(draft.enabled === undefined ? {} : { enabled: draft.enabled }),
    ...(timeout === undefined ? {} : { connectTimeoutMs: timeout }),
    ...(Object.keys(draft.extra).length === 0 ? {} : { extra: draft.extra }),
  }
}

/**
 * The save request for one row, or undefined when the snapshot does not carry
 * what a write needs (the row has no declaring document or no revision).
 */
export function saveRequestOf(
  project: ProjectSnapshot,
  row: ServerRow,
  entry: EntrySnapshot,
  consent: boolean,
): SaveRequest | undefined {
  if (row.source === undefined || row.documentRevision === undefined) return undefined
  return {
    projectRoot: project.projectRoot,
    server: row.name,
    document: row.source,
    revision: row.documentRevision,
    ...(row.writeScope === 'global' ? { consent } : {}),
    entry,
  }
}

// ── the JSON pane's diff ──────────────────────────────────────────────────────

/** One line of the JSON pane: shared context, or one side of a change. */
export interface DiffLine {
  kind: 'context' | 'removed' | 'added'
  text: string
}

/**
 * Line diff between two pretty-printed entries.
 *
 * A plain longest-common-subsequence walk: entries are small, and a faithful
 * diff is what makes the pane show the edit instead of a copy of the snapshot.
 * @param before - the declared entry, line by line.
 * @param after - the entry the draft would write.
 * @returns every line of both sides, in reading order.
 */
export function diffLines(before: readonly string[], after: readonly string[]): DiffLine[] {
  const table: number[][] = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(after.length + 1).fill(0),
  )
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      const row = table[i]
      const next = table[i + 1]
      if (row === undefined || next === undefined) continue
      row[j] =
        before[i] === after[j]
          ? (next[j + 1] ?? 0) + 1
          : Math.max(next[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    const left = before[i] ?? ''
    const right = after[j] ?? ''
    if (left === right) {
      lines.push({ kind: 'context', text: left })
      i += 1
      j += 1
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      lines.push({ kind: 'removed', text: left })
      i += 1
    } else {
      lines.push({ kind: 'added', text: right })
      j += 1
    }
  }
  for (; i < before.length; i += 1) lines.push({ kind: 'removed', text: before[i] ?? '' })
  for (; j < after.length; j += 1) lines.push({ kind: 'added', text: after[j] ?? '' })
  return lines
}

/**
 * The entry in the shape the document holds it: the keys the form never showed
 * sit beside the parsed ones instead of under `extra`, and the keys that resolve
 * through the credentials file are gone, because the document does not declare
 * them at all.
 *
 * Both sides of the diff go through this, so an untouched draft compares equal
 * to the snapshot however the host bucketed the unparsed and credential keys.
 */
export function entryBody(entry: EntrySnapshot): Record<string, unknown> {
  const body: Record<string, unknown> = { transport: entry.transport }
  if (entry.command !== undefined) body.command = entry.command
  if (entry.args !== undefined) body.args = entry.args
  if (entry.cwd !== undefined) body.cwd = entry.cwd
  const env = documentFields(entry.env)
  if (env !== undefined) body.env = env
  if (entry.url !== undefined) body.url = entry.url
  const headers = documentFields(entry.headers)
  if (headers !== undefined) body.headers = headers
  if (entry.enabled !== undefined) body.enabled = entry.enabled
  if (entry.connectTimeoutMs !== undefined) body.connectTimeoutMs = entry.connectTimeoutMs
  for (const [key, value] of Object.entries(entry.extra ?? {})) body[key] = value
  return body
}

/** A declared list without the keys that only exist in the credentials file. */
function documentFields(fields: readonly EntryField[] | undefined): EntryField[] | undefined {
  return fields?.filter((field) => field.fromCredentials !== true)
}

/** The declared entry against the entry the draft would write, line by line. */
export function entryDiff(declared: EntrySnapshot | undefined, edited: EntrySnapshot): DiffLine[] {
  const before = declared === undefined ? [] : JSON.stringify(entryBody(declared), null, 2).split('\n')
  return diffLines(before, JSON.stringify(entryBody(edited), null, 2).split('\n'))
}

/** `true` when the draft would write something other than the declared entry. */
export function entryDirty(declared: EntrySnapshot | undefined, edited: EntrySnapshot): boolean {
  return entryDiff(declared, edited).some((line) => line.kind !== 'context')
}

/**
 * One `env`/`headers` list as the document holds it: a flat object of strings.
 *
 * The snapshot's own shape is a list of `{ key, value }` — that is what a diff
 * compares and what the JSON preview prints — while a document declares an
 * object. The pane edits the document, so this is the shape it shows.
 * @param fields - the draft's rows.
 * @returns the object; a key with no value (a secret the panel is not shown) and
 *   a key answered outside the document are both left out, because neither has a
 *   value the pane could print.
 */
function recordFields(fields: readonly FieldDraft[]): Record<string, string> {
  const record: Record<string, string> = {}
  for (const field of fields) {
    if (field.key === '' || field.text === '' || field.fromCredentials === true) continue
    record[field.key] = field.text
  }
  return record
}

/**
 * One draft as its document declares it: the shape a person writes in `mcp.json`.
 *
 * The keys a document cannot carry are the same ones {@link entryBody} drops: a
 * secret the panel is not shown has no value to print, and a key answered by the
 * project's `.env` or the credentials file is not in the document at all. Both
 * are kept by {@link draftFromJson} when the pane's text omits them, so editing
 * the body never erases one by accident.
 * @param draft - the entry the form and the pane edit.
 * @returns the declaration object the host would write.
 */
export function documentBody(draft: EntryDraft): Record<string, unknown> {
  const body: Record<string, unknown> = { transport: draft.transport }
  if (draft.command !== undefined) body.command = draft.command
  if (draft.args !== undefined) body.args = draft.args
  if (draft.cwd !== undefined) body.cwd = draft.cwd
  if (draft.envDeclared) body.env = recordFields(draft.env)
  if (draft.url !== undefined) body.url = draft.url
  if (draft.headersDeclared) body.headers = recordFields(draft.headers)
  if (draft.enabled !== undefined) body.enabled = draft.enabled
  if (draft.connectTimeoutMs !== '') body.connectTimeoutMs = Number(draft.connectTimeoutMs)
  for (const [key, value] of Object.entries(draft.extra)) body[key] = value
  return body
}

/** The entry as the JSON pane shows and writes it: the document's own body. */
export function jsonBodyOf(draft: EntryDraft): string {
  return `${JSON.stringify(documentBody(draft), null, 2)}\n`
}

/** One edit of the JSON pane: the draft it parses into, or why it does not. */
export type JsonDraftAnswer = { draft: EntryDraft } | { error: string }

/** A string field, or `undefined` when the document sets nothing. */
function jsonString(body: Record<string, unknown>, key: string): string | undefined | false {
  const value = body[key]
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : false
}

/** One `env`/`headers` pair of the parsed body, or `false` for a value that is not text. */
function jsonFields(value: unknown, path: string): EntryField[] | undefined | false {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const fields: EntryField[] = []
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'string') return false
    void path
    fields.push({ key, value: entry })
  }
  return fields
}

/**
 * Read one JSON edit back into a draft.
 *
 * This is the inverse of {@link entryBody}, and it is deliberately the same
 * shape the form edits: whatever the pane parses becomes the draft the form
 * renders and the confirmation compares, so both entries edit one value.
 *
 * Two things the document cannot express are preserved rather than dropped:
 * keys answered outside it (the project's `.env` or the credentials file) are
 * not part of the body the pane shows, so a hand edit that omits them keeps the
 * ones the draft already had. Unknown keys travel in `extra` exactly as written,
 * because a save replaces the entry wholesale.
 * @param text - the pane's text.
 * @param base - the draft the pane opened on: its server, revision and the keys
 *   the document does not carry.
 * @returns the parsed draft, or the first field that does not parse.
 */
export function draftFromJson(text: string, base: EntryDraft): JsonDraftAnswer {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: 'not an object' }
  }
  const body = value as Record<string, unknown>
  const transport = body.transport
  if (transport !== 'stdio' && transport !== 'streamable-http') return { error: 'transport' }

  const command = jsonString(body, 'command')
  if (command === false) return { error: 'command' }
  const cwd = jsonString(body, 'cwd')
  if (cwd === false) return { error: 'cwd' }
  const url = jsonString(body, 'url')
  if (url === false) return { error: 'url' }

  let args: readonly string[] | undefined
  if (body.args !== undefined) {
    if (!Array.isArray(body.args)) return { error: 'args' }
    const lines: string[] = []
    for (const [index, entry] of body.args.entries()) {
      if (typeof entry !== 'string') return { error: `args[${index}]` }
      lines.push(entry)
    }
    args = lines
  }

  const env = jsonFields(body.env, 'env')
  if (env === false) return { error: 'env' }
  const headers = jsonFields(body.headers, 'headers')
  if (headers === false) return { error: 'headers' }

  const enabled = body.enabled
  if (enabled !== undefined && typeof enabled !== 'boolean') return { error: 'enabled' }
  const timeout = body.connectTimeoutMs
  if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 0)) {
    return { error: 'connectTimeoutMs' }
  }

  const known = new Set([
    'transport',
    'command',
    'args',
    'cwd',
    'env',
    'headers',
    'url',
    'enabled',
    'connectTimeoutMs',
  ])
  const extra: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(body)) {
    if (!known.has(key)) extra[key] = entry
  }

  /**
   * The parsed list, plus the keys the pane cannot show a value for.
   *
   * Both are keys the document holds and the pane's body does not print: a key
   * answered outside the document, and a secret whose value the host withholds.
   * The pane's text omitting them is "unchanged", not "deleted" — a save removes
   * a key when the draft drops it, and only the form's own row can do that.
   */
  const carryUnshown = (
    parsed: EntryField[] | undefined,
    was: readonly FieldDraft[],
  ): FieldDraft[] => {
    const text1 = (parsed ?? []).map((field) => ({
      key: field.key,
      text: field.value ?? '',
      masked: false,
      fromCredentials: false,
      replaced: false,
      added: false,
    }))
    const carried = new Set(text1.map((field) => field.key))
    for (const field of was) {
      const unshown = field.fromCredentials === true || (field.masked === true && field.text === '')
      if (unshown && !carried.has(field.key)) text1.push(field)
    }
    return text1
  }

  return {
    draft: {
      server: base.server,
      revision: base.revision,
      // Every field above is narrowed to its real type by its own `false` check.
      transport,
      command,
      args,
      cwd,
      url,
      env: carryUnshown(env, base.env),
      envDeclared: env !== undefined,
      headers: carryUnshown(headers, base.headers),
      headersDeclared: headers !== undefined,
      enabled: enabled as boolean | undefined,
      connectTimeoutMs: timeout === undefined ? '' : String(timeout),
      extra,
    },
  }
}

// ── saving ────────────────────────────────────────────────────────────────────

/** What the host answered to a save: written, or one of the frozen error codes. */
export type SaveAnswer =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly code: SaveErrorCode
      readonly message: string
      /**
       * Wire code of `message` (`projectMcp.host` namespace), when the host
       * coded the refusal (F-48); `saveNotice` resolves it through the host
       * seat and an answer without it keeps the `hostMessage` wrapper.
       */
      readonly messageCode?: string | undefined
      /** Flat params of {@link SaveAnswer}'s messageCode, when it has any. */
      readonly messageParams?: Record<string, string> | undefined
    }

/** The sentence each frozen {@link SaveErrorCode} gets; the keys live in {@link EN}. */
const SAVE_ERROR_KEYS: Record<SaveErrorCode, LocaleKey> = {
  invalid: 'saveErrorInvalid',
  blocked: 'saveErrorBlocked',
  conflict: 'saveErrorConflict',
  'not-found': 'saveErrorNotFound',
  failed: 'saveErrorFailed',
}

const SAVE_ERROR_CODES = Object.keys(SAVE_ERROR_KEYS) as SaveErrorCode[]

function codeOf(code: string | undefined): SaveErrorCode {
  return SAVE_ERROR_CODES.find((known) => known === code) ?? 'failed'
}

/** The shape of the `{ ok, value | error }` envelope every host route answers with. */
interface SaveEnvelope {
  ok?: boolean
  error?: { code?: string; message?: string; messageCode?: string; messageParams?: Record<string, string> }
}

/**
 * `POST` one save and unwrap the envelope.
 *
 * Unlike the snapshot poll this never throws: every failure is one of the five
 * frozen codes, and `invalid` keeps the host's own text — the only place the
 * parser's reason reaches the user.
 * @param request - the entry, the document and the revision it was built from.
 * @returns the host's answer, normalized to {@link SaveAnswer}.
 */
export async function postSave(request: SaveRequest): Promise<SaveAnswer> {
  try {
    const response = await fetch(`${ROUTE_PREFIX}/${ROUTE_ACTIONS.save}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    const payload = (await response.json()) as SaveEnvelope
    if (payload.ok === true) return { ok: true }
    return {
      ok: false,
      code: codeOf(payload.error?.code),
      message: payload.error?.message ?? `request failed (${response.status})`,
      // The coded companions are optional on the wire: an old host's refusal
      // has none, and the notice falls back to the message.
      ...(typeof payload.error?.messageCode === 'string'
        ? { messageCode: payload.error.messageCode, messageParams: payload.error.messageParams }
        : {}),
    }
  } catch (error) {
    return { ok: false, code: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}

/** One save answer, as a sentence, plus what the notice has to offer. */
export interface SaveNotice {
  /** The sentence to show, one locale key per code. */
  text: string
  /** `true` when the document was written. */
  written: boolean
  /**
   * The host's own sentence, ready to render; only `invalid` shows it. A
   * coded refusal is resolved through the host seat and stands alone (F-48);
   * an uncoded one keeps the `hostMessage` wrapper it always had.
   */
  detail: string | undefined
  /** `true` when the page offers the re-read action that `conflict` asks for. */
  reRead: boolean
}

/**
 * Turn a save answer into the sentence the page shows.
 * @param answer - the host's answer, normalized by {@link postSave}.
 * @param t - the UI-namespace seat.
 * @param hostT - the `projectMcp.host` seat for a coded refusal's message;
 *   absent — or a seat that does not know the code — the payload's English
 *   message answers, never the raw code.
 */
export function saveNotice(answer: SaveAnswer, t: Translate, hostT?: Translate | undefined): SaveNotice {
  if (answer.ok) return { text: t('saveOk'), written: true, detail: undefined, reRead: false }
  return {
    text: t(SAVE_ERROR_KEYS[answer.code]),
    written: false,
    detail:
      answer.code !== 'invalid'
        ? undefined
        : answer.messageCode === undefined
          ? t('hostMessage', { message: answer.message })
          : resolveHost(hostT ?? hostTranslate(undefined), answer.messageCode, answer.messageParams, answer.message),
    reRead: answer.code === 'conflict',
  }
}

// ── form controls ─────────────────────────────────────────────────────────────

/**
 * One control that feeds the save request.
 *
 * Enabled while the row may be written; when the tier is `readonly` it renders
 * disabled with the row's own `writeBlockedReason`. The internal `data-write`
 * marker lets the no-DOM tests find every such control without a rendered
 * document.
 */
function formControl<T extends keyof ReactHTML>(
  kind: T,
  props: Record<string, unknown>,
  editable: boolean,
  reason: string,
  children?: ReactNode,
): ReactNode {
  const marked: Record<string, unknown> = {
    ...props,
    title: reason,
    'data-write': true,
    ...(editable ? {} : { disabled: true }),
  }
  return h(kind, marked as never, children)
}

/** A field the host owns: shown, never editable, with the reason why. */
function hostField(label: string, value: string, reason: string): ReactNode {
  return h(
    'div',
    { style: STYLE.field, key: label },
    h('span', { style: STYLE.fieldLabel }, label),
    h('input', {
      style: STYLE.input,
      value,
      readOnly: true,
      disabled: true,
      title: reason,
      'aria-label': label,
      'data-read': true,
    }),
  )
}

/**
 * The same host-owned row for a value that carries line breaks — the mount
 * detail. It keeps the label, the read-only marker and the reason tooltip, but
 * renders pre-wrapped text so the diagnostic's structure survives.
 */
function hostDetailField(label: string, value: string, reason: string): ReactNode {
  return h(
    'div',
    { style: STYLE.field, key: label },
    h('span', { style: STYLE.fieldLabel }, label),
    h(
      'div',
      {
        style: STYLE.fieldText,
        title: reason,
        'aria-label': label,
        'data-read': true,
      },
      value,
    ),
  )
}

/** One editable text field of the parsed entry. */
function textField(
  label: string,
  value: string,
  editable: boolean,
  reason: string,
  onChange: (value: string) => void,
  hint?: string,
): ReactNode {
  return h(
    'div',
    { key: label },
    h(
      'div',
      { style: STYLE.field },
      h('span', { style: STYLE.fieldLabel }, label),
      formControl(
        'input',
        {
          style: STYLE.input,
          value,
          readOnly: !editable,
          'aria-label': label,
          ...(editable
            ? { onChange: (event: { target: { value: string } }) => onChange(event.target.value) }
            : {}),
        },
        editable,
        reason,
      ),
    ),
    hint === undefined ? null : h('div', { style: STYLE.fieldHint }, hint),
  )
}

/** Reproduce one `env`/`headers` list as key/value rows plus an add button. */
function fieldList(
  label: string,
  rows: readonly FieldDraft[],
  editable: boolean,
  reason: string,
  t: Translate,
  hint: string,
  onChange: (rows: FieldDraft[]) => void,
): ReactNode {
  return h(
    'div',
    { style: STYLE.fieldGroup, key: label },
    h('span', { style: STYLE.fieldLabel }, label),
    h(
      'div',
      null,
      rows.length === 0 ? h('div', { style: STYLE.hint }, hint) : null,
      rows.map((row, index) =>
        h(
          'div',
          { key: `${row.key}#${index}` },
          h(
            'div',
            { style: STYLE.fieldRow },
            row.added
              ? formControl(
                  'input',
                  {
                    style: STYLE.input,
                    value: row.key,
                    placeholder: t('keyPlaceholder'),
                    'aria-label': t('keyField'),
                    ...(editable
                      ? {
                          onChange: (event: { target: { value: string } }) =>
                            onChange(replaceRow(rows, index, { key: event.target.value })),
                        }
                      : {}),
                  },
                  editable,
                  reason,
                )
              : h('span', { style: STYLE.fieldKey, title: row.key }, row.key),
            row.fromCredentials
              ? h('input', {
                  style: STYLE.input,
                  value: row.text,
                  readOnly: true,
                  disabled: true,
                  title: t('credentialsNote'),
                  placeholder: t('credentialValue'),
                  'aria-label': `${row.key} — ${t('credentialsNote')}`,
                  'data-read': true,
                })
              : formControl(
                  'input',
                  {
                    style: STYLE.input,
                    value: row.text,
                    placeholder:
                      row.masked && !row.replaced ? t('maskedValue') : t('valuePlaceholder'),
                    'aria-label': `${row.key} ${t('valueField')}`,
                    ...(editable
                      ? {
                          onChange: (event: { target: { value: string } }) =>
                            onChange(
                              replaceRow(rows, index, {
                                // A masked input becomes a replacement on the first
                                // keystroke, even when the user clears it back to empty.
                                text: event.target.value,
                                replaced: row.masked ? true : row.replaced,
                              }),
                            ),
                        }
                      : {}),
                  },
                  editable,
                  reason,
                ),
            row.fromCredentials || !editable
              ? null
              : h(
                  'button',
                  {
                    style: STYLE.iconButton,
                    title: t('removeKeyHint'),
                    'aria-label': `${t('removeKey')} ${row.key}`,
                    onClick: () => onChange(rows.filter((_entry, at) => at !== index)),
                  },
                  t('removeKey'),
                ),
          ),
          row.fromCredentials ? h('div', { style: STYLE.fieldHint }, t('credentialsNote')) : null,
        ),
      ),
      h(
        'button',
        {
          style: { ...STYLE.button, fontSize: '0.8em' },
          disabled: !editable,
          title: editable ? t('addKeyHint') : reason,
          onClick: () =>
            onChange([
              ...rows,
              {
                key: '',
                text: '',
                masked: false,
                fromCredentials: false,
                replaced: false,
                added: true,
              },
            ]),
        },
        t('addKey'),
      ),
    ),
  )
}

/** One row of a key/value list, replaced by key change or a typed value. */
function replaceRow(
  rows: readonly FieldDraft[],
  index: number,
  patch: Partial<FieldDraft>,
): FieldDraft[] {
  return rows.map((row, at) => (at === index ? { ...row, ...patch } : row))
}

/** The JSON pane's lines, coloured by side of the change. */
/**
 * The reason a disabled control carries: the host's payload resolved through
 * the host namespace (a known code translates; an unknown one falls back to
 * the payload's own English, never the raw code), or the page's fallback when
 * the host reported no reason at all.
 */
function blockedReason(row: ServerRow, t: Translate, hostT?: Translate | undefined): string {
  if (row.writeBlockedReason === undefined) return t('writeBlockedUnknown')
  return resolveHost(hostT ?? hostTranslate(undefined), row.blockedCode, row.blockedParams, row.writeBlockedReason)
}

/** `true` when the row's declaring document may be rewritten at all. */
function writable(row: ServerRow): boolean {
  return row.writeScope !== undefined && row.writeScope !== 'readonly'
}

// ── the page ──────────────────────────────────────────────────────────────────

/**
 * Everything the page renders, as plain props — the tests drive this directly.
 *
 * The editor props ride along from {@link EditorProps}: the shell owns the draft
 * and the confirmation state, the page is a function of them.
 */
export interface SettingsPageProps extends Omit<EditorProps, 'project' | 'row'> {
  /** Host snapshot, or undefined before the first poll lands. */
  snapshot: McpSnapshot | undefined
  /** Last fetch failure, when the host did not answer. */
  error: string | undefined
  /** True while a host action is in flight. */
  busy: boolean
  view: SettingsView
  onView: (view: SettingsView) => void
  /** Which page of this plugin's own settings page is open. */
  page: SettingsPageKey
  onPage: (page: SettingsPageKey) => void
  /** Selected project root; a stale value falls back to the first project. */
  selectedRoot: string | undefined
  onSelectProject: (projectRoot: string) => void
  /** Selected server name; opens the split editor. */
  selectedServer: string | undefined
  onSync: () => void
  /** Retry every failed mount of the selected project. */
  onRetry: () => void
  /** `true` while the table view also shows the snapshot's own JSON. */
  json: boolean
  onJson: (next: boolean) => void
  /** Switch one project's mode; written straight through to the host. */
  onMode: (projectRoot: string, mode: ToolMode) => void
  /** Roots with a mode write in flight. */
  modePending: ReadonlySet<string>
  /** Last refusal of a mode write, when the host did not take it. */
  modeError: string | undefined
  /** Wire companions of `modeError`, when the host coded the refusal (F-48). */
  modeErrorCode?: string | undefined
  /** Flat params of `modeErrorCode`. */
  modeErrorParams?: Record<string, string> | undefined
  /** Pin or unpin one tool of one project; the host stores it at once. */
  onPin?: ((projectRoot: string, tool: string, pinned: boolean) => void) | undefined
  /** Tool names with a pin write in flight. */
  pinPending?: ReadonlySet<string> | undefined
  /** Last refusal of a pin write, when the host did not take it. */
  pinError?: string | undefined
  /** Wire companions of `pinError`, when the host coded the refusal (F-48). */
  pinErrorCode?: string | undefined
  /** Flat params of `pinErrorCode`. */
  pinErrorParams?: Record<string, string> | undefined
  /** Choose which declaration of one contested name the project shows. */
  onChoice?: ((projectRoot: string, server: string, choice: ConflictChoice) => void) | undefined
  /** Contested names with a choice write in flight, per `projectRoot` + name. */
  choicePending?: ReadonlySet<string> | undefined
  /** Last refusal of a choice write, when the host did not take it. */
  choiceError?: string | undefined
  /** Wire companions of `choiceError`, when the host coded the refusal (F-48). */
  choiceErrorCode?: string | undefined
  /** Flat params of `choiceErrorCode`. */
  choiceErrorParams?: Record<string, string> | undefined
}

/**
 * The registered component: wire the host poll, the remembered view and the
 * editor's own state into the pure page. Kept thin on purpose — everything below
 * this line is a plain function of its props, which is what the no-DOM tests
 * exercise.
 */
export function SettingsTab(props: SettingsTabProps): ReactNode {
  const t = translateOf(props.t)
  const { snapshot, error, busy, run, reload } = useSnapshot(true, DEFAULT_REFRESH_MS)
  const [view, setView] = useState<SettingsView>(() => settingsViewOf())
  const [page, setPage] = useState<SettingsPageKey>(DEFAULT_SETTINGS_PAGE)
  const [selectedRoot, setSelectedRoot] = useState<string | undefined>(undefined)
  const [selectedServer, setSelectedServer] = useState<string | undefined>(undefined)
  const [modePending, setModePending] = useState<ReadonlySet<string>>(() => new Set())
  // Each refusal is the host's whole answer — prose plus the F-48 wire code
  // and its params — so the render site resolves the coded message through
  // the host seat and an old host's prose renders exactly as before.
  const [modeRefusal, setModeRefusal] = useState<PolicyRefusal | undefined>(undefined)
  // The other half of the policy: one row of the tool list disables while its own
  // pin is in flight, and the host's refusal is shown rather than reverted.
  const [pinPending, setPinPending] = useState<ReadonlySet<string>>(() => new Set())
  const [pinRefusal, setPinRefusal] = useState<PolicyRefusal | undefined>(undefined)
  // The durable answer to a name two declarations fight over: which of them the
  // project shows. One card disables while its own write is in flight.
  const [choicePending, setChoicePending] = useState<ReadonlySet<string>>(() => new Set())
  const [choiceRefusal, setChoiceRefusal] = useState<PolicyRefusal | undefined>(undefined)
  // The editor's own state: the draft the user is building, the confirmation
  // step, the consent a global write needs, and the last answer from the host.
  const [stored, setStored] = useState<EntryDraft | undefined>(undefined)
  /**
   * The JSON pane's parse error, held here rather than in the pane.
   *
   * The pane owns the text, but Save is decided here: a document must never be
   * written from text the pane could not read, so a failed parse blocks the
   * confirmation until the text parses again.
   */
  const [jsonError, setJsonError] = useState<string | undefined>(undefined)
  const [confirming, setConfirming] = useState(false)
  const [consent, setConsent] = useState(false)
  const [saveState, setSaveState] = useState<SaveAnswer | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  // The one place the media query is read; the page below takes the flag as a prop.
  const narrow = useNarrowSettings()
  const resetEditor = useCallback((): void => {
    setStored(undefined)
    setConfirming(false)
    setConsent(false)
    setSaveState(undefined)
    setSaving(false)
    setJsonError(undefined)
  }, [])
  const chooseView = useCallback((next: SettingsView): void => {
    setView(next)
    persistSettingsView(next)
  }, [])
  const chooseProject = useCallback(
    (projectRoot: string): void => {
      setSelectedRoot(projectRoot)
      setSelectedServer(undefined)
      resetEditor()
    },
    [resetEditor],
  )
  const chooseServer = useCallback(
    (name: string | undefined): void => {
      setSelectedServer(name)
      resetEditor()
    },
    [resetEditor],
  )
  // Both operator actions act on the selected project and ask for the whole
  // snapshot back: this page lists every project, so a narrowed answer would
  // empty it, while the action itself must not start a server for a project the
  // user is not looking at. The toolbar's button and every broken row's own
  // `Retry` send exactly the same request.
  const sync = useCallback((): void => {
    void run(
      ROUTE_ACTIONS.sync,
      operatorBody(selectedProject(snapshot, selectedRoot)?.projectRoot, true),
    )
  }, [snapshot, selectedRoot, run])
  const retry = useCallback((): void => {
    void run(
      ROUTE_ACTIONS.retry,
      operatorBody(selectedProject(snapshot, selectedRoot)?.projectRoot, true),
    )
  }, [snapshot, selectedRoot, run])
  const [json, setJson] = useState(false)
  const chooseJson = useCallback((next: boolean): void => setJson(next), [])
  /**
   * Write one project's mode. The switch is not a draft: the host reads the mode
   * on each request assembly, so the answer of this call is the only source of
   * truth and a refusal is shown rather than silently reverted.
   */
  const onMode = useCallback(
    (projectRoot: string, mode: ToolMode): void => {
      setModeRefusal(undefined)
      void requestMode(policyBody(projectRoot, mode), {
        onStart: (root) => setModePending((previous) => new Set(previous).add(root)),
        onSettled: (root) =>
          setModePending((previous) => {
            const next = new Set(previous)
            next.delete(root)
            return next
          }),
        onRefused: (message, messageCode, messageParams) => setModeRefusal({ message, messageCode, messageParams }),
      })
    },
    [],
  )
  const onPin = useCallback((projectRoot: string, tool: string, pinned: boolean): void => {
    setPinRefusal(undefined)
    void requestPin(pinBody(projectRoot, tool, pinned), {
      onStart: (name) => setPinPending((previous) => new Set(previous).add(name)),
      onSettled: (name) =>
        setPinPending((previous) => {
          const next = new Set(previous)
          next.delete(name)
          return next
        }),
      onRefused: (message, messageCode, messageParams) => setPinRefusal({ message, messageCode, messageParams }),
    })
  }, [])
  const onChoice = useCallback(
    (projectRoot: string, server: string, choice: ConflictChoice): void => {
      setChoiceRefusal(undefined)
      const key = choiceKey(projectRoot, server)
      const settle = (): void =>
        setChoicePending((previous) => {
          const next = new Set(previous)
          next.delete(key)
          return next
        })
      setChoicePending((previous) => new Set(previous).add(key))
      void postConflict(conflictBody(projectRoot, server, choice))
        .then((answer) => {
          if (!answer.ok) {
            setChoiceRefusal({
              message: answer.message,
              messageCode: answer.messageCode,
              messageParams: answer.messageParams,
            })
          }
        })
        .finally(settle)
    },
    [],
  )
  const project = selectedProject(snapshot, selectedRoot)
  const row = project?.rows.find((entry) => entry.name === selectedServer)
  const draft = row === undefined ? undefined : activeDraft(row, stored)
  const onDraft = useCallback((next: EntryDraft): void => {
    setStored(next)
    // The form re-derives the pane's text from this draft, so whatever the pane
    // failed to parse is no longer what is on screen.
    setJsonError(undefined)
  }, [])
  const onJsonEdit = useCallback(
    (next: EntryDraft | undefined, error: string | undefined): void => {
      setJsonError(error)
      if (next !== undefined) setStored(next)
    },
    [],
  )
  const onDiscard = useCallback((): void => {
    setStored(undefined)
    setConfirming(false)
    setSaveState(undefined)
  }, [])
  const onAskSave = useCallback((): void => {
    setSaveState(undefined)
    setConfirming(true)
  }, [])
  const onCancelSave = useCallback((): void => setConfirming(false), [])
  const onConsent = useCallback((next: boolean): void => setConsent(next), [])
  const onReRead = useCallback((): void => {
    setStored(undefined)
    setConfirming(false)
    setSaveState(undefined)
    void reload()
  }, [reload])
  const onConfirmSave = useCallback((): void => {
    if (project === undefined || row === undefined || draft === undefined) return
    // Belt and braces with the disabled confirm button: a global write without
    // the explicit consent is never sent.
    if (row.writeScope === 'global' && !consent) return
    const request = saveRequestOf(project, row, draftEntry(draft), consent)
    if (request === undefined) return
    setSaving(true)
    void postSave(request).then((answer) => {
      setSaving(false)
      setConfirming(false)
      setSaveState(answer)
      if (!answer.ok) return
      // The write landed: drop the draft and pull the fresh snapshot the host
      // re-read after the save.
      setStored(undefined)
      setConsent(false)
      void reload()
    })
  }, [project, row, draft, consent, run, reload])
  return h(SettingsPage, {
    snapshot,
    error,
    busy,
    view,
    onView: chooseView,
    page,
    onPage: setPage,
    onMode,
    modePending,
    modeError: modeRefusal?.message,
    modeErrorCode: modeRefusal?.messageCode,
    modeErrorParams: modeRefusal?.messageParams,
    onPin,
    pinPending,
    pinError: pinRefusal?.message,
    pinErrorCode: pinRefusal?.messageCode,
    pinErrorParams: pinRefusal?.messageParams,
    onChoice,
    choicePending,
    choiceError: choiceRefusal?.message,
    choiceErrorCode: choiceRefusal?.messageCode,
    choiceErrorParams: choiceRefusal?.messageParams,
    selectedRoot,
    onSelectProject: chooseProject,
    selectedServer,
    onSelectServer: chooseServer,
    onSync: sync,
    onRetry: retry,
    json,
    onJson: chooseJson,
    draft,
    confirming,
    consent,
    saveState,
    saving,
    onDraft,
    onJsonEdit,
    jsonError,
    onDiscard,
    onAskSave,
    onCancelSave,
    onConsent,
    onConfirmSave,
    onReRead,
    narrow,
    t,
    hostT: props.hostT,
  })
}

/**
 * The page: toolbar, then one state body. Exported so every state — before the
 * first poll, no live project, no declared server, a failed fetch — is asserted
 * without a DOM.
 * @param props - see {@link SettingsPageProps}.
 * @returns the page element tree.
 */
export function SettingsPage(props: SettingsPageProps): ReactNode {
  const t = props.t
  const projects = props.snapshot?.projects ?? []
  return h(
    'div',
    { style: STYLE.root },
    h(
      'div',
      { style: STYLE.bar },
      projects.length === 0
        ? null
        : h(ProjectSelector, {
            projects,
            selected: props.selectedRoot,
            onSelect: props.onSelectProject,
            t,
          }),
      projects.length === 0
        ? null
        : h('span', { style: STYLE.muted }, liveProjectCount(projects.length, t)),
      h('span', { style: { flex: 1 } }),
      h(SettingsPageSwitch, { page: props.page, onChange: props.onPage, t }),
      // The view switch, the JSON reading and the way out of it belong to the
      // server page: `Tools` is one policy form, not a second way to read the
      // same documents, so it keeps the toolbar it shares and drops the rest.
      props.page === 'tools' ? null : h(ViewSwitch, { view: props.view, onChange: props.onView, t }),
      props.page === 'tools' || props.view !== 'table'
        ? null
        : h(
            'button',
            {
              style: STYLE.button,
              'aria-pressed': props.json,
              title: props.json ? t('hideJson') : t('showJson'),
              onClick: () => props.onJson(!props.json),
            },
            props.json ? t('hideJson') : t('showJson'),
          ),
      h(
        'button',
        {
          style: STYLE.button,
          disabled: props.busy,
          title: t('syncHint'),
          onClick: props.onSync,
        },
        t('sync'),
      ),
    ),
    // A poll that fails after data has landed keeps the page: the rows stay, and
    // the failure is reported above them instead of replacing them.
    props.error === undefined || props.snapshot === undefined
      ? null
      : h(
          'div',
          { style: STYLE.note },
          `${t('hostUnavailable')} `,
          h('span', { style: STYLE.hint }, props.error),
        ),
    h('div', { style: STYLE.body }, settingsBody(props)),
  )
}

/**
 * The body below the toolbar: exactly one branch per situation, and every empty
 * branch names what is missing instead of showing an empty box.
 * @param props - see {@link SettingsPageProps}.
 * @returns the element tree below the toolbar.
 */
export function settingsBody(props: SettingsPageProps): ReactNode {
  const t = props.t
  // The error state only when there is nothing to show; a later failure is
  // reported by the page above the rows it kept.
  if (props.error !== undefined && props.snapshot === undefined) {
    return h(
      'div',
      { style: STYLE.errorState },
      h('div', { style: STYLE.stateTitle }, t('hostUnavailable')),
      h('div', { style: STYLE.hint }, t('hostUnavailableHint', { route: `${ROUTE_PREFIX}/snapshot` })),
      h('div', { style: STYLE.hint }, props.error),
    )
  }
  if (props.snapshot === undefined) {
    return h(
      'div',
      { style: STYLE.errorState },
      emptyState(t('loading'), t('loadingHint')),
    )
  }
  const projects = props.snapshot.projects
  if (projects.length === 0) {
    return withCodeLine(t('noSessions'), t('noSessionsHint'), readPaths(props.snapshot, t))
  }
  const project = selectedProject(props.snapshot, props.selectedRoot)
  if (project === undefined) return null
  if (props.page === 'tools') {
    return h(ToolsPage, {
      project,
      rows: projectPolicyRows(projects),
      onMode: props.onMode,
      pending: props.modePending,
      modeError: props.modeError,
      modeErrorCode: props.modeErrorCode,
      modeErrorParams: props.modeErrorParams,
      onSync: props.onSync,
      onPin: props.onPin,
      pinPending: props.pinPending,
      pinError: props.pinError,
      pinErrorCode: props.pinErrorCode,
      pinErrorParams: props.pinErrorParams,
      onChoice: props.onChoice,
      choicePending: props.choicePending,
      choiceError: props.choiceError,
      choiceErrorCode: props.choiceErrorCode,
      choiceErrorParams: props.choiceErrorParams,
      t,
      hostT: props.hostT,
    })
  }
  const row = project.rows.find((entry) => entry.name === props.selectedServer)
  if (row !== undefined) {
    return h(EditorSplit, {
      project,
      row,
      onSelectServer: props.onSelectServer,
      draft: props.draft,
      confirming: props.confirming,
      consent: props.consent,
      saveState: props.saveState,
      saving: props.saving,
      onDraft: props.onDraft,
      onJsonEdit: props.onJsonEdit,
      jsonError: props.jsonError,
      onDiscard: props.onDiscard,
      onAskSave: props.onAskSave,
      onCancelSave: props.onCancelSave,
      onConsent: props.onConsent,
      onConfirmSave: props.onConfirmSave,
      onReRead: props.onReRead,
      narrow: props.narrow,
      t,
      hostT: props.hostT,
    })
  }
  if (project.rows.length === 0) {
    // Where to declare one: this project's own documents, as configured. An
    // empty list is the honest answer "nowhere", not a file name this bundle
    // would otherwise invent.
    const documents = (project.files ?? [])
      .filter((file) => file.scope === 'project')
      .map((file) => file.path)
    return documents.length === 0
      ? emptyState(t('noServers'), t('noServersNoPath'))
      : withCodeLine(t('noServers'), t('noServersHint'), documents.join(' · '))
  }
  return props.view === 'files'
    ? h(FileCards, {
        project,
        selectedServer: props.selectedServer,
        onSelectServer: props.onSelectServer,
        t,
        hostT: props.hostT,
      })
    : h(
        'div',
        null,
        h(ServerTable, {
          project,
          selectedServer: props.selectedServer,
          onSelectServer: props.onSelectServer,
          onRetry: props.onRetry,
          busy: props.busy,
          t,
          hostT: props.hostT,
        }),
        // The table keeps the failure banners it renders; the JSON reading is an
        // extra, below them, and only while the toolbar's toggle is on.
        props.json ? h(JsonPreview, { project, t }) : null,
      )
}

/** A centred empty state followed by the path or command that fixes it. */
function withCodeLine(title: string, hint: string, code: string): ReactNode {
  return h('div', null, emptyState(title, hint), h('div', { style: STYLE.codeLine }, code))
}

/** The `Table` / `By files` switch. Not a write: it only changes this page. */
export function ViewSwitch(props: {
  view: SettingsView
  onChange: (view: SettingsView) => void
  t: Translate
}): ReactNode {
  const item = (value: SettingsView, label: string): ReactNode =>
    h(
      'button',
      {
        key: value,
        style:
          value === props.view
            ? { ...STYLE.segmentItem, ...STYLE.segmentItemActive }
            : STYLE.segmentItem,
        'aria-pressed': value === props.view,
        onClick: () => props.onChange(value),
      },
      label,
    )
  return h(
    'div',
    { style: STYLE.segment },
    item('table', props.t('viewTable')),
    item('files', props.t('viewFiles')),
  )
}

/**
 * Project picker. The only seat on this page where another project is visible,
 * and it only ever selects which single project's rows the body renders.
 */
export function ProjectSelector(props: {
  projects: readonly ProjectSnapshot[]
  selected: string | undefined
  onSelect: (projectRoot: string) => void
  t: Translate
}): ReactNode {
  const value =
    props.selected !== undefined &&
    props.projects.some((project) => project.projectRoot === props.selected)
      ? props.selected
      : (props.projects[0]?.projectRoot ?? '')
  return h(
    'label',
    { style: STYLE.muted },
    `${props.t('project')}: `,
    h(
      'select',
      {
        style: STYLE.select,
        value,
        title: value,
        onChange: (event: { target: { value: string } }) => props.onSelect(event.target.value),
      },
      props.projects.map((project) =>
        h(
          'option',
          { key: project.projectRoot, value: project.projectRoot },
          basename(project.projectRoot),
        ),
      ),
    ),
  )
}

/** The dense overview: one row per declared server of the selected project. */
/**
 * The table's status cell: the host's word for the row, in the colour of that
 * status, and — for a quiet row the host counted — how long it has been unused.
 *
 * The figure comes from the host's own `usage[server].lastUsedAt`; a row the
 * counters never recorded has nothing to print, and the cell stays the word it
 * has always been rather than saying `idle 0m`.
 */
function statusCell(row: ServerRow, project: ProjectSnapshot, t: Translate): ReactNode {
  const idle = idleNote(row.status, project.usage?.[row.name]?.lastUsedAt, t)
  return h(
    'td',
    { style: { ...STYLE.td, color: STATUS_COLOR[row.status] } },
    t(STATUS_KEYS[row.status]),
    idle === undefined ? null : h('span', { style: STYLE.hint }, ` ${idle}`),
  )
}

export function ServerTable(props: {
  project: ProjectSnapshot
  selectedServer?: string | undefined
  onSelectServer: (name: string | undefined) => void
  /** Retry the project's failed mounts; absent while nothing can be written. */
  onRetry?: (() => void) | undefined
  /** `true` while a host action is in flight, so the row buttons stay still. */
  busy?: boolean | undefined
  t: Translate
  /** The host namespace's seat, for the rows' coded blocked reasons. */
  hostT?: Translate | undefined
}): ReactNode {
  const t = props.t
  return h(
    'div',
    { style: STYLE.tableScroll },
    h(
      'table',
      { style: STYLE.table },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', { style: STYLE.th }, t('server')),
          h('th', { style: STYLE.th }, t('transport')),
          h('th', { style: STYLE.th }, t('status')),
          h('th', { style: STYLE.th }, t('source')),
          h('th', { style: STYLE.th }, t('on')),
          h('th', { style: STYLE.th }, ''),
        ),
      ),
      h(
        'tbody',
        null,
        props.project.rows.map((row) =>
          h(
            'tr',
            { key: row.name },
            h(
              'td',
              { style: STYLE.td },
              statusDot(row.status, t),
              ' ',
              serverButton(row, row.name === props.selectedServer, props.onSelectServer, t, props.hostT),
            ),
            h('td', { style: STYLE.td }, h('span', { style: STYLE.muted }, row.transport ?? '—')),
            statusCell(row, props.project, t),
            h('td', { style: STYLE.td }, sourceLabel(row, props.project, t)),
            h('td', { style: STYLE.td }, enabledSwitch(row, t, props.hostT)),
            h('td', { style: STYLE.td }, rowAction(row, props, t)),
          ),
        ),
      ),
    ),
    ...props.project.rows
      .filter((row) => row.status === 'error' && row.detail !== undefined)
      .map((row) =>
        h(
          'div',
          { style: STYLE.note, key: `detail-${row.name}` },
          h('strong', null, row.name),
          // The row passed the filter, so its detail is present; the seat
          // translates it when the host sent the wire code (F-48).
          ` — ${rowDetail(row, props.hostT) ?? ''}`,
        ),
      ),
  )
}

/**
 * The table's last cell: the one action the row has.
 *
 * A broken row offers a real `Retry` — the host route is project-scoped, so it
 * sends the request the toolbar's own button sends. Every other row offers `…`,
 * which opens the entry in the split editor: on this surface a row is read-only,
 * so the only thing left to do with it is go and edit it. Both labels are keys;
 * neither control writes anything itself.
 * @param row - the server row.
 * @param props - the table's own props, for the action and the busy flag.
 * @param t - translate seat.
 * @returns the cell's content.
 */
function rowAction(
  row: ServerRow,
  props: {
    onSelectServer: (name: string | undefined) => void
    onRetry?: (() => void) | undefined
    busy?: boolean | undefined
  },
  t: Translate,
): ReactNode {
  if (row.status === 'error' && props.onRetry !== undefined) {
    return h(
      'button',
      {
        style: STYLE.button,
        title: t('retryHint'),
        disabled: props.busy === true,
        onClick: props.onRetry,
      },
      t('retry'),
    )
  }
  return h(
    'button',
    {
      style: STYLE.button,
      title: t('rowActionsHint'),
      onClick: () => props.onSelectServer(row.name),
    },
    t('rowActionsMore'),
  )
}

/**
 * The snapshot's own reading of a project's entries, as JSON.
 *
 * Built from the parsed entries the host published, not from the document on
 * disk: the page never reads a file, and this preview must not imply it does. A
 * row the host did not parse has no entry and is left out rather than invented.
 * @param project - the selected project.
 * @returns the two-space JSON body the preview prints.
 */
export function projectJson(project: ProjectSnapshot): string {
  const servers: Record<string, unknown> = {}
  for (const row of project.rows) {
    if (row.entry === undefined) continue
    servers[row.name] = entryBody(row.entry)
  }
  return JSON.stringify({ mcpServers: servers }, null, 2)
}

/**
 * The table view's optional JSON pane: the snapshot's entries, read-only.
 *
 * @param props - the project and the translate seat.
 * @returns the titled code block.
 */
export function JsonPreview(props: { project: ProjectSnapshot; t: Translate }): ReactNode {
  return h(
    'div',
    null,
    h('div', { style: STYLE.paneHead }, props.t('jsonPreview')),
    h('div', { style: STYLE.hint }, props.t('jsonPreviewHint')),
    h('pre', { style: STYLE.json }, projectJson(props.project)),
  )
}

/** The "By files" overview: one card per declaring document, in priority order. */
export function FileCards(props: {
  project: ProjectSnapshot
  selectedServer?: string | undefined
  onSelectServer: (name: string | undefined) => void
  t: Translate
  /** The host namespace's seat, for the rows' coded blocked reasons. */
  hostT?: Translate | undefined
}): ReactNode {
  const t = props.t
  return h(
    'div',
    null,
    fileGroups(props.project).map((group) =>
      h(
        'div',
        { key: group.source, style: STYLE.card },
        h(
          'div',
          { style: STYLE.cardHead },
          h(
            'span',
            { style: STYLE.cardPath },
            group.source === '' ? t('documentUnknown') : group.label,
          ),
          group.priority?.global === true ? h('span', { style: STYLE.tag }, t('global')) : null,
          group.priority === undefined
            ? null
            : h('span', { style: STYLE.tag }, t('priority', { tier: group.priority.tier, total: group.priority.total })),
          h('span', { style: { flex: 1 } }),
          h('span', { style: STYLE.muted }, serverCount(group.rows.length, t)),
        ),
        group.rows.map((row) =>
          h(
            'div',
            { key: row.name, style: STYLE.row },
            statusDot(row.status, t),
            serverButton(row, row.name === props.selectedServer, props.onSelectServer, t, props.hostT),
            row.transport === undefined
              ? null
              : h('span', { style: STYLE.tag }, row.transport),
            // The status carries the row's tone here too: the document view is
            // the same rows as the table, read by document instead of by column.
            h('span', { style: { ...STYLE.muted, color: STATUS_COLOR[row.status] } }, t(STATUS_KEYS[row.status])),
            h('span', { style: { flex: 1 } }),
            enabledSwitch(row, t, props.hostT),
          ),
        ),
        group.overrides.map((note, index) =>
          h(
            'div',
            { key: `${note.name}#${index}`, style: STYLE.overrideNote },
            note.from === undefined
              ? t('overrideUnpinned', { name: note.name })
              : t('overrideFrom', { name: note.name, from: note.from }),
          ),
        ),
      ),
    ),
  )
}

/** Everything the split editor renders, as plain props. */
export interface EditorProps {
  /** Project the row belongs to; its root rides in the save request. */
  project: ProjectSnapshot
  /** The row being edited. */
  row: ServerRow
  /** Called with the server to open, or undefined to go back to the overview. */
  onSelectServer: (name: string | undefined) => void
  /**
   * The open row's form state, already resolved through {@link activeDraft} by
   * the shell: the stored draft while it still matches the row's revision, a
   * fresh one otherwise. Undefined when the host did not parse the entry.
   */
  draft: EntryDraft | undefined
  /** True while the confirmation step is open. */
  confirming: boolean
  /** Consent checkbox state; only `global` rows read it. */
  consent: boolean
  /** Last save answer, when one has landed. */
  saveState: SaveAnswer | undefined
  /** True while the save request is in flight. */
  saving: boolean
  /** The JSON pane's parse error, when the last edit did not parse. */
  jsonError?: string | undefined
  /** Report one JSON edit: a parsed draft, or the reason it did not parse. */
  onJsonEdit?: ((draft: EntryDraft | undefined, error: string | undefined) => void) | undefined
  onDraft: (draft: EntryDraft) => void
  onDiscard: () => void
  /** Open the confirmation step; writes nothing on its own. */
  onAskSave: () => void
  onCancelSave: () => void
  onConsent: (consent: boolean) => void
  /** Write the document: the only control that reaches the host. */
  onConfirmSave: () => void
  /** Refetch the snapshot after a `conflict`. */
  onReRead: () => void
  /**
   * Stack the three panes instead of laying them in a row. The shell passes
   * {@link useNarrowSettings}'s flag; the tests pass it by hand, which is why
   * the editor itself never reads the media query. Defaults to `false`.
   */
  narrow?: boolean | undefined
  t: Translate
  /**
   * The `projectMcp.host` seat for the host's coded messages (the blocked
   * reason is the first channel). Optional: absent outside a shell and in
   * tests, where the payload's English message renders exactly as before.
   */
  hostT?: Translate | undefined
}

/**
 * One pane's rule for the current layout.
 * @param base - the pane's side-by-side rule.
 * @param stacked - the overrides for the stacked layout.
 * @param narrow - `true` while the panes render stacked.
 * @returns the style object the pane renders with.
 */
function paneStyle(
  base: CSSProperties,
  stacked: CSSProperties,
  narrow: boolean,
): CSSProperties {
  return narrow ? { ...base, ...stacked } : base
}

/**
 * The entry as JSON, editable: the pane under the form.
 *
 * One value, two views: the text is what the pane last showed or the user typed,
 * and every keystroke is parsed back into the shell's draft through
 * {@link draftFromJson}. A parse that fails leaves the draft alone and reports
 * the reason upward — the shell blocks Save on it, so a document can never be
 * written from text the pane could not read. The text re-syncs only when the
 * draft changes from somewhere else (the form above, another server): the draft
 * the pane itself produced is the one it already shows.
 * @param props - the draft, the write scope, the pane's own label and the
 *   shell's error line.
 * @returns the editable body; its head belongs to the editor, which reads
 *   whether the body differs from the snapshot.
 */
export function JsonPane(props: {
  /** The draft the form and the pane both edit. */
  draft: EntryDraft
  /** `true` while the declaring document may be written. */
  editable: boolean
  /** Why it may not be written, when it may not. */
  reason: string
  /** The pane head's label: the document, and whether it differs from the snapshot. */
  label: string
  /** The parse error the shell holds, when the last edit did not parse. */
  error: string | undefined
  /** Report one edit: a parsed draft, or the reason it did not parse. */
  onJson?: ((draft: EntryDraft | undefined, error: string | undefined) => void) | undefined
  t: Translate
}): ReactNode {
  const t = props.t
  const [text, setText] = useState(() => jsonBodyOf(props.draft))
  /** The draft this pane produced last, so its own echo does not overwrite the text. */
  const adopted = useRef<EntryDraft | undefined>(props.draft)
  useEffect(() => {
    if (props.draft === adopted.current) return
    adopted.current = props.draft
    setText(jsonBodyOf(props.draft))
  }, [props.draft])
  const change = (next: string): void => {
    setText(next)
    const answer = draftFromJson(next, props.draft)
    if ('error' in answer) {
      props.onJson?.(undefined, answer.error)
      return
    }
    adopted.current = answer.draft
    props.onJson?.(answer.draft, undefined)
  }
  return h(
    'div',
    null,
    h('textarea', {
      style: props.editable ? STYLE.jsonArea : { ...STYLE.jsonArea, opacity: 0.75 },
      value: text,
      readOnly: !props.editable,
      spellCheck: false,
      'aria-label': props.label,
      // The same marking the form's controls carry: this is a write control of
      // the document, and on a tier that may not be written it is disabled with
      // the host's own reason as its title.
      'data-write': true,
      title: props.editable ? t('jsonEditHint') : props.reason,
      ...(props.editable ? {} : { disabled: true }),
      onChange: (event: { target: { value: string } }) => change(event.target.value),
    }),
    props.error === undefined
      ? null
      : h('div', { style: STYLE.noteError }, t('jsonInvalid', { reason: props.error })),
  )
}

/**
 * The split editor: the project's servers on the left, and the entry on the
 * right — its fields, and the document body under them.
 *
 * One entry, two editors: the form's fields and the JSON pane both write the same
 * draft, and the pane parses every keystroke back into it. That is the one thing
 * the pane cannot delegate: text the pane cannot read leaves the draft alone and
 * blocks the write (the shell holds the reason), so a document is never saved
 * from something nobody parsed. A `readonly` tier keeps every control disabled
 * with `writeBlockedReason`. Nothing reaches the host before the confirmation
 * step: Save only opens it, and the confirm button inside it is the write. The
 * list and the entry column share the width they are given until `narrow` says
 * there is too little of it, and then everything stacks.
 */
export function EditorSplit(props: EditorProps): ReactNode {
  const t = props.t
  const narrow = props.narrow === true
  const { project, row } = props
  const { draft } = props
  const declared = row.entry
  const edited = draft === undefined ? undefined : draftEntry(draft)
  const dirty = declared !== undefined && edited !== undefined && entryDirty(declared, edited)
  const parsed = draft !== undefined && edited !== undefined
  const editable = parsed && writable(row)
  const reason = blockedReason(row, t, props.hostT)
  const timeoutBad = draft !== undefined && timeoutInvalid(draft.connectTimeoutMs)
  const request = edited === undefined ? undefined : saveRequestOf(project, row, edited, props.consent)
  const jsonBad = props.jsonError !== undefined
  const saveEnabled =
    !props.saving && editable && dirty && !timeoutBad && !jsonBad && request !== undefined
  // The Save control is never silently dead: whatever disables it is its title.
  const saveReason = ((): string => {
    if (!parsed) return t('entryUnavailable')
    if (jsonBad) return t('saveJsonInvalid')
    if (!writable(row)) return reason
    if (timeoutBad) return t('saveTimeoutInvalid')
    if (request === undefined) return t('saveUnavailable')
    if (props.saving) return t('saving')
    if (!dirty) return t('saveNoChange')
    return t('saveHint')
  })()
  const global = row.writeScope === 'global'
  const confirmReady = !props.saving && (!global || props.consent)
  const source = row.source
  const label = source === undefined ? t('documentUnknown') : documentLabel(source, project.projectRoot)
  const backup = source === undefined ? undefined : `${source}.bak`
  const backupLabel =
    backup === undefined ? t('documentUnknown') : documentLabel(backup, project.projectRoot)
  const state = !parsed
    ? t('entryUnavailable')
    : writable(row)
      ? t('editableNote', { document: label, backup: backupLabel })
      : t('writeBlocked', { reason })
  return h(
    'div',
    null,
    h(
      'div',
      { style: STYLE.splitBar },
      h(
        'button',
        {
          style: STYLE.button,
          title: t('backHint'),
          onClick: () => props.onSelectServer(undefined),
        },
        `‹ ${t('back')}`,
      ),
      h('span', { style: STYLE.hint, title: source ?? project.projectRoot }, state),
    ),
    h(
      'div',
      { style: paneStyle(STYLE.split, STYLE.splitNarrow, narrow) },
      h(
        'div',
        {
          style: paneStyle(STYLE.paneList, STYLE.paneListNarrow, narrow),
          'data-pane': 'list',
        },
        h('div', { style: STYLE.paneHead }, t('servers')),
        project.rows.map((entry) =>
          h(
            'div',
            {
              key: entry.name,
              style:
                entry.name === row.name
                  ? { ...STYLE.listItem, ...STYLE.listItemActive }
                  : STYLE.listItem,
            },
            statusDot(entry.status, t),
            serverButton(entry, entry.name === row.name, props.onSelectServer, t, props.hostT),
          ),
        ),
      ),
      h(
        'div',
        { style: paneStyle(STYLE.paneColumn, STYLE.paneColumnNarrow, narrow) },
        h(
          'div',
          {
            style: paneStyle(STYLE.paneForm, STYLE.paneFormNarrow, narrow),
            'data-pane': 'form',
          },
          // The form's own head: the pane below it holds the same entry in the
          // shape the document keeps, and the list is every declared server.
          h('div', { style: STYLE.paneHead }, t('paneEntry')),
          hostField(t('name'), row.name, t('nameReason')),
          ...(draft === undefined
            ? []
            : draftFields(draft, declared, editable, reason, t, props.onDraft)),
          hostField(t('status'), t(STATUS_KEYS[row.status]), t('statusReason')),
          hostField(t('source'), source ?? t('documentUnknown'), t('sourceReason')),
          hostDetailField(t('detail'), rowDetail(row, props.hostT) ?? '—', t('detailReason')),
        ),
        h(
          'div',
          {
            style: paneStyle(STYLE.paneJson, STYLE.paneJsonNarrow, narrow),
            'data-pane': 'json',
          },
          h(
            'div',
            { style: STYLE.paneHead },
            draft === undefined || edited === undefined
              ? label
              : `${label} · ${dirty ? t('jsonDiff') : t('jsonClean')}`,
          ),
          draft === undefined || declared === undefined || edited === undefined
            ? h('div', { style: STYLE.json }, t('jsonUnavailable'))
            : h(JsonPane, {
                draft,
                editable,
                reason,
                label,
                error: props.jsonError,
                onJson: props.onJsonEdit,
                t,
              }),
        ),
      ),
    ),
    h(
      'div',
      null,
      h(
        'div',
        { style: STYLE.splitFooter },
        formControl(
          'button',
          { style: STYLE.buttonPrimary, onClick: props.onAskSave },
          saveEnabled,
          saveReason,
          t('save'),
        ),
        h(
          'button',
          {
            style: STYLE.button,
            disabled: !dirty,
            title: dirty ? t('discardHint') : t('discardReason'),
            onClick: props.onDiscard,
          },
          t('discard'),
        ),
        dirty ? h('span', { style: STYLE.tag }, t('unsaved')) : null,
        h('span', { style: { flex: 1 } }),
        h(
          'span',
          {
            style: STYLE.hint,
            title: source ?? project.projectRoot,
          },
          t(writable(row) ? 'footerWrite' : 'footerReadonly', { document: label }),
        ),
      ),
      props.confirming
        ? confirmation({
            label,
            backupLabel,
            server: row.name,
            global,
            consent: props.consent,
            ready: confirmReady,
            saving: props.saving,
            t,
            onConsent: props.onConsent,
            onConfirm: props.onConfirmSave,
            onCancel: props.onCancelSave,
          })
        : null,
      props.saveState === undefined ? null : noticeBlock(props.saveState, t, props.onReRead, props.hostT),
    ),
  )
}

/** The entry's own fields, for the transport the draft currently declares. */
function draftFields(
  draft: EntryDraft,
  declared: EntrySnapshot | undefined,
  editable: boolean,
  reason: string,
  t: Translate,
  onDraft: (draft: EntryDraft) => void,
): ReactNode[] {
  const clearable = (value: string): string | undefined => (value === '' ? undefined : value)
  const transport = transportField(draft, editable, reason, t, onDraft)
  if (draft.transport === 'streamable-http') {
    return [
      transport,
      textField(t('urlField'), draft.url ?? '', editable, reason, (value) =>
        onDraft({ ...draft, url: clearable(value) }),
      ),
      fieldList(t('headersField'), draft.headers, editable, reason, t, t('headersHint'), (headers) =>
        onDraft({ ...draft, headers }),
      ),
      ...commonFields(draft, declared, editable, reason, t, onDraft),
    ]
  }
  return [
    transport,
    textField(t('commandField'), draft.command ?? '', editable, reason, (value) =>
      onDraft({ ...draft, command: clearable(value) }),
    ),
    textField(
      t('argsField'),
      (draft.args ?? []).join('\n'),
      editable,
      reason,
      (value) => onDraft({ ...draft, args: value === '' ? undefined : value.split('\n') }),
      t('argsHint'),
    ),
    textField(t('cwdField'), draft.cwd ?? '', editable, reason, (value) =>
      onDraft({ ...draft, cwd: clearable(value) }),
    ),
    fieldList(t('envField'), draft.env, editable, reason, t, t('envHint'), (env) =>
      onDraft({ ...draft, env }),
    ),
    ...commonFields(draft, declared, editable, reason, t, onDraft),
  ]
}

/** Fields both transports carry: `enabled` and the connect timeout. */
function commonFields(
  draft: EntryDraft,
  declared: EntrySnapshot | undefined,
  editable: boolean,
  reason: string,
  t: Translate,
  onDraft: (draft: EntryDraft) => void,
): ReactNode[] {
  const value = draft.enabled === undefined ? t('absent') : String(draft.enabled)
  return [
    h(
      'div',
      { style: STYLE.field, key: 'enabled' },
      h('span', { style: STYLE.fieldLabel }, t('enabledField')),
      h(
        'label',
        { style: { display: 'flex', alignItems: 'center', gap: 6 } },
        formControl(
          'input',
          {
            type: 'checkbox',
            checked: draft.enabled !== false,
            style: STYLE.switch,
            'aria-label': t('enabledField'),
            ...(editable
              ? {
                  onChange: (event: { target: { checked: boolean } }) =>
                    onDraft({
                      ...draft,
                      enabled: event.target.checked ? (declared?.enabled === true ? true : undefined) : false,
                    }),
                }
              : {}),
          },
          editable,
          reason,
        ),
        h('span', { style: STYLE.hint }, t('enabledValue', { value })),
      ),
    ),
    textField(
      t('timeoutField'),
      draft.connectTimeoutMs,
      editable,
      reason,
      (value) => onDraft({ ...draft, connectTimeoutMs: value }),
      timeoutInvalid(draft.connectTimeoutMs) ? t('saveTimeoutInvalid') : t('timeoutHint'),
    ),
  ]
}

/** The confirmation step: what is written where, and the consent it may need. */
function confirmation(props: {
  label: string
  backupLabel: string
  server: string
  global: boolean
  consent: boolean
  ready: boolean
  saving: boolean
  t: Translate
  onConsent: (consent: boolean) => void
  onConfirm: () => void
  onCancel: () => void
}): ReactNode {
  const { t } = props
  return h(
    'div',
    { style: STYLE.confirm },
    h('div', { style: STYLE.stateTitle }, t('confirmTitle', { document: props.label })),
    h('div', { style: STYLE.hint }, t('confirmBackup', { backup: props.backupLabel })),
    h('div', { style: STYLE.hint }, t('confirmFormat', { server: props.server })),
    props.global ? h('div', { style: STYLE.hint }, t('confirmConsent')) : null,
    props.global
      ? h(
          'label',
          { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.85em' } },
          h('input', {
            type: 'checkbox',
            checked: props.consent,
            style: STYLE.switch,
            'aria-label': t('consentLabel'),
            onChange: (event: { target: { checked: boolean } }) =>
              props.onConsent(event.target.checked),
          }),
          t('consentLabel'),
        )
      : null,
    h(
      'div',
      { style: STYLE.splitFooter },
      formControl(
        'button',
        { style: STYLE.buttonPrimary, onClick: props.onConfirm },
        props.ready,
        props.ready ? t('confirmWriteHint') : props.saving ? t('saving') : t('confirmBlocked'),
        t('confirmWrite'),
      ),
      h('button', { style: STYLE.button, onClick: props.onCancel }, t('cancel')),
    ),
  )
}

/** The sentence the last save answer gets, plus the actions it offers. */
function noticeBlock(answer: SaveAnswer, t: Translate, onReRead: () => void, hostT?: Translate | undefined): ReactNode {
  const notice = saveNotice(answer, t, hostT)
  return h(
    'div',
    { style: notice.written ? STYLE.noteOk : STYLE.noteError },
    notice.text,
    // The detail arrives ready to render: saveNotice applied the hostMessage
    // wrapper to an uncoded answer and the host seat to a coded one.
    notice.detail === undefined ? null : h('div', { style: STYLE.hint }, notice.detail),
    notice.reRead
      ? h('button', { style: STYLE.button, title: t('reReadHint'), onClick: onReRead }, t('reRead'))
      : null,
  )
}

/** The transport field: the two transports the host maps. */
function transportField(
  draft: EntryDraft,
  editable: boolean,
  reason: string,
  t: Translate,
  onDraft: (draft: EntryDraft) => void,
): ReactNode {
  return h(
    'div',
    { style: STYLE.field, key: 'transport' },
    h('span', { style: STYLE.fieldLabel }, t('transport')),
    formControl(
      'select',
      {
        style: STYLE.input,
        value: draft.transport,
        'aria-label': t('transport'),
        ...(editable
          ? {
              onChange: (event: { target: { value: string } }) =>
                onDraft({
                  ...draft,
                  transport: event.target.value === 'streamable-http' ? 'streamable-http' : 'stdio',
                }),
            }
          : {}),
      },
      editable,
      reason,
      ['stdio', 'streamable-http'].map((option) => h('option', { key: option, value: option }, option)),
    ),
  )
}

/** The Source column: the declaring document, or the project root fallback. */
function sourceLabel(row: ServerRow, project: ProjectSnapshot, t: Translate): ReactNode {
  const label =
    row.source === undefined ? t('documentUnknown') : documentLabel(row.source, project.projectRoot)
  return h('span', { style: { ...STYLE.muted, fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)' }, title: row.source ?? project.projectRoot }, label)
}

/** The row's `enabled` switch: the table edits nothing, so it opens the editor. */
function enabledSwitch(row: ServerRow, t: Translate, hostT?: Translate | undefined): ReactNode {
  // The mockups draw the On column as their switch, not as a checkbox: the two
  // live states are the same fact (`enabled: false` is what `disabled` means),
  // and the switch is the shape the rest of the page's controls use. It is not
  // an editor either way — the click that opens the entry is the row's own.
  const on = row.status !== 'disabled'
  return formControl(
    'button',
    {
      type: 'button',
      style: on ? STYLE.switchOn : { ...STYLE.switchOn, ...STYLE.switchOff },
      'aria-checked': on,
      'aria-label': t('on'),
    },
    false,
    writable(row) ? t('openToEdit') : blockedReason(row, t, hostT),
    h('span', {
      style: on ? { ...STYLE.switchKnob, ...STYLE.switchKnobOn } : STYLE.switchKnob,
      'aria-hidden': true,
    }),
  )
}

/** A status dot; the colour and the wording both come from the shared vocabulary. */
function statusDot(status: ServerStatus, t: Translate): ReactNode {
  return h('span', {
    style: { ...STYLE.dot, background: STATUS_COLOR[status] },
    title: t(STATUS_HINT[status]),
    'aria-hidden': true,
  })
}

/** A server name that selects it; selection is not a write. */
function serverButton(
  row: ServerRow,
  selected: boolean,
  onSelect: (name: string | undefined) => void,
  t: Translate,
  hostT?: Translate | undefined,
): ReactNode {
  return h(
    'button',
    {
      style: selected
        ? { ...STYLE.serverButton, ...STYLE.serverButtonActive }
        : STYLE.serverButton,
      title: rowDetail(row, hostT) ?? t(STATUS_HINT[row.status]),
      onClick: () => onSelect(selected ? undefined : row.name),
    },
    row.name,
  )
}
