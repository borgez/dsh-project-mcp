/**
 * Settings page: the hook shell, and the controls a user operates.
 *
 * `tests/settings.spec.ts` drives every pure component of
 * `src/client/settings.ts` as a function of its props, in the node environment.
 * What it cannot reach is the half of the module that only exists while React is
 * rendering: `SettingsTab`'s `useState`/`useCallback`/`useEffect` wiring, the
 * media-query hook behind the narrow layout, and the inline `onClick`/`onChange`
 * bodies of controls whose presence alone the pure tests assert.
 *
 * ## No DOM environment, and why
 *
 * F-20 allows a file-scoped environment pragma naming a DOM implementation.
 * This checkout has neither `jsdom` nor `happy-dom` anywhere in its tree — there
 * is no DOM package to name, and F-20 forbids adding one — so the pragma would
 * fail collection with "Cannot find package 'jsdom'" rather than run the suite.
 * Nor is there a renderer to borrow: `react-dom` is not resolvable from this
 * package (it is installed only under the sidebar's own dependency closure).
 *
 * The hooks are therefore driven through React's own hook contract. React's
 * hooks are plain function calls into whatever dispatcher is installed; a small
 * dispatcher of our own holds one slot per hook, so state survives a re-render,
 * effects are queued and run afterwards, and callbacks keep their identity while
 * their dependencies do not change. That is the seam a renderer would give,
 * without a DOM.
 *
 * Every browser call the shell makes is stubbed, so the checks are about what
 * the page then *does*: which route it posts, what it renders after a save, and
 * what each control reports when a user operates it.
 */

import { describe, expect, it } from 'vitest'
import * as React from 'react'
import { createElement as h } from 'react'
import type { McpSnapshot, ProjectSnapshot, ServerRow, ToolMode } from '../src/types.ts'
import {
  EditorSplit,
  ProjectSelector,
  SettingsTab,
  ViewSwitch,
  browserMatchMedia,
  draftOf,
  entryBody,
  fileGroups,
  narrowSettingsLayout,
  useNarrowSettings,
} from '../src/client/settings.ts'
import type { EntryDraft, MediaQueryLike, SettingsTabProps, Translate } from '../src/client/settings.ts'
import { en } from '../src/client/locales/ui.ts'
import type { EntrySnapshot } from '../src/types.ts'
import { ROUTE_ACTIONS, ROUTE_PREFIX } from '../src/shared.ts'

/** The namespace's own dictionary: the exact table the live seat holds. */
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

/** Every element in the tree, the root included. */
function elements(node: unknown): Element[] {
  if (node === null || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap((child) => elements(child))
  const element = node as Element
  return [element, ...elements(element.props.children)]
}

/**
 * Invoke the pure function components in a tree, so the walkers see the
 * elements they produce. Never used on {@link SettingsTab} itself: it is the
 * shell's only hook-bearing component, and it is driven by {@link mount}.
 */
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

/**
 * The dispatcher {@link resolve} walks with: every hook answers its first render.
 *
 * `mount` owns the real slots, but `resolve` invokes the components below the
 * shell by hand, after that render — and a component that keeps state (the JSON
 * pane holds its own text) would otherwise call React's hooks with no dispatcher
 * installed at all. One value per hook is all a single walk needs, because
 * nothing below is re-rendered here.
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

/** The element the shell rendered, with its own components invoked. */
function rendered(tree: unknown): unknown {
  return resolve(tree)
}

/** Every string a user would read under this node, in tree order. */
function texts(node: unknown): string[] {
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (Array.isArray(node)) return node.flatMap((child) => texts(child))
  const element = node as Element
  return texts(element.props.children)
}

/** One control of a tree, by the aria-label it carries. */
function labelled(tree: unknown, label: string): Element | undefined {
  return elements(tree).find((element) => element.props['aria-label'] === label)
}

/** One button of a tree, by the text a user reads on it. */
function button(tree: unknown, label: string): Element | undefined {
  return elements(tree).find(
    (element) => element.type === 'button' && texts(element).join('') === label,
  )
}

/** A checkbox `onChange` event, as React hands it to the handler. */
function checkbox(checked: boolean): { target: { checked: boolean } } {
  return { target: { checked } }
}

/** A text `onChange` event, as React hands it to the handler. */
function typed(value: string): { target: { value: string } } {
  return { target: { value } }
}

// ── fixtures ──────────────────────────────────────────────────────────────────

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

/** One writable row whose entry the host parsed. */
function editorRow(overrides: Partial<ServerRow> = {}): ServerRow {
  return {
    name: 'gateway',
    status: 'error',
    projectRoot: '/repo',
    source: '/repo/.dsh/mcp.json',
    transport: 'stdio',
    entry: ENTRY,
    writeScope: 'project',
    documentRevision: 'rev-1',
    ...overrides,
  }
}

const REPO: ProjectSnapshot = {
  projectRoot: '/repo',
  sessionIds: ['session-aaa11111'],
  rows: [editorRow()],
  issues: [],
  sessions: [],
}

const OTHER: ProjectSnapshot = {
  projectRoot: '/other',
  sessionIds: ['session-zzz'],
  rows: [{ name: 'beta', status: 'idle', projectRoot: '/other', source: '/other/.dsh/mcp.json' }],
  issues: [],
  sessions: [],
}

function snapshotOf(...projects: ProjectSnapshot[]): McpSnapshot {
  return { ready: true, projects, watchedFiles: [] }
}

/** Two live projects: the page renders exactly one of them at a time. */
const TWO_PROJECTS = snapshotOf(REPO, OTHER)

// ── the browser the shell runs against ────────────────────────────────────────

interface BrowserStub {
  /** Every request the shell made, in order, with the parsed POST body. */
  calls: { url: string; method: string; body: unknown }[]
  /** The envelope the next save `POST` answers with. */
  save: { status?: number; body: unknown }
  /** The envelope the next policy (`mode`) `POST` answers with. */
  policy: { status?: number; body: unknown }
  /** Put the stubbed globals back. */
  restore(): void
}

/**
 * Replace the browser globals the client shell reads.
 * @param snapshot - the snapshot the read routes answer with.
 * @returns the stub, with the recorded requests and the undo.
 */
function stubBrowser(snapshot: McpSnapshot = TWO_PROJECTS): BrowserStub {
  const calls: BrowserStub['calls'] = []
  const globals = globalThis as Record<string, unknown>
  const before = {
    fetch: globals.fetch,
    EventSource: globals.EventSource,
    matchMedia: globals.matchMedia,
    setInterval: globals.setInterval,
    clearInterval: globals.clearInterval,
  }
  const stub: BrowserStub = {
    calls,
    save: { body: { ok: true } },
    policy: { body: { ok: true } },
    restore: () => {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete globals[key]
        else globals[key] = value
      }
    },
  }
  globals.fetch = async (url: string, init?: RequestInit) => {
    // Every route answers with the envelope its own surface unwraps: the save
    // route with `{ ok }`, the read routes with `{ ok, value }`.
    const save = init?.method === 'POST' && url.endsWith(`/${ROUTE_ACTIONS.save}`)
    const policy = init?.method === 'POST' && url.endsWith(`/${ROUTE_ACTIONS.policy}`)
    const answer = save ? stub.save : policy ? stub.policy : undefined
    const status = answer?.status ?? 200
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    })
    const body = answer?.body ?? { ok: true, value: snapshot }
    return { ok: status < 400, status, json: async () => body }
  }
  // A push connection that never delivers a frame: the poll then does the work.
  globals.EventSource = class {
    addEventListener(): void {}
    close(): void {}
  }
  globals.matchMedia = (): MediaQueryLike => ({ matches: false })
  globals.setInterval = () => ({ timer: true })
  globals.clearInterval = () => undefined
  return stub
}

/** A `MediaQueryList` the check drives by hand. */
interface DriveableList extends MediaQueryLike {
  listeners(): (() => void)[]
  ask(): string[]
  set(next: boolean): void
}

function mediaList(matches: boolean): DriveableList {
  const listeners: (() => void)[] = []
  const asked: string[] = []
  const list: DriveableList = {
    matches,
    addEventListener: (_type: 'change', listener: () => void) => listeners.push(listener),
    removeEventListener: (_type: 'change', listener: () => void) => {
      const at = listeners.indexOf(listener)
      if (at >= 0) listeners.splice(at, 1)
    },
    listeners: () => listeners,
    ask: () => asked,
    set: (next: boolean) => {
      list.matches = next
      for (const listener of listeners) listener()
    },
  }
  return list
}

/** Install `globalThis.matchMedia`, run one check, then put it back. */
function withMatchMedia(list: () => DriveableList, run: () => void): void {
  const globals = globalThis as Record<string, unknown>
  const before = globals.matchMedia
  globals.matchMedia = (query: string) => {
    const current = list()
    current.ask().push(query)
    return current
  }
  try {
    run()
  } finally {
    if (before === undefined) delete globals.matchMedia
    else globals.matchMedia = before
  }
}

// ── the hook host ─────────────────────────────────────────────────────────────

interface Slot {
  state?: unknown
  deps?: readonly unknown[] | undefined
  value?: unknown
  /** The callback of a `useCallback`, re-created each render: a memoized
   * callback still closes over the latest props. */
  derived?: unknown
}

interface Mounted {
  /** The tree the last render produced. */
  tree(): unknown
  /** Re-render, running nothing else. */
  render(): void
  /** Run the effects the last render queued, then re-render. */
  flush(): void
  /** Run every effect cleanup, the way an unmount does. */
  cleanup(): void
  /** Let the shell's async work settle, then re-render. */
  settle(): Promise<void>
  /** The props of the element the shell rendered; its callbacks live here. */
  props(): Record<string, unknown>
}

/**
 * Render a hook-bearing component and keep its hooks alive between renders.
 *
 * The component is called with our dispatcher installed and its element tree is
 * returned as it is: the children it names are React elements, and the pure ones
 * are resolved by the checks that read them. State survives a re-render, effects
 * are queued and run by {@link Mounted.flush}, and callbacks keep their identity
 * while their dependencies do not change.
 * @param component - the hook-bearing component to drive.
 * @returns the shell, with its tree and the callbacks of the element it rendered.
 */
function mount<P extends object>(component: (props: P) => unknown, props: P): Mounted {
  const slots: Slot[] = []
  const queued: (() => unknown)[] = []
  const cleanups: (() => unknown)[] = []
  let cursor = 0
  let captured: unknown

  const same = (left: readonly unknown[] | undefined, right: readonly unknown[]): boolean =>
    left !== undefined &&
    left.length === right.length &&
    left.every((value, at) => Object.is(value, right[at]))

  const dispatcher = {
    useState: (initial?: unknown): [unknown, (next: unknown) => void] => {
      const slot = (slots[cursor++] ??= {})
      if (!('state' in slot)) {
        slot.state = typeof initial === 'function' ? (initial as () => unknown)() : initial
      }
      return [
        slot.state,
        (next: unknown) => {
          slot.state =
            typeof next === 'function' ? (next as (previous: unknown) => unknown)(slot.state) : next
        },
      ]
    },
    useRef: (initial?: unknown) => {
      const slot = (slots[cursor++] ??= {})
      if (!('value' in slot)) slot.value = { current: initial }
      return slot.value
    },
    useMemo: (create: () => unknown, deps: readonly unknown[]) => {
      const slot = (slots[cursor++] ??= {})
      slot.derived = create()
      if (!same(slot.deps, deps)) {
        slot.deps = deps
        slot.value = slot.derived
      }
      return slot.value
    },
    useCallback: (create: unknown, deps: readonly unknown[]) => {
      const slot = (slots[cursor++] ??= {})
      slot.derived = create
      if (!same(slot.deps, deps)) {
        slot.deps = deps
        slot.value = slot.derived
      }
      return slot.value
    },
    useEffect: (create: () => unknown, deps?: readonly unknown[]) => {
      const slot = (slots[cursor++] ??= {})
      if (deps === undefined || !same(slot.deps, deps)) {
        slot.deps = deps
        queued.push(create)
      }
    },
    useLayoutEffect: () => undefined,
    useInsertionEffect: () => undefined,
    useDebugValue: () => undefined,
    useReducer: (
      reducer: (state: unknown, action: unknown) => unknown,
      initial: unknown,
    ): [unknown, (action: unknown) => void] => {
      const slot = (slots[cursor++] ??= { state: initial })
      return [
        slot.state,
        (action: unknown) => {
          slot.state = reducer(slot.state, action)
        },
      ]
    },
    useContext: (context: { _currentValue?: unknown }) => context._currentValue,
    useId: () => `:r${cursor++}:`,
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    useTransition: () => [false, (callback: () => void) => callback()],
    useDeferredValue: (value: unknown) => value,
    useImperativeHandle: () => undefined,
  }

  const render = (): void => {
    cursor = 0
    const holder = dispatcherHolder()
    const previous = holder.current
    holder.current = dispatcher
    try {
      captured = component(props)
    } finally {
      holder.current = previous
    }
  }

  const mounted: Mounted = {
    tree: () => captured,
    render,
    flush: () => {
      const run = queued.splice(0)
      for (const effect of run) {
        const cleanup = effect()
        if (typeof cleanup === 'function') cleanups.push(cleanup as () => unknown)
      }
      if (run.length > 0) render()
    },
    cleanup: () => {
      for (const cleanup of cleanups.splice(0).reverse()) cleanup()
    },
    settle: async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      render()
    },
    props: () => {
      if (captured === undefined) render()
      return (captured as Element).props
    },
  }
  return mounted
}

/**
 * React's current-dispatcher holder.
 *
 * React exports no way to install a dispatcher; this internals object is the
 * seam `react-test-renderer` itself uses, and it is assigned only inside
 * {@link mount}'s render and restored in the same `finally`.
 */
function dispatcherHolder(): { current: unknown } {
  const internals = (React as unknown as {
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: {
      ReactCurrentDispatcher: { current: unknown }
    }
  }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  return internals.ReactCurrentDispatcher
}

// ── the shell: poll, routes, state ────────────────────────────────────────────

/** The page's props, with only what a check cares about overridden. */
function page(
  row: ServerRow,
  overrides: Record<string, unknown> = {},
): ReturnType<typeof EditorSplit> {
  return EditorSplit({
    project: { ...REPO, rows: [row] },
    row,
    onSelectServer: () => undefined,
    draft: draftOf(row),
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
  } as Parameters<typeof EditorSplit>[0])
}

describe('the settings shell', () => {
  it('renders both of its pages, the toolbar and the first-poll state', () => {
    const browser = stubBrowser(snapshotOf())
    try {
      const shell = mount(SettingsTab, { t } as SettingsTabProps)
      shell.render()
      const text = texts(rendered(shell.tree())).join(' | ')

      expect(text).toContain(t('tabServers'))
      expect(text).toContain(t('tabTools'))
      expect(text).toContain(t('viewTable'))
      expect(text).toContain(t('viewFiles'))
      expect(text).toContain(t('sync'))
      // Nothing has been read yet, so the body names the first poll.
      expect(text).toContain(t('loading'))
    } finally {
      browser.restore()
    }
  })

  it('polls the snapshot route, and the sync button posts the selected project', async () => {
    const browser = stubBrowser()
    try {
      const shell = mount(SettingsTab, { t } as SettingsTabProps)
      shell.render()
      shell.flush()
      await shell.settle()

      const poll = browser.calls.find((call) => call.url === `${ROUTE_PREFIX}/${ROUTE_ACTIONS.snapshot}`)
      expect(poll?.method).toBe('GET')
      // The first project is selected while nothing is chosen by hand.
      expect(texts(rendered(shell.tree())).join(' | ')).toContain('gateway')

      const props = shell.props()
      ;(props.onSync as () => void)()
      const sync = browser.calls.find((call) => call.url === `${ROUTE_PREFIX}/${ROUTE_ACTIONS.sync}`)
      expect(sync?.method).toBe('POST')
      // The page lists every project, so both operator actions ask for all of it.
      expect(sync?.body).toEqual({ projectRoot: '/repo', full: true })
    } finally {
      browser.restore()
    }
  })

  it('remembers the by-files view and moves the selection with it', async () => {
    const browser = stubBrowser()
    try {
      const shell = mount(SettingsTab, { t } as SettingsTabProps)
      shell.render()
      shell.flush()
      await shell.settle()

      const props = shell.props()
      ;(props.onView as (view: string) => void)('files')
      shell.render()
      expect(texts(rendered(shell.tree())).join(' | ')).toContain('.dsh/mcp.json')

      // A project change is not a write and must not keep a server open.
      ;(props.onSelectProject as (root: string) => void)('/other')
      shell.render()
      const text = texts(rendered(shell.tree())).join(' | ')
      expect(text).toContain('beta')
      expect(text).not.toContain('gateway')
    } finally {
      browser.restore()
    }
  })

  it('opens the editor on a server, and drops the draft when the project changes', async () => {
    const browser = stubBrowser()
    try {
      const shell = mount(SettingsTab, { t } as SettingsTabProps)
      shell.render()
      shell.flush()
      await shell.settle()

      const props = shell.props()
      ;(props.onSelectServer as (name: string) => void)('gateway')
      shell.render()
      expect(texts(rendered(shell.tree())).join(' | ')).toContain(t('paneEntry'))

      // A stored draft is dropped with the selection, so the next row opens
      // clean rather than carrying an edit built for another server.
      ;(props.onSelectServer as (name: string | undefined) => void)(undefined)
      shell.render()
      expect(texts(rendered(shell.tree())).join(' | ')).not.toContain(t('paneEntry'))
    } finally {
      browser.restore()
    }
  })

  it('toggles the JSON reading and the separate Tools page', async () => {
    const browser = stubBrowser()
    try {
      const shell = mount(SettingsTab, { t } as SettingsTabProps)
      shell.render()
      shell.flush()
      await shell.settle()

      const props = shell.props()
      ;(props.onJson as (next: boolean) => void)(true)
      shell.render()
      expect(texts(rendered(shell.tree())).join(' | ')).toContain(t('jsonPreview'))

      ;(props.onPage as (page: string) => void)('tools')
      shell.render()
      const text = texts(rendered(shell.tree())).join(' | ')
      // The policy note is the mode row's tooltip now, so the page carries it as
      // an attribute rather than as a paragraph above the rows.
      const titles = elements(rendered(shell.tree()))
        .map((element) => element.props.title)
        .filter((title) => typeof title === 'string')
      expect(titles).toContain(t('policyNote'))
      expect(text).not.toContain(t('policyNote'))
      expect(text).not.toContain(t('jsonPreview'))
    } finally {
      browser.restore()
    }
  })

  it('writes a project mode straight through, and reports a refusal', async () => {
    const browser = stubBrowser()
    browser.save = { body: { ok: false, error: { code: 'blocked', message: 'the host refused it' } } }
    try {
      const shell = mount(SettingsTab, { t } as SettingsTabProps)
      shell.render()
      shell.flush()
      await shell.settle()

      const props = shell.props()
      ;(props.onMode as (root: string, mode: ToolMode) => void)('/repo', 'off')
      shell.render()
      const call = browser.calls.find((entry) => entry.url === `${ROUTE_PREFIX}/${ROUTE_ACTIONS.policy}`)
      expect(call?.method).toBe('POST')
      // The mode is not a draft: the switch writes it on the spot.
      expect(call?.body).toMatchObject({ projectRoot: '/repo', mode: 'off' })
    } finally {
      browser.restore()
    }
  })

  it('saves the open entry after the confirmation, then re-reads the snapshot', async () => {
    const browser = stubBrowser()
    try {
      const shell = mount(SettingsTab, { t } as SettingsTabProps)
      shell.render()
      shell.flush()
      await shell.settle()

      const props = shell.props()
      ;(props.onSelectServer as (name: string) => void)('gateway')
      shell.render()

      // The shell hands the editor the snapshot's own entry; edit it by hand.
      const draft = shell.props().draft as EntryDraft
      ;(shell.props().onDraft as (next: EntryDraft) => void)({ ...draft, command: 'node' })
      shell.render()
      // Save only opens the confirmation; nothing is posted yet.
      ;(shell.props().onAskSave as () => void)()
      shell.render()
      expect(browser.calls.some((call) => call.method === 'POST' && call.url.endsWith(ROUTE_ACTIONS.save))).toBe(false)

      ;(shell.props().onConfirmSave as () => void)()
      await new Promise((resolve) => setTimeout(resolve, 0))
      shell.render()

      const save = browser.calls.find((call) => call.url.endsWith(`/${ROUTE_ACTIONS.save}`))
      expect(save?.body).toMatchObject({
        projectRoot: '/repo',
        server: 'gateway',
        document: '/repo/.dsh/mcp.json',
        revision: 'rev-1',
        entry: { command: 'node' },
      })
      // The answer is shown, and the fresh snapshot is read back.
      expect(texts(rendered(shell.tree())).join(' | ')).toContain(t('saveOk'))
      expect(browser.calls.filter((call) => call.url.endsWith(ROUTE_ACTIONS.snapshot)).length).toBeGreaterThan(1)
    } finally {
      browser.restore()
    }
  })

  it('shows the host’s refusal instead of pretending the write landed', async () => {
    const browser = stubBrowser()
    browser.save = { body: { ok: false, error: { code: 'invalid', message: 'args[0] must be a string' } } }
    try {
      const shell = mount(SettingsTab, { t } as SettingsTabProps)
      shell.render()
      shell.flush()
      await shell.settle()

      ;(shell.props().onSelectServer as (name: string) => void)('gateway')
      shell.render()
      const draft = shell.props().draft as EntryDraft
      ;(shell.props().onDraft as (next: EntryDraft) => void)({ ...draft, command: 'node' })
      shell.render()
      ;(shell.props().onAskSave as () => void)()
      shell.render()
      ;(shell.props().onConfirmSave as () => void)()
      await new Promise((resolve) => setTimeout(resolve, 0))
      shell.render()

      const text = texts(rendered(shell.tree())).join(' | ')
      expect(text).toContain(t('saveErrorInvalid'))
      // Only `invalid` carries the parser's own sentence.
      expect(text).toContain('args[0] must be a string')
    } finally {
      browser.restore()
    }
  })

  it('refuses a global write without consent, and sends it with consent', async () => {
    const browser = stubBrowser(
      snapshotOf({ ...REPO, rows: [editorRow({ writeScope: 'global', source: '/home/dev/.dsh/mcp.json' })] }),
    )
    try {
      const shell = mount(SettingsTab, { t } as SettingsTabProps)
      shell.render()
      shell.flush()
      await shell.settle()

      ;(shell.props().onSelectServer as (name: string) => void)('gateway')
      shell.render()
      const draft = shell.props().draft as EntryDraft
      ;(shell.props().onDraft as (next: EntryDraft) => void)({ ...draft, command: 'node' })
      shell.render()
      ;(shell.props().onAskSave as () => void)()
      shell.render()

      // Belt and braces: the confirm button is disabled, and the handler
      // itself refuses to build a request without the explicit consent.
      ;(shell.props().onConfirmSave as () => void)()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(browser.calls.some((call) => call.url.endsWith(`/${ROUTE_ACTIONS.save}`))).toBe(false)

      ;(shell.props().onConsent as (next: boolean) => void)(true)
      shell.render()
      ;(shell.props().onConfirmSave as () => void)()
      await new Promise((resolve) => setTimeout(resolve, 0))
      shell.render()

      const save = browser.calls.find((call) => call.url.endsWith(`/${ROUTE_ACTIONS.save}`))
      expect(save?.body).toMatchObject({
        document: '/home/dev/.dsh/mcp.json',
        consent: true,
        entry: { command: 'node' },
      })
    } finally {
      browser.restore()
    }
  })

  it('cancels the confirmation and re-reads the snapshot on request', async () => {
    const browser = stubBrowser()
    try {
      const shell = mount(SettingsTab, { t } as SettingsTabProps)
      shell.render()
      shell.flush()
      await shell.settle()
      const polls = browser.calls.length

      ;(shell.props().onReRead as () => void)()
      await new Promise((resolve) => setTimeout(resolve, 0))
      shell.render()

      // Re-read refetches; it is the recovery the `conflict` answer asks for.
      expect(browser.calls.length).toBeGreaterThan(polls)
      ;(shell.props().onCancelSave as () => void)()
      shell.render()
    } finally {
      browser.restore()
    }
  })
})

// ── the media query: the flag and the subscription ────────────────────────────

describe('the narrow-layout flag', () => {
  it('follows the query, subscribes to its change event and stops on unmount', () => {
    const list = mediaList(true)
    withMatchMedia(
      () => list,
      () => {
        function Probe(): unknown {
          return h('span', null, String(useNarrowSettings()))
        }
        const shell = mount(Probe, {})
        shell.render()
        expect(texts(rendered(shell.tree()))).toContain('true')
        expect(list.ask()).toEqual(['(max-width: 850px)'])

        // The subscription is the effect: the render itself only reads the flag.
        shell.flush()
        expect(list.listeners()).toHaveLength(1)

        // A resize is reported through the query's own event; the hook re-reads
        // the *same* list, which is how the browser reports the new width.
        list.set(false)
        shell.render()
        expect(texts(rendered(shell.tree()))).toContain('false')

        // Unmounting drops the listener: one left behind would call setState on
        // a component React has already let go.
        shell.cleanup()
        expect(list.listeners()).toHaveLength(0)
      },
    )
  })

  it('stays wide, and subscribes to nothing, without a matcher', () => {
    const globals = globalThis as Record<string, unknown>
    const before = globals.matchMedia
    try {
      delete globals.matchMedia
      function Probe(): unknown {
        return h('span', null, String(useNarrowSettings()))
      }
      const shell = mount(Probe, {})
      shell.render()

      expect(texts(shell.tree())).toContain('false')
      // The effect returns early: there is nothing to subscribe to.
      shell.flush()
      expect(texts(rendered(shell.tree()))).toContain('false')
    } finally {
      if (before === undefined) delete globals.matchMedia
      else globals.matchMedia = before
    }
  })

  it('resolves the layout from a matcher, and stays wide without one', () => {
    const asked: string[] = []
    const match = (query: string): MediaQueryLike => {
      asked.push(query)
      return { matches: true }
    }

    expect(narrowSettingsLayout(match)).toBe(true)
    expect(asked).toEqual(['(max-width: 850px)'])
    expect(narrowSettingsLayout(() => ({ matches: false }))).toBe(false)
    expect(narrowSettingsLayout(undefined)).toBe(false)
  })
})

describe('the browser’s own matcher', () => {
  it('is undefined without a matchMedia, and bound to the host with one', () => {
    const globals = globalThis as Record<string, unknown>
    const before = globals.matchMedia
    try {
      delete globals.matchMedia
      expect(browserMatchMedia()).toBeUndefined()

      const asked: string[] = []
      globals.matchMedia = (query: string) => {
        asked.push(query)
        return { matches: true }
      }
      const match = browserMatchMedia()
      expect(match?.('(max-width: 850px)').matches).toBe(true)
      expect(asked).toEqual(['(max-width: 850px)'])
    } finally {
      if (before === undefined) delete globals.matchMedia
      else globals.matchMedia = before
    }
  })

  it('survives a policy that makes reading the property itself throw', () => {
    const globals = globalThis as Record<string, unknown>
    const before = Object.getOwnPropertyDescriptor(globals, 'matchMedia')
    try {
      Object.defineProperty(globals, 'matchMedia', {
        configurable: true,
        get(): never {
          throw new Error('blocked by policy')
        },
      })
      expect(browserMatchMedia()).toBeUndefined()
    } finally {
      if (before === undefined) delete globals.matchMedia
      else Object.defineProperty(globals, 'matchMedia', before)
    }
  })
})

// ── the controls of the editor ────────────────────────────────────────────────

describe('the editor’s own fields report every keystroke', () => {
  it('reports a typed command, args, cwd and timeout', () => {
    const drafts: EntryDraft[] = []
    const tree = page(editorRow(), { onDraft: (next: EntryDraft) => drafts.push(next) })

    ;(labelled(tree, 'Command')?.props.onChange as (event: unknown) => void)(typed('node'))
    expect(drafts[0]?.command).toBe('node')
    // An emptied field clears the declaration rather than writing an empty one.
    ;(labelled(tree, 'CWD')?.props.onChange as (event: unknown) => void)(typed(''))
    expect(drafts[1]?.cwd).toBeUndefined()
    ;(labelled(tree, 'Args')?.props.onChange as (event: unknown) => void)(typed('a\nb'))
    expect(drafts[2]?.args).toEqual(['a', 'b'])
    ;(labelled(tree, 'Args')?.props.onChange as (event: unknown) => void)(typed(''))
    expect(drafts[3]?.args).toBeUndefined()
    ;(labelled(tree, 'Timeout')?.props.onChange as (event: unknown) => void)(typed('2500'))
    expect(drafts[4]?.connectTimeoutMs).toBe('2500')
  })

  it('adds, retypes and removes an env key', () => {
    const drafts: EntryDraft[] = []
    const tree = page(editorRow(), { onDraft: (next: EntryDraft) => drafts.push(next) })
    const add = button(tree, t('addKey'))
    const remove = button(tree, t('removeKey'))

    ;(add?.props.onClick as () => void)()
    // The appended key starts unnamed, and an unnamed key is never written.
    const added = drafts[0]?.env.at(-1)
    expect(added).toMatchObject({ key: '', added: true, text: '' })

    // A row the user added has its key in an input: typing one names the new
    // key, and that is the only control on an added row that is editable.
    const addedTree = page(editorRow(), {
      onDraft: (next: EntryDraft) => drafts.push(next),
      draft: { ...(draftOf(editorRow()) as EntryDraft), env: [added as never] },
    })
    ;(labelled(addedTree, t('keyField'))?.props.onChange as (event: unknown) => void)(typed('NEW_KEY'))
    expect(drafts.at(-1)?.env[0]).toMatchObject({ key: 'NEW_KEY', added: true })

    ;(remove?.props.onClick as () => void)()
    expect(drafts.at(-1)?.env.map((field) => field.key)).toEqual(['API_TOKEN', 'HOME_TOKEN'])

    const value = labelled(tree, 'API_TOKEN Value')
    ;(value?.props.onChange as (event: unknown) => void)(typed('rotated'))
    // A masked input becomes a replacement on the first keystroke, even empty.
    expect(drafts.at(-1)?.env[1]).toMatchObject({ text: 'rotated', replaced: true })
  })

  it('marks a masked input as replaced even when the user clears it', () => {
    const drafts: EntryDraft[] = []
    const tree = page(editorRow(), { onDraft: (next: EntryDraft) => drafts.push(next) })

    ;(labelled(tree, 'API_TOKEN Value')?.props.onChange as (event: unknown) => void)(typed(''))
    // The declared secret is replaced by an empty value on purpose: the host is
    // told to write nothing, not to keep what the form never saw.
    expect(drafts[0]?.env[1]).toMatchObject({ text: '', replaced: true, masked: true })
  })

  it('switches the transport, and only to one the host maps', () => {
    const drafts: EntryDraft[] = []
    const tree = page(editorRow(), { onDraft: (next: EntryDraft) => drafts.push(next) })
    const transport = labelled(tree, 'Transport')

    ;(transport?.props.onChange as (event: unknown) => void)(typed('streamable-http'))
    expect(drafts[0]?.transport).toBe('streamable-http')
    ;(transport?.props.onChange as (event: unknown) => void)(typed('nonsense'))
    expect(drafts[1]?.transport).toBe('stdio')
  })

  it('writes the enabled flag from the checkbox', () => {
    const drafts: EntryDraft[] = []
    const tree = page(editorRow(), { onDraft: (next: EntryDraft) => drafts.push(next) })
    const enabled = labelled(tree, 'Enabled')

    ;(enabled?.props.onChange as (event: unknown) => void)(checkbox(false))
    expect(drafts[0]?.enabled).toBe(false)
    // Ticking it back keeps the declaration the document already carried.
    ;(enabled?.props.onChange as (event: unknown) => void)(checkbox(true))
    expect(drafts[1]?.enabled).toBe(true)
  })

  it('reports a cleared `enabled` the document never declared', () => {
    const drafts: EntryDraft[] = []
    // A declaration that sets no `enabled` at all: the key is absent, not false.
    const { enabled: declared, ...withoutEnabled } = ENTRY
    void declared
    const row = editorRow({ entry: withoutEnabled })
    const tree = page(row, { onDraft: (next: EntryDraft) => drafts.push(next) })

    // The snapshot sets nothing, so ticking the box invents nothing either.
    ;(labelled(tree, 'Enabled')?.props.onChange as (event: unknown) => void)(checkbox(true))
    expect(drafts[0]?.enabled).toBeUndefined()
    expect(texts(tree).join(' | ')).toContain(t('absent'))
  })

  it('goes back to the overview from the editor’s own back button', () => {
    const opened: (string | undefined)[] = []
    const tree = page(editorRow(), {
      onSelectServer: (name: string | undefined) => opened.push(name),
    })
    const back = elements(tree).find(
      (element) => element.type === 'button' && texts(element).join('').startsWith('‹'),
    )

    // The back button is the editor's only exit that writes nothing.
    ;(back?.props.onClick as () => void)()
    expect(opened).toEqual([undefined])
  })

  it('reports consent from the confirmation’s own checkbox', () => {
    const consents: boolean[] = []
    const global = editorRow({ writeScope: 'global', source: '/home/dev/.dsh/mcp.json' })
    const tree = page(global, {
      confirming: true,
      onConsent: (next: boolean) => consents.push(next),
    })
    const box = labelled(tree, t('consentLabel'))

    ;(box?.props.onChange as (event: unknown) => void)(checkbox(true))
    expect(consents).toEqual([true])
  })

  it('offers the re-read action only for a conflict, and reports the click', () => {
    const reread: string[] = []
    const conflict = page(editorRow(), {
      saveState: { ok: false, code: 'conflict', message: 'the document changed' },
      onReRead: () => reread.push('re-read'),
    })
    const blocked = page(editorRow(), {
      saveState: { ok: false, code: 'blocked', message: 'not this tier' },
    })
    const reRead = button(conflict, t('reRead'))

    expect(reRead).toBeDefined()
    ;(reRead?.props.onClick as () => void)()
    expect(reread).toEqual(['re-read'])
    // Every other code names the failure without offering the action.
    expect(button(blocked, t('reRead'))).toBeUndefined()
    expect(texts(blocked).join(' | ')).toContain(t('saveErrorBlocked'))
  })
})

// ── the entry body a streamable-http draft writes ─────────────────────────────

describe('the editor of a streamable-http entry', () => {
  const HTTP: EntrySnapshot = {
    transport: 'streamable-http',
    url: 'https://example.invalid/mcp',
    headers: [
      { key: 'Authorization', masked: true },
      { key: 'X-Home', fromCredentials: true },
    ],
    connectTimeoutMs: 4000,
    extra: { note: 'kept' },
  }

  it('reports a typed url and a header list, in the transport the draft declares', () => {
    const drafts: EntryDraft[] = []
    const row = editorRow({ entry: HTTP })
    const tree = page(row, { onDraft: (next: EntryDraft) => drafts.push(next) })

    // The stdio fields belong to the other transport and are simply not here.
    expect(labelled(tree, 'Command')).toBeUndefined()
    ;(labelled(tree, 'URL')?.props.onChange as (event: unknown) => void)(typed('https://other.invalid'))
    expect(drafts[0]?.url).toBe('https://other.invalid')
    // An emptied url clears the declaration, exactly as an emptied command does.
    ;(labelled(tree, 'URL')?.props.onChange as (event: unknown) => void)(typed(''))
    expect(drafts[1]?.url).toBeUndefined()

    // The headers list is the same control the `env` list uses.
    ;(button(tree, t('addKey'))?.props.onClick as () => void)()
    expect(drafts[2]?.headers.at(-1)).toMatchObject({ key: '', added: true })
  })

  it('carries url, headers and the timeout, and drops the credential keys', () => {
    expect(entryBody(HTTP)).toEqual({
      transport: 'streamable-http',
      url: 'https://example.invalid/mcp',
      headers: [{ key: 'Authorization', masked: true }],
      connectTimeoutMs: 4000,
      note: 'kept',
    })
  })
})

// ── the switches and the retry the shell wires ────────────────────────────────

describe('the page’s own switches report the click', () => {
  it('reports the view and the project a user picked', () => {
    // Both controls are pure, but the callbacks they raise are the shell's own
    // `chooseView` / `chooseProject`; the shell is driven with them below too.
    const views: string[] = []
    const viewTree = ViewSwitch({ view: 'table', onChange: (next) => views.push(next), t })
    const files = elements(viewTree).find(
      (element) => element.type === 'button' && texts(element).join('') === t('viewFiles'),
    )
    ;(files?.props.onClick as () => void)()
    expect(views).toEqual(['files'])
    // The active view is the one the page is showing, and it is marked as such.
    const table = elements(viewTree).find(
      (element) => element.type === 'button' && texts(element).join('') === t('viewTable'),
    )
    expect(table?.props['aria-pressed']).toBe(true)

    const roots: string[] = []
    const picker = ProjectSelector({
      projects: [REPO, OTHER],
      selected: '/repo',
      onSelect: (root) => roots.push(root),
      t,
    })
    const select = elements(picker).find((element) => element.type === 'select')
    expect(select?.props.value).toBe('/repo')
    ;(select?.props.onChange as (event: unknown) => void)(typed('/other'))
    expect(roots).toEqual(['/other'])
    // A stale selection falls back to the first project rather than to nothing.
    const stale = ProjectSelector({
      projects: [REPO, OTHER],
      selected: '/gone',
      onSelect: () => undefined,
      t,
    })
    expect(elements(stale).find((element) => element.type === 'select')?.props.value).toBe('/repo')
  })

  it('retries every failed mount of the selected project', async () => {
    const browser = stubBrowser()
    try {
      const shell = mount(SettingsTab, { t } as SettingsTabProps)
      shell.render()
      shell.flush()
      await shell.settle()

      ;(shell.props().onRetry as () => void)()
      const retry = browser.calls.find((call) => call.url === `${ROUTE_PREFIX}/${ROUTE_ACTIONS.retry}`)
      expect(retry?.method).toBe('POST')
      // The host route is project-scoped; the answer is asked for whole, because
      // this page lists every project.
      expect(retry?.body).toEqual({ projectRoot: '/repo', full: true })
    } finally {
      browser.restore()
    }
  })

  it('marks a project while its mode write is in flight, then reports a refusal', async () => {
    const browser = stubBrowser()
    browser.policy = { body: { ok: false, error: { message: 'the host refused the mode' } } }
    try {
      const shell = mount(SettingsTab, { t } as SettingsTabProps)
      shell.render()
      shell.flush()
      await shell.settle()
      ;(shell.props().onPage as (page: string) => void)('tools')
      shell.render()

      ;(shell.props().onMode as (root: string, mode: ToolMode) => void)('/repo', 'disclosure')
      shell.render()
      // The switch is written through, not drafted: the write is in flight now.
      expect(shell.props().modePending).toEqual(new Set(['/repo']))

      await new Promise((resolve) => setTimeout(resolve, 5))
      shell.render()
      // The refusal is shown, and the project is no longer pending.
      expect(shell.props().modePending).toEqual(new Set())
      expect(shell.props().modeError).toBe('the host refused the mode')
    } finally {
      browser.restore()
    }
  })

  it('discards a draft without asking the host, and never leaves the editor', async () => {
    const browser = stubBrowser()
    try {
      const shell = mount(SettingsTab, { t } as SettingsTabProps)
      shell.render()
      shell.flush()
      await shell.settle();

      ;(shell.props().onSelectServer as (name: string) => void)('gateway')
      shell.render()
      const draft = shell.props().draft as EntryDraft
      expect(draft).toBeDefined()
      ;(shell.props().onDraft as (next: EntryDraft) => void)({ ...draft, command: 'node' })
      shell.render()
      expect(shell.props().draft).toMatchObject({ command: 'node' })

      // Discard is local: the snapshot's own entry comes back and nothing is posted.
      ;(shell.props().onDiscard as () => void)()
      shell.render()
      expect((shell.props().draft as EntryDraft).command).toBe('npx')
      expect(browser.calls.filter((call) => call.method === 'POST')).toEqual([])
    } finally {
      browser.restore()
    }
  })
})

// ── grouping: exactly one lower-priority document pins the loser ──────────────

describe('a merge warning with a single lower-priority document', () => {
  it('names the document the losing entry came from', () => {
    const project: ProjectSnapshot = {
      ...REPO,
      rows: [
        // One global document, then the winning project document: exactly one
        // lower-priority group is in the picture, so the loser can be pinned.
        // A second earlier document would leave `from` unknowable, which the
        // sibling spec already covers.
        { name: 'global-other', status: 'active', projectRoot: '/repo', source: '/home/dev/.dsh/mcp.json' },
        { name: 'tglider', status: 'active', projectRoot: '/repo', source: '/repo/.dsh/mcp.json' },
      ],
      issues: [
        {
          source: '/repo',
          server: 'tglider',
          level: 'warning',
          message:
            'serverName "tglider" was declared in more than one document; the highest-priority definition wins',
          code: 'parse.server.multiDocument',
          params: { name: 'tglider' },
        },
      ],
    }

    const groups = fileGroups(project)
    const winner = groups.find((group) => group.rows.some((row) => row.name === 'tglider'))

    expect(winner?.overrides).toEqual([{ name: 'tglider', from: '~/.dsh/mcp.json' }])
  })
})

/**
 * The JSON pane under the form: one entry, two editors.
 *
 * The pane is the only place where an edit is read as text and parsed back, so
 * this is where the two failure modes live: an edit that parses has to reach the
 * form above, and an edit that does not has to reach nothing at all — the draft
 * stays the last readable one and the write is blocked.
 */
describe('the JSON pane under the form', () => {
  it('edits the same entry as the form, and blocks the write when it does not parse', async () => {
    const browser = stubBrowser()
    try {
      const shell = mount(SettingsTab, { t } as SettingsTabProps)
      shell.render()
      shell.flush()
      await shell.settle()
      const props = shell.props()
      ;(props.onSelectServer as (name: string) => void)('gateway')
      shell.render()

      const pane = (): Element | undefined =>
        elements(rendered(shell.tree())).find((element) => element.type === 'textarea')
      const type = (text: string): void => {
        ;(pane()?.props.onChange as (event: { target: { value: string } }) => void)(typed(text))
      }

      expect(pane()?.props.value).toContain('"transport": "stdio"')
      // Every write control of the entry is marked, this one included.
      expect(pane()?.props['data-write']).toBe(true)

      // A readable edit becomes the draft the form renders.
      type(JSON.stringify({ transport: 'stdio', command: 'node' }, null, 2))
      shell.render()
      expect(labelled(rendered(shell.tree()), 'Command')?.props.value).toBe('node')

      // Text the pane cannot read leaves the draft alone and blocks the write.
      type('{ nope')
      shell.render()
      const tree = rendered(shell.tree())
      expect(labelled(tree, 'Command')?.props.value).toBe('node')
      expect(button(tree, t('save'))?.props.disabled).toBe(true)
      expect(button(tree, t('save'))?.props.title).toBe(t('saveJsonInvalid'))
      expect(texts(tree).join(' | ')).toContain(t('jsonInvalid', { reason: '' }).trim())
    } finally {
      browser.restore()
    }
  })
})
