/**
 * Panel view model: the project-level merge plus the per-session breakdown.
 *
 * These checks stay on plain React element trees — no DOM, no renderer — so they
 * run in the same node environment as the rest of the suite. They assert what a
 * user would read: which session is this tab's, what each session has mounted,
 * and that the merged rows still come first.
 */

import { describe, expect, it } from 'vitest'
import type { CSSProperties } from 'react'
import type { LogEvent, McpSnapshot, ProjectSnapshot, ServerRow, SessionSnapshot } from '../src/types.ts'
import type { SessionBreakdown, Translate } from '../src/client/view.ts'
import {
  DEFAULT_LOG_LEVEL,
  DEFAULT_LOG_SCOPE,
  Disclosure,
  INDENT,
  IssueView,
  LOGS_CLEARED_KEY,
  LOG_LEVEL_KEY,
  LOG_PAGE_SIZE,
  LOG_SCOPE_KEY,
  LogsView,
  PanelHeader,
  ProjectBlock,
  STATUS_COLOR,
  ServersBlock,
  SessionList,
  ToolsSection,
  ToolsView,
  currentProject,
  fetchLogs,
  fallbackTranslate,
  logFacts,
  logLevelOf,
  logList,
  logRow,
  logScopeOf,
  logVisible,
  logsClearedAt,
  logsEmptyState,
  logsPaging,
  mergeLogs,
  panelSummary,
  persistLogFilter,
  persistLogsClearedAt,
  projectIssueLines,
  serverRow,
  sessionBreakdown,
  sessionDeviates,
  sessionEntry,
  sessionLogCount,
  sessionRows,
  sessionsHeader,
  sessionsSummary,
  shortTransport,
  statusGroups,
  tabBody,
  toolRow,
  translateOf,
} from '../src/client/view.ts'

const t = translateOf()

/** One log event of this project, the way the host publishes it. */
function event(overrides: Partial<LogEvent> = {}): LogEvent {
  return {
    at: 1_700_000_000_000,
    level: 'info',
    projectRoot: '/repo',
    sessionId: 'session-aaa11111',
    message: 'mounting /repo (project)',
    ...overrides,
  }
}

/** The colour of every status dot in a tree, in tree order. */
function dotColors(node: unknown): unknown[] {
  return elements(node)
    .filter((element) => element.props['aria-hidden'] === true)
    .map((element) => (element.props.style as CSSProperties).background)
}

/** The element that carries a row's detail text, wherever it sits in the tree. */
function bannerOf(node: unknown, detail: string): Element | undefined {
  return elements(node).find((element) => element.props.children === detail)
}

/**
 * Invoke the pure function components in a tree, for the walkers to see the
 * elements they produce. Only for trees without a hook-bearing component in
 * them: the sessions section owns state, so it is asserted through
 * {@link sessionsHeader} instead.
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

function row(name: string, status: ServerRow['status']): ServerRow {
  return { name, status, projectRoot: '/repo' }
}

function session(id: string, rows: ServerRow[]): SessionSnapshot {
  return { id, rows, issues: [] }
}

/** Two sessions in one project: the first idle, the second holding the mount. */
const PROJECT: ProjectSnapshot = {
  projectRoot: '/repo',
  sessionIds: ['session-aaa11111', 'session-bbb22222'],
  rows: [row('alpha', 'active'), row('beta', 'idle')],
  issues: [],
  sessions: [
    session('session-aaa11111', [row('alpha', 'idle'), row('beta', 'idle')]),
    session('session-bbb22222', [row('alpha', 'active')]),
  ],
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

/**
 * Every element of a tree that carries a rung of the indentation ladder, in tree
 * order, with the text under it. An unresolvable component in the tree (the
 * sessions section owns state) simply contributes no rungs of its own.
 */
function rungs(node: unknown): { paddingLeft: unknown; text: string }[] {
  return elements(node).flatMap((element) => {
    const paddingLeft = (element.props.style as CSSProperties | undefined)?.paddingLeft
    return paddingLeft === undefined ? [] : [{ paddingLeft, text: texts(element).join(' ') }]
  })
}

describe('sessionBreakdown', () => {
  it('splits one project into per-session views and marks this tab’s session', () => {
    const sessions = sessionBreakdown(PROJECT, 'session-bbb22222')

    expect(sessions.map((entry) => [entry.id, entry.current, entry.summary, entry.deviates])).toEqual(
      [
        ['session-aaa11111', false, '2 idle', true],
        ['session-bbb22222', true, '1 active', true],
      ],
    )
  })

  it('marks no session as deviating while they all read like the project', () => {
    const agreeing: ProjectSnapshot = {
      ...PROJECT,
      sessions: [
        session('session-aaa11111', PROJECT.rows),
        session('session-bbb22222', PROJECT.rows),
      ],
    }

    expect(sessionBreakdown(agreeing, 'session-aaa11111').map((entry) => entry.deviates)).toEqual([
      false,
      false,
    ])
  })

  it('summarizes a session that declared nothing', () => {
    const [only] = sessionBreakdown(
      { ...PROJECT, sessions: [session('session-ccc', [])] },
      undefined,
    )

    expect(only?.summary).toBe('nothing declared')
    expect(only?.current).toBe(false)
    // A session that claims nothing is not a session that disagrees.
    expect(only?.deviates).toBe(false)
  })

  it('tolerates a host half that predates the per-session field', () => {
    const older = { ...PROJECT, sessions: undefined } as unknown as ProjectSnapshot

    expect(sessionBreakdown(older, 'session-aaa11111')).toEqual([])
  })

  it('tolerates a session entry the host published without its own rows', () => {
    const older = {
      ...PROJECT,
      sessions: [{ id: 'session-aaa11111' }],
    } as unknown as ProjectSnapshot

    expect(sessionBreakdown(older, 'session-aaa11111')).toEqual([
      {
        id: 'session-aaa11111',
        current: true,
        rows: [],
        summary: 'nothing declared',
        deviates: false,
      },
    ])
  })
})

describe('sessionDeviates', () => {
  const project = [row('alpha', 'active'), row('beta', 'idle')]

  it('reads a status flipped in either direction as a disagreement', () => {
    expect(sessionDeviates(project, [row('alpha', 'idle'), row('beta', 'idle')])).toBe(true)
    expect(sessionDeviates([row('alpha', 'idle'), row('beta', 'idle')], project)).toBe(true)
  })

  it('reads a server present on one side only as a disagreement', () => {
    expect(sessionDeviates(project, [row('alpha', 'active')])).toBe(true)
    expect(sessionDeviates([row('alpha', 'active')], project)).toBe(true)
  })

  it('counts neither a different order nor a repeated name as a disagreement', () => {
    expect(
      sessionDeviates(project, [
        row('beta', 'idle'),
        row('alpha', 'active'),
        row('alpha', 'active'),
      ]),
    ).toBe(false)
  })

  it('reads one name declared with two statuses as a disagreement, in either order', () => {
    expect(
      sessionDeviates([row('alpha', 'active')], [row('alpha', 'active'), row('alpha', 'idle')]),
    ).toBe(true)
    // The same pair the other way round inside one list: the verdict is read
    // from the set of statuses a name was declared with, so which declaration
    // happens to come last cannot decide it. A `name → last status` map — the
    // shape this replaced — answers `false` here.
    expect(
      sessionDeviates([row('alpha', 'active')], [row('alpha', 'idle'), row('alpha', 'active')]),
    ).toBe(true)
    expect(
      sessionDeviates([row('alpha', 'active'), row('alpha', 'idle')], [row('alpha', 'active')]),
    ).toBe(true)
    // Twice with the same status is still one reading, not two.
    expect(
      sessionDeviates([row('alpha', 'active')], [row('alpha', 'active'), row('alpha', 'active')]),
    ).toBe(false)
  })

  it('never disagrees with a session that declared nothing', () => {
    expect(sessionDeviates(project, [])).toBe(false)
    expect(sessionDeviates([], [])).toBe(false)
  })
})

describe('ProjectBlock', () => {
  it('shows the merged rows first and hands the breakdown to the session list', () => {
    const element = ProjectBlock({
      project: PROJECT,
      currentSessionId: 'session-bbb22222',
      busy: false,
      onRelease: () => undefined,
      t,
    })
    const text = texts(element).join(' | ')

    expect(text).toContain('repo')
    // The head is the folder and the chip; the count and the merged summary
    // moved into the collapsed sessions section below the rows.
    expect(text).toContain('this session')
    expect(text).toContain('beta')
    // The merge is what the project reports as a whole, not one session's view,
    // and a row says so with its dot rather than with the status word.
    expect(dotColors(element)).toEqual([STATUS_COLOR.active, STATUS_COLOR.idle])

    const list = elements(element).find((node) => Array.isArray(node.props.sessions))
    expect((list?.props.sessions as { id: string }[]).map((entry) => entry.id)).toEqual([
      'session-aaa11111',
      'session-bbb22222',
    ])
    expect(typeof list?.props.onRelease).toBe('function')
    expect(list?.props.busy).toBe(false)
    expect(list?.props.merged).toBe(true)
  })

  it('hands the session list only the sessions that disagree with the project', () => {
    const project: ProjectSnapshot = {
      ...PROJECT,
      sessions: [
        // Reads like the merged rows: nothing to explain.
        session('session-aaa11111', PROJECT.rows),
        // Holds alpha, but not the beta the project merged.
        session('session-bbb22222', [row('alpha', 'active')]),
      ],
    }
    const element = ProjectBlock({
      project,
      currentSessionId: 'session-bbb22222',
      busy: false,
      onRelease: () => undefined,
      t,
    })
    const list = elements(element).find((node) => Array.isArray(node.props.sessions))
    const sessions = list?.props.sessions as SessionBreakdown[]

    expect(sessions.map((entry) => [entry.id, entry.deviates])).toEqual([
      ['session-bbb22222', true],
    ])
    // The rows above are still the merge of both sessions, so the note stands.
    expect(list?.props.merged).toBe(true)
  })

  it('hands an empty session list while nothing disagrees', () => {
    const project: ProjectSnapshot = {
      ...PROJECT,
      sessions: [
        session('session-aaa11111', PROJECT.rows),
        session('session-bbb22222', PROJECT.rows),
        // A session that claims nothing never disagrees, either.
        session('session-ccc33333', []),
      ],
    }
    const element = ProjectBlock({
      project,
      currentSessionId: 'session-aaa11111',
      busy: false,
      onRelease: () => undefined,
      t,
    })
    const list = elements(element).find((node) => Array.isArray(node.props.sessions))

    // The component that would draw the section is handed nothing; that it then
    // renders no header and no rows is the DOM spec's reading to take.
    expect(list?.props.sessions).toEqual([])
    // The project's own rows are what is left, headed by its folder.
    expect(texts(element).join(' | ')).toContain('repo')
    expect(texts(element).join(' | ')).toContain('alpha')
  })

  it('drops the merge note for a project of one session, even a disagreeing one', () => {
    const project: ProjectSnapshot = {
      ...PROJECT,
      // Holds alpha, but not the beta the project merged: the one session is out
      // of step, and still there is no other session for the rows to be merged
      // across.
      sessions: [session('session-aaa11111', [row('alpha', 'active')])],
    }
    const element = ProjectBlock({
      project,
      currentSessionId: 'session-aaa11111',
      busy: false,
      onRelease: () => undefined,
      t,
    })
    const list = elements(element).find((node) => Array.isArray(node.props.sessions))

    expect((list?.props.sessions as SessionBreakdown[]).map((entry) => entry.id)).toEqual([
      'session-aaa11111',
    ])
    expect(list?.props.merged).toBe(false)
  })

  it('does not claim a current session when the tab has none', () => {
    const element = ProjectBlock({
      project: PROJECT,
      busy: false,
      onRelease: () => undefined,
      t,
    })

    expect(texts(element).join(' | ')).not.toContain('this session')
  })

  it('leaves the project unnamed when the surface above already names it', () => {
    const named = texts(ProjectBlock({ project: PROJECT, busy: false, onRelease: () => undefined, t }))
    const bare = texts(
      ProjectBlock({ project: PROJECT, busy: false, onRelease: () => undefined, showName: false, t }),
    )

    expect(named).toContain('repo')
    expect(bare).not.toContain('repo')
    expect(bare).toContain('alpha')
  })
})

describe('the sessions section', () => {
  it('carries the whole answer while it is collapsed', () => {
    const sessions = sessionBreakdown(PROJECT, 'session-bbb22222')
    const header = sessionsHeader({ sessions, open: false, onToggle: () => undefined, merged: true, t })
    const text = texts(header)

    expect(text).toEqual(['▸ sessions', '2 differ', '1 active, 2 idle', 'merged across sessions'])
    expect((elements(header).find((node) => node.type === 'button')?.props['aria-expanded'])).toBe(false)
  })

  it('counts what disagrees as `1 differs`, never as one session', () => {
    const sessions = sessionBreakdown(PROJECT, 'session-bbb22222').slice(0, 1)
    const text = texts(sessionsHeader({ sessions, open: true, onToggle: () => undefined, t }))

    expect(text).toEqual(['▾ sessions', '1 differs', '2 idle'])
  })

  it('keeps the merge note for a project of several sessions with one out of step', () => {
    const project: ProjectSnapshot = {
      ...PROJECT,
      sessions: [
        session('session-aaa11111', PROJECT.rows),
        session('session-bbb22222', [row('alpha', 'active')]),
      ],
    }
    const block = ProjectBlock({ project, busy: false, onRelease: () => undefined, t })
    const list = elements(block).find((node) => Array.isArray(node.props.sessions))
    const text = texts(
      sessionsHeader({
        sessions: list?.props.sessions as SessionBreakdown[],
        open: false,
        onToggle: () => undefined,
        merged: list?.props.merged === true,
        t,
      }),
    )

    // The chip counts the one deviating session; the note is about the rows
    // above, which are the merge of both.
    expect(text).toContain('1 differs')
    expect(text).toContain(t('mergedAcrossSessions'))
  })

  it('reads the listed sessions’ own rows as one summary', () => {
    expect(sessionsSummary(sessionBreakdown(PROJECT, undefined))).toBe('1 active, 2 idle')
    expect(sessionsSummary([])).toBe('nothing declared')
  })

  it('summarizes through the translate seat, the count a placeholder of the template', () => {
    // A seat whose `summaryActive` template answers in another language and
    // puts the count after the word: the line must follow the template, so no
    // language is ever read a concatenation.
    const seat: Translate = (key, params) =>
      key === 'summaryActive'
        ? `активных: ${String(params?.count)}`
        : fallbackTranslate(key, params)

    expect(sessionsSummary(sessionBreakdown(PROJECT, undefined, seat), seat)).toBe(
      'активных: 1, 2 idle',
    )
    expect(sessionsSummary([], seat)).toBe('nothing declared')
  })
})

describe('the servers surface’s indentation ladder', () => {
  const sessions = sessionBreakdown(PROJECT, 'session-bbb22222')
  const block = (): unknown =>
    ProjectBlock({
      project: PROJECT,
      currentSessionId: 'session-bbb22222',
      busy: false,
      onRelease: () => undefined,
      t,
    })
  const entry = (expanded: boolean, index = 1): unknown =>
    sessionEntry({
      session: sessions[index]!,
      expanded,
      onToggle: () => undefined,
      busy: false,
      onRelease: () => undefined,
      t,
    })

  it('is one 12px step per nesting level: project 0 · sessions 12 · session 24 · servers 36', () => {
    const header = sessionsHeader({ sessions, open: false, onToggle: () => undefined, t })

    expect(INDENT).toBe(12)
    expect(rungs(block()).map((rung) => rung.paddingLeft)).toEqual([0])
    expect(rungs(header).map((rung) => rung.paddingLeft)).toEqual([12])
    // The session row and, under it, the servers that session holds.
    expect(rungs(entry(true)).map((rung) => rung.paddingLeft)).toEqual([24, 36])
  })

  it('keeps the four levels readable without the indent: the same text, one step further in', () => {
    const [project] = rungs(block())
    const [section] = rungs(sessionsHeader({ sessions, open: false, onToggle: () => undefined, t }))
    const [sessionRow, servers] = rungs(entry(true))

    expect(project?.text).toContain('alpha')
    expect(section?.text).toContain('sessions')
    expect(sessionRow?.text).toContain('this session')
    expect(servers?.text).toContain('alpha')
  })

  it('hides a collapsed session’s servers instead of merely unindenting them', () => {
    expect(rungs(entry(false)).map((rung) => rung.paddingLeft)).toEqual([24])
    expect(texts(entry(false)).join(' ')).not.toContain('alpha')
  })

  it('shows the fold marker on a collapsed session row only', () => {
    // `docs/design/mockups/harness.html`: an expanded row has already opened, and the marker
    // is the state of the fold, not decoration on every row.
    const marker = (expanded: boolean): string =>
      texts(elements(entry(expanded)).find((element) => element.props['aria-expanded'] !== undefined) ?? null).join('')

    expect(marker(true)).not.toContain('▾')
    expect(marker(true)).not.toContain('▸')
    expect(marker(true)).toContain('bbb222')
    expect(marker(false)).toContain('▸')
  })
})

describe('the tab’s toolbar', () => {
  const base = {
    project: PROJECT,
    sessions: 2,
    busy: false,
    onSync: () => undefined,
    t,
  }

  it('names the project and chips this session, with the summary on the right', () => {
    expect(texts(resolve(PanelHeader(base)))).toEqual([
      'repo',
      'this session',
      'Sync',
      '2 sessions',
    ])
  })

  it('carries no switch and no action but Sync, because the bar is gone (F-26)', () => {
    const bar = resolve(PanelHeader(base))

    expect(elements(bar).filter((element) => element.type === 'button')).toHaveLength(1)
    expect(
      elements(bar).filter((element) => element.props['aria-pressed'] !== undefined),
    ).toEqual([])
    // `Retry failed` is the errors block's own action now, not this row's.
    expect(texts(bar)).not.toContain('Retry failed')
  })

  it('leaves the project unnamed and unchipped, and still syncs, without one', () => {
    const synced: string[] = []
    const bar = resolve(
      PanelHeader({ ...base, project: undefined, sessions: 0, onSync: () => synced.push('sync') }),
    )

    expect(texts(bar)).toEqual(['no project', 'Sync', '0 sessions'])
    ;(elements(bar).find((element) => element.type === 'button')?.props.onClick as () => void)()
    expect(synced).toEqual(['sync'])
  })
})

describe('the server row', () => {
  it('reads the status as a dot, the transport as a chip and nothing else', () => {
    const rows = serverRow(
      { name: 'tglider', status: 'active', transport: 'streamable-http', projectRoot: '/repo' },
      'row',
      { t },
    )

    expect(texts(rows)).toEqual(['tglider', 'http'])
    expect(dotColors(rows)).toEqual([STATUS_COLOR.active])
    expect(bannerOf(rows, 'no tool in 60.2s')).toBeUndefined()
  })

  it('chips a quiet state and dims the row without shrinking it', () => {
    const rows = serverRow(
      { name: 'rider', status: 'idle', transport: 'stdio', projectRoot: '/repo' },
      'row',
      { t },
    )
    const row = elements(rows)[0]

    expect(texts(rows)).toEqual(['rider', 'stdio', 'idle'])
    expect(dotColors(rows)).toEqual([STATUS_COLOR.idle])
    expect((row?.props.style as CSSProperties).opacity).toBe(0.6)
  })

  it('retries a broken row in place and shows its detail in a banner', () => {
    const retried: string[] = []
    const detail = [
      'gateway: no tool appeared in 60.2s',
      'endpoint: stdio docker',
      'declared in: /repo/.dsh/mcp.json',
      'hint: a stdio server that exits on startup prints the reason on stderr — see the DSH log',
      'projectMcp.retry() restarts this mount from scratch',
    ].join('\n')
    const rows = serverRow(
      {
        name: 'gateway',
        status: 'error',
        transport: 'stdio',
        detail,
        projectRoot: '/repo',
      },
      'row',
      { onRetry: () => retried.push('retry'), t },
    )
    const retry = elements(rows).find((element) => element.type === 'button')

    expect(texts(rows)).toEqual(['gateway', 'stdio', 'Retry', detail])
    ;(retry?.props.onClick as () => void)()
    expect(retried).toEqual(['retry'])

    const banner = bannerOf(rows, detail)
    expect((banner?.props.style as CSSProperties).borderLeft).toContain('state-error-primary')
    // The detail is a multi-line diagnostic; without pre-wrap the browser
    // collapses it back into the run-on line this format exists to replace.
    expect((banner?.props.style as CSSProperties).whiteSpace).toBe('pre-wrap')
  })

  it('carries no Retry when nothing can be written, and warns rather than fails', () => {
    const rows = serverRow(
      { name: 'gateway', status: 'error', projectRoot: '/repo' },
      'row',
      { t },
    )
    const conflict = serverRow(
      { name: 'context7', status: 'conflict', detail: 'the name is taken', projectRoot: '/repo' },
      'row',
      { t },
    )

    expect(elements(rows).some((element) => element.type === 'button')).toBe(false)
    const banner = bannerOf(conflict, 'the name is taken')
    expect((banner?.props.style as CSSProperties).borderLeftColor).toContain('state-warn-primary')
  })

  it('keeps the short transport beside the full one the table prints', () => {
    expect(shortTransport('streamable-http')).toBe('http')
    expect(shortTransport('stdio')).toBe('stdio')
    expect(shortTransport('sse')).toBe('sse')
  })
})

describe('issues a row already carries', () => {
  const issues = [
    { source: '/repo', server: 'gateway', level: 'error' as const, message: 'no tool appeared' },
    { source: '/repo', level: 'warning' as const, message: 'declared twice' },
  ]

  it('drops the issue a row’s own banner repeats', () => {
    const project: ProjectSnapshot = {
      ...PROJECT,
      rows: [
        { name: 'gateway', status: 'error', detail: 'no tool appeared', projectRoot: '/repo' },
        row('alpha', 'active'),
      ],
      issues,
    }

    expect(projectIssueLines(project)).toEqual([issues[1]])
  })

  it('keeps the issue when the row carries no detail of its own', () => {
    const project: ProjectSnapshot = {
      ...PROJECT,
      rows: [row('gateway', 'error')],
      issues,
    }

    expect(projectIssueLines(project)).toEqual(issues)
  })
})

describe('the project issue line (F-48)', () => {
  const project = (issue: ProjectSnapshot['issues'][number]): ProjectSnapshot => ({
    ...PROJECT,
    rows: [],
    issues: [issue],
  })

  it('renders a coded issue through the host seat, params substituted', () => {
    const hostT: Translate = (key, params) =>
      key === 'parse.server.multiDocument'
        ? `serverName "${String(params?.name ?? '')}" объявлен более чем в одном документе`
        : key
    const element = ProjectBlock({
      project: project({
        source: '/repo',
        server: 'tglider',
        level: 'warning',
        message:
          'serverName "tglider" was declared in more than one document; the highest-priority definition wins',
        code: 'parse.server.multiDocument',
        params: { name: 'tglider' },
      }),
      busy: false,
      onRelease: () => undefined,
      t,
      hostT,
    })
    expect(texts(element).join(' | ')).toContain(
      'warning: serverName "tglider" объявлен более чем в одном документе',
    )
  })

  it('falls back to the payload prose without a host seat, never to the raw code', () => {
    const element = ProjectBlock({
      project: project({
        source: '/repo',
        level: 'error',
        message: 'expected an object with an "mcpServers" object',
        code: 'parse.doc.notObject',
      }),
      busy: false,
      onRelease: () => undefined,
      t,
    })
    const text = texts(element).join(' | ')
    expect(text).toContain('error: expected an object with an "mcpServers" object')
    expect(text).not.toContain('parse.doc.notObject')
  })

  it('renders an uncoded issue exactly as before', () => {
    const element = ProjectBlock({
      project: project({ source: '/repo', level: 'warning', message: 'declared twice' }),
      busy: false,
      onRelease: () => undefined,
      t,
    })
    expect(texts(element).join(' | ')).toContain('warning: declared twice')
  })
})

describe('sessionRows', () => {
  it('renders one session’s own rows, not the merged ones', () => {
    const sessions = sessionBreakdown(PROJECT, undefined)
    const idle = sessions[0]
    const busy = sessions[1]

    expect(idle === undefined || busy === undefined).toBe(false)
    const idleRows = sessionRows(idle!, t)
    const busyRows = sessionRows(busy!, t)

    expect(texts(idleRows).join(' | ')).toContain('idle')
    expect(texts(idleRows).join(' | ')).toContain('beta')
    expect(dotColors(idleRows)).toEqual([STATUS_COLOR.idle, STATUS_COLOR.idle])
    expect(dotColors(busyRows)).toEqual([STATUS_COLOR.active])
    expect(texts(busyRows).join(' | ')).not.toContain('beta')
  })

  it('says so when a session declared nothing', () => {
    const [only] = sessionBreakdown({ ...PROJECT, sessions: [session('session-ccc', [])] }, undefined)

    expect(texts(sessionRows(only!))).toEqual(['nothing declared'])
  })
})

/** In-memory stand-in for `localStorage`, so these checks need no DOM. */
function memoryStorage(initial: Record<string, string> = {}): {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  values: Record<string, string>
} {
  const values: Record<string, string> = { ...initial }
  return {
    values,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value
    },
  }
}

function snapshotOf(...projects: ProjectSnapshot[]): McpSnapshot {
  return { ready: true, projects, watchedFiles: [] }
}

describe('currentProject', () => {
  it('picks the one project whose sessions include this tab’s session', () => {
    const elsewhere: ProjectSnapshot = {
      ...PROJECT,
      projectRoot: '/elsewhere',
      sessionIds: ['session-zzz'],
      sessions: [session('session-zzz', [])],
    }

    expect(currentProject(snapshotOf(elsewhere, PROJECT), 'session-bbb22222')?.projectRoot).toBe(
      '/repo',
    )
  })

  it('finds it through sessionIds when the host half has no per-session field', () => {
    const older = { ...PROJECT, sessions: undefined } as unknown as ProjectSnapshot

    expect(currentProject(snapshotOf(older), 'session-aaa11111')?.projectRoot).toBe('/repo')
  })

  it('returns nothing for another session, a tab without one, or before the first poll', () => {
    expect(currentProject(snapshotOf(PROJECT), 'session-zzz')).toBeUndefined()
    expect(currentProject(snapshotOf(PROJECT), undefined)).toBeUndefined()
    expect(currentProject(undefined, 'session-aaa11111')).toBeUndefined()
  })

  it('never falls back to another project that happens to have servers', () => {
    const elsewhere: ProjectSnapshot = {
      ...PROJECT,
      projectRoot: '/elsewhere',
      sessionIds: ['session-zzz'],
      sessions: [session('session-zzz', [row('other', 'error')])],
    }

    expect(currentProject(snapshotOf(elsewhere), 'session-aaa11111')).toBeUndefined()
  })
})

describe('statusGroups', () => {
  it('groups the actionable statuses in triage order and drops the quiet ones', () => {
    const rows = [
      row('alpha', 'active'),
      row('beta', 'connecting'),
      row('gamma', 'error'),
      row('delta', 'conflict'),
      row('epsilon', 'idle'),
      row('zeta', 'disabled'),
    ]

    expect(
      statusGroups(rows).map((group) => [group.status, group.rows.map((entry) => entry.name)]),
    ).toEqual([
      ['error', ['gamma']],
      ['conflict', ['delta']],
      ['connecting', ['beta']],
    ])
  })

  it('is empty when every declared server is in a quiet state', () => {
    expect(statusGroups([row('alpha', 'active'), row('beta', 'idle')])).toEqual([])
  })
})

describe('tabBody', () => {
  const base = {
    project: PROJECT as ProjectSnapshot | undefined,
    sessionId: 'session-bbb22222' as string | undefined,
    groups: [] as ReturnType<typeof statusGroups>,
    busy: false,
    onRelease: () => undefined,
  }

  /** The top-level blocks of the one surface, a block that is not drawn as `null`. */
  const blocksOf = (props: Parameters<typeof tabBody>[0]): (Element | null)[] => {
    const body = tabBody(props)
    return (Array.isArray(body) ? body : [body]) as (Element | null)[]
  }

  const typesOf = (blocks: (Element | null)[]): unknown[] =>
    blocks.map((block) => (block === null ? null : block.type))

  it('lays the one surface out in the contract’s order', () => {
    expect(typesOf(blocksOf(base))).toEqual([
      ServersBlock,
      SessionList,
      ToolsSection,
      null,
      Disclosure,
    ])
  })

  it('draws this session’s own servers first, never the merged project rows', () => {
    // The merged rows hold alpha and beta; this session mounted alpha alone.
    const servers = blocksOf(base)[0] as Element

    expect(servers.props.rows).toEqual([row('alpha', 'active')])
  })

  it('hands the sessions section only the sessions that disagree', () => {
    // The merged rows are one session's own reading, so that session has nothing
    // to explain and only the other one may reach the section. Handing the list
    // every session would draw a row for the agreeing one as well, and this
    // fixture is what makes that visible: with two deviating sessions the check
    // would pass even if nothing were filtered.
    const agreeing = session('session-bbb22222', [row('alpha', 'active'), row('beta', 'idle')])
    const outOfStep = session('session-aaa11111', [row('alpha', 'idle'), row('beta', 'idle')])
    const split: ProjectSnapshot = {
      projectRoot: '/repo',
      sessionIds: [outOfStep.id, agreeing.id],
      rows: [...agreeing.rows],
      issues: [],
      sessions: [outOfStep, agreeing],
    }
    const list = blocksOf({ ...base, project: split })[1] as Element
    const listed = list.props.sessions as { id: string; deviates: boolean }[]

    // The agreeing session really does read like the merged rows, so its absence
    // below is the filter's doing and not an accident of the fixture.
    expect(sessionDeviates(split.rows, agreeing.rows)).toBe(false)
    expect(sessionDeviates(split.rows, outOfStep.rows)).toBe(true)
    // Both sessions feed the rows above, so the merge note is drawn; only the
    // one that disagrees is listed.
    expect(list.props.merged).toBe(true)
    expect(listed.map((entry) => entry.id)).toEqual(['session-aaa11111'])
    expect(listed.every((entry) => entry.deviates)).toBe(true)
  })

  it('hands the tools block this session, its policy and the pin action', () => {
    const calls: [string, boolean][] = []
    const tools = blocksOf({
      ...base,
      policy: { mode: 'disclosure', pins: [] },
      onPin: (tool: string, pinned: boolean) => calls.push([tool, pinned]),
    })[2] as Element

    expect(tools.props.sessionId).toBe('session-bbb22222')
    ;(tools.props.onPin as (tool: string, pinned: boolean) => void)('mcp__x__y', true)
    expect(calls).toEqual([['mcp__x__y', true]])
  })

  it('draws the errors block only while there are groups, with Retry inside it', () => {
    const project: ProjectSnapshot = { ...PROJECT, rows: [...PROJECT.rows, row('gamma', 'error')] }
    const groups = statusGroups(project.rows)

    expect(blocksOf(base)[3]).toBeNull()

    const loud = blocksOf({ ...base, project, groups, onRetry: () => undefined })[3] as Element
    expect(loud.type).toBe(Disclosure)
    expect(loud.props.label).toBe(t('errorsSection'))
    expect(loud.props.count).toBe(groups.length)
    const body = loud.props.body as (Element | null)[]
    expect(body[0]?.type).toBe(IssueView)
    expect(body[0]?.props.groups).toBe(groups)
    expect(texts(body[1])).toContain(t('retryFailed'))

    // With nothing that can be written the block carries the groups alone.
    const readOnly = blocksOf({ ...base, project, groups })[3] as Element
    expect((readOnly.props.body as (Element | null)[])[1]).toBeNull()
  })

  it('draws the logs block always, with this session’s own event count', () => {
    const logs = blocksOf({ ...base, sessionLogCount: 6 })[4] as Element

    expect(logs.type).toBe(Disclosure)
    expect(logs.props.label).toBe(t('logsSection'))
    expect(logs.props.count).toBe(6)
    expect((logs.props.body as Element).type).toBe(LogsView)
    // A host half that published no count draws a real zero, not a blank head.
    expect((blocksOf(base)[4] as Element).props.count).toBe(0)
  })

  it('names what is missing instead of listing nothing', () => {
    expect(texts(tabBody({ ...base, sessionId: undefined })).join(' ')).toContain(
      'No session is attached',
    )
    expect(texts(tabBody({ ...base, project: undefined })).join(' ')).toContain(
      'not inside a project',
    )
    // A session that declares nothing still gets every block below its own line.
    const empty = blocksOf({
      ...base,
      project: {
        ...PROJECT,
        rows: [],
        sessions: [{ id: 'session-bbb22222', rows: [], issues: [] }],
      },
    })

    expect(typesOf(empty)).toEqual(['div', SessionList, ToolsSection, null, Disclosure])
    expect(texts(empty[0]).join(' ')).toContain('declares no MCP servers')
  })
})

describe('the toolbar’s right edge', () => {
  it('reads the session’s count out of the snapshot, and zero without the field', () => {
    expect(sessionLogCount({ logCount: 6 })).toBe(6)
    expect(sessionLogCount({})).toBe(0)
    expect(sessionLogCount(undefined)).toBe(0)
  })

  it('carries the project’s session count and nothing mode-shaped', () => {
    // One screen means one phrase (F-26): every other count is badged on the
    // block it belongs to, so the toolbar never repeats one.
    expect(panelSummary({ sessions: 2 }, t)).toBe('2 sessions')
    expect(panelSummary({ sessions: 1 }, t)).toBe('1 session')
    expect(panelSummary({ sessions: 0 }, t)).toBe('0 sessions')
  })
})

describe('log filters', () => {
  const mine = event({ at: 4_000, level: 'error', sessionId: 'session-aaa11111' })
  const theirs = event({ at: 3_000, level: 'info', sessionId: 'session-bbb22222' })
  const mineInfo = event({ at: 2_000, level: 'info', sessionId: 'session-aaa11111' })
  const older = event({ at: 1_000, level: 'warn', sessionId: 'session-aaa11111' })

  it('keeps only this session when the tab asks for it', () => {
    const visible = logVisible({
      logs: [older, mineInfo, theirs, mine],
      scope: 'session',
      level: 'all',
      sessionId: 'session-aaa11111',
      clearedAt: undefined,
    })

    expect(visible.map((entry) => entry.at)).toEqual([4_000, 2_000, 1_000])
  })

  it('keeps every session when the tab asks for the whole project', () => {
    const visible = logVisible({
      logs: [older, mineInfo, theirs, mine],
      scope: 'all',
      level: 'all',
      sessionId: 'session-aaa11111',
      clearedAt: undefined,
    })

    expect(visible.map((entry) => entry.at)).toEqual([4_000, 3_000, 2_000, 1_000])
  })

  it('keeps only failures when the level filter is errors', () => {
    const visible = logVisible({
      logs: [older, mineInfo, theirs, mine],
      scope: 'all',
      level: 'error',
      sessionId: 'session-aaa11111',
      clearedAt: undefined,
    })

    expect(visible.map((entry) => entry.at)).toEqual([4_000])
  })

  it('drops everything the Clear mark covers, whatever the filters say', () => {
    // `at <= logsClearedAt` is not drawn: the mark is exclusive, so an event at
    // the exact millisecond of the click is cleared with the ones before it.
    const visible = logVisible({
      logs: [older, mineInfo, theirs, mine],
      scope: 'all',
      level: 'all',
      sessionId: 'session-aaa11111',
      clearedAt: 3_000,
    })

    expect(visible.map((entry) => entry.at)).toEqual([4_000])
    expect(
      logVisible({
        logs: [older],
        scope: 'session',
        level: 'all',
        sessionId: 'session-aaa11111',
        clearedAt: 1_000,
      }),
    ).toEqual([])
  })

  it('reads newest first, whatever order the ring handed over', () => {
    const visible = logVisible({
      logs: [mine, older, theirs, mineInfo],
      scope: 'all',
      level: 'all',
      sessionId: 'session-aaa11111',
      clearedAt: undefined,
    })

    expect(visible.map((entry) => entry.at)).toEqual([4_000, 3_000, 2_000, 1_000])
  })
})

describe('log filter storage', () => {
  it('defaults to this session and errors only, and round-trips both', () => {
    const storage = memoryStorage()

    // The owner's call: the tab answers "did anything break" before anything
    // else, so the level that is read when nothing is stored is `errors`.
    expect(DEFAULT_LOG_LEVEL).toBe('error')
    expect(logScopeOf(storage)).toBe(DEFAULT_LOG_SCOPE)
    expect(logLevelOf(storage)).toBe(DEFAULT_LOG_LEVEL)
    persistLogFilter(LOG_SCOPE_KEY, 'all', storage)
    persistLogFilter(LOG_LEVEL_KEY, 'all', storage)
    expect(storage.values[LOG_SCOPE_KEY]).toBe('all')
    expect(storage.values[LOG_LEVEL_KEY]).toBe('all')
    expect(logScopeOf(storage)).toBe('all')
    expect(logLevelOf(storage)).toBe('all')
  })

  it('falls back to the defaults for an unknown or absent value', () => {
    expect(logScopeOf(memoryStorage({ [LOG_SCOPE_KEY]: 'nonsense' }))).toBe(DEFAULT_LOG_SCOPE)
    expect(logLevelOf(memoryStorage({ [LOG_LEVEL_KEY]: 'nonsense' }))).toBe(DEFAULT_LOG_LEVEL)
    expect(logScopeOf(undefined)).toBe(DEFAULT_LOG_SCOPE)
    expect(logLevelOf(undefined)).toBe(DEFAULT_LOG_LEVEL)
  })

  it('remembers a Clear mark, and reads nothing where none was pressed', () => {
    const storage = memoryStorage()

    expect(logsClearedAt(storage)).toBeUndefined()
    persistLogsClearedAt(1_700_000_000_000, storage)
    expect(storage.values[LOGS_CLEARED_KEY]).toBe('1700000000000')
    expect(logsClearedAt(storage)).toBe(1_700_000_000_000)
    expect(logsClearedAt(memoryStorage({ [LOGS_CLEARED_KEY]: 'not-a-number' }))).toBeUndefined()
  })

  it('survives storage that throws, and no storage at all', () => {
    const hostile = {
      getItem: (): string | null => {
        throw new Error('blocked')
      },
      setItem: (): void => {
        throw new Error('blocked')
      },
    }

    expect(logScopeOf(hostile)).toBe(DEFAULT_LOG_SCOPE)
    expect(logLevelOf(hostile)).toBe(DEFAULT_LOG_LEVEL)
    expect(logsClearedAt(hostile)).toBeUndefined()
    expect(() => persistLogFilter(LOG_SCOPE_KEY, 'all', hostile)).not.toThrow()
    expect(() => persistLogsClearedAt(1, hostile)).not.toThrow()
  })
})

describe('a log row', () => {
  it('draws the clock in mono time, the level as a chip, the server and the message', () => {
    const tree = logRow(
      event({ at: Date.UTC(2026, 0, 2, 12, 41, 31), level: 'up', server: 'tglider', message: 'tglider is up in 812ms' }),
      'row',
      t,
    )
    const rendered = texts(tree)

    expect(rendered).toContain('up')
    expect(rendered).toContain('tglider')
    expect(rendered).toContain('tglider is up in 812ms')
    // The clock is real time, seconds included, in the viewer's own zone.
    expect(rendered.some((line) => /^\d{2}:\d{2}:\d{2}$/.test(line))).toBe(true)
  })

  it('colours the chip by the meaning of the level, not by the level word', () => {
    const chip = (level: LogEvent['level']): CSSProperties => {
      const tree = logRow(event({ level }), 'row', t) as unknown as Element
      const row = tree.props.children as Element[]
      const levelChip = elements(row[0]).find((element) => texts(element).join('') === level)
      return (levelChip?.props.style ?? {}) as CSSProperties
    }

    expect(chip('error').color).toBe(STATUS_COLOR.error)
    expect(chip('warn').color).toBe(STATUS_COLOR.connecting)
    expect(chip('up').color).toBe(STATUS_COLOR.active)
    // `info` is the quiet chip: the plate's own tone, no alarm colour.
    expect(chip('info').color).toBe('var(--dsw-alias-label-secondary, inherit)')
  })

  it('gives the message its own full width, so a narrow sidebar cannot stair-step it', () => {
    const tree = logRow(event({ message: 'no tool appeared in 4m 27s' }), 'row', t) as unknown as Element
    const row = (tree.props.children as Element[])[0]!
    const message = elements(row).find((element) => element.props.children === 'no tool appeared in 4m 27s')

    expect((message?.props.style as CSSProperties).flex).toBe('1 1 100%')
  })

  it('draws the failure’s own facts under it, and nothing when there are none', () => {
    const withFacts = logRow(
      event({
        level: 'error',
        server: 'gateway',
        message: 'gateway errored',
        detail: 'endpoint: stdio docker\n.gateway/mcp.json',
      }),
      'row',
      t,
    )
    const rendered = texts(withFacts)

    expect(rendered).toContain('endpoint: stdio docker')
    expect(rendered).toContain('.gateway/mcp.json')
    expect(texts(logRow(event({ level: 'error' }), 'row', t))).not.toContain('endpoint')
  })

  it('relays the host’s facts and drops its advice', () => {
    const facts = logFacts(
      [
        'gateway: no tool appeared in 4m 27s',
        'endpoint: stdio docker',
        'declared in .dsh/mcp.json',
        'hint: check the command and retry',
        'note: the mount is dropped after 60s',
        '',
      ].join('\n'),
    )

    // The facts are relayed as the host spelled them, and neither a hint nor a
    // repeated reminder about `Retry` is one of the three.
    expect(facts).toEqual([
      'gateway: no tool appeared in 4m 27s',
      'endpoint: stdio docker',
      'declared in .dsh/mcp.json',
    ])
    expect(facts.join(' ')).not.toContain('Retry')
    expect(logFacts(undefined)).toEqual([])
  })
})

/**
 * The Logs tab through the host namespace (F-48): a coded event renders its
 * translated template, an uncoded or unknown one renders its English message
 * exactly as before.
 */
describe('the Logs tab resolves host codes', () => {
  /**
   * A bound host namespace, as the harness answers one: the template with its
   * params on a hit, the key itself on a miss — the signal `resolveHost` reads.
   */
  const hostSeat =
    (table: Record<string, string>): Translate =>
    (key, params) => {
      const template = table[key] ?? key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
        name in (params as Record<string, unknown>) ? String((params as Record<string, unknown>)[name]) : whole,
      )
    }

  /** A seat that knows two lifecycle codes in Russian, nothing else. */
  const hostRu = hostSeat({
    unmounting: 'снятие — {reason} (проработал {ran})',
    'unmount.reason.sessionIdle': 'сессия простаивает',
    'mount.failedDetail': '{name}: не удалось\nэндпоинт: {endpoint}\nобъявлено в: {source}',
  })

  it('renders a coded event translated, the *Code param resolved two-level', () => {
    const tree = logRow(
      event({
        level: 'warn',
        server: 'alpha',
        message: 'unmounting — the session went idle (it ran for 1m 2s)',
        code: 'unmounting',
        params: { reasonCode: 'unmount.reason.sessionIdle', ran: '1m 2s' },
      }),
      'row',
      t,
      hostRu,
    )

    expect(texts(tree)).toContain('снятие — сессия простаивает (проработал 1m 2s)')
    expect(texts(tree)).not.toContain('unmounting — the session went idle (it ran for 1m 2s)')
  })

  it('renders a coded detail translated, still split into fact lines', () => {
    const tree = logRow(
      event({
        level: 'error',
        server: 'gamma',
        message: 'mount failed — boom',
        code: 'mount.failed',
        params: { error: 'boom' },
        detail: 'gamma: mount failed — boom\nendpoint: stdio npx\ndeclared in: /repo/.dsh/mcp.json',
        detailCode: 'mount.failedDetail',
        detailParams: { name: 'gamma', error: 'boom', endpoint: 'stdio npx', source: '/repo/.dsh/mcp.json' },
      }),
      'row',
      t,
      hostRu,
    )
    const rendered = texts(tree)

    // The detail resolved through its code, then split the way logFacts splits.
    expect(rendered).toContain('gamma: не удалось')
    expect(rendered).toContain('эндпоинт: stdio npx')
    expect(rendered).toContain('объявлено в: /repo/.dsh/mcp.json')
    // The message code is unknown to this seat, so the English fallback shows.
    expect(rendered).toContain('mount failed — boom')
  })

  it('renders the English message for an unknown code and for an uncoded event', () => {
    const skewed = logRow(
      event({ message: 'unmounting — a reason this client predates (it ran for 2s)', code: 'unmounting.future' }),
      'row',
      t,
      hostRu,
    )
    expect(texts(skewed)).toContain('unmounting — a reason this client predates (it ran for 2s)')
    expect(texts(skewed)).not.toContain('unmounting.future')

    const uncoded = logRow(event({ message: 'mounting /repo (project)' }), 'row', t, hostRu)
    expect(texts(uncoded)).toContain('mounting /repo (project)')
  })
})

describe('paging older events', () => {
  it('keeps one cursor, newest first, and drops what a page overlap repeats', () => {
    const shown = [event({ at: 4_000 }), event({ at: 3_000 })]
    const page = [event({ at: 3_000 }), event({ at: 2_000 }), event({ at: 1_000 })]

    expect(mergeLogs(page, shown).map((entry) => entry.at)).toEqual([4_000, 3_000, 2_000, 1_000])
  })

  it('asks the contract’s own route, without a literal of its own', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string): Promise<Response> => {
      calls.push(String(url))
      return {
        json: async (): Promise<unknown> => ({
          ok: true,
          value: { events: [event({ at: 1_000 })], total: 51, more: false },
        }),
      } as unknown as Response
    }) as unknown as typeof fetch

    const page = await fetchLogs('/repo', 2_000, 50, fetchImpl)

    expect(page).toEqual({ events: [event({ at: 1_000 })], total: 51, more: false })
    // `before` is the exclusive cursor the host pages on, and the page size is
    // the one the tab drew its list from.
    expect(calls[0]).toBe(`/project-mcp/logs?projectRoot=%2Frepo&limit=${LOG_PAGE_SIZE}&before=2000`)
  })

  it('reads a refusal, an unreadable answer or a missing fetch as no page at all', async () => {
    const refused = (async (): Promise<Response> =>
      ({ json: async (): Promise<unknown> => ({ ok: false, error: { message: 'no' } }) }) as unknown as Response) as unknown as typeof fetch
    const throwing = (async (): Promise<Response> => {
      throw new Error('offline')
    }) as unknown as typeof fetch

    expect(await fetchLogs('/repo', undefined, 50, refused)).toBeUndefined()
    expect(await fetchLogs('/repo', undefined, 50, throwing)).toBeUndefined()
    expect(await fetchLogs('/repo', undefined, 50, undefined)).toBeUndefined()
  })
})

describe('the Logs body', () => {
  it('is the logs disclosure’s own body, handed the project, session and storage seam', () => {
    const storage = memoryStorage()
    const body = tabBody({
      project: PROJECT,
      sessionId: 'session-aaa11111',
      groups: [],
      busy: false,
      onRelease: () => undefined,
      storage,
    }) as unknown as (Element | null)[]
    const logs = body[4] as Element
    const element = logs.props.body as Element

    expect(logs.type).toBe(Disclosure)
    expect(element.type).toBe(LogsView)
    expect(element.props.project).toBe(PROJECT)
    expect(element.props.sessionId).toBe('session-aaa11111')
    expect(element.props.storage).toBe(storage)
  })

  it('names the empty state and where to look instead of drawing nothing', () => {
    const rendered = texts(logsEmptyState(t))

    expect(rendered).toContain(t('logsEmptyTitle'))
    expect(rendered).toContain(t('logsEmptyHint'))
    expect(rendered.join(' ')).toContain('first step')
    expect(rendered.join(' ')).toContain('Sync')
  })

  it('draws this session’s events through the same filters the storage was read into', () => {
    // The stored pair is what the view seeds its state from; the filtering it
    // then does is the pure one asserted above, on the real ring shape.
    const storage = memoryStorage({
      [LOG_SCOPE_KEY]: 'all',
      [LOG_LEVEL_KEY]: 'error',
      [LOGS_CLEARED_KEY]: '2500',
    })
    const logs = [
      event({ at: 2_000, level: 'error', sessionId: 'session-bbb22222', message: 'cleared away' }),
      event({ at: 3_000, level: 'error', sessionId: 'session-bbb22222', message: 'still here' }),
      event({ at: 4_000, level: 'info', sessionId: 'session-bbb22222', message: 'not an error' }),
    ]

    expect(logScopeOf(storage)).toBe('all')
    expect(logLevelOf(storage)).toBe('error')
    expect(logsClearedAt(storage)).toBe(2_500)
    expect(
      logVisible({
        logs,
        scope: logScopeOf(storage),
        level: logLevelOf(storage),
        sessionId: 'session-aaa11111',
        clearedAt: logsClearedAt(storage),
      }).map((entry) => entry.message),
    ).toEqual(['still here'])
  })

  it('draws the toolbar, the counts and every event it is handed', () => {
    const logs = [
      event({ at: 3_000, level: 'up', server: 'tglider', message: 'tglider is up in 812ms' }),
      event({ at: 2_000, level: 'error', server: 'gateway', message: 'gateway errored', detail: 'endpoint: stdio docker' }),
    ]
    const rendered = texts(
      logList(PROJECT, logs, {
        scope: 'session',
        level: 'all',
        total: 12,
        loading: false,
        failed: false,
        more: true,
        t,
        onScope: () => undefined,
        onLevel: () => undefined,
        onClear: () => undefined,
        onOlder: () => undefined,
      }),
    )

    // The pair of filter chips, the Clear action, and the count of the ring.
    for (const line of [
      t('logsThisSession'),
      t('logsAllSessions'),
      t('logsAllLevels'),
      t('logsErrorsOnly'),
      t('logsClear'),
      '12 in this project',
      'tglider is up in 812ms',
      'gateway errored',
      'endpoint: stdio docker',
    ]) {
      expect(rendered).toContain(line)
    }
    expect(rendered).toContain(t('logsMore'))
    expect(rendered).toContain('showing 2 of 12')
  })

  it('presses only the filter of each pair that is applied', () => {
    const tree = logList(PROJECT, [event()], {
      scope: 'all',
      level: 'error',
      total: 1,
      loading: false,
      failed: false,
      more: false,
      t,
      onScope: () => undefined,
      onLevel: () => undefined,
      onClear: () => undefined,
      onOlder: () => undefined,
    })
    const chipOf = (label: string): Element | undefined =>
      elements(tree).find(
        (element) => element.type === 'button' && texts(element).join('') === label,
      )

    expect(chipOf(t('logsAllSessions'))?.props['aria-pressed']).toBe(true)
    expect(chipOf(t('logsErrorsOnly'))?.props['aria-pressed']).toBe(true)
    expect(chipOf(t('logsThisSession'))?.props['aria-pressed']).toBe(false)
    expect(chipOf(t('logsAllLevels'))?.props['aria-pressed']).toBe(false)
    // These two pairs are the only pressed controls in the whole body: the mode
    // switch that used to be the other one is gone (F-26).
    expect(
      elements(tree).filter((element) => element.props['aria-pressed'] === true),
    ).toHaveLength(2)
  })

  it('names the empty state and reports a page that never arrived', () => {
    const empty = texts(
      logList(PROJECT, [], {
        scope: 'session',
        level: 'all',
        total: 0,
        loading: false,
        failed: false,
        more: false,
        t,
        onScope: () => undefined,
        onLevel: () => undefined,
        onClear: () => undefined,
        onOlder: () => undefined,
      }),
    )
    const failed = texts(
      logList(PROJECT, [event()], {
        scope: 'session',
        level: 'all',
        total: 3,
        loading: false,
        failed: true,
        more: true,
        t,
        onScope: () => undefined,
        onLevel: () => undefined,
        onClear: () => undefined,
        onOlder: () => undefined,
      }),
    )

    expect(empty).toContain(t('logsEmptyTitle'))
    expect(empty).toContain(t('logsEmptyHint'))
    expect(failed).toContain(t('logsLoadFailed'))
  })

  it('says the ring holds other events when the errors filter hid them all', () => {
    const list = (total: number): string[] =>
      texts(
        logList(PROJECT, [], {
          scope: 'session',
          level: 'error',
          total,
          loading: false,
          failed: false,
          more: false,
          t,
          onScope: () => undefined,
          onLevel: () => undefined,
          onClear: () => undefined,
          onOlder: () => undefined,
        }),
      )

    // The tab opens on `errors`; a ring that only holds mounting/is-up lines
    // must not read as a project that recorded nothing.
    const filtered = list(12)
    expect(filtered).toContain(t('logsNoErrorsTitle'))
    expect(filtered).toContain(t('logsNoErrorsHint'))
    expect(filtered).not.toContain(t('logsEmptyTitle'))

    // A ring that really is empty keeps the "nothing yet" copy.
    const empty = list(0)
    expect(empty).toContain(t('logsEmptyTitle'))
    expect(empty).not.toContain(t('logsNoErrorsTitle'))
  })

  it('swaps the Show older button for a loading line while a page is in flight', () => {
    const rendered = (loading: boolean): string[] =>
      texts(
        logList(PROJECT, [event()], {
          scope: 'session',
          level: 'all',
          total: 3,
          loading,
          failed: false,
          more: true,
          t,
          onScope: () => undefined,
          onLevel: () => undefined,
          onClear: () => undefined,
          onOlder: () => undefined,
        }),
      )

    expect(rendered(false)).toContain(t('logsMore'))
    expect(rendered(true)).toContain(t('logsLoading'))
    expect(rendered(true)).not.toContain(t('logsMore'))
  })

  it('offers older events only while the ring holds any, and never re-asks a spent cursor', () => {
    const shown = [event({ at: 3_000, message: 'newest' }), event({ at: 2_000, message: 'second' })]
    const visible = logVisible({
      logs: shown,
      scope: 'all',
      level: 'all',
      sessionId: 'session-aaa11111',
      clearedAt: undefined,
    })

    // 60 in the ring, 2 on screen: there is older material to ask for, and the
    // cursor is the oldest event drawn.
    expect(logsPaging({ visible, total: 60, attempted: [] })).toEqual({ more: true, cursor: 2_000 })
    // The snapshot carried the whole ring, so there is nothing to ask for.
    expect(logsPaging({ visible, total: 2, attempted: [] })).toEqual({ more: false, cursor: 2_000 })
    // The cursor was already asked for: a second request would loop.
    expect(logsPaging({ visible, total: 60, attempted: [2_000] })).toEqual({ more: false, cursor: 2_000 })
    // Nothing drawn means no cursor to page from.
    expect(logsPaging({ visible: [], total: 60, attempted: [] })).toEqual({ more: false, cursor: undefined })
  })
})

describe('layout parity with the mockup', () => {
  it('draws the tag as a layer-filled mono chip, not a bordered word', () => {
    const styleOf = (element: Element): CSSProperties => (element.props.style ?? {}) as CSSProperties
    // The dictionary's chip is the element that carries the layer fill itself:
    // the status dot has one background but no typeface, the name has neither.
    const withTransport: ServerRow = { ...row('alpha', 'active'), transport: 'streamable-http' }
    const chips = elements(resolve(serverRow(withTransport, 'x', { t }))).filter(
      (element) => styleOf(element).background !== undefined && styleOf(element).fontFamily !== undefined,
    )

    expect(chips.length).toBeGreaterThan(0)
    for (const chip of chips) {
      expect(styleOf(chip).background).toContain('--dsw-alias-bg-layer-3')
      expect(styleOf(chip).fontFamily).toContain('mono')
      // The dictionary's `tag` is a plate, not a bordered box, and it is not the
      // primary colour dimmed by an opacity.
      expect(styleOf(chip).border).toBeUndefined()
      expect(styleOf(chip).opacity).toBeUndefined()
    }
  })

  it('paints quiet text with the alias tones the mockup’s `.muted`/`.dim` name', () => {
    // `.muted` is the secondary tone, at the text’s own size — not the primary
    // colour at `.6` opacity, which is what this surface used to do.
    const header = elements(
      resolve(
        PanelHeader({
          project: PROJECT,
          sessions: 2,
          busy: false,
          onSync: () => undefined,
          t,
        }),
      ),
    ).map(
      (element) => (element.props.style ?? {}) as CSSProperties,
    )
    const secondary = header.filter((style) => style.color === 'var(--dsw-alias-label-secondary, inherit)')

    expect(secondary.length).toBeGreaterThan(0)
    for (const style of secondary) {
      expect(style.opacity).toBeUndefined()
    }

    // `.dim` is the tertiary tone, one step quieter: the log clock reads in it.
    const line = logRow(event({ at: Date.UTC(2026, 0, 2, 12, 41, 31) }), 'row', t) as unknown as Element
    const clock = elements((line.props.children as Element[])[0]!).find((element) =>
      /^[0-9]{2}:[0-9]{2}:[0-9]{2}$/.test(texts(element).join('')),
    )

    expect((clock?.props.style as CSSProperties).color).toBe('var(--dsw-alias-label-tertiary, #81858c)')

    // A quiet *row* still reads by opacity; that is the row, not the text tone.
    const quiet = elements(resolve(serverRow(row('alpha', 'idle'), 'x', { t }))).map(
      (element) => (element.props.style ?? {}) as CSSProperties,
    )

    expect(quiet.some((style) => style.opacity === 0.6)).toBe(true)
  })

  it('keeps the indentation ladder one step of twelve pixels at a time', () => {
    expect(INDENT).toBe(12)
  })

  it('paints the quiet chip with the `.dim` tone, the transport chip with `.muted`', () => {
    const rows = elements(
      resolve(serverRow({ ...row('alpha', 'idle'), transport: 'stdio' }, 'x', { t })),
    )
    const chip = (label: string): CSSProperties =>
      (rows.find((element) => element.props.children === label)?.props.style ?? {}) as CSSProperties

    // `docs/design/mockups/harness.html` draws `idle` in `.dim`; the transport chip beside it
    // stays on `.muted`. Two tones, so the quiet state reads as a state.
    expect(chip('idle').color).toBe('var(--dsw-alias-label-tertiary, #81858c)')
    expect(chip('stdio').color).toBe('var(--dsw-alias-label-secondary, inherit)')
  })

  it('leaves a quiet row without a warning banner and keeps a failure’s detail', () => {
    const quiet = resolve(
      serverRow({ ...row('alpha', 'idle'), detail: 'not mounted yet' }, 'x', { t }),
    )
    const broken = resolve(
      serverRow({ ...row('gateway', 'error'), detail: 'no tool appeared' }, 'x', { t }),
    )

    // `docs/design/mockups/harness.html` — an idle row is a dot, a name, a chip; the reason
    // lives on the row's own `title`, and a warning banner per idle server turns
    // the list into a wall of amber. A failure keeps its banner.
    expect(bannerOf(quiet, 'not mounted yet')).toBeUndefined()
    expect(bannerOf(broken, 'no tool appeared')).toBeDefined()
  })

  it('reads the toolbar’s right edge and the sessions seam in the `.dim` tone', () => {
    const header = elements(
      resolve(
        PanelHeader({
          project: PROJECT,
          sessions: 2,
          busy: false,
          onSync: () => undefined,
          t,
        }),
      ),
    )
    const summary = header.find((element) => element.props.children === '2 sessions')

    expect((summary?.props.style as CSSProperties).color).toBe('var(--dsw-alias-label-tertiary, #81858c)')

    // `docs/design/mockups/harness.html` — `▾ sessions` is `.dim` too: it names the seam.
    const seam = elements(
      sessionsHeader({
        sessions: sessionBreakdown(PROJECT, 'session-aaa11111'),
        open: true,
        onToggle: () => undefined,
        t,
      }),
    ).find((element) => element.type === 'button')

    expect((seam?.props.style as CSSProperties).color).toBe('var(--dsw-alias-label-tertiary, #81858c)')
  })

  it('dims a collapsed session id and leaves an open one in the primary tone', () => {
    const entry = (expanded: boolean): CSSProperties =>
      (elements(
        sessionEntry({
          session: {
            id: 'session-8fce1c42',
            rows: [],
            current: false,
            summary: 'nothing declared',
            deviates: false,
          },
          expanded,
          busy: false,
          onToggle: () => undefined,
          onRelease: () => undefined,
          t,
        }),
      ).find((element) => element.type === 'button')?.props.style ?? {}) as CSSProperties

    // `docs/design/mockups/harness.html` — the folded row's id is `.dim`; open, the id is
    // content and inherits the panel's primary tone.
    expect(entry(false).color).toBe('var(--dsw-alias-label-tertiary, #81858c)')
    expect(entry(true).color).toBe('inherit')
  })

  it('turns the tool row into a disclosure: a head button, and the detail under it', () => {
    const style = (element: Element | undefined): CSSProperties =>
      (element?.props.style ?? {}) as CSSProperties
    const row = { name: 'mcp__tglider__workspace' }
    const closed = elements(
      resolve(
        toolRow(
          row,
          undefined,
          'pinned',
          { via: 'pin', open: false, onToggle: () => undefined },
          t,
        ),
      ),
    )
    const head = closed.find((element) => element.type === 'button')

    expect(head?.props['aria-expanded']).toBe(false)
    // The row is the tool line itself: the head button carries the name.
    expect(texts(head ?? null)).toContain('mcp__tglider__workspace')
    // Closed draws no detail block at all.
    expect(texts(closed).join(' ')).not.toContain(t('toolsStep', { step: 4 }))

    const open = elements(
      resolve(
        toolRow(
          row,
          undefined,
          'pinned',
          { via: 'pin', open: true, onToggle: () => undefined },
          t,
        ),
      ),
    )
    // The block is the element indented one rung in from the row; the facts keep
    // the pre-wrap treatment the surface gives every host-published text.
    const detail = open.find(
      (element) =>
        style(element).paddingLeft === 12 || String(style(element).padding ?? '').endsWith('12px'),
    )
    const facts = open.find((element) => style(element).whiteSpace === 'pre-wrap')

    expect(open.find((element) => element.type === 'button')?.props['aria-expanded']).toBe(true)
    expect(texts(detail ?? null).join(' · ')).toContain('mcp__tglider__workspace')
    expect(texts(facts ?? null).join(' · ')).toContain(t('toolServer', { server: 'tglider' }))
    expect(texts(facts ?? null).join(' · ')).toContain(t('toolTierPinned'))
  })

  it('keeps `.muted` at the text’s own size and gives it no opacity trick', () => {
    const summary = elements(
      sessionsHeader({
        sessions: sessionBreakdown(PROJECT, 'session-aaa11111'),
        open: true,
        onToggle: () => undefined,
        t,
      }),
    ).find((element) => element.props.children === '1 active, 2 idle')

    const style = summary?.props.style as CSSProperties
    expect(style.color).toBe('var(--dsw-alias-label-secondary, inherit)')
    expect(style.fontSize).toBeUndefined()
    expect(style.opacity).toBeUndefined()
  })

  it('sets the panel’s own inset to the mockup’s bar and body padding', () => {
    const bars = elements(
      resolve(
        PanelHeader({
          project: PROJECT,
          sessions: 2,
          busy: false,
          onSync: () => undefined,
          t,
        }),
      ),
    ).map((element) => (element.props.style ?? {}) as CSSProperties)
    const bar = bars.find((style) => style.padding !== undefined)

    // `docs/design/mockups/harness.html` — `.panel-bar { padding: 7px 9px }`; the rows' own inset is
    // `.body { padding: 9px 10px }`, i.e. `STYLE.project` below. The Problems
    // view is the hook-free surface that carries it.
    expect(bar?.padding).toBe('7px 9px')
    const rowSurface = (elements(
      resolve(IssueView({ project: PROJECT, groups: [{ status: 'error', rows: [row('gateway', 'error')] }], t })),
    )[0]?.props.style ?? {}) as CSSProperties

    expect(rowSurface?.padding).toBe('9px 10px')
  })
})

/**
 * The row detail wire codes (F-48, Task 4): every `row.detail` render site of
 * this module resolves the row's `detailCode`/`detailParams` through the host
 * seat, and a row without companions — or a seat that does not know the code —
 * renders the payload's English prose exactly as before.
 */
describe('the row detail wire codes (F-48, Task 4)', () => {
  /**
   * A host seat that knows one detail code in another language; every other
   * key echoes, the harness's own miss signal.
   */
  const hostT: Translate = (key, params) => {
    if (key !== 'mount.stalledDetail') return key
    const template =
      '{name}: за {elapsed} ни одного инструмента\nэндпоинт: {endpoint}\nобъявлено в: {source}'
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
      name in params ? String(params[name]) : whole,
    )
  }

  const DETAIL =
    'gateway: no tool appeared in 60.2s\nendpoint: stdio docker\ndeclared in: /repo/.dsh/mcp.json'

  /** The row the host publishes for a stalled mount: coded companions beside byte-identical prose. */
  const coded = (): ServerRow => ({
    ...row('gateway', 'error'),
    detail: DETAIL,
    detailCode: 'mount.stalledDetail',
    detailParams: {
      name: 'gateway',
      elapsed: '60.2s',
      endpoint: 'stdio docker',
      source: '/repo/.dsh/mcp.json',
    },
  })
  const translated =
    'gateway: за 60.2s ни одного инструмента\nэндпоинт: stdio docker\nобъявлено в: /repo/.dsh/mcp.json'

  it('serverRow resolves the banner and the tooltip through the host seat', () => {
    const tree = serverRow(coded(), 'row', { t, hostT })
    expect(bannerOf(tree, translated)).toBeDefined()
    expect(elements(tree).some((element) => element.props.title === translated)).toBe(true)
  })

  it('serverRow shows the payload prose without a seat, and for a code the seat does not know', () => {
    const seatless = serverRow(coded(), 'row', { t })
    expect(bannerOf(seatless, DETAIL)).toBeDefined()
    expect(texts(seatless).join(' | ')).not.toContain('mount.stalledDetail')

    const unknown = serverRow({ ...coded(), detailCode: 'mount.futureDetail' }, 'row', { t, hostT })
    expect(bannerOf(unknown, DETAIL)).toBeDefined()
    expect(texts(unknown).join(' | ')).not.toContain('mount.futureDetail')
  })

  it('serverRow renders an uncoded row’s prose exactly as before', () => {
    const tree = serverRow({ ...row('context7', 'conflict'), detail: 'the name is taken' }, 'row', { t, hostT })
    expect(bannerOf(tree, 'the name is taken')).toBeDefined()
  })

  it('ServersBlock resolves the row tooltip through the host seat', () => {
    const tree = resolve(ServersBlock({ rows: [coded()], t, hostT }))
    expect(elements(tree).some((element) => element.props.title === translated)).toBe(true)
  })

  it('IssueView routes its rows through the host seat', () => {
    const tree = resolve(
      IssueView({ project: PROJECT, groups: [{ status: 'error', rows: [coded()] }], t, hostT }),
    )
    expect(bannerOf(tree, translated)).toBeDefined()
    expect(elements(tree).some((element) => element.props.title === translated)).toBe(true)
  })

  it('sessionRows routes its rows through the host seat handed down', () => {
    const breakdown: SessionBreakdown = {
      id: 'session-ccc33333',
      current: false,
      rows: [coded()],
      summary: '1 error',
      deviates: true,
    }
    const tree = resolve(sessionRows(breakdown, t, hostT))
    expect(bannerOf(tree, translated)).toBeDefined()
  })

  it('ProjectBlock resolves the merged rows through the seat it already holds', () => {
    const tree = ProjectBlock({
      project: { ...PROJECT, rows: [coded()] },
      busy: false,
      onRelease: () => undefined,
      t,
      hostT,
    })
    expect(bannerOf(tree, translated)).toBeDefined()
    expect(elements(tree).some((element) => element.props.title === translated)).toBe(true)
  })
})
