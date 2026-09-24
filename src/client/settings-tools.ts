/**
 * The tools side of the plugin's page in DSH's native Settings.
 *
 * The page has two pages of its own, because one plugin is one row of the
 * settings navigation: `Servers` is the declaration view this module never
 * touches, and `Tools` is the per-project policy the disclosure half of the
 * mockup lays out. Both live in the same `settings.section` registration — this
 * module adds the tab, it does not register a second navigation item.
 *
 * Tools answers a different question than the live surfaces: not "what does the
 * model see right now", but "what will this project offer, and what is pinned".
 * Everything on it is measured rather than invented: the server and tool counts
 * come from the host snapshot's rows and each session's `tools`, the pinned list
 * and the mode are the project's own `policy`, the per-server counters are
 * counted from the session's own offer by the registry's `mcp__<server>__`
 * prefix, the conflicts are the host's report, and the request preview lists the
 * names the session really offers with the token estimate the contract derives
 * from the serialized sizes. Nothing here reads `./demo.ts`, and no row invents
 * a value the host does not publish.
 *
 * @module dsh-project-mcp/client/settings-tools
 */

import { createElement as h } from 'react'
import type { ReactNode } from 'react'
import type {
  ConflictChoice,
  ProjectSnapshot,
  ServerConflict,
  SessionTools,
  ToolMode,
  ToolPolicy,
} from '../types.ts'
import { policyOf } from './policy.ts'
import { STYLE } from './settings.ts'
import type { LocaleKey, Translate } from './settings.ts'
import {
  basename,
  callsLabel,
  serverOfToolName,
  serverPinPress,
  serverPinState,
  toolCounts,
  toolCalls,
} from './view.ts'
import type { ToolCalls } from './view.ts'
import { byCalls } from './usage-view.ts'
import { hostTranslate, resolveHost } from './locales/host.ts'

/**
 * A serialized size in tokens, by the contract's own reading: `chars / 4`.
 *
 * The estimate is printed only where a size is known: a session the host
 * published without `deferredChars` gets the hidden count and no estimate,
 * rather than an invented one.
 * @param chars - serialized size in characters.
 * @returns the estimate, rounded to a whole token.
 */
export function tokenEstimate(chars: number): number {
  return Math.round(chars / 4)
}

/**
 * The three values the mode switch offers, in the order the contract lists them.
 *
 * Straight from the frozen `ToolMode`, so the form cannot drift into the
 * mockup's `all-direct` spelling of the same state.
 */
export const TOOL_MODES: readonly ToolMode[] = ['disclosure', 'direct', 'off']

/** Which of the plugin page's own pages is open. */
export type SettingsPageKey = 'servers' | 'tools'

/** Page shown when nothing else was chosen, so the page never opens blank. */
export const DEFAULT_SETTINGS_PAGE: SettingsPageKey = 'servers'

/** One page of the plugin's own settings page, in the switch's order. */
export interface SettingsPageTab {
  key: SettingsPageKey
  /** Dictionary key of the label; the switch resolves it through `t`. */
  labelKey: LocaleKey
}

/**
 * The two pages of our own settings page.
 *
 * `Servers` is what the plugin has shipped since the write path landed; `Tools`
 * is the disclosure policy, added next to it rather than as a second row of the
 * settings navigation.
 */
export const SETTINGS_PAGES: readonly SettingsPageTab[] = [
  { key: 'servers', labelKey: 'tabServers' },
  { key: 'tools', labelKey: 'tabTools' },
]

/** The `Servers` / `Tools` switch inside our own settings page. */
export function SettingsPageSwitch(props: {
  page: SettingsPageKey
  onChange: (page: SettingsPageKey) => void
  t: Translate
}): ReactNode {
  const item = (tab: SettingsPageTab): ReactNode =>
    h(
      'button',
      {
        key: tab.key,
        style:
          tab.key === props.page
            ? { ...STYLE.segmentItem, ...STYLE.segmentItemActive }
            : STYLE.segmentItem,
        'aria-pressed': tab.key === props.page,
        onClick: () => props.onChange(tab.key),
      },
      props.t(tab.labelKey),
    )
  return h('div', { style: STYLE.segment }, SETTINGS_PAGES.map(item))
}

// ── the project table ─────────────────────────────────────────────────────────

/** How many live sessions one project has; the table's "seen" column. */
export function liveSessions(project: ProjectSnapshot): number {
  return project.sessionIds.length
}

/**
 * The live snapshot of one project's first session, when the host published one.
 * @param project - project row of the settings page.
 * @returns that session's snapshot, or undefined when nothing is live.
 */
export function firstSession(project: ProjectSnapshot): ProjectSnapshot['sessions'][number] | undefined {
  return (project.sessions ?? [])[0]
}

/** The tools one project shows in the table, with their provenance. */
export interface ProjectToolCounts {
  /** Servers the project declares. */
  servers: number
  /** Tools mounted for the project, when the session published them. */
  tools: number | undefined
  /** Tools the session activated on demand. */
  disclosed: number
}

/**
 * Count one project's servers and tools.
 *
 * Both numbers are real: servers are `project.rows`, tools are the mounted total
 * of the first live session's `SessionTools`. A project whose sessions published
 * no offer has no tool count at all — the row shows a dash — because the count of
 * its *servers* is not the count of its tools.
 * @param project - project row of the settings page.
 * @returns the counts; `tools` is undefined when no session published an offer.
 */
export function projectToolCounts(project: ProjectSnapshot): ProjectToolCounts {
  const live = firstSession(project)?.tools
  return {
    servers: project.rows.length,
    tools: live?.mounted,
    disclosed: live === undefined ? 0 : toolCounts(live).disclosed,
  }
}

/** The policy row of one project: the host's own counts and the policy in force. */
export interface ProjectPolicyRow {
  /** Project root. */
  projectRoot: string
  /** Short label the table shows. */
  label: string
  /** Declared servers and mounted tools. */
  counts: ProjectToolCounts
  /** The policy in force, as the host published it. */
  policy: ToolPolicy
}

/**
 * One table row per project with a live session, in snapshot order.
 * @param projects - projects the host snapshot carries.
 * @returns the rows the table renders.
 */
export function projectPolicyRows(projects: readonly ProjectSnapshot[]): ProjectPolicyRow[] {
  return projects.map((project) => ({
    projectRoot: project.projectRoot,
    label: basename(project.projectRoot),
    counts: projectToolCounts(project),
    policy: policyOf(project),
  }))
}

/** What one mode value is called in the UI. */
const MODE_KEYS: Record<ToolMode, LocaleKey> = {
  disclosure: 'modeDisclosure',
  direct: 'modeDirect',
  off: 'modeOff',
}

/** The label of one mode value. */
export function modeLabel(mode: ToolMode, t: Translate): string {
  return t(MODE_KEYS[mode])
}

/**
 * The dense per-project overview: one row per project with a live session.
 *
 * The mode cell is the one interactive column: a mode is a value the host
 * stores, so it is written as soon as it is clicked (the page says so under the
 * form) and the button goes quiet while the answer is in flight.
 *
 * Seven columns did not fit the settings panel's content column on every window;
 * the five the host answers for do, and the table is still a scroll region
 * rather than a block that runs under the panel edge. Its headers stay on one
 * line, and the project name — the only free-form text in it — wraps inside its
 * cell instead of widening the table.
 */
export function ToolsProjectTable(props: {
  rows: readonly ProjectPolicyRow[]
  /** Roots the host is currently writing a mode or a pin for. */
  pending: ReadonlySet<string>
  onMode: (projectRoot: string, mode: ToolMode) => void
  t: Translate
}): ReactNode {
  const { t } = props
  const th = { ...STYLE.th, whiteSpace: 'nowrap' as const }
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
          h('th', { style: th }, t('project')),
          h('th', { style: th }, t('servers')),
          h('th', { style: th }, t('toolsCount')),
          h('th', { style: th }, t('pinned')),
          h('th', { style: th }, t('mode')),
        ),
      ),
      h(
        'tbody',
        null,
        props.rows.map((row) =>
          h(
            'tr',
            { key: row.projectRoot },
            h('td', { style: { ...STYLE.td, overflowWrap: 'anywhere' as const } }, row.label),
            h('td', { style: STYLE.td }, String(row.counts.servers)),
            h(
              'td',
              { style: STYLE.td },
              row.counts.tools === undefined ? '—' : String(row.counts.tools),
            ),
            h('td', { style: STYLE.td }, String(row.policy.pins.length)),
            h(
              'td',
              { style: STYLE.td },
              ModeSwitchRow({
                mode: row.policy.mode,
                busy: props.pending.has(row.projectRoot),
                onMode: (mode) => props.onMode(row.projectRoot, mode),
                t,
              }),
            ),
          ),
        ),
      ),
    ),
  )
}

// ── the tools tab ─────────────────────────────────────────────────────────────

/** Props of the `Tools` page: the selected project and its host policy. */
export interface ToolsPageProps {
  /** The project the page shows; selected by the shared project picker. */
  project: ProjectSnapshot
  /** Every project with a live session, for the overview table above the form. */
  rows: readonly ProjectPolicyRow[]
  /** Switch one project's mode; the host stores it, so it is written at once. */
  onMode: (projectRoot: string, mode: ToolMode) => void
  /** Roots with a policy write in flight. */
  pending: ReadonlySet<string>
  /** Last refusal from a policy write, when the host did not take it. */
  modeError: string | undefined
  /** Wire companions of `modeError`, when the host coded the refusal (F-48). */
  modeErrorCode?: string | undefined
  /** Flat params of `modeErrorCode`. */
  modeErrorParams?: Record<string, string> | undefined
  /** Re-read the host snapshot now; the conflict report's own action. */
  onSync: () => void
  /** Pin or unpin one tool of one project; the host stores it at once. */
  onPin?: ((projectRoot: string, tool: string, pinned: boolean) => void) | undefined
  /** Tool names with a pin write in flight, per `projectRoot` + `tool`. */
  pinPending?: ReadonlySet<string> | undefined
  /** Last refusal from a pin write, when the host did not take it. */
  pinError?: string | undefined
  /** Wire companions of `pinError`, when the host coded the refusal (F-48). */
  pinErrorCode?: string | undefined
  /** Flat params of `pinErrorCode`. */
  pinErrorParams?: Record<string, string> | undefined
  /**
   * Choose which declaration of one contested name the project shows. The host
   * stores the answer and answers with the snapshot that already reflects it,
   * so this page draws the new state instead of guessing it.
   */
  onChoice?: ((projectRoot: string, server: string, choice: ConflictChoice) => void) | undefined
  /** Contested names with a choice write in flight, per `projectRoot` + name. */
  choicePending?: ReadonlySet<string> | undefined
  /** Last refusal from a choice write, when the host did not take it. */
  choiceError?: string | undefined
  /** Wire companions of `choiceError`, when the host coded the refusal (F-48). */
  choiceErrorCode?: string | undefined
  /** Flat params of `choiceErrorCode`. */
  choiceErrorParams?: Record<string, string> | undefined
  t: Translate
  /** Host-namespace seat for the conflicts' coded messages (F-48). */
  hostT?: Translate | undefined
}

/**
 * The `Tools` page: the project table, then the form of the selected project.
 *
 * The page is a vertical list of setting rows rather than the mockup's split:
 * a policy form is a list of settings, which is what DSH's own settings pages
 * are, and the split's panes are too narrow for the sentences they had to hold.
 */
export function ToolsPage(props: ToolsPageProps): ReactNode {
  const { t } = props
  const policy = policyOf(props.project)
  return h(
    'div',
    null,
    h(ToolsProjectTable, {
      rows: props.rows,
      pending: props.pending,
      onMode: props.onMode,
      t,
    }),
    props.modeError === undefined
      ? null
      : h(
          'div',
          { style: STYLE.noteError },
          // A coded refusal translates through the host seat; prose alone
          // renders exactly as it did before codes existed.
          `${t('modeRefused')} ${resolveHost(props.hostT ?? hostTranslate(undefined), props.modeErrorCode, props.modeErrorParams, props.modeError)}`,
        ),
    h(ProjectForm, {
      project: props.project,
      policy,
      onMode: props.onMode,
      pending: props.pending.has(props.project.projectRoot),
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
    }),
  )
}

/**
 * The switch that stands for a whole server (F-44).
 *
 * It wears the control every per-name row below wears, and its reading is
 * {@link serverPinState}'s proportion: on while the project pins **every** name
 * this page lists for that server, off otherwise. A half-pinned server
 * therefore reads off, and that is the honest reading of the only store there
 * is — the pin list holds names, no rule about servers, and this page has no
 * third visual for "some". What the press does is said by the tooltip and is
 * never a loss: the set is completed when it is not complete and released only
 * when it is ({@link serverPinPress}).
 *
 * The names are **every** name the host published for that server: the offered
 * ones this page lists below, and the ones it kept hidden. A pin is what pulls a
 * hidden name into the request (that is what the tab's hidden tier does with its
 * own `Pin`), so a switch that stood for the server while skipping them would
 * leave the server half-pinned — and the row's own description already counts
 * them (`1 of 3 tools offered directly`).
 * @param props - the project, the server, the names that stand for it and the writer.
 * @returns the switch, inert while there is nothing to write to.
 */
function serverPinSwitch(props: {
  projectRoot: string
  server: string
  /** Every name the host published for this server, hidden ones included. */
  names: readonly string[]
  /** The project's own pin list. */
  pins: readonly string[]
  /** `true` while a pin write of this server is in flight. */
  pending: boolean
  onPin?: ((projectRoot: string, tool: string, pinned: boolean) => void) | undefined
  t: Translate
}): ReactNode {
  const { t } = props
  const all = serverPinState(props.names, props.pins) === 'all'
  const press = serverPinPress(props.names, props.pins)
  // `names` is never empty for a row that is drawn: the rows come from
  // `serverToolCounts`, and a server is in that list because it contributed at
  // least one name. A switch over nothing would not exist to be disabled.
  const disabled = props.onPin === undefined || props.pending
  return h(
    'button',
    {
      type: 'button',
      style: all ? STYLE.switchOn : { ...STYLE.switchOn, ...STYLE.switchOff },
      'aria-checked': all,
      'aria-label': `${props.server} — ${all ? t('serverUnpin') : t('serverPin')}`,
      title: all ? t('serverUnpinHint') : t('serverPinHint'),
      disabled,
      onClick: () => {
        for (const name of press.names) props.onPin?.(props.projectRoot, name, press.pinned)
      },
    },
    h('span', { style: all ? { ...STYLE.switchKnob, ...STYLE.switchKnobOn } : STYLE.switchKnob }),
  )
}

/**
 * The form of one project's policy: the setting rows — the mode, then one row
 * per server of the session — under the page's own note, then the pinned group
 * with the conflict report, the mounted tool list and the request preview as
 * full-width blocks.
 *
 * The server rows are the mockup's "not to be touched" field, made real: each
 * one names a server this session mounts and says, from the session's own offer,
 * how many of its tools the model is offered directly. A row that used to
 * promise a locked example service now counts the project's own servers.
 */
export function ProjectForm(props: {
  project: ProjectSnapshot
  /** The host's policy for that project: the mode and the pin list. */
  policy: ToolPolicy
  onMode: (projectRoot: string, mode: ToolMode) => void
  /** `true` while this project's mode is being written. */
  pending: boolean
  /** Re-read the host snapshot now; the conflict report's own action. */
  onSync: () => void
  /** Pin or unpin one tool of this project; the host stores it at once. */
  onPin?: ((projectRoot: string, tool: string, pinned: boolean) => void) | undefined
  /** Tool names with a pin write in flight. */
  pinPending?: ReadonlySet<string> | undefined
  /** Last refusal from a pin write, when the host did not take it. */
  pinError?: string | undefined
  /** Wire companions of `pinError`, when the host coded the refusal (F-48). */
  pinErrorCode?: string | undefined
  /** Flat params of `pinErrorCode`. */
  pinErrorParams?: Record<string, string> | undefined
  /** Choose which declaration of one contested name this project shows. */
  onChoice?: ((projectRoot: string, server: string, choice: ConflictChoice) => void) | undefined
  /** Contested names with a choice write in flight. */
  choicePending?: ReadonlySet<string> | undefined
  /** Last refusal from a choice write, when the host did not take it. */
  choiceError?: string | undefined
  /** Wire companions of `choiceError`, when the host coded the refusal (F-48). */
  choiceErrorCode?: string | undefined
  /** Flat params of `choiceErrorCode`. */
  choiceErrorParams?: Record<string, string> | undefined
  t: Translate
  /** Host-namespace seat for the conflicts' coded messages (F-48). */
  hostT?: Translate | undefined
}): ReactNode {
  const { t, policy } = props
  const tools = firstSession(props.project)?.tools
  const servers = tools === undefined ? [] : serverToolCounts(tools)
  // The names this page lists, read once: the per-name list below works from
  // this set.
  const offered = offeredNames(tools)
  /**
   * Every name the host published for one server, offered and hidden alike.
   *
   * The per-name list below shows the offered half only, but a server's switch
   * speaks for the server: the hidden names are exactly the ones a pin pulls
   * into the request, and the row's own description counts them, so leaving them
   * out would make the switch quieter than the sentence beside it.
   * @param server - the `serverName` as the registry spells it in the prefix.
   * @returns the names, offered first, each once.
   */
  const mountedOf = (server: string): string[] => [
    ...new Set([
      ...offered.filter((name) => serverOfToolName(name) === server),
      ...(tools?.deferred ?? []).filter((name) => serverOfToolName(name) === server),
    ]),
  ]
  return h(
    'div',
    null,
    // The mode is the host's own value: the write goes out on the click, so
    // the row carries the hint about that instead of a Save of its own. The
    // longer explanation rides the row's tooltip rather than a paragraph above
    // it — the mockup spends its lines on controls, not on prose.
    SettingRow({
      label: t('mode'),
      description: t('modeHint'),
      title: t('policyNote'),
      control: ModeSwitchRow({
        mode: policy.mode,
        busy: props.pending,
        onMode: (mode) => props.onMode(props.project.projectRoot, mode),
        t,
      }),
      last: servers.length === 0,
    }),
    // One row per server, and since F-44 the row is also where a whole server
    // gets pinned: the name keeps its place at the right edge and the switch
    // stands beside it, so the reading and the action share one line.
    ...servers.map((count, index) => {
      const names = mountedOf(count.server)
      return SettingRow({
        label: t('server'),
        description: serverOfferLabel(count, t),
        control: h(
          'span',
          { style: STYLE.settingRowControl },
          h('span', { style: STYLE.muted }, count.server),
          serverPinSwitch({
            projectRoot: props.project.projectRoot,
            server: count.server,
            names,
            pins: policy.pins,
            pending: names.some((name) => props.pinPending?.has(name) === true),
            onPin: props.onPin,
            t,
          }),
        ),
        last: index === servers.length - 1,
      })
    }),
    h(
      'div',
      { style: STYLE.settingGroup },
      h('div', { style: STYLE.settingGroupHead }, t('pinned')),
      // The pin list is the host's: names the user pinned by hand, in the order
      // they pinned them. No badge, because nothing here is invented — and the
      // list gets the whole width, so a long name cannot be clipped.
      h(
        'div',
        { style: STYLE.tagList },
        policy.pins.length === 0
          ? h('span', { style: STYLE.hint }, t('pinListEmpty'))
          : policy.pins.map((name) => h('span', { key: name, style: STYLE.tag }, name)),
      ),
      // The conflict check is real: the report is the host's own
      // `ProjectSnapshot.conflicts`, drawn under the row, and the button asks
      // the host for a fresh snapshot rather than standing in for one. Both the
      // hint and the button carry the label "Check conflicts": the head is the
      // block's own title, and the button repeats it as the action.
      SettingRow({
        label: t('checkConflicts'),
        description: t('pinList'),
        title: t('checkConflictsHint'),
        control: h(
          'button',
          { style: STYLE.button, title: t('checkConflictsHint'), onClick: props.onSync },
          t('checkConflicts'),
        ),
        last: true,
      }),
      ConflictReport({
        projectRoot: props.project.projectRoot,
        conflicts: props.project.conflicts ?? [],
        onChoice: props.onChoice,
        choicePending: props.choicePending,
        choiceError: props.choiceError,
        choiceErrorCode: props.choiceErrorCode,
        choiceErrorParams: props.choiceErrorParams,
        t,
        hostT: props.hostT,
      }),
    ),
    h(ToolList, {
      project: props.project,
      policy,
      onPin: props.onPin,
      pinPending: props.pinPending,
      pinError: props.pinError,
      pinErrorCode: props.pinErrorCode,
      pinErrorParams: props.pinErrorParams,
      t,
      hostT: props.hostT,
    }),
    h(RequestPreview, { project: props.project, policy, t }),
  )
}

/**
 * The host's conflict report for one project, always drawn.
 *
 * The report needs no click to appear: the host counts the conflicts when it
 * builds the snapshot, so hiding them behind a button would hide an answer the
 * page already holds. The empty state is a real answer too — "no conflicts" is
 * the good case, and the row above it says so instead of showing nothing.
 * @param props - the conflicts, in the host's order.
 * @returns one row per conflict, or the empty state.
 */
export function ConflictReport(props: {
  /** Project the names belong to; the choice is stored per project. */
  projectRoot: string
  conflicts: readonly ServerConflict[]
  /** Choose a declaration; absent leaves the cards read-only. */
  onChoice?: ((projectRoot: string, server: string, choice: ConflictChoice) => void) | undefined
  /** Contested names with a write in flight. */
  choicePending?: ReadonlySet<string> | undefined
  /** Last refusal from a choice write, when the host did not take it. */
  choiceError?: string | undefined
  /** Wire companions of `choiceError`, when the host coded the refusal (F-48). */
  choiceErrorCode?: string | undefined
  /** Flat params of `choiceErrorCode`. */
  choiceErrorParams?: Record<string, string> | undefined
  t: Translate
  /**
   * Host-namespace seat for the conflicts' coded messages (F-48); without one
   * each card renders its payload's English, byte-identical to before codes.
   */
  hostT?: Translate | undefined
}): ReactNode {
  const { t } = props
  if (props.conflicts.length === 0) {
    return h('div', { style: { ...STYLE.hint, padding: '8px 0' } }, t('conflictsNone'))
  }
  return h(
    'div',
    null,
    props.conflicts.map((conflict) =>
      // One conflict is one card, in the alarm tone: the mockups draw a conflict
      // as a note that reads as a warning, not as another table row.
      h(
        'div',
        { key: conflict.server, style: STYLE.noteError },
        h('strong', null, conflict.server),
        ' ',
        h('span', { style: conflictTone(conflict.kind) }, conflictKindLabel(conflict.kind, t)),
        h(
          'div',
          { style: STYLE.muted },
          resolveHost(props.hostT ?? hostTranslate(undefined), conflict.code, conflict.params, conflict.message),
        ),
        conflict.sources.length === 0
          ? null
          : h(
              'div',
              { style: STYLE.hint },
              t('conflictSources', { sources: conflict.sources.join(' · ') }),
            ),
        ConflictChoiceRow({
          projectRoot: props.projectRoot,
          conflict,
          onChoice: props.onChoice,
          pending: props.choicePending?.has(choiceKey(props.projectRoot, conflict.server)) ?? false,
          t,
        }),
      ),
    ),
    props.choiceError === undefined
      ? null
      : h(
          'div',
          { style: STYLE.noteError },
          `${t('choiceRefused')} ${resolveHost(props.hostT ?? hostTranslate(undefined), props.choiceErrorCode, props.choiceErrorParams, props.choiceError)}`,
        ),
  )
}

/**
 * The choice control of one conflict card: which of the declarations this
 * project shows.
 *
 * Drawn wherever a profile-level reservation meets a surface that can write the
 * answer. A duplicate declaration has no toggle on purpose: both copies live in
 * this project's own documents, and no rename of the winner brings the loser
 * back.
 *
 * The three answers are the host's own `ConflictChoice`, in its order. `profile`
 * and `native` need nothing but the name the conflict already carries; `local`
 * is the one that cannot be drawn without a worked-out alias, so a host that
 * published none loses that button alone — an alias-less project can still keep
 * the profile instance or mount its own declaration under the declared name.
 * @param props - the conflict, its project and the write surface.
 * @returns the row, or `null` when the conflict carries no choice.
 */
function ConflictChoiceRow(props: {
  projectRoot: string
  conflict: ServerConflict
  onChoice?: ((projectRoot: string, server: string, choice: ConflictChoice) => void) | undefined
  pending: boolean
  t: Translate
}): ReactNode {
  const { conflict, t } = props
  const write = props.onChoice
  if (conflict.kind !== 'profile' || write === undefined) return null
  const choice = conflict.choice ?? 'profile'
  const button = (next: ConflictChoice, title: string, label: string): ReactNode =>
    h(
      'button',
      {
        type: 'button',
        style: choice === next ? STYLE.choiceOn : STYLE.choiceOff,
        disabled: props.pending,
        'aria-pressed': choice === next,
        title,
        onClick: () => write(props.projectRoot, conflict.server, next),
      },
      label,
    )
  const alias = conflict.alias
  return h(
    'div',
    { style: STYLE.choiceRow },
    h('span', { style: STYLE.hint }, t('choiceLabel')),
    button('profile', t('choiceProfileHint'), t('conflictProfile')),
    // Only a `local` answer names the alias it would mount under, so the button
    // exists exactly where the host published one.
    alias === undefined
      ? null
      : button('local', t('choiceLocalHint', { alias }), t('choiceLocal', { alias })),
    button('native', t('choiceNativeHint'), t('choiceNative')),
  )
}

/** The key one contested name's write is tracked under: project + name. */
export function choiceKey(projectRoot: string, server: string): string {
  return `${projectRoot}\u0000${server}`
}

/**
 * The chip rule an alarm about this kind of conflict wears.
 *
 * A profile-level reservation is the warning tone — the name is taken, nothing
 * is broken. A duplicate declaration inside one project is the error tone: only
 * one of the two can win, so a declaration the file states is being dropped.
 * @param kind - the host's own conflict kind.
 * @returns the chip style for that kind.
 */
function conflictTone(kind: ServerConflict['kind']): Record<string, unknown> {
  return kind === 'profile' ? STYLE.tagWarn : STYLE.tagError
}

/** What one conflict kind is called in the UI. */
const CONFLICT_KEYS: Record<ServerConflict['kind'], LocaleKey> = {
  profile: 'conflictProfile',
  duplicate: 'conflictDuplicate',
}

/** The label of one conflict kind. */
export function conflictKindLabel(kind: ServerConflict['kind'], t: Translate): string {
  return t(CONFLICT_KEYS[kind])
}

/**
 * One setting row of the `Tools` page: the label and its description in the
 * text column, the control in the column on the right.
 *
 * The text column is the wide one and the one that wraps — `flex: 1` takes the
 * leftover width and `minWidth: 0` lets it shrink below its content instead of
 * pushing the control out of the panel. The control column is `flex: none`, so
 * it measures to its own content and never wraps. That is exactly the shape the
 * old three-pane grid got wrong: it put sentences in panes narrower than one of
 * their words, so they rendered as one-word-wide slivers.
 * @param props - label, optional description and the row's own control.
 * @returns the row element.
 */
export function SettingRow(props: {
  /** Bold text of the text column. */
  label: string
  /** Muted one-line description under the label, when the row has one. */
  description?: string
  /**
   * The longer explanation of the row, as a tooltip rather than a paragraph.
   *
   * The mockups keep a settings line to a label and a control; anything that
   * needs a sentence hangs it off the label it explains.
   */
  title?: string
  /** The control, sized to its content in the column on the right. */
  control: ReactNode
  /** `true` on the last row of a group, whose trailing separator is dropped. */
  last?: boolean
}): ReactNode {
  return h(
    'div',
    { style: props.last === true ? { ...STYLE.settingRow, ...STYLE.lastRow } : STYLE.settingRow },
    h(
      'div',
      {
        style: STYLE.settingRowText,
        ...(props.title === undefined ? null : { title: props.title }),
      },
      h('div', { style: STYLE.settingRowLabel }, props.label),
      props.description === undefined
        ? null
        : h('div', { style: STYLE.settingRowDesc }, props.description),
    ),
    h('div', { style: STYLE.settingRowControl }, props.control),
  )
}

/**
 * The mode switch: `disclosure / direct / off`, the host's own three values.
 *
 * Unlike the mockup's segmented controls below it, this one writes through to
 * the host the moment it is clicked (the caller owns the request), so each
 * button stays disabled until the answer lands and the row re-reads the mode the
 * host actually stored.
 */
export function ModeSwitchRow(props: {
  mode: ToolMode
  busy: boolean
  onMode: (mode: ToolMode) => void
  t: Translate
}): ReactNode {
  return h(
    'span',
    { style: STYLE.segment },
    TOOL_MODES.map((mode) =>
      h(
        'button',
        {
          key: mode,
          style:
            mode === props.mode
              ? { ...STYLE.segmentItem, ...STYLE.segmentItemActive }
              : STYLE.segmentItem,
          'aria-pressed': mode === props.mode,
          disabled: props.busy,
          onClick: () => props.onMode(mode),
        },
        modeLabel(mode, props.t),
      ),
    ),
  )
}

// ── the session's own offer, counted per server ───────────────────────────────

/** One server's share of a session's offer. */
export interface ServerToolCount {
  /** Server name, without the registry's `mcp__` prefix. */
  server: string
  /** Its tools the session offers the model right now. */
  offered: number
  /** Its tools mounted for the project but held back from this offer. */
  hidden: number
  /** `offered + hidden`. */
  total: number
}

/**
 * The names one session offers, in offer order: the durable baseline, then the
 * two on-demand tiers.
 *
 * Each name once: the tiers are not disjoint — a pinned or hot name can be
 * activated too — and both readers of this list count, so a repeat would be
 * counted twice (the per-server rows) or printed twice (the picker below).
 * @param tools - one session's offer, when the host published one.
 * @returns the public names, each once; empty without an offer.
 */
export function offeredNames(tools: SessionTools | undefined): string[] {
  if (tools === undefined) return []
  return [
    ...new Set([
      ...tools.baseline,
      ...tools.activated.map((tool) => tool.name),
      ...tools.context.map((tool) => tool.name),
    ]),
  ]
}

/**
 * The names this project's request would carry, in offer order: the host's pin
 * list first, then the session's own offer, each name once.
 *
 * Pins lead because that is where the request builder starts: a pinned name is
 * offered from the first step whatever the counters say. A pin the project no
 * longer mounts is kept — the declaration may come back — which is why the list
 * follows `policy.pins` rather than filtering it first.
 * @param tools - one session's tool offer.
 * @param policy - the project's policy, whose `pins` lead the list.
 * @returns the visible names, in request order.
 */
export function visibleToolNames(tools: SessionTools, policy: ToolPolicy): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const name of [...policy.pins, ...offeredNames(tools)]) {
    if (seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

/**
 * Count the session's offer per server, by the registry's `mcp__<server>__`
 * prefix (contract C6).
 *
 * `offered` and `hidden` are the session's own lists, so a name without the
 * prefix — a built-in, or one another owner contributes — belongs to no server
 * and is left out rather than filed under a made-up one. The sum of `total` is
 * therefore a lower bound on `SessionTools.mounted`, which stays the control.
 * @param tools - one session's tool offer.
 * @returns one entry per server, ordered by name.
 */
export function serverToolCounts(tools: SessionTools): ServerToolCount[] {
  const counts = new Map<string, ServerToolCount>()
  const bump = (name: string, tier: 'offered' | 'hidden'): void => {
    const server = serverOfToolName(name)
    if (server === undefined) return
    const entry = counts.get(server) ?? { server, offered: 0, hidden: 0, total: 0 }
    if (tier === 'offered') entry.offered += 1
    else entry.hidden += 1
    entry.total = entry.offered + entry.hidden
    counts.set(server, entry)
  }
  for (const name of offeredNames(tools)) bump(name, 'offered')
  for (const name of tools.deferred) bump(name, 'hidden')
  return [...counts.values()].sort((left, right) => left.server.localeCompare(right.server))
}

/**
 * What one server's counters mean in words: everything it mounts is offered
 * directly, or only part of it is.
 * @param count - one server's counters.
 * @param t - translate seat.
 * @returns the sentence the filter row carries.
 */
export function serverOfferLabel(count: ServerToolCount, t: Translate): string {
  return count.hidden === 0
    ? t('serverAllOffered', { count: count.offered })
    : t('serverPartlyOffered', { offered: count.offered, total: count.total })
}

/** One name and its switch: the picker's row. */
function pinRow(
  name: string,
  pinned: boolean,
  pending: boolean,
  calls: ToolCalls | undefined,
  props: {
    onPin?: ((projectRoot: string, tool: string, pinned: boolean) => void) | undefined
    project: ProjectSnapshot
    t: Translate
  },
): ReactNode {
  const { t } = props
  const disabled = props.onPin === undefined || pending
  const figure = callsLabel(calls, t)
  return h(
    'div',
    { key: name, style: STYLE.listItem },
    h('span', { style: STYLE.muted }, name),
    figure === undefined ? null : h('span', { style: STYLE.hint }, figure),
    h('span', { style: { flex: 1 } }),
    h(
      'button',
      {
        type: 'button',
        style: pinned ? STYLE.switchOn : { ...STYLE.switchOn, ...STYLE.switchOff },
        'aria-checked': pinned,
        'aria-label': name,
        title: pinned ? t('toolsUnpinHint') : t('toolsPinHint'),
        disabled,
        onClick: () => props.onPin?.(props.project.projectRoot, name, !pinned),
      },
      h('span', { style: pinned ? { ...STYLE.switchKnob, ...STYLE.switchKnobOn } : STYLE.switchKnob }),
    ),
  )
}

/**
 * The project's mounted tools as a full-width block, with the pinned ones
 * marked.
 *
 * It lists the names the host actually offers — the pinned list first, then
 * whatever this session's own `tools` published — so a name on screen is a name
 * the project really mounts. The total in the head is the host's count of
 * mounted tools; a project whose session has published no offer yet shows a
 * dash and no rows rather than a number nobody measured.
 *
 * The block used to be the split's left pane, which is why it carried a
 * fixed-width rail and a right border; it is a card between two other blocks
 * now, so its rows are separated by the card's own rules instead.
 *
 * Since F-32 the rows are ordered by the host's own call counters and carry
 * that count, so the name worth pinning is the name at the top rather than the
 * one the session happened to list first.
 */
export function ToolList(props: {
  project: ProjectSnapshot
  policy: ToolPolicy
  /** Pin or unpin one tool of this project; absent leaves the switches inert. */
  onPin?: ((projectRoot: string, tool: string, pinned: boolean) => void) | undefined
  /** Tool names with a pin write in flight. */
  pinPending?: ReadonlySet<string> | undefined
  /** Last refusal from a pin write, when the host did not take it. */
  pinError?: string | undefined
  /** Wire companions of `pinError`, when the host coded the refusal (F-48). */
  pinErrorCode?: string | undefined
  /** Flat params of `pinErrorCode`. */
  pinErrorParams?: Record<string, string> | undefined
  t: Translate
  /** Host-namespace seat for the refusal's coded message (F-48). */
  hostT?: Translate | undefined
}): ReactNode {
  const { t } = props
  const counts = projectToolCounts(props.project)
  const live = firstSession(props.project)
  const tools = live?.tools
  const offered = offeredNames(tools)
  const pinnedNames = new Set(props.policy.pins)
  const pending = props.pinPending ?? new Set<string>()
  const rest = counts.tools === undefined ? 0 : Math.max(0, counts.tools - offered.length)
  return h(
    'div',
    { style: STYLE.card },
    h('div', { style: STYLE.cardHead }, `${t('tabTools')} · ${counts.tools ?? '—'}`),
    offered.length === 0
      ? h(
          'div',
          { style: STYLE.listItem },
          h('span', { style: STYLE.hint }, t('requestPreviewNoOffer')),
        )
      : [...offered]
          .sort(byCalls(props.project.usage, live?.id))
          .map((name) =>
            pinRow(
              name,
              pinnedNames.has(name),
              pending.has(name),
              toolCalls(name, props.project.usage, live?.id),
              props,
            ),
          ),
    rest > 0
      ? h(
          'div',
          { style: { ...STYLE.listItem, ...STYLE.muted } },
          h('span', { style: STYLE.hint }, t('moreTools', { count: rest })),
        )
      : null,
    // The prefix is a fact of the registry, not a setting of this page: it is
    // stated once, under the names it explains, and is not a control.
    h(
      'div',
      { style: { ...STYLE.listItem, ...STYLE.lastRow } },
      h('span', { style: STYLE.hint }, t('prefixFact')),
    ),
    props.pinError === undefined
      ? null
      : h(
          'div',
          { style: STYLE.noteError },
          `${t('pinRefused')} ${resolveHost(props.hostT ?? hostTranslate(undefined), props.pinErrorCode, props.pinErrorParams, props.pinError)}`,
        ),
  )
}

/**
 * The request the policy would build, as far as the host publishes it: the names
 * this session offers, in request order, with the pinned ones marked.
 *
 * The names are real — the session's own `tools` plus the policy's pin list —
 * and the sizes are the contract's own (`visibleChars` / `deferredChars`), so
 * the token estimate is `Math.round(chars / 4)` and is printed only where a size
 * is known: a snapshot without `deferredChars` shows the hidden count and no
 * estimate at all, rather than an invented one. The mockup's `tools[] = 6` with
 * its five made-up lines and its invented savings went with the other
 * placeholders.
 *
 * It used to be the split's third column, where the widest line of the preview
 * was wider than the pane and collided with the form beside it.
 */
export function RequestPreview(props: {
  project: ProjectSnapshot
  policy: ToolPolicy
  t: Translate
}): ReactNode {
  const { t } = props
  const tools = firstSession(props.project)?.tools
  if (tools === undefined) {
    return h(
      'div',
      { style: STYLE.card },
      h('div', { style: STYLE.cardHead }, t('requestPreview')),
      h(
        'div',
        { style: { ...STYLE.listItem, ...STYLE.lastRow } },
        h('span', { style: STYLE.hint }, t('requestPreviewNoOffer')),
      ),
    )
  }
  const names = visibleToolNames(tools, props.policy)
  const pinned = new Set(props.policy.pins)
  const footer =
    tools.deferredChars === undefined
      ? t('requestPreviewHidden', { count: tools.deferred.length })
      : t('requestPreviewSaved', {
          count: tools.deferred.length,
          tokens: tokenEstimate(tools.deferredChars),
        })
  return h(
    'div',
    { style: STYLE.card },
    h(
      'div',
      { style: STYLE.cardHead },
      t('requestPreview'),
      h('span', { style: STYLE.tag }, t('requestPreviewTools', { count: names.length })),
      tools.visibleChars === undefined
        ? null
        : h(
            'span',
            { style: STYLE.tag },
            t('requestPreviewTokens', { tokens: tokenEstimate(tools.visibleChars) }),
          ),
    ),
    h(
      'pre',
      { style: STYLE.json },
      names.map((name) =>
        h('div', { key: name }, pinned.has(name) ? `${name}  ${t('pinTag')}` : name),
      ),
      h('div', { style: STYLE.muted }, footer),
    ),
  )
}
