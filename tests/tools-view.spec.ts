/**
 * The sidebar tab's tools block: what one session's model sees right now.
 *
 * Plain React element trees driven by fake `SessionTools` and a fake policy, no
 * DOM: the walkers resolve the pure components so every assertion reads what a
 * user would. The frozen host contract decides most of them — an absent `tools`
 * means "not mounted yet", `deferred` is the hidden count and nothing else, the
 * pin list is `policy.pins` — and a gate that is off is not a spent budget. The
 * block is one of the single surface's blocks since F-26: the session's declared
 * servers are drawn above it by `tabBody`, and each row here is its own
 * disclosure.
 */

import { describe, expect, it } from 'vitest'
import type { ProjectSnapshot, ServerRow, ServerStatus, SessionSnapshot, SessionTools, ToolPolicy } from '../src/types.ts'
import { demoTools } from './helpers/tools.ts'
import {
  HiddenTier,
  NO_TOOL_FILTER,
  STYLE,
  ServersBlock,
  ToolsFilter,
  ToolsView,
  budgetLine,
  budgetSplit,
  counterParts,
  filterHiddenServers,
  filterToolRows,
  hiddenByServer,
  matchesToolQuery,
  pinnedByServer,
  pinnedRows,
  serverOfToolName,
  serverPinPress,
  serverPinState,
  sessionToolsOf,
  sessionRowsOf,
  tierVisible,
  toggledTier,
  toolCallsLine,
  toolCounts,
  toolFactsBody,
  toolFilterActive,
  toolFactsView,
  toolReasonLine,
  toolServerState,
  toolTierSentence,
  toolTime,
  translateOf,
} from '../src/client/view.ts'
import type { ToolFilter, ToolTier, Translate } from '../src/client/view.ts'

const t = translateOf()

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

/**
 * Invoke the pure function components in a tree so the walkers see the elements
 * they actually produce. None of the tools surfaces takes a hook of its own.
 */
function resolve(node: unknown): unknown {
  if (Array.isArray(node)) return node.map((child) => resolve(child))
  if (node === null || typeof node !== 'object') return node
  const element = node as Element
  if (typeof element.type === 'function') {
    return resolve((element.type as (props: Record<string, unknown>) => unknown)(element.props))
  }
  return { type: element.type, props: { ...element.props, children: resolve(element.props.children) } }
}

/** The button whose label is `label`, wherever it sits in the tree. */
function button(node: unknown, label: string): Element | undefined {
  return elements(node).find(
    (element) => element.type === 'button' && texts(element).join('') === label,
  )
}

function session(id: string, tools?: SessionTools): SessionSnapshot {
  return tools === undefined ? { id, rows: [], issues: [] } : { id, rows: [], issues: [], tools }
}

/** One project's policy as the host stores it. */
function policy(mode: ToolPolicy['mode'], pins: readonly string[] = []): ToolPolicy {
  return { mode, pins }
}

function projectOf(...sessions: SessionSnapshot[]): ProjectSnapshot {
  return {
    projectRoot: '/repo',
    sessionIds: sessions.map((entry) => entry.id),
    rows: [],
    issues: [],
    sessions,
  }
}

/** The multi-line diagnostic the host now sends for a stalled mount. */
const DETAIL = [
  'yandex-wiki: no tool appeared in 4m 27s',
  'endpoint: streamable-http https://mcp.wiki.yandex.net',
  'declared in: /repo/.dsh/mcp.json',
  'the watchdog waits 60.0s; the client keeps retrying with backoff until its attempt budget runs out',
  "hint: a streamable-http endpoint that lists no tool — check it is reachable, speaks MCP, and accepts the declaration's headers",
  'projectMcp.retry() restarts this mount from scratch',
].join('\n')

/** One declared server row, as the host publishes it. */
function row(name: string, status: ServerStatus, extra: Partial<ServerRow> = {}): ServerRow {
  return { name, status, projectRoot: '/repo', ...extra }
}

/**
 * A project whose session carries its own declared rows — the shape the Tools
 * mode reads, per-session rather than the merged project view.
 * @param rows - the session's rows.
 * @param tools - its offer, absent for a session the host has not mounted.
 * @param id - the session id.
 * @returns the project snapshot.
 */
function projectWithRows(
  rows: readonly ServerRow[],
  tools?: SessionTools,
  id = 'session-aaa11111',
): ProjectSnapshot {
  const entry = session(id, tools)
  return {
    projectRoot: '/repo',
    sessionIds: [id],
    rows: [...rows],
    issues: [],
    sessions: [{ ...entry, rows: [...rows] }],
  }
}

function memoryStorage(initial: Record<string, string> = {}): {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  values: Record<string, string>
} {
  const values = { ...initial }
  return {
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value
    },
    values,
  }
}

/** One session that offers two names by counter and hides three. */
const TOOLS: SessionTools = {
  sessionId: 'session-aaa11111',
  baseline: ['mcp__tglider__workspace', 'mcp__grafana-local__query_prometheus'],
  activated: [{ name: 'mcp__tglider__find_references', via: 'session', at: 1_700_000_000_000 }],
  context: [{ name: 'mcp__tglider__get_type_hierarchy', via: 'context' }],
  deferred: ['mcp__tglider__symbol', 'mcp__tglider__structure', 'mcp__memory__search_nodes'],
  mounted: 9,
  surfaceChars: 900,
  budgetChars: 1_000,
  deferring: true,
}

/** The project's policy: one of the two counter-offered names is pinned by hand. */
const POLICY: ToolPolicy = policy('disclosure', ['mcp__tglider__workspace'])

describe('toolCounts', () => {
  it('names the three counters the Tools mode and the settings page share', () => {
    // `toolCounts` still answers "always in the request" for the budget: one pin
    // plus one counter-offered name, two disclosed, three hidden.
    expect(toolCounts(TOOLS)).toEqual({ pinned: 2, disclosed: 2, hidden: 3, offering: 4 })
  })

  it('reads the same counters as one part each, in the same order', () => {
    const parts = counterParts(TOOLS, POLICY, t)

    expect(parts.map((part) => part.key)).toEqual(['pinned', 'counters', 'disclosed', 'hidden'])
    expect(parts.map((part) => `${part.count} ${part.label}`)).toEqual([
      '1 pinned',
      '1 by the counters',
      '2 disclosed',
      '3 hidden',
    ])
  })

  it('counts the pin list, not the baseline, as pinned', () => {
    // The one number this fixes: with two names in the baseline and one pin, the
    // sentence used to say "2 pinned" over a pin list of one.
    const unpinned = counterParts(TOOLS, policy('disclosure'), t)

    expect(unpinned.map((part) => `${part.count} ${part.label}`)).toEqual([
      '0 pinned',
      '2 by the counters',
      '2 disclosed',
      '3 hidden',
    ])
  })

  it('takes the hidden count from `deferred` alone, never from mounted minus offered', () => {
    // 47 mounted and nothing offered is a real, entirely hidden session; the
    // baseline tier is a plain string list and is not part of the offer here.
    const hiddenOnly = demoTools({ baseline: [], activated: [], context: [], mounted: 47 })

    expect(toolCounts(hiddenOnly)).toEqual({
      pinned: 0,
      disclosed: 0,
      hidden: 3,
      offering: 0,
    })
  })
})

describe('pinned rows', () => {
  it('puts the policy’s pins first, marks them, and keeps the counter tier readable', () => {
    // `baseline.length` is what the badge counts, so the list has to show the
    // same tier — only the user's own pins carry the `Unpin` action.
    expect(pinnedRows(TOOLS, POLICY)).toEqual([
      { name: 'mcp__tglider__workspace', pinned: true },
      { name: 'mcp__grafana-local__query_prometheus', pinned: false },
    ])
  })

  it('shows a pin the project no longer offers, because the host keeps it', () => {
    const rows = pinnedRows(TOOLS, policy('disclosure', ['mcp__gone__tool']))

    expect(rows[0]).toEqual({ name: 'mcp__gone__tool', pinned: true })
    expect(rows).toHaveLength(3)
  })

  it('marks nothing pinned when the host published no policy', () => {
    expect(pinnedRows(TOOLS, policy('disclosure')).every((row) => row.pinned !== true)).toBe(true)
  })
})

describe('hidden split', () => {
  it('groups the names by server, busiest first and then by name', () => {
    expect(
      hiddenByServer([
        'mcp__tglider__symbol',
        'mcp__grafana-local__query_prometheus',
        'mcp__tglider__structure',
        'odd_name',
      ]),
    ).toEqual([
      { server: 'tglider', count: 2, names: ['mcp__tglider__symbol', 'mcp__tglider__structure'] },
      { server: 'grafana-local', count: 1, names: ['mcp__grafana-local__query_prometheus'] },
      { server: 'unknown', count: 1, names: ['odd_name'] },
    ])
  })

  it('reads the server out of the registry name the host publishes', () => {
    expect(serverOfToolName('mcp__tglider__workspace')).toBe('tglider')
    expect(serverOfToolName('mcp__a__b')).toBe('a')
    expect(serverOfToolName('mcp__tglider')).toBeUndefined()
    expect(serverOfToolName('workspace')).toBeUndefined()
  })
})

describe('budget split', () => {
  it('measures the offer against the mounted surface', () => {
    expect(budgetSplit(TOOLS)).toEqual({ used: 4, total: 9, percent: 44, exhausted: true })
  })

  it('never divides by an empty surface, and never exceeds a whole budget', () => {
    expect(budgetSplit(demoTools({ mounted: 0 })).percent).toBe(0)
    expect(budgetSplit(demoTools({ baseline: ['a', 'b', 'c'], mounted: 2 })).percent).toBe(100)
  })

  it('is exhausted exactly while the host says the surface is deferring', () => {
    // Nothing else decides it: a zero budget the deployment still gate-checks
    // with is deferring, and a fitting surface with a real budget is not.
    expect(budgetSplit(demoTools({ deferring: true })).exhausted).toBe(true)
    expect(budgetSplit(demoTools({ deferring: false })).exhausted).toBe(false)
  })
})

describe('budget line', () => {
  it('says which gate is off when the deployment switched deferral off', () => {
    const line = texts(budgetLine(demoTools({ budgetChars: 0, deferred: [] }), t))

    expect(line.join(' ')).toContain('the disclosure gate is off')
    expect(line.join(' ')).not.toContain('nothing hidden')
  })

  it('draws no line at all when the gate is on and nothing was deferred', () => {
    // A fitting surface is not a state to report: the chips carry `0 hidden`, and
    // the sentence repeating that in words was the empty row this block stopped
    // drawing. An absent line, not an empty one.
    const tools = demoTools({ budgetChars: 1_000, deferring: false, deferred: [] })

    expect(budgetLine(tools, t)).toBe(null)
    expect(texts(budgetLine(tools, t))).toEqual([])
  })

  it('prints the host’s own characters and the tokens it derives from them', () => {
    const tree = resolve(budgetLine(TOOLS, t))
    const line = texts(tree).join(' ')

    // 900 characters at the contract's four characters per token.
    expect(line).toContain('900 chars of 1000 · ≈ 225 tokens')
    // There are no slots anywhere any more: not on the line, not in the dictionary.
    expect(line).not.toContain('slot')
    expect(t('toolsBudget', { used: 900, total: 1000, tokens: 225 })).not.toContain('slot')
    // The line is a measurement now, so it carries no `demo` badge.
    expect(texts(tree)).not.toContain(t('toolsDemo'))
  })

  it('rounds the token estimate the contract’s way, and never prints a fraction', () => {
    const line = texts(budgetLine(demoTools({ surfaceChars: 901, budgetChars: 4_000, deferring: true }), t))

    expect(line.join(' ')).toContain('901 chars of 4000 · ≈ 225 tokens')
  })

  it('never says the gate is off while the session is deferring tools', () => {
    // A zero budget the deployment still gate-checks with hides everything, so
    // the hidden list and the gate-off copy must not appear together.
    const tree = resolve(
      budgetLine(demoTools({ budgetChars: 0, surfaceChars: 400, deferring: true, deferred: ['mcp__tglider__symbol'] }), t),
    )
    const line = texts(tree).join(' ')

    expect(line).toContain('400 chars of 0 · ≈ 100 tokens')
    expect(line).not.toContain('the disclosure gate is off')
  })
})

/**
 * The Tools mode of one session, with the policy and the action under test.
 * @param tools - the session's offer; omit it for a session the host has not mounted.
 * @param id - session id the view is opened for.
 * @param extra - policy and pin action to drive it with.
 * @returns the resolved element tree.
 */
function view(
  tools?: SessionTools,
  id = 'session-aaa11111',
  extra: {
    policy?: ToolPolicy
    onPin?: (tool: string, pinned: boolean) => void
    pending?: boolean
    /** The row whose detail block is open, as {@link ToolsSection} would hand it over. */
    openTool?: string
    /** `true` while the hidden list is open, as {@link ToolsSection} holds it. */
    openHidden?: boolean
    /** Another owner of `assembly.tools`, as the host would report it (C3). */
    presentation?: ProjectSnapshot['presentation']
    /** The filter the panel shows, as {@link ToolsSection} would hand it over (F-43). */
    filter?: ToolFilter
    /** Replace the query, as the section's own writer does. */
    onQuery?: (query: string) => void
    /** Press one tier in or out of the filter. */
    onTier?: (tier: ToolTier) => void
    /** Drop the query and every pressed tier. */
    onClearFilter?: () => void
    /** Pin every name of one server in one press, as the section's writer does. */
    onPinServer?: (server: string, names: readonly string[]) => void
    /** The host namespace's seat, as the panel hands it down (F-48). */
    hostT?: Translate
  } = {},
): unknown {
  const { presentation, ...rest } = extra
  const project = { ...projectOf(session(id, tools)), ...(presentation === undefined ? {} : { presentation }) }
  return resolve(ToolsView({ project, sessionId: id, policy: rest.policy ?? POLICY, ...rest, t }))
}

describe('ToolsView', () => {
  it('explains an unmounted session instead of printing zeroes', () => {
    const rendered = texts(view()).join(' | ')

    expect(rendered).toContain(t('toolsNotMounted'))
    expect(rendered).toContain('lazy mounting')
    expect(rendered).toContain('tools[] = built-ins only')
    expect(rendered).not.toContain('0 pinned')
    expect(rendered).not.toContain('chars of')
  })

  it('draws no counter for a published offer that offers nothing', () => {
    // `tools` absent is "not mounted yet"; a published offer is a measurement,
    // and a measurement of nothing prints no chip: the block still stands, with
    // its label above and nothing to count.
    const tools = demoTools({
      baseline: [],
      activated: [],
      context: [],
      deferred: [],
      mounted: 0,
      budgetChars: 0,
    })
    const rendered = texts(view(tools, 'session-aaa11111', { policy: policy('disclosure') }))

    expect(rendered).toContain(t('toolsSeeModel'))
    for (const zero of ['0 pinned', '0 by the counters', '0 disclosed', '0 hidden']) {
      expect(rendered).not.toContain(zero)
    }
    expect(rendered).not.toContain(t('toolsNotMounted'))
  })

  it('reads one session out of its project and ignores the others', () => {
    const project = projectOf(session('session-aaa11111'), session('session-bbb22222', TOOLS))

    expect(sessionToolsOf(project, 'session-bbb22222')).toBe(TOOLS)
    expect(sessionToolsOf(project, 'session-ccc33333')).toBeUndefined()
    expect(sessionToolsOf(project, undefined)).toBeUndefined()
  })

  it('lists the pinned tier by its real registry names, and the counter tier as offered', () => {
    const rendered = texts(
      view({ ...TOOLS, deferred: [], budgetChars: 1_000, deferring: false }),
    )

    expect(rendered).toContain('mcp__tglider__workspace')
    expect(rendered).not.toContain('tglider/workspace')
    // One chip per counter that has a number: the three that do, and no chip at
    // all for the tier at zero.
    expect(rendered).toContain('1 pinned')
    expect(rendered).toContain('1 by the counters')
    expect(rendered).toContain('2 disclosed')
    expect(rendered).not.toContain('0 hidden')
    // The counter-seeded name is on screen, under its own group, and carries the
    // pin action the counters always promised.
    expect(rendered).toContain('mcp__grafana-local__query_prometheus')
    expect(rendered).toContain(t('toolsGroupCounters'))
    expect(rendered).toContain(t('toolsPin'))
  })

  it('draws no pinned group at all rather than explaining an empty one', () => {
    // Nothing pinned is not a heading over an apology: the group, its empty row
    // and its zero are all absent — and so are the mockup's names.
    const rendered = texts(
      view({ ...TOOLS, baseline: [], deferred: [], budgetChars: 1_000, deferring: false }, 'session-aaa11111', {
        policy: policy('disclosure'),
      }),
    )

    expect(rendered).not.toContain(t('toolsGroupPinned'))
    expect(rendered).not.toContain('0 pinned')
    expect(rendered).not.toContain('mcp__tglider__workspace')
  })

  it('draws no disclosed group when the session has disclosed nothing', () => {
    const rendered = texts(
      view(
        { ...TOOLS, activated: [], context: [], deferred: [], budgetChars: 1_000, deferring: false },
        'session-aaa11111',
        { policy: policy('disclosure', ['mcp__tglider__workspace']) },
      ),
    )

    expect(rendered).not.toContain(t('toolsGroupDisclosed'))
    expect(rendered).not.toContain('0 disclosed')
  })

  it('folds the hidden remainder behind one head, and never lists it unasked', () => {
    const rendered = texts(view(TOOLS)).join(' | ')

    // The counters already print `3 hidden`; the head carries the same figure
    // and the names are all it adds, so a closed tier draws none of them.
    expect(rendered).toContain(`▸ ${t('toolsGroupHidden')}`)
    expect(rendered).not.toContain('mcp__tglider__symbol')
    expect(rendered).not.toContain('tglider · 2')
  })

  it('opens the hidden remainder into its real names, grouped by the server that held them', () => {
    const tree = view(TOOLS, 'session-aaa11111', { openHidden: true })
    const rendered = texts(tree).join(' | ')

    expect(rendered).toContain(`▾ ${t('toolsGroupHidden')}`)
    expect(rendered).toContain('tglider · 2')
    expect(rendered).toContain('memory · 1')
    for (const name of TOOLS.deferred) expect(rendered).toContain(name)
    // The sentence that used to sit under the head as a caption is the head's
    // own tooltip now: nothing hidden draws no head at all.
    const head = elements(tree).find(
      (element) => element.type === 'button' && texts(element)[0] === `▾ ${t('toolsGroupHidden')}`,
    )
    expect(head?.props.title).toBe(t('toolsHiddenVia'))
  })

  it('tags a disclosed row with the host’s own step, and keeps the real clock time', () => {
    const tools = demoTools({
      activated: [{ name: 'mcp__tglider__find_references', via: 'session', at: 1_700_000_000_000, step: 4 }],
      context: [{ name: 'mcp__tglider__find_references', via: 'context', step: 6 }],
      deferred: [],
      budgetChars: 1_000,
      deferring: false,
    })
    const rendered = texts(view(tools, 'session-aaa11111', { policy: policy('disclosure') }))

    expect(rendered).toContain(toolTime(1_700_000_000_000))
    expect(rendered.some((line) => /^\d{2}:\d{2}$/.test(line))).toBe(true)
    // `OfferedTool.step` is the host's counter (contract C2), not a literal.
    expect(rendered).toContain(t('toolsStep', { step: 4 }))
    expect(rendered).toContain(t('toolsStep', { step: 6 }))
  })

  it('draws no step tag, and no placeholder badge, when the host sent no step', () => {
    const tools = demoTools({
      baseline: [],
      activated: [{ name: 'mcp__tglider__find_references', via: 'session', at: 1_700_000_000_000 }],
      context: [],
      deferred: [],
      budgetChars: 1_000,
      deferring: false,
    })
    const tree = view(tools, 'session-aaa11111', { policy: policy('disclosure') })
    const rendered = texts(tree)

    expect(rendered).toContain('mcp__tglider__find_references')
    expect(rendered.some((line) => line.startsWith('step '))).toBe(false)
    // The whole block here is the host's own readings, so nothing carries the
    // `demo` badge: not the disclosure row, not the counters beside it.
    expect(rendered).not.toContain(t('toolsDemo'))
  })

  it('renders no clock for the context tier, which carries no time', () => {
    const tools = demoTools({
      baseline: [],
      activated: [],
      context: [{ name: 'mcp__tglider__find_references', via: 'context' }],
      deferred: [],
      budgetChars: 1_000,
      deferring: false,
    })
    const rendered = texts(view(tools, 'session-aaa11111', { policy: policy('disclosure') }))

    expect(rendered).toContain('mcp__tglider__find_references')
    expect(rendered.some((line) => /^\d{2}:\d{2}$/.test(line))).toBe(false)
  })

  it('spends the budget in the host’s units: the character line plus what to free', () => {
    const rendered = texts(view(TOOLS)).join(' | ')

    expect(rendered).toContain('900 chars of 1000 · ≈ 225 tokens')
    expect(rendered).toContain(t('toolsBudgetExhausted'))
    expect(rendered).toContain('free room in the budget or pin the tool in the project settings')
  })

  it('warns about another presentation owner exactly when the host reports one', () => {
    const presentation = { name: 'progressive-tools', note: 'assembly.tools is owned twice' }
    const tree = view({ ...TOOLS, deferred: [], budgetChars: 1_000, deferring: false }, 'session-aaa11111', {
      policy: policy('disclosure'),
      presentation,
    })
    const rendered = texts(tree).join(' ')

    expect(rendered).toContain(`${t('toolsPresentationOwner')}: progressive-tools`)
    expect(rendered).toContain('assembly.tools is owned twice')
    // The banner is the host's report, so it carries no `demo` badge of its own:
    // only the counter-seeded rows beside it are still placeholders.
    // Looked up by the element that actually carries the sentence, not by the
    // containers above it.
    const banner = elements(tree).find((element) =>
      String((element.props.children as unknown[] | undefined)?.[0] ?? '').includes('assembly.tools'),
    )

    expect(texts(banner ?? null)).not.toContain(t('toolsDemo'))
  })

  it('resolves a coded presentation note through the host seat, and keeps an uncoded one as prose', () => {
    // A host seat that knows the note's code in another language; the rest
    // echo, the harness's own miss signal (F-48, Task 4).
    const hostT: Translate = (key) =>
      key === 'present.ownerNote' ? 'второй владелец представления перезаписывает assembly.tools' : key
    const coded = view({ ...TOOLS, deferred: [], budgetChars: 1_000, deferring: false }, 'session-aaa11111', {
      presentation: { name: 'progressive-tools', note: 'assembly.tools is owned twice', noteCode: 'present.ownerNote' },
      hostT,
    })
    const rendered = texts(coded).join(' ')
    expect(rendered).toContain('второй владелец представления перезаписывает assembly.tools')
    expect(rendered).not.toContain('assembly.tools is owned twice')

    // The old host: prose only, and the banner reads exactly it.
    const plain = view({ ...TOOLS, deferred: [], budgetChars: 1_000, deferring: false }, 'session-aaa11111', {
      presentation: { name: 'progressive-tools', note: 'assembly.tools is owned twice' },
      hostT,
    })
    expect(texts(plain).join(' ')).toContain('assembly.tools is owned twice')
  })

  it('draws no owner banner, and no badge, without the host’s report', () => {
    const tree = view({ ...TOOLS, deferred: [], budgetChars: 1_000, deferring: false })

    expect(texts(tree).join(' ')).not.toContain(t('toolsPresentationOwner'))
    // The counter tier is still marked; the banner simply is not there.
    expect(
      elements(tree).some((element) => texts(element).join(' ').includes(t('toolsPresentationOwner'))),
    ).toBe(false)
  })
})

describe('the pin action', () => {
  it('offers Unpin on the policy’s pins and Pin on what the counters offered', () => {
    const tree = view(TOOLS)

    // One pin, one counter-offered name, two disclosures. The row itself is a
    // button too (F-26), so an action is the button that does not carry
    // `aria-expanded`.
    const actions = elements(tree).filter(
      (element) => element.type === 'button' && element.props['aria-expanded'] === undefined,
    )
    expect(actions).toHaveLength(4)
    expect(elements(tree).filter((element) => texts(element).join('') === t('toolsUnpin'))).toHaveLength(1)
    expect(elements(tree).filter((element) => texts(element).join('') === t('toolsPin'))).toHaveLength(1)
  })

  it('reports the name and the direction the host expects for one unpin', () => {
    const calls: [string, boolean][] = []
    const tree = view(TOOLS, 'session-aaa11111', { onPin: (tool, pinned) => calls.push([tool, pinned]) })

    ;(button(tree, t('toolsUnpin'))?.props.onClick as () => void)()
    expect(calls).toEqual([['mcp__tglider__workspace', false]])
  })

  it('reports the name and the direction the host expects for one pin', () => {
    const calls: [string, boolean][] = []
    const tree = view(TOOLS, 'session-aaa11111', { onPin: (tool, pinned) => calls.push([tool, pinned]) })

    ;(button(tree, t('toolsPin'))?.props.onClick as () => void)()
    expect(calls).toEqual([['mcp__grafana-local__query_prometheus', true]])
  })

  it('stays still while a pin request is in flight', () => {
    const tree = view(TOOLS, 'session-aaa11111', { onPin: () => undefined, pending: true })

    expect(button(tree, t('toolsUnpin'))?.props.disabled).toBe(true)
    expect(button(tree, t('toolsPin'))?.props.disabled).toBe(true)
  })

  it('offers no pin for a name this session does not offer at all', () => {
    // Every pin row comes from the host's own pin list or its own baseline, so a
    // tool the project does not mount has no row and cannot be pinned.
    const rendered = texts(
      view({ ...TOOLS, baseline: [] }, 'session-aaa11111', { policy: policy('disclosure') }),
    ).join(' | ')

    expect(rendered).not.toContain(t('toolsGroupPinned'))
    expect(rendered).not.toContain(t('toolsPin'))
  })
})

/**
 * One tool row is a disclosure of its own (F-26): the header stays what it always
 * showed, and the open body prints the registry name, the server and the tier —
 * with the step and the clock only while the host published them.
 */
describe('a tool row’s detail', () => {
  /**
   * The row's own head: the button whose first text is the registry name. Its
   * later texts are the step tag and the clock, so the match is on the name
   * rather than on the whole line.
   */
  const line = (node: unknown, name: string): Element | undefined =>
    elements(node).find(
      (element) => element.type === 'button' && texts(element)[0] === name,
    )

  it('makes every row a button that is closed until the section opens one', () => {
    const tree = view(TOOLS)
    const heads = elements(tree).filter(
      (element) => element.type === 'button' && element.props['aria-expanded'] !== undefined,
    )

    // Five: four tool rows — the pin, the counter-seeded baseline name and the
    // two the session disclosed — plus the head that folds the hidden remainder.
    expect(heads).toHaveLength(5)
    expect(heads.every((element) => element.props['aria-expanded'] === false)).toBe(true)
    // Closed means the body is absent, not merely hidden behind an indent: the
    // row's own wrapper holds no detail block to read.
    expect(detailOf(tree, 'mcp__tglider__workspace')).toBe('')
  })

  /**
   * The open row's own detail block, read where it is drawn.
   *
   * Found structurally — the row wrapper's child that is neither the row's own
   * `button[aria-expanded]` head nor its action button — never by a style or by
   * searching the tree for the name. The header prints the same full name, so a
   * whole-tree reading would pass even for a body that printed a short one; this
   * helper reads the body itself, and answers '' while the row is folded.
   */
  const detailOf = (node: unknown, name: string): string => {
    const head = line(node, name)
    const wrapper = elements(node).find(
      (element) =>
        Array.isArray(element.props.children) &&
        (element.props.children as unknown[]).includes(head),
    )
    const body = (wrapper?.props.children as unknown[] | undefined)?.find(
      (child) => child !== head && child !== null && (child as Element).type !== 'button',
    )
    return texts(body ?? null).join(' · ')
  }

  it('opens one row into its name, its server and the tier that offered it', () => {
    const tree = view(TOOLS, 'session-aaa11111', { openTool: 'mcp__tglider__workspace' })
    const body = detailOf(tree, 'mcp__tglider__workspace')

    expect(line(tree, 'mcp__tglider__workspace')?.props['aria-expanded']).toBe(true)
    // The body itself spells the full public registry name out, and names where
    // the tool came from. Reading the whole tree would not say so: the header
    // prints the same name.
    expect(body).toContain('mcp__tglider__workspace')
    expect(body).toContain(t('toolServer', { server: 'tglider' }))
    expect(body).toContain(t('toolTierPinned'))
    // A short display name in the body is not the registry name.
    expect(body).not.toContain('tglider/workspace')
    // The counter-seeded row beside it stays closed.
    expect(line(tree, 'mcp__grafana-local__query_prometheus')?.props['aria-expanded']).toBe(false)
    expect(detailOf(tree, 'mcp__grafana-local__query_prometheus')).toBe('')
  })

  it('prints the step and the clock only while the host published them', () => {
    const tools = demoTools({
      baseline: [],
      activated: [
        { name: 'mcp__tglider__find_references', via: 'session', at: 1_700_000_000_000, step: 4 },
      ],
      context: [{ name: 'mcp__tglider__get_type_hierarchy', via: 'context' }],
      deferred: [],
      budgetChars: 1_000,
      deferring: false,
    })
    const open = (openTool: string): unknown =>
      view(tools, 'session-aaa11111', { policy: policy('disclosure'), openTool })
    const activated = detailOf(
      open('mcp__tglider__find_references'),
      'mcp__tglider__find_references',
    )
    const context = detailOf(
      open('mcp__tglider__get_type_hierarchy'),
      'mcp__tglider__get_type_hierarchy',
    )

    expect(activated).toContain(t('toolServer', { server: 'tglider' }))
    expect(activated).toContain(t('toolTierSession'))
    expect(activated).toContain(t('toolsStep', { step: 4 }))
    expect(activated).toContain(toolTime(1_700_000_000_000))
    expect(context).toContain(t('toolTierContext'))
    // The host published no step and no time for the context tier, so the block
    // draws neither — no invented number, no placeholder clock.
    expect(context).not.toContain('step ')
    expect(context.split(' · ').some((part) => /^\d{2}:\d{2}$/.test(part))).toBe(false)
  })

  it('invents no per-tool size, because the host published none', () => {
    const rendered = detailOf(
      view(TOOLS, 'session-aaa11111', { openTool: 'mcp__tglider__workspace' }),
      'mcp__tglider__workspace',
    )

    // The group's budget line above is where an estimate is real; the one tool's
    // block carries the host's own facts and nothing derived.
    expect(rendered).toContain(t('toolServer', { server: 'tglider' }))
    expect(rendered).not.toContain('chars')
    expect(rendered).not.toContain('tokens')
  })
})

describe('the body’s own facts', () => {
  it('reads the server and its state out of the session’s declared rows', () => {
    // The state is the row's own status word, translated through the block's
    // `STATUS_KEYS`: an invented `idle` for a server nobody declared is exactly
    // what this line exists to prevent.
    expect(toolServerState('mcp__tglider__workspace', [row('tglider', 'active')], t)).toBe(
      t('toolServerState', { server: 'tglider', state: t('statusActive') }),
    )
    expect(toolServerState('mcp__tglider__workspace', [row('tglider', 'error')], t)).toBe(
      t('toolServerState', { server: 'tglider', state: t('statusError') }),
    )
  })

  it('draws no state for a name with no server, and none for a server nobody declared', () => {
    expect(toolServerState('odd_name', [row('tglider', 'active')], t)).toBeUndefined()
    expect(toolServerState('mcp__tglider__workspace', [], t)).toBeUndefined()
    expect(toolServerState('mcp__tglider__workspace', undefined, t)).toBeUndefined()
  })

  it('prints the two counter readings apart, and only the ones the host measured', () => {
    const both = { recorded: true, split: true, project: 182, session: 3 }

    expect(toolCallsLine(both, t)).toBe(
      [t('callsProject', { count: 182 }), t('toolCallsSession', { count: 3 })].join(' · '),
    )
    // A host that does not split by session has one figure, not two.
    expect(toolCallsLine({ recorded: true, split: false, project: 182, session: undefined }, t)).toBe(
      t('callsProject', { count: 182 }),
    )
    // No record at all is not a row of zeroes: it is no line.
    expect(toolCallsLine(undefined, t)).toBeUndefined()
    expect(
      toolCallsLine({ recorded: false, split: false, project: undefined, session: undefined }, t),
    ).toBeUndefined()
  })

  it('prints the reason with the host’s own figures, and invents none of them', () => {
    expect(toolReasonLine({ kind: 'budget', chars: 1_240, budget: 8_000, used: 6_900 }, t)).toBe(
      t('toolReasonBudget', { chars: 1_240, budget: 8_000, used: 6_900 }),
    )
    // A figure the host did not measure leaves its phrase out — no zero, no
    // estimate: the panel never computes a size of its own (contract C2's rule).
    const partial = toolReasonLine({ kind: 'budget', chars: 640 }, t)
    expect(partial).toContain(t('toolReasonChars', { chars: 640 }))
    expect(partial).not.toContain('budget')
    expect(partial).not.toContain('already offered')
    // A reason with no measurement at all is still a reason: the word alone.
    expect(toolReasonLine({ kind: 'budget' }, t)).toBe(t('toolReason'))
    // An offered name carries no reason, so the body prints no line.
    expect(toolReasonLine(undefined, t)).toBeUndefined()
  })

  it('says the tier as a sentence instead of the wire word', () => {
    expect(toolTierSentence('pin', t)).toBe(t('toolTierPinned'))
    expect(toolTierSentence('session', t)).toBe(t('toolTierSession'))
    expect(toolTierSentence('context', t)).toBe(t('toolTierContext'))
  })
})

describe('mode copy', () => {
  it('says what the mode did instead of reporting it as hidden tools', () => {
    // The same published row, read under each mode: only `disclosure` may print
    // the offer counters, because only there do they describe this plugin's work.
    const off = texts(view(TOOLS, undefined, { policy: policy('off') })).join(' | ')
    expect(off).toContain(t('toolsModeOff'))
    expect(off).toContain(t('toolsModeOffCounters', { mounted: TOOLS.mounted }))
    expect(off).not.toContain('pinned')
    expect(off).not.toContain(`${TOOLS.deferred.length} hidden`)

    const direct = texts(view(TOOLS, undefined, { policy: policy('direct') })).join(' | ')
    expect(direct).toContain(t('toolsModeDirect'))
    expect(direct).not.toContain('nothing hidden')

    const disclosure = texts(view(TOOLS, undefined, { policy: policy('disclosure') })).join(' | ')
    expect(disclosure).not.toContain(t('toolsModeOff'))
    expect(disclosure).not.toContain(t('toolsModeDirect'))
    expect(disclosure).toContain('2 by the counters')
  })

  it('tells the three modes apart as plain sentences', () => {
    expect(t('toolsModeDirect')).toContain('nothing is deferred')
    expect(t('toolsModeOff')).toContain('switched off')
  })
})

describe('ServersBlock', () => {
  const rows = [
    row('tglider', 'active', { transport: 'stdio' }),
    row('grafana-local', 'connecting', { transport: 'streamable-http' }),
    row('yandex-wiki', 'error', { transport: 'streamable-http', detail: DETAIL }),
    row('unused', 'disabled'),
  ]

  it('lists every declared server with its status, and keeps the failure on the row', () => {
    const tree = resolve(ServersBlock({ rows, t }))
    const listed = texts(tree)

    expect(listed).toContain(t('toolsServers'))
    expect(listed).toContain('1/4 up')
    for (const [name, status] of [
      ['tglider', 'active'],
      ['grafana-local', 'connecting'],
      ['yandex-wiki', 'error'],
      ['unused', 'disabled'],
    ] as const) {
      expect(listed).toContain(name)
      expect(listed).toContain(status)
    }
    // The host's diagnostic is no longer drawn under the rows (F-26): the row
    // keeps it as its own tooltip, and the errors disclosure reads it out in
    // full. Drawing both put an amber wall between the tools and the reader.
    expect(listed).not.toContain(DETAIL)
    expect(elements(tree).find((element) => element.props.title === DETAIL)).toBeDefined()
  })

  it('turns the summary chip red only while a server is failing', () => {
    // The chip is the one element whose tooltip names every row's state.
    const chipOf = (node: unknown): Element | undefined =>
      elements(resolve(node)).find((element) => element.props.title === 'a: active' || element.props.title === 'a: error')
    const healthy = chipOf(ServersBlock({ rows: [row('a', 'active')], t }))
    const failing = chipOf(ServersBlock({ rows: [row('a', 'error')], t }))

    expect(texts(healthy ?? null).join('')).toBe('1/1 up')
    expect(texts(failing ?? null).join('')).toBe('0/1 up')
    expect((healthy?.props.style as { color?: string }).color).toContain('label-secondary')
    expect((failing?.props.style as { color?: string }).color).toContain('state-error')
    // The chip is a plate now, so the alarm is the type colour on the same
    // layer fill — not a border, which would have been the only other cue.
    expect((failing?.props.style as { background?: string }).background).toContain('bg-layer-3')
  })

  it('offers the project’s Retry on a failing row, and on that row only', () => {
    const retried: string[] = []
    const tree = resolve(ServersBlock({ rows, t, onRetry: () => retried.push('retry'), busy: false }))
    const retry = button(tree, t('retry'))

    // One action, on the one failing row: the active, connecting and disabled
    // rows are readings, not jobs, and a `Retry` beside them would promise a
    // restart for a server that is already doing what it should.
    expect(elements(tree).filter((element) => element.type === 'button')).toHaveLength(1)
    expect(retry?.props.title).toBe(t('retryHint'))
    expect(retry?.props.disabled).toBe(false)
    ;(retry?.props.onClick as () => void)()
    expect(retried).toEqual(['retry'])
  })

  it('keeps the row button still while a host action is in flight', () => {
    const tree = resolve(ServersBlock({ rows, t, onRetry: () => undefined, busy: true }))

    expect(button(tree, t('retry'))?.props.disabled).toBe(true)
  })

  it('offers no Retry where nothing can be written', () => {
    // A read-only surface hands no action down, and the row draws none: the
    // button is the callback's own shadow, exactly as it is in `serverRow`.
    const tree = resolve(ServersBlock({ rows, t }))

    expect(button(tree, t('retry'))).toBeUndefined()
  })

  it('renders nothing for a session that declares no server', () => {
    expect(ServersBlock({ rows: [], t })).toBeNull()
  })
})

describe('the Servers surface’s indentation ladder', () => {
  /**
   * The one change the Servers mode made to Surface A is a 12px nesting ladder;
   * the Tools mode's own declared-servers block answers a different question
   * (what the model sees) and its rows stay flat at the project's own rung.
   */
  it('leaves the Tools mode’s declared-servers block at the project rung, unindented', () => {
    const tree = resolve(
      ServersBlock({
        rows: [
          row('tglider', 'active', { transport: 'stdio' }),
          row('yandex-wiki', 'error', { transport: 'streamable-http', detail: DETAIL }),
        ],
        t,
      }),
    )
    const indented = elements(tree).filter(
      (element) => (element.props.style as { paddingLeft?: unknown } | undefined)?.paddingLeft !== undefined,
    )

    // The block still lists the same two rows; it just carries no rung of a
    // ladder that belongs to the Servers surface, and no diagnostic of its own.
    expect(indented).toEqual([])
    expect(texts(tree)).toContain('tglider')
    expect(texts(tree)).not.toContain(DETAIL)
    expect(elements(tree).find((element) => element.props.title === DETAIL)).toBeDefined()
  })
})

describe('sessionRowsOf', () => {
  it("reads the session's own rows, falling back to the project's merged view", () => {
    const project: ProjectSnapshot = {
      ...projectOf(session('s1')),
      rows: [row('merged', 'active')],
      sessions: [{ ...session('s1'), rows: [row('mine', 'idle')] }],
    }

    expect(sessionRowsOf(project, 's1').map((entry) => entry.name)).toEqual(['mine'])
    expect(sessionRowsOf(project, 'not-listed').map((entry) => entry.name)).toEqual(['merged'])
    expect(sessionRowsOf(project, undefined)).toEqual([])
  })
})

describe('the host’s call counters on tool rows (F-32)', () => {
  /** A server the counters know, with a count for one of its tools and none for the others. */
  const counters: ProjectSnapshot['usage'] = {
    tglider: { calls: 183, errors: 0, tools: { workspace: 182 } },
  }

  /**
   * The tools block of one session, read as one flat string.
   * @param usage - the project's counters; omitted for a project never counted.
   * @returns every string the block draws, joined.
   */
  function block(usage?: ProjectSnapshot['usage']): string {
    const project = projectOf(session('session-aaa11111', demoTools()))
    return texts(
      resolve(
        ToolsView({
          project: usage === undefined ? project : { ...project, usage },
          sessionId: 'session-aaa11111',
          policy: POLICY,
          t,
        }),
      ),
    ).join(' | ')
  }

  it('writes the count the host kept, right after the name', () => {
    expect(block(counters)).toContain('182 calls')
  })

  it('says never called for a name whose server was recorded without it', () => {
    // `tglider` is in the counters and its two disclosed tools are not counted:
    // the honest reading is that the server was recorded and these never ran.
    expect(block(counters)).toContain('never called')
  })

  it('writes no figure at all when the host published no counters', () => {
    const rendered = block()
    expect(rendered).not.toContain('182 calls')
    expect(rendered).not.toContain('never called')
  })

  it('counts one name once, on its own row', () => {
    expect(block(counters).split('182 calls')).toHaveLength(2)
  })

  it('leads with this session’s own count and names the project’s beside it', () => {
    const split: ProjectSnapshot['usage'] = {
      tglider: {
        calls: 185,
        errors: 0,
        tools: { workspace: 182 },
        sessions: {
          'session-aaa11111': { calls: 3, errors: 0, tools: { workspace: 3 } },
        },
      },
    }
    // Tools are mounted for the project and used inside a session: the row leads
    // with the reading this session asks about and names the project's when the
    // two disagree (F-34).
    expect(block(split)).toContain('3 calls · 182 in the project')
  })

  it('says never called here, with the project’s figure, for a tool only other sessions ran', () => {
    const elsewhere: ProjectSnapshot['usage'] = {
      tglider: {
        calls: 182,
        errors: 0,
        tools: { workspace: 182 },
        sessions: {
          'session-aaa11111': { calls: 0, errors: 0, tools: {} },
        },
      },
    }
    expect(block(elsewhere)).toContain('never called · 182 in the project')
  })

  it('prints one number when this session’s reading is the whole story', () => {
    const same: ProjectSnapshot['usage'] = {
      tglider: {
        calls: 182,
        errors: 0,
        tools: { workspace: 182 },
        sessions: {
          'session-aaa11111': { calls: 182, errors: 0, tools: { workspace: 182 } },
        },
      },
    }
    const rendered = block(same)
    expect(rendered).toContain('182 calls')
    // Two numbers that agree are one number.
    expect(rendered).not.toContain('in the project')
  })

  it('writes a single call in the singular', () => {
    const once: ProjectSnapshot['usage'] = {
      tglider: { calls: 1, errors: 0, tools: { workspace: 1 } },
    }
    expect(block(once)).toContain('1 call')
  })
})

/**
 * The tools block's filter (F-43): one query over the registry names, and the
 * counter chips above the list as the tier switch.
 *
 * The pure half of the behaviour lives here — what the filter functions keep,
 * and the tree the block draws for a filter handed in. The half that writes the
 * filter (typing into the field, pressing a chip) is in `view-dom.spec.ts`,
 * where the state of {@link ToolsSection} actually runs.
 */
describe('the tools block’s filter (F-43)', () => {
  /**
   * The block as {@link ToolsSection} draws it: the filter and all three of its
   * writers, which is what makes the chips buttons and the field a field.
   */
  function section(filter: ToolFilter): unknown {
    return view(demoTools(), 'session-aaa11111', {
      filter,
      onQuery: () => undefined,
      onTier: () => undefined,
      onClearFilter: () => undefined,
    })
  }

  /** The block's own words, as one flat string. */
  function words(filter?: ToolFilter): string {
    return texts(view(demoTools(), 'session-aaa11111', filter === undefined ? {} : { filter })).join(
      ' | ',
    )
  }

  /**
   * The tier chips the block drew, as `{count} {label}` → whether the tier is
   * pressed. A chip is a button only while the block can write the filter to
   * something; the reading the block had before F-43 is a span.
   */
  function chipsOf(tree: unknown): Record<string, unknown> {
    return Object.fromEntries(
      elements(tree)
        .filter((element) => element.type === 'button' && element.props['aria-pressed'] !== undefined)
        .map((element) => [texts(element).join(''), element.props['aria-pressed']]),
    )
  }

  it('matches a registry name case-insensitively, and on the server it carries', () => {
    expect(matchesToolQuery('mcp__tglider__workspace', 'workspace')).toBe(true)
    expect(matchesToolQuery('mcp__tglider__workspace', 'TGLIDER')).toBe(true)
    // The registry name carries its server as a prefix, so one field answers
    // both "which tool" and "which server" — and never the other project's names.
    expect(matchesToolQuery('mcp__grafana-local__query_prometheus', 'grafana')).toBe(true)
    expect(matchesToolQuery('mcp__grafana-local__query_prometheus', 'memory')).toBe(false)
    // A field whose value is only a space is an empty field, not a query that
    // matches nothing: a trailing space is not a broken panel.
    expect(matchesToolQuery('mcp__tglider__workspace', '   ')).toBe(true)
  })

  it('is active on a query, on a tier, and on both', () => {
    expect(toolFilterActive(NO_TOOL_FILTER)).toBe(false)
    expect(toolFilterActive({ query: '  ', tiers: [] })).toBe(false)
    expect(toolFilterActive({ query: 'sym', tiers: [] })).toBe(true)
    expect(toolFilterActive({ query: '', tiers: ['hidden'] })).toBe(true)
  })

  it('lets every tier through until one is pressed, and releases it on a second press', () => {
    expect(tierVisible(NO_TOOL_FILTER, 'hidden')).toBe(true)
    const one = toggledTier([], 'hidden')

    expect(one).toEqual(['hidden'])
    expect(tierVisible({ query: '', tiers: one }, 'hidden')).toBe(true)
    expect(tierVisible({ query: '', tiers: one }, 'pinned')).toBe(false)
    // An empty tier list means every tier, so the second press hands the block
    // its full list back rather than leaving it on nothing.
    expect(toggledTier(one, 'hidden')).toEqual([])
  })

  it('keeps the rows of a tier that pass the query, in the order they came in', () => {
    const rows = [{ name: 'mcp__tglider__workspace' }, { name: 'mcp__memory__search_nodes' }]

    expect(filterToolRows(rows, 'memory').map((row) => row.name)).toEqual(['mcp__memory__search_nodes'])
    expect(filterToolRows(rows, '')).toEqual(rows)
  })

  it('drops the hidden groups a query emptied, renumbering the ones it kept', () => {
    const groups = hiddenByServer(demoTools().deferred)

    expect(groups).toHaveLength(3)
    expect(filterHiddenServers(groups, 'symbol').map((group) => `${group.server} ${group.count}`)).toEqual([
      'tglider 1',
    ])
    expect(filterHiddenServers(groups, 'mcp__')).toHaveLength(3)
    // A group head over an empty list would be a count the user cannot spend.
    expect(filterHiddenServers(groups, 'nothing at all')).toEqual([])
  })

  it('narrows the drawn names to the query and says how many of them are left', () => {
    const rendered = words({ query: 'grafana', tiers: [] })

    expect(rendered).toContain('mcp__grafana-local__query_prometheus')
    expect(rendered).not.toContain('mcp__tglider__workspace')
    expect(rendered).not.toContain('mcp__memory__search_nodes')
    // Six rows before the filter: one pin, two disclosures, three hidden.
    expect(rendered).toContain('showing 1 of 6')
  })

  it('draws the empty state instead of a head over nothing', () => {
    const rendered = words({ query: 'no tool is called this', tiers: [] })

    expect(rendered).toContain(t('toolsFilterNone'))
    expect(rendered).not.toContain('showing 0 of')
    expect(rendered).not.toContain(t('toolsGroupPinned'))
    expect(rendered).not.toContain(t('toolsGroupDisclosed'))
  })

  it('draws one tier alone when its chip is pressed, and every tier with none', () => {
    const all = words()
    const hiddenOnly = words({ query: '', tiers: ['hidden'] })

    expect(all).toContain(t('toolsGroupPinned'))
    expect(all).toContain(t('toolsGroupDisclosed'))
    expect(hiddenOnly).not.toContain(t('toolsGroupPinned'))
    expect(hiddenOnly).not.toContain(t('toolsGroupDisclosed'))
    expect(hiddenOnly).toContain(t('toolsGroupHidden'))
    expect(hiddenOnly).toContain('mcp__memory__search_nodes')
    // The denominator stays the block's own six rows: a pressed tier narrows
    // what is drawn, not what the session holds.
    expect(hiddenOnly).toContain('showing 3 of 6')
  })

  it('presses the chip of the tier it narrowed to and leaves the other two alone', () => {
    expect(chipsOf(section({ query: '', tiers: ['hidden', 'pinned'] }))).toEqual({
      '1 pinned': true,
      '2 disclosed': false,
      '3 hidden': true,
    })
  })

  it('keeps the pressed chip of a tier a host refresh emptied, so the empty list stays explainable', () => {
    // The host republished with nothing disclosed while the tier was pressed:
    // the chip is drawn `0 disclosed` and still pressed, because the control
    // that caused the empty list may not disappear before it is released.
    const emptied = demoTools({ activated: [], context: [] })
    const tree = resolve(
      ToolsView({
        project: projectOf(session('session-aaa11111', emptied)),
        sessionId: 'session-aaa11111',
        policy: POLICY,
        filter: { query: '', tiers: ['disclosed'] },
        onQuery: () => undefined,
        onTier: () => undefined,
        onClearFilter: () => undefined,
        t,
      }),
    )

    expect(chipsOf(tree)).toEqual({ '1 pinned': false, '0 disclosed': true, '3 hidden': false })
    expect(texts(tree)).toContain(t('toolsFilterNone'))
  })

  it('keeps the chips a reading while there is nobody to write a filter to', () => {
    const tree = view(demoTools())

    // No writer, no control: the block is the tree it drew before F-43.
    expect(chipsOf(tree)).toEqual({})
    expect(elements(tree).filter((element) => element.type === 'input')).toEqual([])
    expect(texts(tree)).toContain('1 pinned')
  })

  it('draws the query field, the caption and the Clear that hands the list back', () => {
    const tree = section({ query: 'grafana', tiers: [] })
    const fields = elements(tree).filter((element) => element.type === 'input')

    expect(fields).toHaveLength(1)
    expect(fields[0]?.props.value).toBe('grafana')
    expect(fields[0]?.props.placeholder).toBe(t('toolsFilterPlaceholder'))
    expect(texts(tree)).toContain(t('toolsFilterClear'))
    // Nothing is applied, so there is nothing to clear: the button is the state
    // of the filter, not furniture.
    expect(texts(section(NO_TOOL_FILTER))).not.toContain(t('toolsFilterClear'))
  })

  it('opens the hidden tier itself while the filter is on, and not before', () => {
    // Folded by default: the tier's names are not drawn at all.
    expect(words()).not.toContain('mcp__memory__search_nodes')
    // A query that found names inside the fold is an answer the user must be able
    // to read, so the tier opens itself rather than hiding its own matches.
    expect(words({ query: 'memory', tiers: [] })).toContain('mcp__memory__search_nodes')
    // A pressed tier is a filter too, and the list is what it asked for.
    expect(words({ query: '', tiers: ['hidden'] })).toContain('mcp__memory__search_nodes')
  })

  it('counts the matches under the hidden head while the filter narrows it', () => {
    const head = elements(section({ query: 'memory', tiers: [] })).find(
      (element) =>
        element.props['aria-expanded'] === true &&
        texts(element).join('').includes(t('toolsGroupHidden')),
    )

    // The head answers for the list under it — one name — while the chip above
    // keeps the tier's own total of three. Two readings, each true.
    expect(texts(head).join('')).toBe(`▾ ${t('toolsGroupHidden')}1`)
    expect(words({ query: 'memory', tiers: [] })).toContain('3 hidden')
  })

  it('lets the user’s own press of the hidden head outrank the filter that opened it', () => {
    // Nobody pressed the head: the filter opens the tier, because the matches
    // are the answer to the query.
    expect(words({ query: 'memory', tiers: [] })).toContain('mcp__memory__search_nodes')
    // The head says `false`: the choice stands over the filter, and over the
    // state the panel returns to when the filter is dropped.
    const closed = texts(
      view(demoTools(), 'session-aaa11111', {
        filter: { query: 'memory', tiers: [] },
        openHidden: false,
      }),
    ).join(' | ')
    expect(closed).not.toContain('mcp__memory__search_nodes')
    expect(
      texts(view(demoTools(), 'session-aaa11111', { filter: NO_TOOL_FILTER, openHidden: false })).join(
        ' | ',
      ),
    ).not.toContain('mcp__memory__search_nodes')
  })

  it('writes the button reset before the plate it would otherwise wipe', () => {
    // `font` is a shorthand: React writes an inline style in the object's own
    // order, so a `font: inherit` written after `fontFamily` / `fontSize` resets
    // both and the chip computes to the shell's sans face while its twin — the
    // same words as {@link STYLE.tag} — stays mono. One line of order, so it is
    // asserted rather than trusted.
    const keys = Object.keys(STYLE.filterChip)

    expect(keys.indexOf('font')).toBeLessThan(keys.indexOf('fontFamily'))
    expect(keys.indexOf('font')).toBeLessThan(keys.indexOf('fontSize'))
    expect(STYLE.filterChip.fontFamily).toBe(STYLE.tag.fontFamily)
    expect(STYLE.filterChip.fontSize).toBe(STYLE.tag.fontSize)
  })

  it('draws no filter row at all while there is no writer for it', () => {
    // No writer and nothing applied: nothing to draw.
    expect(resolve(ToolsFilter({ filter: NO_TOOL_FILTER, shown: 6, total: 6, t }))).toBeNull()
    // A filter the block was handed without a writer still hides rows, and the
    // caption is what says so — the field and the Clear are what is missing.
    const captionOnly = resolve(
      ToolsFilter({ filter: { query: 'grafana', tiers: [] }, shown: 1, total: 6, t }),
    )
    expect(texts(captionOnly)).toEqual([t('toolsFilterShown', { shown: 1, total: 6 })])
    expect(elements(captionOnly).filter((element) => element.type === 'input')).toEqual([])
  })
})
/**
 * The server-level pin (F-44): one press for a whole server's names, on the
 * lines where a server is the unit the reader sees.
 *
 * The store behind it holds names and nothing else — there is no server pin in
 * the policy — so this unit is an expansion, and the two helpers below are the
 * whole rule both surfaces share.
 */
describe('the server-level pin (F-44)', () => {
  const NAMES = ['mcp__tglider__symbol', 'mcp__tglider__graph']

  it('reads one server’s pins as a proportion, not a flag', () => {
    expect(serverPinState(NAMES, [])).toBe('none')
    expect(serverPinState(NAMES, ['mcp__tglider__symbol'])).toBe('some')
    expect(serverPinState(NAMES, [...NAMES, 'mcp__other__task'])).toBe('all')
    // A control over no names is not a control: an empty set reads `none`, so
    // its caller draws nothing rather than a switch that can write nothing.
    expect(serverPinState([], [])).toBe('none')
  })

  it('completes a set it does not wholly hold, and releases only a whole one', () => {
    expect(serverPinPress(NAMES, [])).toEqual({ pinned: true, names: NAMES })
    // A half-pinned server adds what it is missing: one press never drops a pin
    // the user wrote by hand.
    expect(serverPinPress(NAMES, ['mcp__tglider__symbol'])).toEqual({
      pinned: true,
      names: ['mcp__tglider__graph'],
    })
    expect(serverPinPress(NAMES, NAMES)).toEqual({ pinned: false, names: NAMES })
    // An empty set is the one case with nothing to write, so its direction can
    // never be spent: the batch is empty either way, and callers draw no control
    // over a set they cannot name (`serverPinState([])` reads `none`).
    expect(serverPinPress([], []).names).toEqual([])
  })

  it('puts one press for a whole server on that server’s own line', () => {
    const calls: [string, readonly string[]][] = []
    const tree = resolve(
      HiddenTier({
        count: NAMES.length,
        servers: [{ server: 'tglider', names: NAMES, count: NAMES.length }],
        open: true,
        onToggle: () => undefined,
        onChange: () => undefined,
        onPinServer: (server, names) => calls.push([server, names]),
        pending: false,
        t,
      }),
    )
    const press = button(tree, t('toolsPinAll'))

    // The label stays the reading it was, and the action sits beside it.
    expect(texts(tree)).toContain(`tglider · ${NAMES.length}`)
    expect(press).toBeDefined()
    ;(press?.props.onClick as () => void)()
    expect(calls).toEqual([['tglider', NAMES]])
  })

  it('says Unpin all for a group that is already wholly pinned', () => {
    // Mode `off` is where this happens: the host defers the pinned names too, so
    // a server's group can stand wholly pinned — and a button that kept saying
    // `Pin all` while it released them would be the one lie this list cannot tell.
    const pinned = resolve(
      HiddenTier({
        count: NAMES.length,
        servers: [{ server: 'tglider', names: NAMES, count: NAMES.length }],
        open: true,
        onToggle: () => undefined,
        onPinServer: () => undefined,
        pins: NAMES,
        pending: false,
        t,
      }),
    )
    const half = resolve(
      HiddenTier({
        count: NAMES.length,
        servers: [{ server: 'tglider', names: NAMES, count: NAMES.length }],
        open: true,
        onToggle: () => undefined,
        onPinServer: () => undefined,
        pins: [NAMES[0] as string],
        pending: false,
        t,
      }),
    )

    expect(button(pinned, t('toolsUnpinAll'))).toBeDefined()
    expect(button(pinned, t('toolsPinAll'))).toBeUndefined()
    // A half-pinned set is completed, not released: the first word stays.
    expect(button(half, t('toolsPinAll'))).toBeDefined()
    expect(button(half, t('toolsUnpinAll'))).toBeUndefined()
  })

  it('groups the pinned names by their server, biggest group first', () => {
    const groups = pinnedByServer([
      'mcp__tglider__workspace',
      'mcp__memory__search_nodes',
      'mcp__tglider__symbol',
      'no-registry-prefix-here',
    ])

    // The same grouping the hidden tier uses, so one block orders its two lists
    // alike; a name without the registry's prefix is its own real group rather
    // than a row that vanishes.
    expect(groups.map((group) => [group.server, group.count, [...group.names]])).toEqual([
      ['tglider', 2, ['mcp__tglider__workspace', 'mcp__tglider__symbol']],
      ['memory', 1, ['mcp__memory__search_nodes']],
      ['unknown', 1, ['no-registry-prefix-here']],
    ])
    expect(pinnedByServer([])).toEqual([])
  })

  it('draws one release per server over the pinned names, with their own rows', () => {
    const calls: [string, readonly string[]][] = []
    const tree = view(demoTools({ baseline: ['mcp__tglider__workspace'] }), 'session-aaa11111', {
      policy: policy('disclosure', [
        'mcp__tglider__workspace',
        'mcp__tglider__symbol',
        'mcp__memory__search_nodes',
      ]),
      onPin: () => undefined,
      onPinServer: (server, names) => calls.push([server, names]),
    })
    const releases = elements(tree).filter(
      (element) => element.type === 'button' && texts(element).join('') === t('toolsUnpinAll'),
    )

    // One release per server, on the server's own line, and the per-name
    // `Unpin` rows are still there beside it. The bigger group leads, and the
    // names inside it keep the order the user pinned them in.
    expect(texts(tree)).toContain(`tglider · 2`)
    expect(texts(tree)).toContain(`memory · 1`)
    expect(releases).toHaveLength(2)
    ;(releases[0]?.props.onClick as () => void)()
    expect(calls).toEqual([['tglider', ['mcp__tglider__workspace', 'mcp__tglider__symbol']]])
  })

  it('draws no release line while there is nobody to write it to', () => {
    const tree = view(demoTools(), 'session-aaa11111', { policy: POLICY })

    expect(
      elements(tree).filter(
        (element) => element.type === 'button' && texts(element).join('') === t('toolsUnpinAll'),
      ),
    ).toEqual([])
    // The pinned name's own `Unpin` stays: the tier is still the pin list.
    expect(button(tree, t('toolsUnpin'))).toBeDefined()
  })

  it('draws no server press while there is nobody to write it to', () => {
    const tree = resolve(
      HiddenTier({
        count: NAMES.length,
        servers: [{ server: 'tglider', names: NAMES, count: NAMES.length }],
        open: true,
        onToggle: () => undefined,
        pending: false,
        t,
      }),
    )

    expect(button(tree, t('toolsPinAll'))).toBeUndefined()
    expect(texts(tree)).toContain('mcp__tglider__symbol')
  })
})
