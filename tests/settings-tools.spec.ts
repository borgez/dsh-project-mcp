/**
 * The `Tools` page of the settings section: the project table, the setting rows
 * and the request preview.
 *
 * The page used to be the entry editor's three-pane split — the list, the form
 * and the JSON preview side by side — with sentences inside the middle pane.
 * The panes are narrower than one of those words on a small panel, which is how
 * the copy rendered as one-word-wide slivers; the page is a vertical list of
 * setting rows now, so these checks are about that shape: every row keeps its
 * label and its description in the wide text column, the control column is
 * `flex: none`, and nothing on the page carries a fixed pixel width wider than
 * the panel's content column.
 *
 * The pins and the mode are the host's policy now, so the checks are about
 * provenance: which cell is the host's answer, which row counts the host's own
 * servers, which names the request preview lists, and that the mode switch
 * writes through the click instead of drafting. Nothing on the page is allowed
 * to invent a value — no `demo` badge, no slot figure, no prefix switch, no
 * mockup plan — so a check that finds one of those has found a regression.
 */

import { describe, expect, it } from 'vitest'
import type {
  ProjectSnapshot,
  ServerConflict,
  ServerRow,
  SessionSnapshot,
  SessionTools,
  ToolPolicy,
} from '../src/types.ts'
import { DEFAULT_TOOL_POLICY } from '../src/types.ts'
import { demoTools } from './helpers/tools.ts'
import {
  ConflictReport,
  DEFAULT_SETTINGS_PAGE,
  ProjectForm,
  RequestPreview,
  SETTINGS_PAGES,
  SettingsPageSwitch,
  TOOL_MODES,
  ToolList,
  ToolsPage,
  ToolsProjectTable,
  conflictKindLabel,
  liveSessions,
  modeLabel,
  offeredNames,
  projectPolicyRows,
  projectToolCounts,
  serverOfferLabel,
  serverToolCounts,
  tokenEstimate,
  visibleToolNames,
  firstSession,
} from '../src/client/settings-tools.ts'
import type { Translate } from '../src/client/view.ts'
import { STYLE } from '../src/client/settings.ts'
import { en } from '../src/client/locales/ui.ts'

/**
 * One namespace, one table: the plugin registers the settings page's keys and
 * the panel's together, so this is the exact dictionary the live seat holds.
 */
const DICTIONARY: Record<string, string> = en

const t: Translate = (key, params) => {
  const template = DICTIONARY[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  )
}

interface Element {
  type: unknown
  props: Record<string, unknown>
}

/** Every string a user would read under this node, in tree order. */
function texts(node: unknown): string[] {
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (Array.isArray(node)) return node.flatMap((child) => texts(child))
  const element = node as Element
  return texts(element.props.children)
}

/** Every element in the tree, the root included. */
function elements(node: unknown): Element[] {
  if (node === null || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap((child) => elements(child))
  const element = node as Element
  return [element, ...elements(element.props.children)]
}

/** The inline style of an element, empty when it carries none. */
function inlineStyle(element: Element | undefined): Record<string, unknown> {
  const style = element?.props.style
  return typeof style === 'object' && style !== null ? (style as Record<string, unknown>) : {}
}

/** Invoke the pure function components in a tree, so the walkers see the output. */
function resolve(node: unknown): unknown {
  if (Array.isArray(node)) return node.map((child) => resolve(child))
  if (node === null || typeof node !== 'object') return node
  const element = node as Element
  if (typeof element.type === 'function') {
    return resolve((element.type as (props: Record<string, unknown>) => unknown)(element.props))
  }
  return { type: element.type, props: { ...element.props, children: resolve(element.props.children) } }
}

/** The rendered cells of a table, header first. */
function tableRows(table: unknown): string[][] {
  const rows = elements(table).filter((element) => element.type === 'tr')
  return rows.map((row) => texts(row))
}

/**
 * The cells of a table row without the mode switch's buttons.
 *
 * The mode cell is interactive, so its text is read off the buttons themselves;
 * this walker is for the cells a user reads as plain values.
 * @param table - resolved table element.
 * @param index - row to read, header first.
 * @returns one string per `td`, in order.
 */
function simpleCells(table: unknown, index: number): string[] {
  const rows = elements(table).filter((element) => element.type === 'tr')
  const row = rows[index]
  if (row === undefined) throw new Error(`the fixture table has no row ${index}`)
  const buttons = new Set(elements(row).filter((element) => element.type === 'button'))
  const cells = elements(row).filter((element) => element.type === 'td')
  return cells.map((cell) => {
    const children = Array.isArray(cell.props.children) ? cell.props.children : [cell.props.children]
    return texts(children.filter((child) => !buttons.has(child as Element))).join('')
  })
}

/** One rendered row of a table, which every fixture here is big enough to have. */
function tableRow(rows: string[][], index: number): string[] {
  const row = rows[index]
  if (row === undefined) throw new Error(`the fixture table has no row ${index}`)
  return row
}

/**
 * The two columns of every setting row on the page, in tree order.
 *
 * A row is recognised by the shape its helper builds rather than by a marker
 * attribute: a block whose first child is the text column and whose second is
 * the control column. Deep styles are compared, so a copied row counts too.
 */
function settingRows(node: unknown): { text: Element; control: Element }[] {
  const same = (style: unknown, expected: unknown): boolean =>
    JSON.stringify(style ?? null) === JSON.stringify(expected)
  return elements(node).flatMap((element) => {
    const children = Array.isArray(element.props.children)
      ? element.props.children
      : [element.props.children]
    const [text, control] = children as (Element | undefined)[]
    if (typeof text?.props?.style === 'undefined') return []
    if (typeof control?.props?.style === 'undefined') return []
    if (!same(text.props.style, STYLE.settingRowText)) return []
    if (!same(control.props.style, STYLE.settingRowControl)) return []
    return [{ text, control }]
  })
}

/** Every fixed pixel width the styles of a tree carry, in tree order. */
function pixelWidths(node: unknown): number[] {
  const asPixels = (value: unknown): number | undefined => {
    if (typeof value === 'number') return value
    const match = /^([\d.]+)px$/u.exec(typeof value === 'string' ? value : '')
    return match?.[1] === undefined ? undefined : Number(match[1])
  }
  return elements(node).flatMap((element) => {
    const style = element.props.style as Record<string, unknown> | undefined
    if (style === undefined) return []
    return [style.width, style.minWidth, style.flexBasis]
      .map(asPixels)
      .filter((value): value is number => value !== undefined)
  })
}

/** The card whose head reads `head`, the block the request preview builds. */
function card(node: unknown, head: string): Element | undefined {
  return elements(node).find(
    (element) =>
      JSON.stringify(element.props.style ?? null) === JSON.stringify(STYLE.card) &&
      texts(element).includes(head),
  )
}

/**
 * The settings panel's content column at its widest, measured from the shell:
 * the panel is `min(800px, 100vw - 48px)` wide, its nav rail is `188px` and the
 * options column pads `24px` on each side, so the column a page may fill is
 * `min(800, 100vw - 48) - 188 - 2 * 24` — 564px at the widest window.
 */
const CONTENT_COLUMN = 564

function row(name: string): ServerRow {
  return { name, status: 'active', projectRoot: '/repo/project1' }
}

function session(id: string, mounted?: number): SessionSnapshot {
  return mounted === undefined
    ? { id, rows: [], issues: [] }
    : { id, rows: [], issues: [], tools: demoTools({ sessionId: id, mounted }) }
}

/** One session whose offer carries the serialized sizes the preview estimates from. */
function sizedSession(
  id: string,
  sizes: { visibleChars?: number; deferredChars?: number },
): SessionSnapshot {
  return {
    id,
    rows: [],
    issues: [],
    tools: demoTools({ sessionId: id, mounted: 47, ...sizes }),
  }
}

/** One project's policy as the host stores it. */
function policy(mode: ToolPolicy['mode'], pins: readonly string[] = []): ToolPolicy {
  return { mode, pins }
}

/** The host's own conflict report, one entry per kind it can publish. */
const PROFILE_CONFLICT: ServerConflict = {
  server: 'rider',
  kind: 'profile',
  sources: ['/home/dev/.dsh/mcp.json'],
  message: 'the profile instance owns the name, so the project entry never mounts',
}

/** The second kind: one name declared by two documents of the project. */
const DUPLICATE_CONFLICT: ServerConflict = {
  server: 'alpha',
  kind: 'duplicate',
  sources: ['/repo/project1/.dsh/mcp.json', '/repo/project1/.kimi-code/mcp.json'],
  message: 'the higher-priority document wins',
}

/** Both conflicts, as the host published them. */
const CONFLICTS: readonly ServerConflict[] = [PROFILE_CONFLICT, DUPLICATE_CONFLICT]

/** Three declared servers, a session that mounted 47 tools, and two conflicts. */
const PROJECT1: ProjectSnapshot = {
  projectRoot: '/repo/project1',
  policy: policy('disclosure', ['mcp__tglider__workspace', 'mcp__tglider__symbol']),
  sessionIds: ['session-aaa11111'],
  rows: [row('alpha'), row('beta'), row('gamma')],
  issues: [],
  sessions: [session('session-aaa11111', 47)],
  conflicts: CONFLICTS,
}

/** A live project whose session has not published an offer yet. */
const AURORA: ProjectSnapshot = {
  projectRoot: '/repo/aurora',
  policy: policy('direct'),
  sessionIds: ['session-zzz99999'],
  rows: [row('delta'), row('epsilon')],
  issues: [],
  sessions: [session('session-zzz99999')],
  conflicts: [],
}

/** A project the host published before it knew the policy: the shipped default. */
const LEGACY: ProjectSnapshot = {
  projectRoot: '/repo/legacy',
  sessionIds: ['session-aaa11111'],
  rows: [],
  issues: [],
  sessions: [session('session-aaa11111')],
}

/** A project whose session published the serialized sizes of its offer. */
const SIZED: ProjectSnapshot = {
  projectRoot: '/repo/sized',
  policy: policy('disclosure', ['mcp__tglider__workspace']),
  sessionIds: ['session-sized1'],
  rows: [row('alpha')],
  issues: [],
  sessions: [sizedSession('session-sized1', { visibleChars: 480, deferredChars: 1_200 })],
  conflicts: [],
}

/** The resolved `Tools` page of the first fixture project. */
function page(overrides: Record<string, unknown> = {}): unknown {
  return resolve(
    ToolsPage({
      project: PROJECT1,
      rows: projectPolicyRows([PROJECT1, AURORA]),
      onMode: () => undefined,
      pending: new Set<string>(),
      modeError: undefined,
      onSync: () => undefined,
      t,
      ...overrides,
    }),
  )
}

describe('the plugin page switch', () => {
  it('is one settings row with two pages, Servers first', () => {
    expect(SETTINGS_PAGES.map((tab) => tab.key)).toEqual(['servers', 'tools'])
    expect(DEFAULT_SETTINGS_PAGE).toBe('servers')
  })

  it('renders both pages and reports the one clicked', () => {
    const clicked: string[] = []
    const tree = resolve(
      SettingsPageSwitch({ page: 'tools', onChange: (page) => clicked.push(page), t }),
    )
    const buttons = elements(tree).filter((element) => element.type === 'button')

    expect(buttons.map((button) => texts(button).join(''))).toEqual(['Servers', 'Tools'])
    expect(buttons.map((button) => button.props['aria-pressed'])).toEqual([false, true])
    ;(buttons[0]?.props.onClick as (() => void) | undefined)?.()
    expect(clicked).toEqual(['servers'])
  })
})

describe('project counts', () => {
  it('measures servers and mounted tools from the host snapshot', () => {
    expect(projectToolCounts(PROJECT1)).toEqual({ servers: 3, tools: 47, disclosed: 2 })
  })

  it('leaves the tool count unknown when no session published an offer', () => {
    expect(projectToolCounts(AURORA)).toEqual({
      servers: 2,
      tools: undefined,
      disclosed: 0,
    })
  })

  it('reads the first live session and how many are attached', () => {
    expect(firstSession(PROJECT1)?.id).toBe('session-aaa11111')
    expect(firstSession({ ...AURORA, sessions: [] })).toBeUndefined()
    expect(liveSessions(PROJECT1)).toBe(1)
  })
})

describe('the project rows', () => {
  it('labels each row by its folder and keeps snapshot order', () => {
    const rows = projectPolicyRows([PROJECT1, AURORA])

    expect(rows.map((entry) => [entry.label, entry.projectRoot])).toEqual([
      ['project1', '/repo/project1'],
      ['aurora', '/repo/aurora'],
    ])
  })

  it('reads the host’s policy, and the shipped default where the host published none', () => {
    const rows = projectPolicyRows([PROJECT1, LEGACY])

    expect(rows[0]?.policy).toBe(PROJECT1.policy)
    expect(rows[1]?.policy).toBe(DEFAULT_TOOL_POLICY)
    expect(rows[1]?.policy.mode).toBe('disclosure')
    expect(rows[1]?.policy.pins).toEqual([])
  })

  it('carries no drafted plan at all: the policy row is the host’s own record', () => {
    const row = projectPolicyRows([PROJECT1])[0]

    expect(Object.keys(row ?? {}).sort()).toEqual(['counts', 'label', 'policy', 'projectRoot'])
  })

  it('names every mode value', () => {
    expect(TOOL_MODES).toEqual(['disclosure', 'direct', 'off'])
    expect(modeLabel('disclosure', t)).toBe('disclosure')
    expect(modeLabel('direct', t)).toBe('all direct')
    expect(modeLabel('off', t)).toBe('off')
  })
})

describe('the project table', () => {
  const requested: [string, string][] = []
  const table = resolve(
    ToolsProjectTable({
      rows: projectPolicyRows([PROJECT1, AURORA]),
      pending: new Set<string>(),
      onMode: (projectRoot, mode) => requested.push([projectRoot, mode]),
      t,
    }),
  )

  it('keeps its headers on one line and wraps a long project name inside its cell', () => {
    const headers = elements(table).filter((element) => element.type === 'th')

    // Every column is a host answer now, so no header carries a badge and none
    // of them is a chip that could end up alone on a wrapped line.
    expect(headers).toHaveLength(5)
    expect(headers.every((header) => inlineStyle(header).whiteSpace === 'nowrap')).toBe(true)
    expect(headers.some((header) => texts(header).includes(t('toolsDemo')))).toBe(false)

    // The project name is the only free-form text in the table, and it is the
    // one that can widen the whole table past the panel.
    const long = resolve(
      ToolsProjectTable({
        rows: projectPolicyRows([{ ...PROJECT1, projectRoot: `/repo/${'p'.repeat(120)}` }]),
        pending: new Set<string>(),
        onMode: () => undefined,
        t,
      }),
    )
    const name = elements(long).filter((element) => element.type === 'td')[0]

    expect(inlineStyle(name).overflowWrap).toBe('anywhere')
  })

  it('scrolls instead of running under the panel edge', () => {
    // Five columns do not fit every panel width; a scroll region is the one
    // shape that cannot collide with what is beside it.
    expect(inlineStyle(table as Element)).toBe(STYLE.tableScroll)
  })

  it('measures five host columns and patches none of them with a badge', () => {
    const header = tableRow(tableRows(table), 0)

    expect(header).toEqual([
      t('project'),
      t('servers'),
      t('toolsCount'),
      t('pinned'),
      t('mode'),
    ])
    // Neither the removed prefix and budget columns nor the badge that marked
    // them appear anywhere in the table.
    expect(header).not.toContain(t('prefix'))
    expect(header).not.toContain(t('budget'))
    expect(header).not.toContain(t('toolsDemo'))
  })

  it('fills the measured cells, the pinned count and the mode from the policy', () => {
    // The mode cell is the switch: its text is its three buttons, and the
    // pressed one is checked in the next test.
    expect(simpleCells(table, 1)).toEqual([
      'project1',
      '3',
      '47',
      '2',
      'disclosureall directoff',
    ])
    const aurora = simpleCells(table, 2)
    expect(aurora).toEqual(['aurora', '2', '—', '0', 'disclosureall directoff'])
  })

  it('marks the current mode of each row pressed, and writes the mode at the click', () => {
    const buttons = elements(table).filter((element) => element.type === 'button')

    // `disclosure` and `off` are pending on the first row, `direct` on the second.
    expect(buttons.map((button) => button.props['aria-pressed'])).toEqual([
      true, false, false,
      false, true, false,
    ])
    ;(buttons[1]?.props.onClick as () => void)()
    ;(buttons[5]?.props.onClick as () => void)()

    expect(requested).toEqual([
      ['/repo/project1', 'direct'],
      ['/repo/aurora', 'off'],
    ])
  })

  it('disables the switch of a project whose mode is being written', () => {
    const busy = resolve(
      ToolsProjectTable({
        rows: projectPolicyRows([PROJECT1, AURORA]),
        pending: new Set(['/repo/project1']),
        onMode: () => undefined,
        t,
      }),
    )
    const buttons = elements(busy).filter((element) => element.type === 'button')

    expect(buttons.slice(0, 3).map((button) => button.props.disabled)).toEqual([true, true, true])
    expect(buttons.slice(3).map((button) => button.props.disabled)).toEqual([false, false, false])
  })
})

/**
 * The server rows of the policy form (F-44).
 *
 * Each row names one server the session mounts; since F-44 it is also where that
 * whole server is pinned, so the row carries a switch over **every** name the
 * host published for that server — the offered ones the per-name switches below
 * drive, and the hidden ones a pin is what pulls into the request. The row's own
 * `1 of 3 tools offered directly` counts the same set.
 */
describe('the server rows of the policy form (F-44)', () => {
  const form = (overrides: Record<string, unknown> = {}): unknown =>
    resolve(
      ProjectForm({
        project: PROJECT1,
        policy: PROJECT1.policy as ToolPolicy,
        onMode: () => undefined,
        pending: false,
        onSync: () => undefined,
        t,
        ...overrides,
      }),
    )

  /** The per-server switches: the only ones whose label names a server. */
  const serverSwitches = (tree: unknown): { props: Record<string, unknown> }[] =>
    elements(tree).filter(
      (element) =>
        element.type === 'button' &&
        element.props['aria-checked'] !== undefined &&
        String(element.props['aria-label'] ?? '').includes(' — '),
    )

  it('gives each server one switch over every name the host published for it', () => {
    const switches = serverSwitches(form())

    // Three servers mount: `tglider` (three offered names and one hidden),
    // `grafana-local` and `memory` (a hidden name each). `PROJECT1` pins two of
    // `tglider`'s four, so that row is half-pinned and reads off; the other two
    // rows have nothing pinned at all. The two servers with no offered name are
    // still pinnable — a pin is exactly what pulls a hidden name in.
    expect(switches.map((entry) => [entry.props['aria-label'], entry.props['aria-checked']])).toEqual([
      [`grafana-local — ${t('serverPin')}`, false],
      [`memory — ${t('serverPin')}`, false],
      [`tglider — ${t('serverPin')}`, false],
    ])
  })

  it('completes the server on one press, and never drops a pin it already holds', () => {
    const calls: [string, string, boolean][] = []
    const tree = form({
      onPin: (root: string, tool: string, pinned: boolean) => calls.push([root, tool, pinned]),
    })

    // `grafana-local` and `memory` each hold one hidden name; `tglider` holds
    // the two names this project has not pinned yet, `symbol` already being
    // pinned by hand.
    ;(serverSwitches(tree)[0]?.props.onClick as () => void)()
    expect(calls).toEqual([['/repo/project1', 'mcp__grafana-local__query_prometheus', true]])

    calls.length = 0
    ;(serverSwitches(tree)[2]?.props.onClick as () => void)()
    expect(calls).toEqual([
      ['/repo/project1', 'mcp__tglider__find_references', true],
      ['/repo/project1', 'mcp__tglider__get_cascade_impact', true],
    ])
  })

  it('releases the whole server when every one of its names is pinned', () => {
    // The order the switch writes in is the row's own: the offered names as the
    // session lists them, then the hidden one.
    const all = [
      'mcp__tglider__workspace',
      'mcp__tglider__find_references',
      'mcp__tglider__get_cascade_impact',
      'mcp__tglider__symbol',
    ]
    const calls: [string, string, boolean][] = []
    const tree = form({
      policy: policy('disclosure', all),
      onPin: (root: string, tool: string, pinned: boolean) => calls.push([root, tool, pinned]),
    })
    const press = serverSwitches(tree)[2]

    expect(press?.props['aria-label']).toBe(`tglider — ${t('serverUnpin')}`)
    expect(press?.props['aria-checked']).toBe(true)
    ;(press?.props.onClick as () => void)()
    expect(calls).toEqual(all.map((name) => ['/repo/project1', name, false]))
  })

  it('draws every server switch inert while there is nobody to write a pin to', () => {
    expect(serverSwitches(form()).map((entry) => entry.props.disabled)).toEqual([true, true, true])
  })
})

describe('the tool list block', () => {
  /** Every pin switch in a tree, in row order. */
  const switchesOf = (tree: unknown): { props: Record<string, unknown> }[] =>
    elements(tree).filter(
      (element) => element.type === 'button' && element.props['aria-checked'] !== undefined,
    )

  const list = (overrides: Record<string, unknown> = {}): unknown =>
    resolve(ToolList({ project: PROJECT1, policy: PROJECT1.policy as ToolPolicy, t, ...overrides }))

  it('lists every name the host offers, and counts the ones it does not', () => {
    const tree = list()
    const rendered = texts(tree)

    expect(rendered).toContain('Tools · 47')
    // The session's own offer: the baseline name plus the two it activated.
    expect(rendered).toContain('mcp__tglider__workspace')
    expect(rendered).toContain('mcp__tglider__find_references')
    expect(rendered).toContain('mcp__tglider__get_cascade_impact')
    // Three offered names against 47 mounted: 44 left over.
    expect(rendered).toContain(t('moreTools', { count: 44 }))
    // It is a card between two blocks, so its last row carries no rule of its
    // own: the card's own bottom edge closes it.
    const last = elements(tree).filter((element) => inlineStyle(element).borderBottom === 'none')
    expect(last).toHaveLength(1)
  })

  it('lists each offered name once, however many tiers offered it', () => {
    const twice = demoTools({
      baseline: ['mcp__tglider__workspace'],
      activated: [{ name: 'mcp__tglider__workspace', via: 'session' }],
    })

    // A pinned or hot name can be activated too; the list and the per-server
    // counts must see it once, or one tool is counted and printed twice.
    expect(offeredNames(twice)).toEqual(['mcp__tglider__workspace'])
    expect(offeredNames(undefined)).toEqual([])
  })

  it('gives every offered name a switch that mirrors the project’s pins', () => {
    const switches = switchesOf(list({ onPin: () => undefined }))

    expect(switches.map((entry) => [entry.props['aria-label'], entry.props['aria-checked']])).toEqual([
      ['mcp__tglider__workspace', true],
      ['mcp__tglider__find_references', false],
      ['mcp__tglider__get_cascade_impact', false],
    ])
  })

  it('reports the project, the name and the wanted direction when a switch is pressed', () => {
    const calls: [string, string, boolean][] = []
    const tree = list({ policy: policy('disclosure'), onPin: (root: string, tool: string, pinned: boolean) => calls.push([root, tool, pinned]) })
    const first = switchesOf(tree)[0]

    ;(first?.props.onClick as () => void)()
    expect(calls).toEqual([['/repo/project1', 'mcp__tglider__workspace', true]])
  })

  it('unpins a name the project already pins', () => {
    const calls: [string, string, boolean][] = []
    const pins = (PROJECT1.policy as ToolPolicy).pins
    const tree = list({ onPin: (root: string, tool: string, pinned: boolean) => calls.push([root, tool, pinned]) })

    expect(pins).toContain('mcp__tglider__workspace')
    ;(switchesOf(tree)[0]?.props.onClick as () => void)()
    expect(calls).toEqual([['/repo/project1', 'mcp__tglider__workspace', false]])
  })

  it('leaves a switch inert while its own write is in flight, and without a writer', () => {
    const busy = list({ onPin: () => undefined, pinPending: new Set(['mcp__tglider__find_references']) })

    expect(switchesOf(busy).map((entry) => entry.props.disabled)).toEqual([false, true, false])
    // No writer at all (a composition without the settings half): the switch
    // still shows the state, and cannot be pressed.
    expect(switchesOf(list()).map((entry) => entry.props.disabled)).toEqual([true, true, true])
  })

  it('keeps a pin whose tool is hidden out of the list', () => {
    const rendered = texts(list({ onPin: () => undefined }))

    // `symbol` is pinned by the project and deferred by this session: the pin
    // list above still names it, while the picker only offers what is offered.
    expect((PROJECT1.policy as ToolPolicy).pins).toContain('mcp__tglider__symbol')
    expect(rendered).not.toContain('mcp__tglider__symbol')
  })

  it('shows the host’s refusal next to the list instead of reverting the switch', () => {
    const rendered = texts(list({ onPin: () => undefined, pinError: 'unknown tool' })).join(' ')

    // One line, the host's own words: the switch is not reverted behind the
    // user's back, the refusal is shown.
    expect(rendered).toContain(t('pinRefused'))
    expect(rendered).toContain('unknown tool')
  })

  it('states the registry prefix as a fixed fact under the names it explains', () => {
    const tree = list()
    const rendered = texts(tree)

    expect(rendered).toContain(t('prefixFact'))
    expect(rendered).not.toContain(t('toolsDemo'))
    // The only controls are the pin switches: the prefix itself is not one.
    expect(elements(tree).filter((element) => element.type === 'button')).toHaveLength(3)
  })

  it('shows no "more" row and no fake total when the host published nothing', () => {
    const rendered = texts(resolve(ToolList({ project: AURORA, policy: AURORA.policy as ToolPolicy, t })))

    expect(rendered).toContain('Tools · —')
    expect(rendered).toContain(t('requestPreviewNoOffer'))
    expect(rendered.some((line) => line.startsWith('…'))).toBe(false)
  })
})

describe('the request preview', () => {
  const preview = (project: ProjectSnapshot, override: Partial<ToolPolicy> = {}): unknown =>
    resolve(RequestPreview({ project, policy: { ...(project.policy as ToolPolicy), ...override }, t }))

  it('lists the names the session really offers, the pins first and each name once', () => {
    const lines = texts(elements(preview(PROJECT1)).find((element) => element.type === 'pre'))

    expect(lines).toEqual([
      `mcp__tglider__workspace  ${t('pinTag')}`,
      `mcp__tglider__symbol  ${t('pinTag')}`,
      'mcp__tglider__find_references',
      'mcp__tglider__get_cascade_impact',
      // No size was published with this session, so the footer counts only.
      t('requestPreviewHidden', { count: 3 }),
    ])
    expect(texts(preview(PROJECT1))).toContain(t('requestPreviewTools', { count: 4 }))
  })

  it('orders the visible names pins-first and drops a name that is offered twice', () => {
    const tools = demoTools({ baseline: ['mcp__tglider__symbol'] })
    const names = visibleToolNames(
      tools,
      policy('disclosure', ['mcp__tglider__symbol', 'mcp__beta__one']),
    )

    expect(names).toEqual([
      'mcp__tglider__symbol',
      'mcp__beta__one',
      'mcp__tglider__find_references',
      'mcp__tglider__get_cascade_impact',
    ])
  })

  it('estimates tokens from the host’s own characters, by the contract’s `chars / 4`', () => {
    const rendered = texts(preview(SIZED))

    expect(rendered).toContain(t('requestPreviewTokens', { tokens: tokenEstimate(480) }))
    expect(rendered).toContain(
      t('requestPreviewSaved', { count: 3, tokens: tokenEstimate(1_200) }),
    )
    expect(tokenEstimate(480)).toBe(120)
    expect(tokenEstimate(1_200)).toBe(300)
    expect(tokenEstimate(0)).toBe(0)
    expect(tokenEstimate(2)).toBe(1)
  })

  it('prints the hidden count and no estimate at all when the host sent no size', () => {
    const rendered = texts(preview(PROJECT1)).join(' | ')

    expect(rendered).toContain(t('requestPreviewHidden', { count: 3 }))
    // No `visibleChars` either: an estimate invented from a size nobody
    // measured is exactly what the contract forbids.
    expect(rendered).not.toContain('≈')
  })

  it('says there is no offer rather than previewing one nobody published', () => {
    const tree = preview(AURORA)

    expect(texts(tree)).toContain(t('requestPreviewNoOffer'))
    expect(elements(tree).some((element) => element.type === 'pre')).toBe(false)
  })

  it('renders none of the mockup’s invented lines', () => {
    const rendered = texts(preview(PROJECT1)).join(' | ')

    expect(rendered).not.toContain('tools[] = 6')
    expect(rendered).not.toContain('hidden 44')
    expect(rendered).not.toContain('mcp__grafana-local__query_prometheus')
    expect(rendered).not.toContain('bash read write glob grep')
  })
})

describe('per-server counters', () => {
  const toolsOf = (project: ProjectSnapshot): SessionTools =>
    firstSession(project)?.tools ?? demoTools()

  it('counts each server’s tools by the registry’s `mcp__<server>__` prefix', () => {
    expect(serverToolCounts(toolsOf(PROJECT1))).toEqual([
      { server: 'grafana-local', offered: 0, hidden: 1, total: 1 },
      { server: 'memory', offered: 0, hidden: 1, total: 1 },
      { server: 'tglider', offered: 3, hidden: 1, total: 4 },
    ])
  })

  it('files a name without the prefix under no server rather than a made-up one', () => {
    const tools = demoTools({
      baseline: ['bash'],
      activated: [],
      context: [],
      deferred: ['read'],
    })

    expect(serverToolCounts(tools)).toEqual([])
  })

  it('counts an offered name on the `activated` and `context` tiers too', () => {
    const tools = demoTools({
      baseline: [],
      activated: [{ name: 'mcp__alpha__one', via: 'session', at: 1 }],
      context: [{ name: 'mcp__alpha__two', via: 'context' }],
      deferred: ['mcp__alpha__three'],
    })

    expect(serverToolCounts(tools)).toEqual([
      { server: 'alpha', offered: 2, hidden: 1, total: 3 },
    ])
  })

  it('says "all of them" only when nothing of that server is held back', () => {
    expect(serverOfferLabel({ server: 'rider', offered: 3, hidden: 0, total: 3 }, t)).toBe(
      t('serverAllOffered', { count: 3 }),
    )
    expect(serverOfferLabel({ server: 'rider', offered: 1, hidden: 2, total: 3 }, t)).toBe(
      t('serverPartlyOffered', { offered: 1, total: 3 }),
    )
    // A server whose every tool is held back is not "all offered" either.
    expect(serverOfferLabel({ server: 'rider', offered: 0, hidden: 2, total: 2 }, t)).toBe(
      t('serverPartlyOffered', { offered: 0, total: 2 }),
    )
  })

  it('draws one row per real server, with its real count and no placeholder name', () => {
    const rows = settingRows(page()).map(({ text, control }) => ({
      label: texts(text)[0],
      description: texts(text)[1],
      control: texts(control).join(''),
    }))
    const serverRows = rows.filter((row) => row.label === t('server'))

    expect(serverRows).toEqual([
      {
        label: t('server'),
        description: t('serverPartlyOffered', { offered: 0, total: 1 }),
        control: 'grafana-local',
      },
      {
        label: t('server'),
        description: t('serverPartlyOffered', { offered: 0, total: 1 }),
        control: 'memory',
      },
      {
        label: t('server'),
        description: t('serverPartlyOffered', { offered: 3, total: 4 }),
        control: 'tglider',
      },
    ])
    const rendered = texts(page()).join(' | ')
    expect(rendered).not.toContain('example-service')
    expect(rendered).not.toContain(t('toolsDemo'))
  })
})

describe('ToolsPage', () => {
  it('draws the overview table above the form', () => {
    const rows = tableRows(page())

    expect(tableRow(rows, 0)[0]).toBe(t('project'))
    expect(rows).toHaveLength(3)
  })

  it('reports the host’s conflicts under an enabled button that re-reads the snapshot', () => {
    const tree = page()
    const button = elements(tree).find(
      (element) => element.type === 'button' && texts(element).join('') === t('checkConflicts'),
    )

    // Never disabled: the report is the host's, and the button asks for a fresh
    // snapshot rather than standing in for one that does not exist.
    expect(button?.props.disabled).toBeUndefined()
    expect(button?.props.title).toBe(t('checkConflictsHint'))
    const synced: string[] = []
    const clicked = elements(page({ onSync: () => synced.push('sync') })).find(
      (element) => element.type === 'button' && texts(element).join('') === t('checkConflicts'),
    )
    ;(clicked?.props.onClick as () => void)()
    expect(synced).toEqual(['sync'])

    const rendered = texts(tree)
    expect(rendered).toContain(PROFILE_CONFLICT.server)
    expect(rendered).toContain(t('conflictProfile'))
    expect(rendered).toContain(PROFILE_CONFLICT.message)
    expect(rendered).toContain(
      t('conflictSources', { sources: PROFILE_CONFLICT.sources.join(' · ') }),
    )
    expect(rendered).toContain(DUPLICATE_CONFLICT.server)
    expect(rendered).toContain(t('conflictDuplicate'))
    expect(rendered).toContain(DUPLICATE_CONFLICT.message)
    expect(rendered).not.toContain(t('toolsDemo'))
  })

  it('draws the empty state when the host reports no conflict', () => {
    const rendered = texts(page({ project: { ...PROJECT1, conflicts: [] } }))

    expect(rendered).toContain(t('conflictsNone'))
    expect(rendered).not.toContain(t('conflictProfile'))
  })

  it('reads a snapshot without the field as a project with no conflict', () => {
    // A host that never counted conflicts publishes no field at all; the page
    // says so instead of hiding the row.
    expect(texts(page({ project: LEGACY }))).toContain(t('conflictsNone'))
  })

  it('labels both kinds of conflict, and draws an empty report as the empty state', () => {
    expect(conflictKindLabel('profile', t)).toBe(t('conflictProfile'))
    expect(conflictKindLabel('duplicate', t)).toBe(t('conflictDuplicate'))
    expect(texts(ConflictReport({ projectRoot: '/repo', conflicts: [], t }))).toEqual([
      t('conflictsNone'),
    ])
  })

  it('offers every declaration of a profile conflict, and posts the chosen one', () => {
    const chosen: [string, string, string][] = []
    const conflict = {
      server: 'grafana-local',
      kind: 'profile' as const,
      sources: ['/repo/.dsh/mcp.json'],
      message: 'owned by a profile-level instance',
      alias: 'p-grafana-local',
      choice: 'profile' as const,
    }
    const tree = ConflictReport({
      projectRoot: '/repo',
      conflicts: [conflict],
      onChoice: (projectRoot, server, choice) => chosen.push([projectRoot, server, choice]),
      t,
    })
    const buttons = elements(tree).filter((element) => element.type === 'button')
    const labels = buttons.map((button) => texts(button).join(''))

    // The host's own order, and the stored answer is the one that reads pressed:
    // a click writes through, so the page shows the host's value and not a draft.
    expect(labels).toEqual([
      t('conflictProfile'),
      t('choiceLocal', { alias: 'p-grafana-local' }),
      t('choiceNative'),
    ])
    expect(buttons.map((button) => button.props['aria-pressed'])).toEqual([true, false, false])
    expect(texts(tree).join(' | ')).toContain(t('choiceLocal', { alias: 'p-grafana-local' }))
    expect(texts(tree).join(' | ')).toContain(t('choiceNative'))
    ;(buttons[1]?.props.onClick as () => void)()
    ;(buttons[2]?.props.onClick as () => void)()
    ;(buttons[0]?.props.onClick as () => void)()
    expect(chosen).toEqual([
      ['/repo', 'grafana-local', 'local'],
      ['/repo', 'grafana-local', 'native'],
      ['/repo', 'grafana-local', 'profile'],
    ])
  })

  it('offers no local declaration without a local name, and still offers the other two', () => {
    const chosen: [string, string, string][] = []
    const conflict = {
      server: 'grafana-local',
      kind: 'profile' as const,
      sources: ['/repo/.dsh/mcp.json'],
      message: 'owned by a profile-level instance',
      // No alias: the host published no local name, so there is nothing for a
      // `local` answer to mount under and the button cannot say anything true.
    }
    const tree = ConflictReport({
      projectRoot: '/repo',
      conflicts: [conflict],
      onChoice: (projectRoot, server, choice) => chosen.push([projectRoot, server, choice]),
      t,
    })
    const buttons = elements(tree).filter((element) => element.type === 'button')

    expect(buttons.map((button) => texts(button).join(''))).toEqual([
      t('conflictProfile'),
      t('choiceNative'),
    ])
    // Neither the local label nor its hint can be drawn: both interpolate the
    // alias the host did not publish.
    expect(texts(tree).join(' | ')).not.toContain(t('choiceLocal', { alias: 'p-grafana-local' }))
    expect(texts(tree).join(' | ')).not.toContain(t('choiceLocalHint', { alias: 'p-grafana-local' }))
    ;(buttons[1]?.props.onClick as () => void)()
    expect(chosen).toEqual([['/repo', 'grafana-local', 'native']])
  })

  it('draws no choice for a duplicate declaration, and none without a writer', () => {
    const duplicate = {
      server: 'alpha',
      kind: 'duplicate' as const,
      sources: ['/repo/.dsh/mcp.json', '/repo/.kimi-code/mcp.json'],
      message: 'two documents declare it',
    }
    const withWriter = ConflictReport({
      projectRoot: '/repo',
      conflicts: [duplicate],
      onChoice: () => undefined,
      t,
    })
    const withoutWriter = ConflictReport({
      projectRoot: '/repo',
      conflicts: [{ ...duplicate, kind: 'profile' as const, alias: 'p-alpha', choice: 'profile' as const }],
      t,
    })

    expect(elements(withWriter).filter((element) => element.type === 'button')).toHaveLength(0)
    expect(elements(withoutWriter).filter((element) => element.type === 'button')).toHaveLength(0)
  })

  it('writes the mode through the click, with no slot, prefix or policy draft at all', () => {
    const modes: [string, string][] = []
    const tree = page({
      onMode: (projectRoot: string, mode: string) => modes.push([projectRoot, mode]),
    })
    const buttons = elements(tree).filter((element) => element.type === 'button')
    const direct = buttons.filter((button) => texts(button).join('') === modeLabel('direct', t))

    // One switch per row plus the selected project's own: the table's first row
    // and the form's are two seats of the same write for `/repo/project1`.
    expect(direct).toHaveLength(3)
    for (const button of [direct[0], direct[2]]) (button?.props.onClick as () => void)()

    expect(modes).toEqual([
      ['/repo/project1', 'direct'],
      ['/repo/project1', 'direct'],
    ])
    // The three rows the mockup drafted are gone: no slots input, no read-only
    // policy, no prefix switch. The page carries no draft state to edit.
    expect(elements(tree).some((element) => element.type === 'input')).toBe(false)
    const rendered = texts(tree).join(' | ')
    expect(rendered).not.toContain(t('policyHint'))
    expect(rendered).not.toContain(t('prefixPlugin'))
    expect(rendered).not.toContain('12 slots')
  })

  it('shows the host’s pin list, not the mockup’s', () => {
    // The pinned field is the one whose hint is `pinList`; the names it shows are
    // the host's own policy list, in the order the host published it.
    const rendered = texts(page())
    const hint = rendered.indexOf(t('pinList'))
    const pinField = rendered.slice(Math.max(0, hint - 4), hint + 1)

    expect(pinField).toContain('mcp__tglider__workspace')
    expect(pinField).toContain('mcp__tglider__symbol')
    // The mockup's own names for that field appear nowhere on the page.
    expect(rendered).not.toContain('mcp__grafana-local__query_loki_logs')
  })

  it('says which project has no offer rather than showing a tool count', () => {
    const rendered = texts(page({ project: AURORA })).join(' | ')

    // A dash where the host published nothing, and no badge claiming otherwise.
    expect(rendered).toContain('Tools · —')
    // The live-session footer is gone with the rest of the page's prose: the
    // dash is the page's whole answer for "no offer", and the session id is no
    // longer printed anywhere a reader has to parse it out of a sentence.
    expect(rendered).not.toContain('live session(s)')
    expect(rendered).not.toContain(t('toolsDemo'))
  })

  it('reports a refused mode write under the form', () => {
    const rendered = texts(page({ modeError: 'unknown project /repo/project1' })).join(' | ')

    expect(rendered).toContain(`${t('modeRefused')} unknown project /repo/project1`)
  })

  it('keeps the form’s own copy in the locale table, and only the real rows’ copy', () => {
    const tree = page()
    const rendered = texts(tree).join(' | ')
    // The two longest explanations are tooltips on the rows they explain, not
    // paragraphs: the page's visible copy is labels and one-line descriptions.
    const titles = elements(tree)
      .map((element) => element.props.title)
      .filter((title) => typeof title === 'string')

    expect(titles).toContain(t('policyNote'))
    expect(titles).toContain(t('checkConflictsHint'))
    expect(rendered).not.toContain(t('policyNote'))
    expect(rendered).not.toContain(t('checkConflictsHint'))
    expect(rendered).toContain(t('modeHint'))
    expect(rendered).toContain(t('pinList'))
    expect(rendered).toContain(t('requestPreview'))
    expect(rendered).toContain(t('prefixFact'))
    expect(rendered).toContain(t('serverPartlyOffered', { offered: 3, total: 4 }))
    // The copy of the rows the mockup drafted is gone with them.
    expect(rendered).not.toContain(t('slotsHint'))
    expect(rendered).not.toContain(t('policyHint'))
    expect(rendered).not.toContain(t('checkConflictsHint') + ' ' + t('toolsDemo'))
    // The dictionary itself no longer carries the removed keys at all.
    const dictionary: Record<string, string> = en
    for (const key of ['slots', 'slotsHint', 'policy', 'policyHint', 'prefix', 'budget', 'budgetSlots']) {
      expect(dictionary[key]).toBeUndefined()
    }
  })
})

describe('the shape of the page', () => {
  const styleOf = (node: unknown): string[] =>
    elements(node).map((element) => JSON.stringify(element.props.style ?? null))

  it('is rows of settings, not the entry editor’s split panes', () => {
    const styles = styleOf(page())

    // The split is the entry editor's own surface. Reusing it on a policy form
    // put every sentence in a pane narrower than one of its words, which is how
    // the copy rendered as one-word-wide slivers.
    expect(styles).not.toContain(JSON.stringify(STYLE.split))
    expect(styles).not.toContain(JSON.stringify(STYLE.paneList))
    expect(styles).not.toContain(JSON.stringify(STYLE.paneForm))
    expect(styles).not.toContain(JSON.stringify(STYLE.paneJson))
    // The page is built from the setting rows instead.
    expect(styles).toContain(JSON.stringify(STYLE.settingRow))
    expect(styles).toContain(JSON.stringify(STYLE.settingRowText))
    expect(styles).toContain(JSON.stringify(STYLE.settingRowControl))
  })

  it('carries one row per setting, with its label and its copy in the text column', () => {
    const rows = settingRows(page())

    expect(rows.map(({ text }) => texts(text)[0])).toEqual([
      t('mode'),
      t('server'),
      t('server'),
      t('server'),
      t('checkConflicts'),
    ])
    expect(rows.map(({ text }) => texts(text)[1])).toEqual([
      t('modeHint'),
      t('serverPartlyOffered', { offered: 0, total: 1 }),
      t('serverPartlyOffered', { offered: 0, total: 1 }),
      t('serverPartlyOffered', { offered: 3, total: 4 }),
      // The conflicts row's description is the pin list's one-liner; the long
      // explanation of the check moved to the row's tooltip.
      t('pinList'),
    ])
    // The copy never leaks into the narrow column: a sentence there is exactly
    // the sliver the old layout drew.
    for (const { text, control } of rows) {
      expect(texts(control).join(' ')).not.toContain(texts(text)[1] ?? '')
    }
  })

  it('never lets the control column be the one that wraps', () => {
    const rows = settingRows(page())

    expect(rows).toHaveLength(5)
    for (const { text, control } of rows) {
      // The text column takes the leftover width and may shrink below its own
      // content; the control measures to its content and never wraps.
      expect(inlineStyle(text).flex).toBe(1)
      expect(inlineStyle(text).minWidth).toBe(0)
      expect(inlineStyle(control).flex).toBe('none')
    }
  })

  it('puts no demo badge on any row, list or card of the page', () => {
    const tree = page()

    // Every row is the host's answer now, so the badge has no row to sit on —
    // and it may not migrate into a control column either.
    expect(texts(tree)).not.toContain(t('toolsDemo'))
    expect(settingRows(tree).every(({ control }) => !texts(control).includes(t('toolsDemo')))).toBe(
      true,
    )
  })

  it('groups the pinned list and the conflict report under one heading', () => {
    const tree = page()
    const group = elements(tree).find(
      (element) =>
        JSON.stringify(element.props.style ?? null) === JSON.stringify(STYLE.settingGroup),
    )

    expect(group).toBeDefined()
    const head = elements(group as Element).find(
      (element) =>
        JSON.stringify(element.props.style ?? null) === JSON.stringify(STYLE.settingGroupHead),
    )
    expect(texts(head as Element)).toEqual([t('pinned')])
    // The group holds the host's pin names, the note that says so, the real
    // conflict check and the report it reads.
    const inside = texts(group as Element)
    expect(inside).toContain('mcp__tglider__workspace')
    expect(inside).toContain('mcp__tglider__symbol')
    expect(inside).toContain(t('pinList'))
    expect(inside).toContain(PROFILE_CONFLICT.server)
    expect(inside).toContain(DUPLICATE_CONFLICT.message)
    expect(
      elements(group as Element).some(
        (element) => element.type === 'button' && texts(element).join('') === t('checkConflicts'),
      ),
    ).toBe(true)
  })

  it('puts the request preview in a card below the rows, not beside them', () => {
    const tree = page()
    const list = elements(tree)
    const preview = card(tree, t('requestPreview'))

    expect(preview).toBeDefined()
    expect(elements(preview as Element).some((element) => element.type === 'pre')).toBe(true)
    const lastRow = Math.max(
      ...list.map((element, index) =>
        JSON.stringify(element.props.style ?? null) === JSON.stringify(STYLE.settingRowControl)
          ? index
          : -1,
      ),
    )
    expect(list.indexOf(preview as Element)).toBeGreaterThan(lastRow)
  })

  it('gives no element a fixed pixel width wider than the panel', () => {
    // Anything wider than `CONTENT_COLUMN` cannot fit, whatever the flex
    // tuning around it does; the widest thing the rows put in the narrow column
    // is measured in the report rather than asserted here, because it is text.
    expect(pixelWidths(page()).filter((width) => width > CONTENT_COLUMN)).toEqual([])
  })
})

describe('the pin picker reads the host’s counters (F-32)', () => {
  /** The same project, with counters that rank a disclosed name above the pinned one. */
  const counted: ProjectSnapshot = {
    ...PROJECT1,
    usage: {
      tglider: { calls: 200, errors: 0, tools: { get_cascade_impact: 90, workspace: 5 } },
    },
  }

  /** The picker's rows, as the strings a user reads, in the order they appear. */
  const rowsOf = (project: ProjectSnapshot): string[] =>
    texts(resolve(ToolList({ project, policy: project.policy as ToolPolicy, t })))

  it('orders rows by frequency and prints each name’s figure', () => {
    const rows = rowsOf(counted)
    expect(rows).toContain('90 calls')
    expect(rows).toContain('5 calls')
    // The server is recorded and this name is not in its counters.
    expect(rows).toContain('never called')
    expect(rows.indexOf('mcp__tglider__get_cascade_impact')).toBeLessThan(
      rows.indexOf('mcp__tglider__workspace'),
    )
    expect(rows.indexOf('mcp__tglider__workspace')).toBeLessThan(
      rows.indexOf('mcp__tglider__find_references'),
    )
  })

  it('leads with the session’s own reading and sorts by it', () => {
    // `get_cascade_impact` is this session's hot name while the project's total
    // belongs to `workspace`: the picker is read at one session, so the session's
    // figure leads and decides the order (F-34).
    const split: ProjectSnapshot = {
      ...PROJECT1,
      usage: {
        tglider: {
          calls: 200,
          errors: 0,
          tools: { workspace: 182, get_cascade_impact: 95 },
          sessions: {
            'session-aaa11111': { calls: 92, errors: 0, tools: { get_cascade_impact: 90 } },
          },
        },
      },
    }
    const rows = rowsOf(split)
    expect(rows).toContain('90 calls · 95 in the project')
    expect(rows).toContain('never called · 182 in the project')
    expect(rows.indexOf('mcp__tglider__get_cascade_impact')).toBeLessThan(
      rows.indexOf('mcp__tglider__workspace'),
    )
  })

  it('prints no figure at all for a project the host never counted', () => {
    const rendered = rowsOf(PROJECT1).join(' | ')
    expect(rendered).not.toContain('never called')
    expect(rendered).not.toContain(' calls')
  })
})

/**
 * The conflict card's wire codes (F-48, Task 4): the card resolves a coded
 * `ServerConflict.message` through the host seat, and an uncoded conflict —
 * or a code the seat does not know — renders the payload's English prose
 * exactly as before.
 */
describe('the conflict card wire codes (F-48, Task 4)', () => {
  /** A host seat that knows one conflict code in another language; the rest echo. */
  const hostT: Translate = (key, params) => {
    if (key !== 'conflict.profileAlias') return key
    const template =
      '"{name}" принадлежит экземпляру mcp-client уровня профиля; копия проекта монтируется как "{alias}"'
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
      name in params ? String(params[name]) : whole,
    )
  }

  const MESSAGE =
    '"alpha" is owned by a profile-level mcp-client instance; this project\'s copy mounts as "p-alpha" when chosen beside it, or under the contested name when chosen to shadow it in this project\'s sessions, and does not mount at all while the profile\'s copy is the one shown.'
  const conflict = (extra: Partial<ServerConflict> = {}): ServerConflict => ({
    server: 'alpha',
    kind: 'profile',
    sources: ['/repo/.dsh/mcp.json'],
    message: MESSAGE,
    alias: 'p-alpha',
    choice: 'profile',
    ...extra,
  })

  it('renders a coded conflict through the host seat, params substituted', () => {
    const tree = ConflictReport({
      projectRoot: '/repo',
      conflicts: [conflict({ code: 'conflict.profileAlias', params: { name: 'alpha', alias: 'p-alpha' } })],
      t,
      hostT,
    })
    expect(texts(tree).join(' | ')).toContain(
      '"alpha" принадлежит экземпляру mcp-client уровня профиля; копия проекта монтируется как "p-alpha"',
    )
  })

  it('renders the payload prose for an uncoded conflict and for a code the seat does not know', () => {
    const uncoded = texts(ConflictReport({ projectRoot: '/repo', conflicts: [conflict()], t, hostT })).join(' | ')
    expect(uncoded).toContain(MESSAGE)

    const unknown = texts(
      ConflictReport({
        projectRoot: '/repo',
        conflicts: [conflict({ code: 'conflict.future', params: {} })],
        t,
        hostT,
      }),
    ).join(' | ')
    expect(unknown).toContain(MESSAGE)
    expect(unknown).not.toContain('conflict.future')
  })
})

/**
 * The refusal wire codes (F-48, Task 5): the three refusal renders of the
 * Tools page — the mode write, the pin list and the conflict choice — resolve
 * the refusal's `messageCode`/`messageParams` through the host seat; a refusal
 * without companions renders the prose exactly as before.
 */
describe('the policy refusal wire codes (F-48, Task 5)', () => {
  /** A host seat that knows one refusal code in another language; the rest echo. */
  const hostT: Translate = (key, params) => {
    if (key !== 'save.noLiveSession') return key
    const template = 'нет активной сессии в {projectRoot}'
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
      name in params ? String(params[name]) : whole,
    )
  }

  const MESSAGE = 'no live session in /repo'
  const TRANSLATED = 'нет активной сессии в /repo'

  it('resolves a coded mode refusal under the form; an uncoded one renders its prose', () => {
    const coded = { modeErrorCode: 'save.noLiveSession', modeErrorParams: { projectRoot: '/repo' } }
    const translated = texts(page({ modeError: MESSAGE, ...coded, hostT })).join(' | ')
    expect(translated).toContain(`${t('modeRefused')} ${TRANSLATED}`)

    const plain = texts(page({ modeError: MESSAGE, hostT })).join(' | ')
    expect(plain).toContain(`${t('modeRefused')} ${MESSAGE}`)
  })

  it('resolves a coded pin refusal next to the list; an uncoded one renders its prose', () => {
    const tree = (overrides: Record<string, unknown>): unknown =>
      resolve(ToolList({ project: PROJECT1, policy: PROJECT1.policy as ToolPolicy, t, ...overrides }))
    const coded = { pinErrorCode: 'save.noLiveSession', pinErrorParams: { projectRoot: '/repo' } }

    const translated = texts(tree({ pinError: MESSAGE, ...coded, hostT })).join(' ')
    expect(translated).toContain(`${t('pinRefused')} ${TRANSLATED}`)

    const plain = texts(tree({ pinError: MESSAGE, hostT })).join(' ')
    expect(plain).toContain(`${t('pinRefused')} ${MESSAGE}`)
  })

  it('resolves a coded choice refusal under the report; an uncoded one renders its prose', () => {
    const report = (overrides: Record<string, unknown>): unknown =>
      ConflictReport({
        projectRoot: '/repo',
        conflicts: [
          {
            server: 'alpha',
            kind: 'profile',
            sources: ['/repo/.dsh/mcp.json'],
            message: 'owned by the profile',
          },
        ],
        t,
        ...overrides,
      })
    const coded = { choiceErrorCode: 'save.noLiveSession', choiceErrorParams: { projectRoot: '/repo' } }

    const translated = texts(report({ choiceError: MESSAGE, ...coded, hostT })).join(' | ')
    expect(translated).toContain(`${t('choiceRefused')} ${TRANSLATED}`)

    const plain = texts(report({ choiceError: MESSAGE, hostT })).join(' | ')
    expect(plain).toContain(`${t('choiceRefused')} ${MESSAGE}`)
  })
})
