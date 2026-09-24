/**
 * Native Settings page: the all-projects overview, the by-files model, the split
 * editor and every state with nothing to list.
 *
 * Same discipline as `view.spec.ts`: plain React element trees, no DOM and no
 * renderer, so the checks stay in the node environment and assert what a user
 * would read. The page is exported as a pure function of its props precisely so
 * this file can drive it directly — the editor's draft, the confirmation step
 * and the save answer all ride in as props, which is what lets the write path be
 * checked without a host, a fetch or a rendered document.
 */

import { describe, expect, it } from 'vitest'
import * as React from 'react'
import type { CSSProperties } from 'react'
import type { EntrySnapshot, McpSnapshot, ProjectSnapshot, ServerRow, SnapshotIssue } from '../src/types.ts'
import {
  DEFAULT_SETTINGS_VIEW,
  EditorSplit,
  FileCards,
  JsonPreview,
  NARROW_SETTINGS_QUERY,
  NS,
  SETTINGS_VIEW_STORAGE_KEY,
  ServerTable,
  SettingsPage,
  SettingsTab,
  activeDraft,
  documentBody,
  draftFromJson,
  documentLabel,
  documentPriority,
  draftEntry,
  draftOf,
  entryBody,
  entryDirty,
  fileGroups,
  jsonBodyOf,
  narrowSettingsLayout,
  persistSettingsView,
  projectJson,
  registerSettingsTab,
  saveNotice,
  saveRequestOf,
  selectedProject,
  settingsBody,
  settingsViewOf,
  translateOf,
} from '../src/client/settings.ts'
import { EN } from '../src/client/settings.ts'
import { en as uiEn } from '../src/client/locales/ui.ts'
import type {
  EditorProps,
  EntryDraft,
  FieldDraft,
  MediaQueryLike,
  SettingsSlotServices,
  SettingsTabProps,
  SettingsTabRegistration,
  Translate,
} from '../src/client/settings.ts'

const t = translateOf()

function row(name: string, status: ServerRow['status'], source?: string): ServerRow {
  return { name, status, projectRoot: '/repo', ...(source === undefined ? {} : { source }) }
}

/** One parsed `stdio` entry: a plain key, a masked secret and a credential key. */
const ENTRY: EntrySnapshot = {
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'example-service'],
  cwd: '/repo',
  env: [
    { key: 'LOG_LEVEL', value: 'info' },
    { key: 'API_TOKEN', masked: true },
    { key: 'HOME_TOKEN', fromCredentials: true },
  ],
  enabled: true,
}

/**
 * A row the editor can open, writable unless a check overrides it.
 *
 * The override bag takes explicit `undefined` on purpose: a check that clears a
 * field (`writeScope`, `entry`, `documentRevision`) is exactly the case that has
 * to render the read-only path.
 */
function editorRow(overrides: Partial<Record<keyof ServerRow, unknown>> = {}): ServerRow {
  const base: ServerRow = {
    name: 'gateway',
    status: 'error',
    projectRoot: '/repo',
    source: '/repo/.dsh/mcp.json',
    transport: 'stdio',
    entry: ENTRY,
    writeScope: 'project',
    documentRevision: 'rev-1',
  }
  return { ...base, ...overrides } as ServerRow
}

/** The entry a save would write for a row, straight from its snapshot. */
function entryOf(server: ServerRow): EntrySnapshot {
  const draft = draftOf(server)
  if (draft === undefined) throw new Error('the fixture row must have a parsed entry')
  return draftEntry(draft)
}

/** The editable rows of the fixture entry's `env` list. */
function editableFields(server: ServerRow): FieldDraft[] {
  const draft = draftOf(server)
  if (draft === undefined) throw new Error('the fixture row must have a parsed entry')
  return draft.env
}

/** The pure editor with every interaction folded in, ready for one override. */
function editor(overrides: Partial<EditorProps> = {}): EditorProps {
  const server = overrides.row ?? editorRow()
  return {
    project: REPO,
    row: server,
    onSelectServer: () => undefined,
    draft: draftOf(server),
    confirming: false,
    consent: false,
    saveState: undefined,
    saving: false,
    onDraft: () => undefined,
    onDiscard: () => undefined,
    onAskSave: () => undefined,
    onCancelSave: () => undefined,
    onConsent: () => undefined,
    onConfirmSave: () => undefined,
    onReRead: () => undefined,
    t,
    ...overrides,
  }
}

/** One field of a tree, by the aria-label its control carries. */
function field(tree: unknown, label: string): Element | undefined {
  return elements(tree).find((element) => element.props['aria-label'] === label)
}

/** The JSON pane as a user reads it: the text the control holds, line by line. */
function paneLines(tree: unknown): string[] {
  const area = elements(tree).find((element) => element.type === 'textarea')
  const value = area?.props.value
  return typeof value === 'string' ? value.split('\n') : []
}

/** One pane's rule, by the marker {@link EditorSplit} puts on it. */
function paneStyle(tree: unknown, pane: 'list' | 'form' | 'json'): CSSProperties | undefined {
  const element = elements(tree).find((node) => node.props['data-pane'] === pane)
  return element?.props.style as CSSProperties | undefined
}

/** The container the three panes sit in, found through its first pane. */
function paneRow(tree: unknown): CSSProperties | undefined {
  const row = elements(tree).find(
    (element) =>
      Array.isArray(element.props.children) &&
      (element.props.children as Element[]).some(
        (child) => child?.props?.['data-pane'] === 'list',
      ),
  )
  return row?.props.style as CSSProperties | undefined
}

/** The flex-shrink factor of a `flex` shorthand. */
function flexShrinkOf(style: CSSProperties | undefined): number {
  return Number(String(style?.flex ?? '').split(' ')[1])
}

/** One button of a tree, by the text a user reads on it. */
function button(tree: unknown, label: string): Element | undefined {
  return elements(tree).find(
    (element) => element.type === 'button' && texts(element).join('') === label,
  )
}

/** Every control that would feed a save, in tree order. */
function writeControls(tree: unknown): Element[] {
  return elements(tree).filter((element) => element.props['data-write'] === true)
}

/** A draft of {@link ENTRY} with one field changed. */
function edited(overrides: Partial<EntryDraft> = {}): EntryDraft {
  const base = draftOf(editorRow())
  if (base === undefined) throw new Error('the fixture row must have a parsed entry')
  return { ...base, ...overrides }
}

function issue(server: string): SnapshotIssue {
  return {
    source: '/repo',
    server,
    level: 'warning',
    message: `serverName "${server}" was declared in more than one document; the highest-priority definition wins`,
    code: 'parse.server.multiDocument',
    params: { name: server },
  }
}

/** `/repo` declares two servers from two documents. */
const REPO: ProjectSnapshot = {
  projectRoot: '/repo',
  sessionIds: ['session-aaa11111'],
  rows: [row('alpha', 'active', '/repo/.dsh/mcp.json'), row('gateway', 'error', '/repo/.dsh/mcp.json')],
  issues: [],
  sessions: [],
}

/** A second project's rows must never appear while `/repo` is selected. */
const OTHER: ProjectSnapshot = {
  projectRoot: '/other',
  sessionIds: ['session-zzz'],
  rows: [row('beta', 'idle', '/other/.dsh/mcp.json')],
  issues: [],
  sessions: [],
}

function snapshotOf(...projects: ProjectSnapshot[]): McpSnapshot {
  return { ready: true, projects, watchedFiles: [] }
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
 * Invoke the pure function components in a tree so the walkers see the elements
 * they actually produce. The page's components take no hooks of their own —
 * {@link SettingsTab} is the only hook-bearing one and the tests never render
 * it — so this stands in for a renderer without pulling in a DOM.
 */
/**
 * The dispatcher the walk installs: every hook answers its first render.
 *
 * The editor's JSON pane keeps its own text, so walking the tree by hand —
 * which is how these checks read a component that is otherwise an element —
 * would call React's hooks with no dispatcher. One value per hook is all one
 * walk needs: nothing below is re-rendered here.
 */
const FIRST_RENDER = {
  useState: (initial?: unknown): [unknown, () => void] => [
    typeof initial === 'function' ? (initial as () => unknown)() : initial,
    () => undefined,
  ],
  useRef: (initial?: unknown): { current: unknown } => ({ current: initial }),
  useEffect: (): void => undefined,
  useLayoutEffect: (): void => undefined,
  useMemo: (create: () => unknown): unknown => create(),
  useCallback: (create: unknown): unknown => create,
}

/** React's current-dispatcher holder: the seam `react-test-renderer` itself uses. */
function dispatcherHolder(): { current: unknown } {
  const internals = (React as unknown as {
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: {
      ReactCurrentDispatcher: { current: unknown }
    }
  }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  return internals.ReactCurrentDispatcher
}

function resolve(node: unknown): unknown {
  const holder = dispatcherHolder()
  const previous = holder.current
  holder.current = FIRST_RENDER
  try {
    return walkTree(node)
  } finally {
    holder.current = previous
  }
}

/** The walk itself: invoke every function component once, in tree order. */
function walkTree(node: unknown): unknown {
  if (Array.isArray(node)) return node.map((child) => walkTree(child))
  if (node === null || typeof node !== 'object') return node
  const element = node as Element
  if (typeof element.type === 'function') {
    return walkTree((element.type as (props: Record<string, unknown>) => unknown)(element.props))
  }
  return { type: element.type, props: { ...element.props, children: walkTree(element.props.children) } }
}

/** The page props, with only what a check cares about overridden. */
function pageProps(overrides: Record<string, unknown> = {}): Parameters<typeof settingsBody>[0] {
  return {
    snapshot: snapshotOf(REPO),
    error: undefined,
    busy: false,
    view: 'table',
    onView: () => undefined,
    page: 'servers',
    onPage: () => undefined,
    onMode: () => undefined,
    modePending: new Set<string>(),
    modeError: undefined,
    selectedRoot: '/repo',
    onSelectProject: () => undefined,
    selectedServer: undefined,
    onSelectServer: () => undefined,
    onSync: () => undefined,
    onRetry: () => undefined,
    json: false,
    onJson: () => undefined,
    draft: undefined,
    confirming: false,
    consent: false,
    saveState: undefined,
    saving: false,
    onDraft: () => undefined,
    onDiscard: () => undefined,
    onAskSave: () => undefined,
    onCancelSave: () => undefined,
    onConsent: () => undefined,
    onConfirmSave: () => undefined,
    onReRead: () => undefined,
    t,
    ...overrides,
  } as Parameters<typeof settingsBody>[0]
}

describe('settings view preference', () => {
  it('defaults to the table and round-trips the by-files choice', () => {
    const storage = memoryStorage()

    expect(settingsViewOf(storage)).toBe('table')
    expect(settingsViewOf(storage)).toBe(DEFAULT_SETTINGS_VIEW)
    persistSettingsView('files', storage)
    expect(storage.values[SETTINGS_VIEW_STORAGE_KEY]).toBe('files')
    expect(settingsViewOf(storage)).toBe('files')
  })

  it('falls back to the default for an unknown stored value', () => {
    expect(settingsViewOf(memoryStorage({ [SETTINGS_VIEW_STORAGE_KEY]: 'nonsense' }))).toBe('table')
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

    expect(settingsViewOf(hostile)).toBe('table')
    expect(() => persistSettingsView('files', hostile)).not.toThrow()
    expect(settingsViewOf(undefined)).toBe('table')
    expect(() => persistSettingsView('files', undefined)).not.toThrow()
  })
})

describe('document grouping', () => {
  it('numbers documents by the read order the host publishes', () => {
    const project: ProjectSnapshot = {
      ...REPO,
      files: [
        { path: '/home/dev/.dsh/mcp.json', scope: 'global' },
        { path: '/repo/.kimi-code/mcp.json', scope: 'project' },
        { path: '/repo/.dsh/mcp.json', scope: 'project' },
      ],
    }
    expect(documentPriority('/home/dev/.dsh/mcp.json', project)).toEqual({ tier: 1, total: 3, global: true })
    expect(documentPriority('/repo/.kimi-code/mcp.json', project)).toEqual({ tier: 2, total: 3, global: false })
    expect(documentPriority('/repo/.dsh/mcp.json', project)).toEqual({ tier: 3, total: 3, global: false })
    expect(documentPriority('/repo/custom.json', project)).toBeUndefined()
    expect(documentPriority('', project)).toBeUndefined()
  })

  it('reads `priority n/total` off a deployment that reads one document', () => {
    const project: ProjectSnapshot = {
      ...REPO,
      files: [{ path: '/repo/.dsh/mcp.json', scope: 'project' }],
    }
    expect(documentPriority('/repo/.dsh/mcp.json', project)).toEqual({ tier: 1, total: 1, global: false })
  })

  it('falls back to the shipped names for a host that reports no documents', () => {
    // No `files` at all is a host older than the field.
    const { files: _absent, ...legacyRepo } = { ...REPO, files: undefined }
    const project: ProjectSnapshot = legacyRepo
    expect(documentPriority('/repo/.kimi-code/mcp.json', project)).toEqual({ tier: 2, total: 3, global: false })
    expect(documentPriority('/repo/.dsh/mcp.json', project)).toEqual({ tier: 3, total: 3, global: false })
    expect(documentPriority('/home/dev/.dsh/mcp.json', project)).toEqual({ tier: 1, total: 3, global: true })
    expect(documentPriority('/repo/custom.json', project)).toBeUndefined()
  })

  it('shortens project paths and global paths, but not a foreign absolute path', () => {
    expect(documentLabel('/repo/.dsh/mcp.json', '/repo')).toBe('.dsh/mcp.json')
    expect(documentLabel('/home/dev/.dsh/mcp.json', '/repo')).toBe('~/.dsh/mcp.json')
    expect(documentLabel('~/.dsh/mcp.json', '/repo')).toBe('~/.dsh/mcp.json')
    expect(documentLabel('/srv/mcp.json', '/repo')).toBe('/srv/mcp.json')
  })

  it('cards documents in priority order and annotates the replaced declaration', () => {
    const project: ProjectSnapshot = {
      ...REPO,
      // Two project documents, as a config that names both would read them.
      files: [
        { path: '/repo/.kimi-code/mcp.json', scope: 'project' },
        { path: '/repo/.dsh/mcp.json', scope: 'project' },
      ],
      rows: [
        row('alpha', 'active', '/repo/.kimi-code/mcp.json'),
        row('tglider', 'active', '/repo/.dsh/mcp.json'),
        row('gateway', 'error', '/repo/.dsh/mcp.json'),
      ],
      issues: [issue('tglider')],
    }

    const groups = fileGroups(project)

    expect(
      groups.map((group) => [group.label, group.priority?.tier, group.rows.map((entry) => entry.name)]),
    ).toEqual([
      ['.kimi-code/mcp.json', 1, ['alpha']],
      ['.dsh/mcp.json', 2, ['tglider', 'gateway']],
    ])
    expect(groups[1]?.overrides).toEqual([{ name: 'tglider', from: '.kimi-code/mcp.json' }])

    const text = texts(FileCards({ project, onSelectServer: () => undefined, t })).join(' | ')
    expect(text).toContain('priority 1/2')
    expect(text).toContain('priority 2/2')
    expect(text).toContain('↳ overrides tglider from .kimi-code/mcp.json')
  })

  it('reads the merge warning by its code, never by its prose (F-48)', () => {
    // The client translates the payload, so matching the English sentence would
    // both break under another language and misread a translated one: the match
    // is `issue.code === 'parse.server.multiDocument'` and nothing else.
    const project: ProjectSnapshot = {
      ...REPO,
      files: [
        { path: '/repo/.kimi-code/mcp.json', scope: 'project' },
        { path: '/repo/.dsh/mcp.json', scope: 'project' },
      ],
      rows: [
        row('alpha', 'active', '/repo/.kimi-code/mcp.json'),
        row('tglider', 'active', '/repo/.dsh/mcp.json'),
      ],
      issues: [issue('tglider')],
    }
    // The fixture carries the code: the annotation appears however the prose reads.
    const coded = fileGroups({
      ...project,
      issues: [{ ...issue('tglider'), message: 'переведённый текст, который не совпадает' }],
    })
    expect(coded[1]?.overrides).toEqual([{ name: 'tglider', from: '.kimi-code/mcp.json' }])
    // An old host's issue — the same English prose but no code — annotates nothing.
    const uncoded = issue('tglider') as Partial<SnapshotIssue>
    delete uncoded.code
    delete uncoded.params
    const legacy = fileGroups({ ...project, issues: [uncoded as SnapshotIssue] })
    expect(legacy.every((group) => group.overrides.length === 0)).toBe(true)
  })

  it('says it cannot pin the loser when several lower-priority documents are present', () => {
    const project: ProjectSnapshot = {
      ...REPO,
      files: [
        { path: '/home/dev/.dsh/mcp.json', scope: 'global' },
        { path: '/repo/.kimi-code/mcp.json', scope: 'project' },
        { path: '/repo/.dsh/mcp.json', scope: 'project' },
      ],
      rows: [
        row('global-one', 'idle', '/home/dev/.dsh/mcp.json'),
        row('alpha', 'active', '/repo/.kimi-code/mcp.json'),
        row('tglider', 'active', '/repo/.dsh/mcp.json'),
      ],
      issues: [issue('tglider')],
    }
    const groups = fileGroups(project)

    expect(groups.map((group) => group.priority?.tier)).toEqual([1, 2, 3])
    expect(groups[2]?.overrides).toEqual([{ name: 'tglider', from: undefined }])
    expect(texts(FileCards({ project, onSelectServer: () => undefined, t })).join(' ')).toContain(
      '↳ overrides tglider declared in a lower-priority document',
    )
  })

  it('keeps a row whose document the host did not report, last and unlabelled', () => {
    const groups = fileGroups({
      ...REPO,
      files: [{ path: '/repo/.dsh/mcp.json', scope: 'project' }],
      rows: [row('anonymous', 'idle'), row('alpha', 'active', '/repo/.dsh/mcp.json')],
    })

    expect(groups.map((group) => [group.source, group.priority?.tier])).toEqual([
      ['/repo/.dsh/mcp.json', 1],
      ['', undefined],
    ])
    expect(texts(FileCards({ project: { ...REPO, rows: [row('anonymous', 'idle')] }, onSelectServer: () => undefined, t })).join(' ')).toContain(
      'declaration document unknown',
    )
  })
})

describe('project selection', () => {
  it('renders only the selected project’s rows, never another project’s', () => {
    const snapshot = snapshotOf(REPO, OTHER)

    const repoText = texts(page(snapshot, '/repo')).join(' | ')
    const otherText = texts(page(snapshot, '/other')).join(' | ')

    expect(repoText).toContain('alpha')
    expect(repoText).toContain('gateway')
    expect(repoText).not.toContain('beta')
    expect(otherText).toContain('beta')
    expect(otherText).not.toContain('alpha')
    expect(otherText).not.toContain('gateway')
  })

  it('falls back to the first live project for a stale or missing selection', () => {
    const snapshot = snapshotOf(REPO, OTHER)

    expect(selectedProject(snapshot, undefined)?.projectRoot).toBe('/repo')
    expect(selectedProject(snapshot, '/gone')?.projectRoot).toBe('/repo')
    expect(selectedProject(snapshot, '/other')?.projectRoot).toBe('/other')
    expect(selectedProject(undefined, '/repo')).toBeUndefined()

    const text = texts(page(snapshot, '/gone')).join(' | ')
    expect(text).toContain('alpha')
    expect(text).not.toContain('beta')
  })

  it('lists every live project in the picker, which is where other projects belong', () => {
    const picker = elements(page(snapshotOf(REPO, OTHER), '/repo')).find(
      (element) => element.type === 'select',
    )

    expect(picker?.props.value).toBe('/repo')
    expect(texts(picker)).toEqual(['repo', 'other'])
  })

  it('shows only a project’s own rows in the by-files view', () => {
    const text = texts(
      page(snapshotOf(REPO, OTHER), '/other', { view: 'files' }),
    ).join(' | ')

    expect(text).toContain('beta')
    expect(text).not.toContain('alpha')
    expect(text).toContain('.dsh/mcp.json')
  })
})

describe('states', () => {
  it('explains the first poll instead of showing an empty box', () => {
    const text = texts(settingsBody(pageProps({ snapshot: undefined }))).join(' ')

    expect(text).toContain('Reading the host snapshot')
    expect(text).toContain('/project-mcp/snapshot')
  })

  it('names the paths to create when no session is attached to a project', () => {
    const text = texts(settingsBody(pageProps({ snapshot: snapshotOf() }))).join(' ')

    expect(text).toContain('No session is attached')
    expect(text).toContain('<project>/.dsh/mcp.json')
  })

  it('separates "nothing declared" from "nothing mounted"', () => {
    const project: ProjectSnapshot = {
      ...REPO,
      files: [{ path: '/repo/.dsh/mcp.json', scope: 'project' }],
      rows: [],
    }
    const text = texts(settingsBody(pageProps({ snapshot: snapshotOf(project) }))).join(' ')

    expect(text).toContain('declares no MCP servers')
    expect(text).toContain('/repo/.dsh/mcp.json')
  })

  it('says there is nowhere to declare one when the deployment reads no document', () => {
    const project: ProjectSnapshot = { ...REPO, files: [], rows: [] }
    const text = texts(settingsBody(pageProps({ snapshot: snapshotOf(project) }))).join(' ')

    expect(text).toContain('declares no MCP servers')
    expect(text).toContain('reads no project document')
    expect(text).not.toContain('mcp.json')
  })

  it('reports a failed snapshot fetch with the route and the error text', () => {
    const text = texts(
      settingsBody(pageProps({ snapshot: undefined, error: 'request failed (503)' })),
    ).join(' ')

    expect(text).toContain('did not get an answer')
    expect(text).toContain('/project-mcp/snapshot')
    expect(text).toContain('request failed (503)')
    expect(text).not.toContain('Reading the host snapshot')
  })

  it('keeps the rows already loaded when a later poll fails', () => {
    const text = texts(page(snapshotOf(REPO), '/repo', { error: 'request failed (503)' })).join(' ')

    expect(text).toContain('alpha')
    expect(text).toContain('gateway')
    expect(text).toContain('did not get an answer')
    expect(text).toContain('request failed (503)')
  })
})

describe('the table view’s row actions', () => {
  const table = { project: REPO, onSelectServer: () => undefined, t }

  it('retries the broken row in place, and opens the editor on every other row', () => {
    const retried: string[] = []
    const opened: (string | undefined)[] = []
    const tree = resolve(
      ServerTable({
        ...table,
        onSelectServer: (name) => opened.push(name),
        onRetry: () => retried.push('retry'),
        busy: false,
      }),
    )

    // Six buttons: the two server names, one action each, and the two rows' own
    // `On` switches — the mockups draw that column as a switch, so it is a
    // read-only button here rather than the checkbox it used to be. Only the
    // error row's action is the real Retry.
    const buttons = elements(tree).filter((element) => element.type === 'button')
    expect(buttons).toHaveLength(6)
    const switches = buttons.filter((element) => element.props['aria-label'] === t('on'))
    expect(switches).toHaveLength(2)
    expect(switches.every((element) => element.props.disabled === true)).toBe(true)
    const retry = button(tree, t('retry'))
    expect(retry?.props.disabled).toBe(false)
    ;(retry?.props.onClick as () => void)()
    expect(retried).toEqual(['retry'])

    const more = elements(tree).filter(
      (element) => element.type === 'button' && texts(element).join('') === t('rowActionsMore'),
    )
    expect(more).toHaveLength(1)
    ;(more[0]?.props.onClick as () => void)()
    // The only thing left to do with a read-only row is go and edit it.
    expect(opened).toEqual(['alpha'])
  })

  it('keeps the row button still while a host action is in flight', () => {
    const tree = resolve(ServerTable({ ...table, onRetry: () => undefined, busy: true }))

    expect(button(tree, t('retry'))?.props.disabled).toBe(true)
  })

  it('offers no Retry at all where the page cannot write, and still opens the editor', () => {
    const tree = resolve(ServerTable(table))
    const more = elements(tree).filter(
      (element) => element.type === 'button' && texts(element).join('') === t('rowActionsMore'),
    )

    expect(button(tree, t('retry'))).toBeUndefined()
    expect(more).toHaveLength(2)
  })

  it('keeps the failure detail as a banner under the table as well as the row', () => {
    const detail = ['gateway: no tool appeared in 60.2s', 'endpoint: stdio docker'].join('\n')
    const broken: ServerRow = {
      ...row('gateway', 'error'),
      detail,
    }
    const tree = ServerTable({ ...table, project: { ...REPO, rows: [broken] }, onRetry: () => undefined })
    const text = texts(tree).join(' | ')

    expect(text).toContain(t('retry'))
    expect(text).toContain(detail)
    // Pre-wrapped, so the note keeps the line structure the host sent.
    const preWrapped = elements(tree).filter(
      (element) =>
        (element.props.style as { whiteSpace?: string } | undefined)?.whiteSpace === 'pre-wrap',
    )
    expect(preWrapped).not.toHaveLength(0)
  })
})

describe('the JSON reading of the table view', () => {
  it('puts the toggle in the toolbar only while the table is the view', () => {
    const table = resolve(SettingsPage(pageProps({})))
    const files = resolve(SettingsPage(pageProps({ view: 'files' })))

    expect(button(table, t('showJson'))).toBeDefined()
    expect(button(files, t('showJson'))).toBeUndefined()
  })

  it('flips its own label and reports the click', () => {
    const asked: boolean[] = []
    const off = resolve(SettingsPage(pageProps({ onJson: (next: boolean) => asked.push(next) })))
    const on = resolve(SettingsPage(pageProps({ json: true })))

    expect(button(off, t('showJson'))?.props['aria-pressed']).toBe(false)
    ;(button(off, t('showJson'))?.props.onClick as () => void)()
    expect(asked).toEqual([true])
    expect(button(on, t('hideJson'))?.props['aria-pressed']).toBe(true)
    expect(button(on, t('showJson'))).toBeUndefined()
  })

  it('reads the snapshot’s parsed entries, and invents nothing for the rest', () => {
    const parsed = editorRow()

    expect(projectJson({ ...REPO, rows: [parsed] })).toContain('"mcpServers"')
    expect(projectJson({ ...REPO, rows: [parsed] })).toContain('"command": "npx"')
    // A row the host did not parse has no entry, so it is left out rather than
    // serialized as an empty server.
    expect(projectJson({ ...REPO, rows: [row('alpha', 'active')] })).toBe('{\n  "mcpServers": {}\n}')
  })

  it('shows the pane only while the toggle is on, and says where it came from', () => {
    const off = resolve(SettingsPage(pageProps({})))
    const on = resolve(SettingsPage(pageProps({ json: true, selectedServer: undefined })))
    const pane = elements(on).find((element) => element.type === 'pre')

    expect(elements(off).some((element) => element.type === 'pre')).toBe(false)
    expect(texts(pane).join('')).toContain('"mcpServers"')
    expect(texts(JsonPreview({ project: REPO, t })).join(' | ')).toContain(t('jsonPreviewHint'))
  })
})

describe('split editor: editable and read-only rows', () => {
  it('opens the parsed entry as editable fields when the document may be written', () => {
    const server = editorRow()
    const tree = EditorSplit(editor({ row: server, draft: edited({ command: 'node' }) }))
    // The Save button stays disabled while the draft is clean; every field is open.
    const form = writeControls(tree).filter((control) => control !== button(tree, 'Save…'))

    expect(form.length).toBeGreaterThanOrEqual(8)
    for (const control of form) expect(control.props.disabled).not.toBe(true)
    // The fields the snapshot did not carry before are here now, filled in.
    expect(field(tree, 'Command')?.props.value).toBe('node')
    expect(field(tree, 'Args')?.props.value).toBe('-y\nexample-service')
    expect(field(tree, 'CWD')?.props.value).toBe('/repo')
    expect(field(tree, 'Transport')?.props.value).toBe('stdio')
    expect(field(tree, 'Enabled')?.props.checked).toBe(true)
    expect(texts(tree).join(' | ')).toContain('Editing')
  })

  it('keeps every write control disabled with the host reason on a readonly row', () => {
    const server = editorRow({ writeScope: 'readonly', writeBlockedReason: 'the profile declares this document' })
    const tree = resolve(EditorSplit(editor({ row: server })))
    const writes = writeControls(tree)
    const text = texts(tree).join(' | ')

    expect(writes.length).toBeGreaterThanOrEqual(8)
    for (const control of writes) {
      expect(control.props.disabled).toBe(true)
      expect(control.props.title).toBe('the profile declares this document')
    }
    // The reason is prose the user reads, not just a tooltip.
    expect(text).toContain('Read-only: the profile declares this document')
    // The parsed entry is still shown, exactly as its document declares it.
    expect(field(tree, 'Command')?.props.value).toBe('npx')
    expect(paneLines(tree).join('\n')).toContain(
      JSON.stringify(documentBody(draftOf(server) as EntryDraft), null, 2),
    )
  })

  it('treats a row the host gave no writeScope as read-only, with its own fallback', () => {
    const server = editorRow({ writeScope: undefined, writeBlockedReason: undefined })
    const tree = EditorSplit(editor({ row: server }))
    const text = texts(tree).join(' | ')

    expect(text).toContain('did not report why this document may not be written')
    for (const control of writeControls(tree)) expect(control.props.disabled).toBe(true)
  })

  it('renders a coded blocked reason through the host namespace', () => {
    const server = editorRow({
      writeScope: 'readonly',
      writeBlockedReason:
        '/opt/mcp.json is not a document this deployment reads, and it configures none to write',
      blockedCode: 'write.blocked.notConfigured',
      blockedParams: { document: '/opt/mcp.json' },
    })
    const hostT: SettingsTabProps['hostT'] = (key, params) =>
      key === 'write.blocked.notConfigured'
        ? `${String(params?.document)} не входит в документы этого развёрнутого экземпляра`
        : key
    const tree = resolve(EditorSplit(editor({ row: server, hostT })))

    for (const control of writeControls(tree)) {
      expect(control.props.title).toBe('/opt/mcp.json не входит в документы этого развёрнутого экземпляра')
    }
  })

  it('shows the payload prose, never the raw code, for a code the namespace lacks', () => {
    const server = editorRow({
      writeScope: 'readonly',
      writeBlockedReason: 'the English sentence the host sent',
      blockedCode: 'write.blocked.future',
      blockedParams: { document: '/opt/mcp.json' },
    })
    const hostT: SettingsTabProps['hostT'] = (key) => key
    const tree = resolve(EditorSplit(editor({ row: server, hostT })))
    const text = texts(tree).join(' | ')

    expect(text).toContain('the English sentence the host sent')
    expect(text).not.toContain('write.blocked.future')
  })

  it('says nothing is editable when the host did not parse the entry', () => {
    const server = editorRow({ entry: undefined })
    const tree = EditorSplit(editor({ row: server, draft: undefined }))

    expect(texts(tree).join(' | ')).toContain('did not parse this entry')
    expect(button(tree, 'Save…')?.props.disabled).toBe(true)
  })

  it('opens the editable editor through the page for the selected server', () => {
    const server = editorRow()
    const tree = resolve(
      SettingsPage(
        pageProps({
          snapshot: snapshotOf({ ...REPO, rows: [server] }),
          selectedServer: 'gateway',
          draft: draftOf(server),
        }),
      ),
    )

    const form = writeControls(tree).filter((control) => control !== button(tree, 'Save…'))
    expect(form.length).toBeGreaterThanOrEqual(8)
    expect(field(tree, 'Command')?.props.value).toBe('npx')
    expect(field(tree, 'Args')?.props.value).toBe('-y\nexample-service')
  })
})

describe('split editor: draft, diff and discard', () => {
  it('opens clean: an untouched draft rebuilds the declared entry field for field', () => {
    const server = editorRow()
    const draft = draftOf(server)
    expect(draft).toBeDefined()

    // The document body comes back identical; the credentials-only key is the
    // one field a save never writes, which `entryBody` leaves out on both sides.
    expect(entryBody(draftEntry(draft!))).toEqual(entryBody(ENTRY))
    expect(entryDirty(server.entry, draftEntry(draft!))).toBe(false)
    const text = texts(EditorSplit(editor({ row: server }))).join(' | ')
    expect(text).toContain('no change')
    expect(text).not.toContain('unsaved')
  })

  it('shows the entry the draft would write, not a copy of the snapshot', () => {
    const server = editorRow()
    const draft = edited({ command: 'node' })
    const tree = resolve(EditorSplit(editor({ row: server, draft })))
    const paneText = paneLines(tree).join('\n')

    // The pane is the document body as the save would write it: the edited value
    // is in place, and the untouched fields keep theirs.
    expect(paneText).toContain('"command": "node"')
    expect(paneText).not.toContain('"command": "npx"')
    expect(paneText).toContain('"cwd": "/repo"')
    // The head says the body differs from the snapshot, and the footer agrees.
    expect(texts(tree).join(' | ')).toContain(t('jsonDiff'))
    expect(texts(tree).join(' | ')).toContain('unsaved')
  })

  it('marks a masked key that was replaced, without inventing a declared value', () => {
    const server = editorRow()
    const draft = edited({
      env: editableFields(server).map((entry) =>
        entry.key === 'API_TOKEN' ? { ...entry, text: 'rotated', replaced: true } : entry,
      ),
    })
    expect(entryDirty(server.entry, draftEntry(draft))).toBe(true)
    const paneText = paneLines(resolve(EditorSplit(editor({ row: server, draft })))).join('\n')

    // A replaced secret is a plain value in the document body, and the secret
    // the panel was never shown has no value to print at all.
    expect(paneText).toContain('"API_TOKEN": "rotated"')
    expect(paneText).not.toContain('masked')
  })

  it('enables Discard only for a changed draft, and the snapshot is the restore', () => {
    const server = editorRow()
    expect(button(EditorSplit(editor({ row: server })), 'Discard')?.props.disabled).toBe(true)

    const dirty = EditorSplit(editor({ row: server, draft: edited({ command: 'node' }) }))
    expect(button(dirty, 'Discard')?.props.disabled).not.toBe(true)
    // Discard is local: it writes nothing, so it is not a write control.
    expect(button(dirty, 'Discard')?.props['data-write']).toBeUndefined()
    // What the shell renders for an empty draft is the snapshot's own entry.
    expect(entryDirty(server.entry, draftEntry(activeDraft(server, undefined)!))).toBe(false)
  })

  it('ignores a stored draft built for another server or another revision', () => {
    const server = editorRow()
    const fresh = draftOf(server)

    expect(activeDraft(server, { ...fresh!, server: 'other' })).toEqual(fresh)
    expect(activeDraft(server, { ...fresh!, revision: 'rev-0' })).toEqual(fresh)
    expect(activeDraft(server, { ...fresh!, command: 'node' })?.command).toBe('node')
  })
})

describe('the JSON pane: the document body, editable', () => {
  const server = editorRow()
  const draft = draftOf(server) as EntryDraft

  it('prints the declaration as a document holds it, not as the snapshot carries it', () => {
    const body = documentBody(draft)

    // The snapshot's shape is a list of `{ key, value }`; a document declares an
    // object, and that is what the pane has to show to be editable.
    expect(body.transport).toBe('stdio')
    expect(body.env).toEqual({ LOG_LEVEL: 'info' })
    // The secret the panel was never shown, and the key the credentials file
    // answers, are both absent: neither has a value the pane could print.
    expect(Object.keys(body)).not.toContain('API_TOKEN')
    // The snapshot's own list still carries them for the form above.
    expect(draft.env.some((field) => field.key === 'API_TOKEN')).toBe(true)
    expect(jsonBodyOf(draft)).toBe(`${JSON.stringify(body, null, 2)}\n`)
  })

  it('keeps a key the credentials file answers out of the body, and in the draft', () => {
    const body = documentBody(draft)

    expect(Object.keys((body.env ?? {}) as Record<string, string>)).toEqual(['LOG_LEVEL'])
    expect(draft.env.some((field) => field.fromCredentials === true)).toBe(true)
    // A key the document declares as a reference is not rewritten by a body edit.
    const answer = draftFromJson(jsonBodyOf(draft), draft)
    expect('draft' in answer).toBe(true)
    if (!('draft' in answer)) return
    expect(answer.draft.env.filter((field) => field.fromCredentials === true)).toHaveLength(1)
  })

  it('parses its own text back into the same entry', () => {
    const answer = draftFromJson(jsonBodyOf(draft), draft)

    expect('draft' in answer).toBe(true)
    if (!('draft' in answer)) return
    expect(jsonBodyOf(answer.draft)).toBe(jsonBodyOf(draft))
    expect(entryDirty(server.entry, draftEntry(answer.draft))).toBe(false)
  })

  it('reports the first field that does not parse, rather than guessing one', () => {
    const bad = (text: string): string | undefined => {
      const answer = draftFromJson(text, draft)
      return 'error' in answer ? answer.error : undefined
    }

    expect(bad('{ nope')).toBeTruthy()
    expect(bad('[1, 2]')).toBe('not an object')
    expect(bad('"npx"')).toBe('not an object')
    expect(bad('{"command": "npx"}')).toBe('transport')
    expect(bad('{"transport": "sse"}')).toBe('transport')
    expect(bad('{"transport": "stdio", "args": [1]}')).toBe('args[0]')
    expect(bad('{"transport": "stdio", "env": {"A": 1}}')).toBe('env')
    expect(bad('{"transport": "stdio", "enabled": "yes"}')).toBe('enabled')
    expect(bad('{"transport": "stdio", "connectTimeoutMs": -1}')).toBe('connectTimeoutMs')
    expect(bad('{"transport": "stdio", "url": 7}')).toBe('url')
  })

  it('carries every key it does not model into the entry, verbatim', () => {
    const text = JSON.stringify(
      { transport: 'streamable-http', url: 'https://example.invalid/mcp', headers: { A: 'b' }, sse: true },
      null,
      2,
    )
    const answer = draftFromJson(text, draft)

    expect('draft' in answer).toBe(true)
    if (!('draft' in answer)) return
    expect(answer.draft.transport).toBe('streamable-http')
    expect(answer.draft.extra).toEqual({ sse: true })
    expect(documentBody(answer.draft).sse).toBe(true)
    // The other transport's keys are gone, because the draft no longer declares them.
    expect(documentBody(answer.draft).env).toBeUndefined()
  })

  it('lets a value replace a secret the panel was not shown', () => {
    const text = JSON.stringify({ transport: 'stdio', env: { API_TOKEN: 'rotated' } }, null, 2)
    const answer = draftFromJson(text, draft)

    expect('draft' in answer).toBe(true)
    if (!('draft' in answer)) return
    const token = answer.draft.env.find((field) => field.key === 'API_TOKEN')
    expect(token?.text).toBe('rotated')
    expect(token?.masked).toBe(false)
    expect(jsonBodyOf(answer.draft)).toContain('"API_TOKEN": "rotated"')
  })

  it('blocks the save while the text does not parse, and says so where the reason is', () => {
    const tree = resolve(EditorSplit(editor({ row: server, draft, jsonError: 'not an object' })))

    expect(button(tree, t('save'))?.props.disabled).toBe(true)
    expect(button(tree, 'Save…')?.props.title).toBe(t('saveJsonInvalid'))
    expect(texts(tree).join(' | ')).toContain(t('jsonInvalid', { reason: 'not an object' }))
    // The control itself carries the reason, like every other write control.
    const area = elements(tree).find((element) => element.type === 'textarea')
    expect(area?.props['data-write']).toBe(true)
  })
})

describe('split editor: secrets', () => {
  it('round-trips an untouched masked key as masked, with no value', () => {
    const server = editorRow()
    const submitted = draftEntry(draftOf(server)!)

    expect(submitted.env).toEqual([
      { key: 'LOG_LEVEL', value: 'info' },
      { key: 'API_TOKEN', masked: true },
      { key: 'HOME_TOKEN', masked: true, fromCredentials: true },
    ])
    const masked = submitted.env?.find((entry) => entry.key === 'API_TOKEN')
    expect(masked).toBeDefined()
    // The key the form never saw must reach the host as "leave it alone".
    expect(Object.keys(masked!)).toEqual(['key', 'masked'])
  })

  it('submits the typed value when the masked key was replaced', () => {
    const server = editorRow()
    const draft = edited({
      env: editableFields(server).map((entry) =>
        entry.key === 'API_TOKEN' ? { ...entry, text: 'rotated', replaced: true } : entry,
      ),
    })

    expect(draftEntry(draft).env).toEqual([
      { key: 'LOG_LEVEL', value: 'info' },
      { key: 'API_TOKEN', value: 'rotated' },
      { key: 'HOME_TOKEN', masked: true, fromCredentials: true },
    ])
  })

  it('shows a fromCredentials key and submits it as a pass-through, not a value', () => {
    const server = editorRow()
    const tree = EditorSplit(editor({ row: server }))
    const credentials = elements(tree).find(
      (element) => element.type === 'input' && element.props['data-read'] === true,
    )

    expect(credentials).toBeDefined()
    expect(credentials?.props.disabled).toBe(true)
    expect(credentials?.props.readOnly).toBe(true)
    expect(credentials?.props['data-write']).toBeUndefined()
    expect(texts(tree).join(' | ')).toContain('Comes from an external source')
    // It is submitted, because the host replaces the whole `env` object with what
    // the request carries: dropping it here would delete the credential reference
    // from the document on any unrelated edit. No value travels with it.
    const field = draftEntry(draftOf(server)!).env?.find((entry) => entry.key === 'HOME_TOKEN')
    expect(field).toEqual({ key: 'HOME_TOKEN', masked: true, fromCredentials: true })
    expect(field !== undefined && 'value' in field).toBe(false)
  })

  it('drops a key the form removed and keeps the entry it never showed', () => {
    const server = editorRow()
    const draft = edited({ env: editableFields(server).filter((entry) => entry.key !== 'LOG_LEVEL') })

    expect(draftEntry(draft).env).toEqual([
      { key: 'API_TOKEN', masked: true },
      { key: 'HOME_TOKEN', masked: true, fromCredentials: true },
    ])
    // `extra` is not presented by the form and must survive the rewrite.
    const withExtra = editorRow({ entry: { ...ENTRY, extra: { keepMe: 1 } } })
    expect(draftEntry(draftOf(withExtra)!).extra).toEqual({ keepMe: 1 })
    expect(entryDirty(withExtra.entry, draftEntry(draftOf(withExtra)!))).toBe(false)
  })
})

describe('split editor: confirmation', () => {
  it('names the document, the .bak copy and the format normalization', () => {
    const server = editorRow()
    const tree = EditorSplit(editor({ row: server, draft: edited({ command: 'node' }), confirming: true }))
    const text = texts(tree).join(' | ')

    expect(text).toContain('Write .dsh/mcp.json?')
    expect(text).toContain('copied to .dsh/mcp.json.bak')
    expect(text).toContain('normalized')
    expect(text).toContain('Write the document')
  })

  it('needs consent for a global document and maps it into the save request', () => {
    const global = editorRow({ writeScope: 'global', source: '/home/dev/.dsh/mcp.json' })
    const draft = edited({ command: 'node' })
    const unconfirmed = EditorSplit(editor({ row: global, draft, confirming: true }))

    expect(button(unconfirmed, 'Write the document')?.props.disabled).toBe(true)
    expect(texts(unconfirmed).join(' | ')).toContain('needs explicit consent')
    expect(field(unconfirmed, EN.consentLabel)?.props.checked).toBe(false)

    const agreed = EditorSplit(editor({ row: global, draft, confirming: true, consent: true }))
    expect(button(agreed, 'Write the document')?.props.disabled).not.toBe(true)
    expect(field(agreed, EN.consentLabel)?.props.checked).toBe(true)
    // The confirmation names the home directory as `~`, not the full path.
    expect(texts(agreed).join(' | ')).toContain('~/.dsh/mcp.json')

    const request = saveRequestOf(REPO, global, draftEntry(draft), true)
    expect(request).toMatchObject({
      projectRoot: '/repo',
      server: 'gateway',
      document: '/home/dev/.dsh/mcp.json',
      revision: 'rev-1',
      consent: true,
    })
    // Consent belongs to the global tier alone.
    expect(saveRequestOf(REPO, editorRow(), draftEntry(draft), true)).not.toHaveProperty('consent')
  })

  it('never writes from the Save button: it only opens the confirmation', () => {
    const calls: string[] = []
    const server = editorRow()
    const draft = edited({ command: 'node' })
    const open = button(
      EditorSplit(
        editor({
          row: server,
          draft,
          onAskSave: () => calls.push('ask'),
          onConfirmSave: () => calls.push('confirm'),
        }),
      ),
      'Save…',
    )
    expect(open?.props['data-write']).toBe(true)
    expect(open?.props.disabled).not.toBe(true)
    ;(open?.props.onClick as () => void)()
    expect(calls).toEqual(['ask'])

    const confirm = button(
      EditorSplit(
        editor({
          row: server,
          draft,
          confirming: true,
          onConfirmSave: () => calls.push('confirm'),
        }),
      ),
      'Write the document',
    )
    ;(confirm?.props.onClick as () => void)()
    expect(calls).toEqual(['ask', 'confirm'])
  })

  it('refuses to build a request without a document or a revision', () => {
    const entry = entryOf(editorRow())
    const tree = EditorSplit(editor({ row: editorRow({ source: undefined }) }))

    expect(saveRequestOf(REPO, editorRow({ source: undefined }), entry, false)).toBeUndefined()
    expect(
      saveRequestOf(REPO, editorRow({ documentRevision: undefined }), entry, false),
    ).toBeUndefined()
    // The Save control says why it cannot build a request, instead of failing later.
    expect(button(tree, 'Save…')?.props.disabled).toBe(true)
    expect(String(button(tree, 'Save…')?.props.title)).toContain('no declaring document or revision')
  })
})

describe('split editor: save answers', () => {
  const CODES = ['invalid', 'blocked', 'conflict', 'not-found', 'failed'] as const

  it('gives every SaveErrorCode its own sentence and says nothing was written', () => {
    const sentences = CODES.map((code) =>
      texts(
        EditorSplit(editor({ saveState: { ok: false, code, message: 'host text' } })),
      ).join(' '),
    )

    for (const sentence of sentences) expect(sentence).toContain('Nothing was written')
    expect(new Set(sentences).size).toBe(CODES.length)
  })

  it('surfaces the host message for invalid alone', () => {
    const invalid = texts(
      EditorSplit(
        editor({
          saveState: { ok: false, code: 'invalid', message: 'args[0] must be a string' },
        }),
      ),
    ).join(' | ')
    const blocked = texts(
      EditorSplit(editor({ saveState: { ok: false, code: 'blocked', message: 'args[0]' } })),
    ).join(' | ')

    expect(invalid).toContain('args[0] must be a string')
    expect(blocked).not.toContain('args[0] must be a string')
  })

  it('offers re-read for a conflict and nothing of the sort elsewhere', () => {
    const conflict = EditorSplit(editor({ saveState: { ok: false, code: 'conflict', message: '' } }))
    const invalid = EditorSplit(editor({ saveState: { ok: false, code: 'invalid', message: '' } }))

    expect(button(conflict, 'Re-read')).toBeDefined()
    expect(button(invalid, 'Re-read')).toBeUndefined()
  })

  it('says the document was written after a successful save', () => {
    const text = texts(EditorSplit(editor({ saveState: { ok: true } }))).join(' | ')

    expect(text).toContain('written and re-read')
  })
})

describe('the split editor’s three panes', () => {
  it('gives each pane its own head, the JSON one naming the document', () => {
    const tree = resolve(EditorSplit(editor()))
    const text = texts(tree)

    expect(elements(tree).filter((element) => element.props['data-pane'] !== undefined)).toHaveLength(3)
    expect(text).toContain(t('servers'))
    expect(text).toContain(t('paneEntry'))
    expect(text).toContain(`${documentLabel('/repo/.dsh/mcp.json', '/repo')} · ${t('jsonClean')}`)
  })
})

describe('settings layout: flexible in a row, stacked when narrow', () => {
  it('keeps the list beside the entry, and the form above the JSON', () => {
    const tree = EditorSplit(editor())
    const row = paneRow(tree)

    expect(row?.display).toBe('flex')
    expect(row?.flexDirection).not.toBe('column')
    // The list is the row's first child and keeps the vertical rule; the column
    // that holds the entry has none, because it is not a column of the row.
    expect(paneStyle(tree, 'list')?.borderRight).toBeTruthy()
    expect(paneStyle(tree, 'list')?.minWidth).toBe(0)
    expect(flexShrinkOf(paneStyle(tree, 'list'))).toBeGreaterThan(0)
    // The form and the JSON pane are two children of one column, in that order,
    // and that column is what shrinks beside the list.
    const column = elements(tree).find(
      (element) =>
        Array.isArray(element.props.children) &&
        (element.props.children as Element[]).some(
          (child) => child?.props?.['data-pane'] === 'form',
        ),
    )
    const children = (column?.props.children ?? []) as Element[]
    expect(column?.props.style).toMatchObject({ display: 'flex', flexDirection: 'column' })
    expect(children.map((child) => child?.props?.['data-pane'])).toEqual(['form', 'json'])
    // The form carries the rule that separates it from the JSON body under it.
    expect(paneStyle(tree, 'form')?.borderBottom).toBeTruthy()
    expect(paneStyle(tree, 'form')?.borderRight).toBeUndefined()
    expect(paneStyle(tree, 'json')?.flex).toBe('1 1 auto')
  })

  it('stacks the list, then the form, then the JSON, with no rule left over', () => {
    const tree = EditorSplit(editor({ narrow: true }))

    expect(paneRow(tree)?.flexDirection).toBe('column')
    for (const pane of ['list', 'form', 'json'] as const) {
      const style = paneStyle(tree, pane)
      expect(style?.width).toBe('100%')
      expect(style?.flex).toBe('none')
    }
    // The row's right rules are gone; the list and the form separate from the
    // pane below them with a bottom rule instead.
    expect(paneStyle(tree, 'list')?.borderRight).toBe('none')
    expect(paneStyle(tree, 'form')?.borderRight).toBeUndefined()
    expect(paneStyle(tree, 'json')?.borderRight).toBeUndefined()
    expect(paneStyle(tree, 'list')?.borderBottom).toBeTruthy()
    expect(paneStyle(tree, 'form')?.borderBottom).toBeTruthy()
  })

  it('renders the page’s content identically in both layouts', () => {
    const wide = resolve(SettingsPage(pageProps({ selectedServer: 'alpha' })))
    const narrow = resolve(SettingsPage(pageProps({ selectedServer: 'alpha', narrow: true })))

    expect(texts(wide).join(' | ')).toContain('alpha')
    expect(texts(narrow)).toEqual(texts(wide))
    // The flag reaches the editor through the page, not only into EditorSplit.
    expect(paneRow(wide)?.flexDirection).not.toBe('column')
    expect(paneRow(narrow)?.flexDirection).toBe('column')
  })

  it('reads the flag from the exported query, and stays wide without a browser', () => {
    const asked: string[] = []
    const match = (query: string): MediaQueryLike => {
      asked.push(query)
      return { matches: true }
    }

    expect(narrowSettingsLayout(match)).toBe(true)
    expect(asked).toEqual([NARROW_SETTINGS_QUERY])
    expect(narrowSettingsLayout(() => ({ matches: false }))).toBe(false)
    // A host without `matchMedia` keeps the side-by-side layout.
    expect(narrowSettingsLayout(undefined)).toBe(false)
    // The threshold on record: the settings panel only reaches its full 800px
    // at a 848px viewport, and below that it squeezes the three panes.
    expect(NARROW_SETTINGS_QUERY).toBe('(max-width: 850px)')
  })
})

describe('the plugin’s own two pages', () => {
  const snapshot = snapshotOf(REPO)

  it('puts the page switch in the toolbar and reports the page clicked', () => {
    const clicked: string[] = []
    const tree = page(snapshot, '/repo', { onPage: (next: string) => clicked.push(next) })
    const toolsButton = elements(tree).find(
      (element) => element.type === 'button' && texts(element).join('') === 'Tools',
    )

    expect(elements(tree).some((element) => element.type === 'button' && texts(element).join('') === 'Servers')).toBe(true)
    expect(toolsButton?.props['aria-pressed']).toBe(false)
    ;(toolsButton?.props.onClick as (() => void) | undefined)?.()

    expect(clicked).toEqual(['tools'])
  })

  it('opens the Tools page in place of the server page, project by project', () => {
    const servers = texts(page(snapshot, '/repo')).join(' | ')
    const tools = texts(page(snapshot, '/repo', { page: 'tools' })).join(' | ')

    // The server page lists the declared rows; the Tools page replaces them with
    // the policy table and the form for the same selected project.
    expect(servers).toContain('alpha')
    expect(tools).not.toContain('alpha')
    expect(tools).toContain(t('pinned'))
    expect(tools).toContain(t('checkConflicts'))
    expect(tools).toContain('repo' /* the fixture root’s folder */)
    // The page's own note about what lives here is the mode row's tooltip now,
    // not a paragraph above the rows: the mockup spends its lines on controls.
    const notes = elements(page(snapshot, '/repo', { page: 'tools' }))
      .map((element) => element.props.title)
      .filter((title) => typeof title === 'string')
    expect(notes).toContain(t('policyNote'))
    expect(tools).not.toContain(t('policyNote'))
    // Nothing invented reaches the rendered page either: no badge, no slot
    // figure, no prefix switch, and no example service the mockup locked.
    expect(tools).not.toContain(t('toolsDemo'))
    expect(tools).not.toContain('12 slots')
    expect(tools).not.toContain('example-service')
    expect(
      elements(page(snapshot, '/repo', { page: 'tools' })).some(
        (element) => element.type === 'input',
      ),
    ).toBe(false)
  })

  it('reads the conflicts and the per-server counts from the same snapshot', () => {
    const live: ProjectSnapshot = {
      ...REPO,
      conflicts: [
        {
          server: 'gateway',
          kind: 'duplicate',
          sources: ['/repo/.dsh/mcp.json', '/repo/.kimi-code/mcp.json'],
          message: 'the higher-priority document wins',
        },
      ],
      sessions: [
        {
          id: 'session-aaa11111',
          rows: [],
          issues: [],
          tools: {
            sessionId: 'session-aaa11111',
            baseline: ['mcp__gateway__status'],
            activated: [],
            context: [],
            deferred: ['mcp__gateway__logs'],
            mounted: 2,
            surfaceChars: 40,
            budgetChars: 0,
            deferring: false,
          },
        },
      ],
    }
    const rendered = texts(page(snapshotOf(live), '/repo', { page: 'tools' })).join(' | ')

    expect(rendered).toContain(t('conflictDuplicate'))
    expect(rendered).toContain('the higher-priority document wins')
    expect(rendered).toContain(t('conflictSources', { sources: '/repo/.dsh/mcp.json · /repo/.kimi-code/mcp.json' }))
    expect(rendered).toContain(t('serverPartlyOffered', { offered: 1, total: 2 }))
    expect(rendered).toContain(t('requestPreviewTools', { count: 1 }))
    // Without `deferredChars` the preview counts the hidden names and stops
    // there, rather than printing a token estimate nobody measured.
    expect(rendered).toContain(t('requestPreviewHidden', { count: 1 }))
    expect(rendered).not.toContain('≈')
  })
})

describe('registration', () => {
  it('waits for the slot declaration and registers the page into it', () => {
    const client = fakeClient()

    // Mirrors `index.ts`: the dictionaries ride the same effect as the page.
    client.services.effect(() => client.services.locale.register(NS, { en: uiEn }), 'dictionaries')
    registerSettingsTab(client.services)

    expect(client.injections).toEqual(['settings.section'])
    // `slots.register` throws on an undeclared slot, so nothing registers yet.
    expect(client.registrations).toEqual([])

    const pending = client.callbacks[0]
    expect(pending).toBeDefined()
    pending?.()
    expect(client.registrations).toHaveLength(1)
    const options = client.registrations[0] as SettingsTabRegistration
    expect(options).toMatchObject({
      name: 'settings.section',
      id: 'dsh-project-mcp',
      order: 900,
      locale: NS,
    })
    // A section is a row of the settings navigation, not a tab of the plugin
    // inventory, and it comes after every in-box one (the last is 25).
    expect(options.order).toBeGreaterThan(25)
    expect(options.label?.()).toBe('Project MCP')
    // The page reads its data over HTTP, so the inject face it registers is
    // deliberately empty: a section that received host objects here would be a
    // second data path beside the snapshot route.
    expect(options.inject?.()).toEqual({})
    // The registered seat is the page wrapped with the host-namespace
    // translator; the wrapper's behaviour is what the next test asserts.
    expect(typeof client.component).toBe('function')
  })

  it('hands the page the framework props plus the host-namespace seat', () => {
    const client = fakeClient()
    const seen: SettingsTabProps[] = []
    registerSettingsTab(client.services, (props) => {
      seen.push(props)
      return null
    })
    client.callbacks[0]?.()

    const registered = client.component as (props: SettingsTabProps) => unknown
    const seat = translateOf()
    registered({ t: seat })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.t).toBe(seat)
    // Bound to `projectMcp.host` by `hostTranslate`: a code the shell's fake
    // does not know echoes, which is the resolver's own miss signal.
    expect(typeof seen[0]?.hostT).toBe('function')
    expect(seen[0]?.hostT?.('write.blocked.notConfigured')).toBe('write.blocked.notConfigured')
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

/** The pure page with the shared props folded in, rendered down to elements. */
function page(
  snapshot: McpSnapshot,
  selectedRoot: string | undefined,
  overrides: Record<string, unknown> = {},
): unknown {
  return resolve(SettingsPage(pageProps({ snapshot, selectedRoot, ...overrides })))
}

/** A fake client composition that records what the registration asks of it. */
function fakeClient(): {
  services: SettingsSlotServices
  injections: string[]
  callbacks: (() => unknown)[]
  registrations: SettingsTabRegistration[]
  component: unknown
} {
  const client = {
    injections: [] as string[],
    callbacks: [] as (() => unknown)[],
    registrations: [] as SettingsTabRegistration[],
    component: undefined as unknown,
    services: undefined as unknown as SettingsSlotServices,
  }
  let dictionaries: Record<string, Record<string, string>> = {}
  client.services = {
    effect: (execute) => execute(),
    locale: {
      register: (namespace, dicts) => {
        if (namespace === NS) dictionaries = dicts
        return () => undefined
      },
      bind: () => (key) => dictionaries.en?.[key] ?? key,
    },
    slots: {
      inject: (slot, callback) => {
        client.injections.push(slot)
        client.callbacks.push(callback)
        return () => undefined
      },
      register: (options, component) => {
        client.registrations.push(options)
        client.component = component
        return () => undefined
      },
    },
  }
  return client
}

/**
 * The row detail wire codes (F-48, Task 4): the settings page's three
 * `row.detail` render sites — the error note under the table, the name
 * button's tooltip and the editor's detail field — resolve the row's
 * `detailCode`/`detailParams` through the host seat; a row without companions
 * renders its prose exactly as before.
 */
describe('the row detail wire codes (F-48, Task 4)', () => {
  /** A host seat that knows one detail code in another language; the rest echo. */
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
  const TRANSLATED =
    'gateway: за 60.2s ни одного инструмента\nэндпоинт: stdio docker\nобъявлено в: /repo/.dsh/mcp.json'

  /** The broken row, with the coded companions the host publishes beside the prose. */
  const broken = (): ServerRow => ({
    ...row('gateway', 'error', '/repo/.dsh/mcp.json'),
    detail: DETAIL,
    detailCode: 'mount.stalledDetail',
    detailParams: {
      name: 'gateway',
      elapsed: '60.2s',
      endpoint: 'stdio docker',
      source: '/repo/.dsh/mcp.json',
    },
  })

  const table = (rows: ServerRow[], seat?: Translate): unknown =>
    ServerTable({
      project: { ...REPO, rows },
      onSelectServer: () => undefined,
      t,
      ...(seat === undefined ? {} : { hostT: seat }),
    })

  it('resolves the error note under the table through the host seat', () => {
    // The note is the row's name in bold, then ` — ` and the detail: the name
    // is its own element, so the detail half is what the assertion reads.
    const text = texts(table([broken()], hostT)).join(' | ')
    expect(text).toContain(`— ${TRANSLATED}`)
  })

  it('keeps the payload prose without a seat, and an uncoded row exactly as before', () => {
    const seatless = texts(table([broken()])).join(' | ')
    expect(seatless).toContain(`— ${DETAIL}`)
    expect(seatless).not.toContain('mount.stalledDetail')

    const uncoded = texts(table([{ ...row('gateway', 'error', '/repo/.dsh/mcp.json'), detail: DETAIL }], hostT)).join(' | ')
    expect(uncoded).toContain(`— ${DETAIL}`)
  })

  it('carries the resolved detail as the name button’s tooltip', () => {
    const tree = table([broken()], hostT)
    const nameButton = elements(tree).find(
      (element) => element.type === 'button' && texts(element).join('') === 'gateway',
    )
    expect(nameButton?.props.title).toBe(TRANSLATED)

    const seatless = elements(table([broken()])).find(
      (element) => element.type === 'button' && texts(element).join('') === 'gateway',
    )
    expect(seatless?.props.title).toBe(DETAIL)
  })

  it('threads the seat from the page body down to the conflict card', () => {
    // settingsBody → ToolsPage → ProjectForm → ConflictReport: a break anywhere
    // in the chain leaves the card on the payload's English.
    const conflicted: ProjectSnapshot = {
      ...REPO,
      conflicts: [
        {
          server: 'alpha',
          kind: 'profile',
          sources: ['/repo/.dsh/mcp.json'],
          message:
            '"alpha" is owned by a profile-level mcp-client instance; the project copy waits.',
          alias: 'p-alpha',
          choice: 'profile',
          code: 'conflict.profile',
          params: { name: 'alpha' },
        },
      ],
    }
    const seat: Translate = (key, params) => {
      if (key !== 'conflict.profile') return key
      const template = '"{name}" принадлежит экземпляру уровня профиля'
      return params === undefined
        ? template
        : template.replace(/\{(\w+)\}/g, (whole, name: string) =>
            name in params ? String(params[name]) : whole,
          )
    }
    const tree = resolve(settingsBody(pageProps({ page: 'tools', snapshot: snapshotOf(conflicted), hostT: seat })))
    expect(texts(tree).join(' | ')).toContain('"alpha" принадлежит экземпляру уровня профиля')
    // Without the seat the same card renders the payload's English.
    const seatless = resolve(settingsBody(pageProps({ page: 'tools', snapshot: snapshotOf(conflicted) })))
    expect(texts(seatless).join(' | ')).toContain('the project copy waits.')
  })

  it('resolves the editor’s detail field through the host seat', () => {
    const server = editorRow({ detail: DETAIL, detailCode: 'mount.stalledDetail', detailParams: {
      name: 'gateway',
      elapsed: '60.2s',
      endpoint: 'stdio docker',
      source: '/repo/.dsh/mcp.json',
    } })
    const tree = EditorSplit(editor({ row: server, hostT }))
    const detailField = field(tree, t('detail'))
    expect(texts(detailField ?? null).join('')).toBe(TRANSLATED)

    // Without companions the field renders the prose exactly as before.
    const plain = EditorSplit(editor({ row: editorRow({ detail: DETAIL }), hostT }))
    expect(texts(field(plain, t('detail')) ?? null).join('')).toBe(DETAIL)
  })
})

/**
 * The save refusal wire codes (F-48, Task 5): `saveNotice` resolves a coded
 * refusal through the host seat and shows the translated sentence; an answer
 * without codes keeps the `hostMessage` wrapper exactly as before.
 */
describe('the save refusal wire codes (F-48, Task 5)', () => {
  /** A host seat that knows one refusal code in another language; the rest echo. */
  const hostT: Translate = (key, params) => {
    if (key !== 'save.invalidJson') return key
    const template = 'объявляющий документ не является допустимым JSON: {error}'
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
      name in params ? String(params[name]) : whole,
    )
  }

  const MESSAGE = 'the declaring document is not valid JSON: Unexpected token'

  it('resolves a coded refusal through the host seat, without the hostMessage wrapper', () => {
    const notice = saveNotice(
      {
        ok: false,
        code: 'invalid',
        message: MESSAGE,
        messageCode: 'save.invalidJson',
        messageParams: { document: '/repo/.dsh/mcp.json', error: 'Unexpected token' },
      },
      t,
      hostT,
    )

    expect(notice.detail).toBe('объявляющий документ не является допустимым JSON: Unexpected token')
    // The wrapper is for uncoded answers: a translated sentence stands alone.
    const wrapper = t('hostMessage', { message: '' })
    expect(notice.detail?.startsWith(wrapper)).toBe(false)
  })

  it('keeps the hostMessage wrapper for an uncoded answer, byte-identical to before codes', () => {
    const notice = saveNotice({ ok: false, code: 'invalid', message: 'args[0] must be a string' }, t, hostT)

    expect(notice.detail).toBe(t('hostMessage', { message: 'args[0] must be a string' }))
  })

  it('falls back to the English message for a code the seat does not know, never the raw code', () => {
    const notice = saveNotice(
      { ok: false, code: 'invalid', message: MESSAGE, messageCode: 'save.future', messageParams: {} },
      t,
      hostT,
    )

    expect(notice.detail).toBe(MESSAGE)
    expect(notice.detail).not.toContain('save.future')
  })
})
