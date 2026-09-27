/**
 * The hook-bearing half of `src/client/view.ts`, driven without a DOM.
 *
 * The hook surface — `useSnapshot`, `ProjectMcpPanel`, the Logs mode, the
 * side-card settings popup and the sessions disclosure — is where the panel
 * reads the host, holds its own state and answers clicks. A returned element
 * alone cannot show any of that: the effects are what subscribe to the status
 * channel, poll and page the log ring, and the state is what a click changes.
 *
 * There is no DOM environment in this tree (`jsdom` and `happy-dom` are absent,
 * and installing one is out of scope), so React's hook dispatcher is replaced by
 * {@link hooks}: a stand-in that renders the whole element tree — invoking the
 * pure components inside it the way React would — keeps the hooks of each
 * component instance in call order, runs the effects after each pass and repeats
 * the pass when an effect changed state. `createElement` stays React's own; only
 * `useState`, `useCallback` and `useEffect` are stood in for. The trees the
 * components produce are therefore the real ones — every assertion below reads a
 * value, a label, a request the panel sent, or the order of two of them, not a
 * line that merely executed.
 *
 * {@link fetchCalls}, {@link installStorage} and {@link FakeEventSource} are the
 * host, the browser's storage and the status channel, as the panel sees them.
 *
 * @module tests/view-dom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement as h } from 'react'
import type { ReactNode } from 'react'
import { ROUTE_ACTIONS, ROUTE_PREFIX, TAB_ID } from '../src/shared.ts'
import type {
  LogEvent,
  McpSnapshot,
  ProjectSnapshot,
  ServerRow,
  SessionSnapshot,
  SessionTools,
} from '../src/types.ts'
import {
  DEFAULT_LOG_LEVEL,
  DEFAULT_LOG_SCOPE,
  DEFAULT_REFRESH_MS,
  Disclosure,
  LOGS_CLEARED_KEY,
  LOG_LEVEL_KEY,
  LOG_SCOPE_KEY,
  REFRESH_KEY,
  LogsView,
  ProjectMcpPanel,
  ProjectMcpSettings,
  SessionList,
  ServersBlock,
  basename,
  fallbackTranslate,
  logLevelOf,
  logScopeOf,
  logsClearedAt,
  persistLogFilter,
  persistLogsClearedAt,
  pluginSettingsOf,
  refreshMsOf,
  sessionBreakdown,
  translateOf,
  useSnapshot,
} from '../src/client/view.ts'
import type { PanelStorage, Translate } from '../src/client/view.ts'

/* -------------------------------------------------------------------------- */
/* The React hook stand-in                                                     */
/* -------------------------------------------------------------------------- */

const hooks = vi.hoisted(() => {
  interface Slot {
    value: unknown
    deps: readonly unknown[] | undefined
    cleanup: (() => void) | undefined
    initialised: boolean
  }
  interface Pending {
    owner: string
    index: number
    run: () => unknown
    deps: readonly unknown[] | undefined
  }

  const owners = new Map<string, Slot[]>()
  let owner = ''
  let slots: Slot[] = []
  let cursor = 0
  let dirty = false
  let pending: Pending[] = []

  const sameDeps = (
    left: readonly unknown[] | undefined,
    right: readonly unknown[] | undefined,
  ): boolean =>
    left !== undefined &&
    right !== undefined &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]))

  const slotAt = (index: number): Slot => {
    const existing = slots[index]
    if (existing !== undefined) return existing
    const created: Slot = { value: undefined, deps: undefined, cleanup: undefined, initialised: false }
    slots[index] = created
    return created
  }

  /**
   * Enter one component instance. Hooks are keyed by the instance's own path in
   * the tree, which is where React keeps them too: a parent that re-renders does
   * not reset the state of the children it already mounted.
   */
  const enter = (id: string): void => {
    owner = id
    const existing = owners.get(id)
    if (existing === undefined) {
      slots = []
      owners.set(id, slots)
    } else {
      slots = existing
    }
    cursor = 0
  }

  function useState<S>(initial: S | (() => S)): [S, (next: S | ((previous: S) => S)) => void] {
    const slot = slotAt(cursor)
    cursor += 1
    if (!slot.initialised) {
      slot.value = typeof initial === 'function' ? (initial as () => S)() : initial
      slot.initialised = true
    }
    const set = (next: S | ((previous: S) => S)): void => {
      const value = typeof next === 'function' ? (next as (previous: S) => S)(slot.value as S) : next
      if (Object.is(value, slot.value)) return
      slot.value = value
      dirty = true
    }
    return [slot.value as S, set]
  }

  function useCallback<T>(callback: T, deps?: readonly unknown[]): T {
    const slot = slotAt(cursor)
    cursor += 1
    if (!slot.initialised || !sameDeps(slot.deps, deps)) {
      slot.value = callback
      slot.deps = deps
      slot.initialised = true
    }
    return slot.value as T
  }

  function useEffect(run: () => unknown, deps?: readonly unknown[]): void {
    const index = cursor
    cursor += 1
    // An effect whose dependencies did not change is not scheduled again, and
    // its cleanup is not run: that is what keeps the poll timer and the status
    // channel subscription alive across the renders a state change causes.
    if (sameDeps(slotAt(index).deps, deps)) return
    pending.push({ owner, index, run, deps })
  }

  /**
   * Render one element tree, invoking every function component it holds the way
   * React would: parent first, then the children it produced, each instance in
   * its own hook namespace. The result holds host elements only, which is what
   * lets the walkers in the checks read what a user would.
   */
  const resolve = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) return node.map((child, index) => resolve(child, `${path}.${index}`))
    if (node === null || typeof node !== 'object') return node
    const element = node as { type?: unknown; props?: Record<string, unknown> }
    if (typeof element.type === 'function') {
      enter(path)
      return resolve((element.type as (props: unknown) => unknown)(element.props), path)
    }
    const props = element.props ?? {}
    return { ...element, props: { ...props, children: resolve(props.children, path) } }
  }

  return {
    useState,
    useCallback,
    useEffect,
    /**
     * One commit: render the whole tree, then run the effects this pass
     * scheduled. A hook that changed state during the render or in an effect
     * repeats the pass, exactly as React re-renders — bounded, so a loop is a
     * failure and not a hang.
     */
    commit(render: () => unknown, root: string): unknown {
      for (let pass = 0; pass < 30; pass += 1) {
        dirty = false
        pending = []
        const top = `${root}/0`
        enter(top)
        const tree = resolve(render(), top)
        const scheduled = pending
        pending = []
        for (const effect of scheduled) {
          const slot = owners.get(effect.owner)?.[effect.index]
          if (slot === undefined) continue
          slot.cleanup?.()
          const cleanup = effect.run()
          slot.cleanup = typeof cleanup === 'function' ? (cleanup as () => void) : undefined
          slot.deps = effect.deps
        }
        if (!dirty) return tree
      }
      throw new Error('hook stand-in: the tree never settled')
    },
    /** Unmount one root: every cleanup it owns, children first. */
    unmount(root: string): void {
      const prefix = `${root}/`
      const ids = [...owners.keys()].filter((id) => id.startsWith(prefix))
      for (const id of ids.reverse()) {
        for (const slot of [...(owners.get(id) ?? [])].reverse()) slot.cleanup?.()
        owners.delete(id)
      }
    },
  }
})

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: hooks.useState,
    useCallback: hooks.useCallback,
    useEffect: hooks.useEffect,
  }
})

/* -------------------------------------------------------------------------- */
/* Element walkers (the same no-DOM vocabulary the sibling specs use)          */
/* -------------------------------------------------------------------------- */

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

/** The strings of a tree, joined for a `toContain` reading. */
function flat(node: unknown): string {
  return texts(node).join(' ')
}

/** The button whose label is exactly `label`, wherever it sits in the tree. */
function button(node: unknown, label: string): Element | undefined {
  return elements(node).find(
    (element) => element.type === 'button' && texts(element).join('') === label,
  )
}

/** Click one label: the panel's own handlers are the subject, not a DOM event. */
function click(node: unknown, label: string): void {
  const target = button(node, label)
  if (target === undefined) throw new Error(`no button labelled ${label}`)
  ;(target.props.onClick as () => void)()
}

/* -------------------------------------------------------------------------- */
/* The host, the browser's storage and the status channel                      */
/* -------------------------------------------------------------------------- */

interface Call {
  readonly url: string
  readonly init: RequestInit | undefined
}

/** Answer every `fetch` with one envelope, recording how it was called. */
function fetchCalls(reply: (url: string) => unknown): Call[] {
  const calls: Call[] = []
  const stub = (input: unknown, init?: RequestInit): Promise<unknown> => {
    const url = String(input)
    calls.push({ url, init })
    return Promise.resolve(reply(url)).then((payload) => ({
      status: 200,
      json: async () => payload,
    }))
  }
  Reflect.set(globalThis, 'fetch', stub)
  return calls
}

/** A host that answered with this value. */
function ok(value: unknown): { ok: true; value: unknown } {
  return { ok: true, value }
}

/** A host that refused, in its own words. */
function refuse(message: string): { ok: false; error: { message: string } } {
  return { ok: false, error: { message } }
}

/** Let every promise the panel is holding settle. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 12; tick += 1) await Promise.resolve()
}

/** An in-memory `localStorage`, so the persistence branches need no browser. */
function installStorage(
  initial: Record<string, string> = {},
): PanelStorage & { values: Record<string, string> } {
  const values: Record<string, string> = { ...initial }
  const storage = {
    values,
    getItem: (key: string): string | null => values[key] ?? null,
    setItem: (key: string, value: string): void => {
      values[key] = value
    },
  }
  Reflect.set(globalThis, 'localStorage', storage)
  return storage
}

/**
 * The status channel, as the browser would hand it to the panel: one listener
 * per event name, one frame at a time. The panel's own subscription is what the
 * checks below read.
 */
class FakeEventSource {
  static readonly opened: FakeEventSource[] = []
  readonly url: string
  closed = false
  private readonly listeners = new Map<string, ((event: { data?: unknown }) => void)[]>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.opened.push(this)
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  close(): void {
    this.closed = true
  }

  /** The event names the panel subscribed to, in subscription order. */
  subscribed(): string[] {
    return [...this.listeners.keys()]
  }

  /** One frame, exactly as the browser hands it over. */
  emit(type: string, frame?: unknown): void {
    this.emitRaw(type, frame === undefined ? undefined : JSON.stringify(frame))
  }

  /** One frame the panel cannot parse, byte for byte what the host sent. */
  emitRaw(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(data === undefined ? {} : { data })
    }
  }
}

const realFetch = globalThis.fetch
const mounted: { unmount(): void }[] = []

beforeEach(() => {
  FakeEventSource.opened.length = 0
})

afterEach(() => {
  for (const handle of mounted.splice(0)) handle.unmount()
  vi.useRealTimers()
  Reflect.set(globalThis, 'fetch', realFetch)
  Reflect.deleteProperty(globalThis, 'EventSource')
  Reflect.deleteProperty(globalThis, 'localStorage')
})

let rootSeq = 0

/**
 * Mount one component into the stand-in under its own root and keep it for the
 * automatic unmount that keeps a test's timers and subscriptions from leaking
 * into the next one.
 */
function mountComponent<P>(
  component: (props: P) => unknown,
  props: P,
): { readonly tree: unknown; rerender(next?: P): unknown; unmount(): void } {
  const root = `mount${(rootSeq += 1)}`
  let current = props
  let tree = hooks.commit(() => component(current), root)
  const handle = {
    get tree(): unknown {
      return tree
    },
    rerender(next?: P): unknown {
      if (next !== undefined) current = next
      tree = hooks.commit(() => component(current), root)
      return tree
    },
    unmount(): void {
      hooks.unmount(root)
    },
  }
  mounted.push(handle)
  return handle
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const t: Translate = translateOf()

function row(
  name: string,
  status: ServerRow['status'],
  extra: Partial<ServerRow> = {},
): ServerRow {
  return { name, status, projectRoot: '/repo', ...extra }
}

/**
 * The multi-line diagnostic the host publishes for a stalled mount: the same
 * text the errors disclosure reads out and the server row keeps as its tooltip.
 */
function detailOf(name: string): string {
  return [
    `${name}: no tool appeared in 60.2s`,
    'endpoint: stdio docker',
    'declared in: /repo/.dsh/mcp.json',
  ].join('\n')
}

function session(
  id: string,
  rows: ServerRow[],
  extras: { tools?: SessionTools; logCount?: number } = {},
): SessionSnapshot {
  return {
    id,
    rows,
    issues: [],
    ...(extras.tools === undefined ? {} : { tools: extras.tools }),
    ...(extras.logCount === undefined ? {} : { logCount: extras.logCount }),
  }
}

function snapshotOf(...projects: ProjectSnapshot[]): McpSnapshot {
  return { ready: true, projects, watchedFiles: [] }
}

function project(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  const mine = session('session-aaaa1111', [row('alpha', 'active')])
  return {
    projectRoot: '/repo',
    sessionIds: [mine.id],
    rows: mine.rows,
    issues: [],
    sessions: [mine],
    ...overrides,
  }
}

function event(overrides: Partial<LogEvent> = {}): LogEvent {
  return {
    at: 2_000,
    level: 'info',
    projectRoot: '/repo',
    sessionId: 'session-aaaa1111',
    message: 'mounting /repo',
    ...overrides,
  }
}

/** One session's offer, one name pinned by hand. */
const TOOLS: SessionTools = {
  sessionId: 'session-aaaa1111',
  baseline: ['mcp__tglider__workspace'],
  activated: [],
  context: [],
  deferred: [],
  mounted: 1,
  surfaceChars: 40,
  budgetChars: 400,
  deferring: false,
}

const PINNED = { mode: 'disclosure', pins: ['mcp__tglider__workspace'] } as const

/** The picture the panel tests read: one project, one failing row, some events. */
function panelSnapshot(): McpSnapshot {
  const mine = session(
    'session-aaaa1111',
    [
      row('alpha', 'active'),
      row('gateway', 'error', { transport: 'stdio', detail: detailOf('gateway') }),
    ],
    { tools: TOOLS, logCount: 3 },
  )
  return snapshotOf(
    project({
      rows: mine.rows,
      sessions: [mine],
      policy: { ...PINNED },
      logs: [event({ at: 3_000, level: 'up', server: 'tglider', message: 'tglider is up in 812ms' })],
      logCount: 40,
    }),
  )
}

/* -------------------------------------------------------------------------- */
/* useSnapshot                                                                 */
/* -------------------------------------------------------------------------- */

interface ProbeProps {
  visible: boolean
  refreshMs: number
  path?: string
}

const probe: { state?: ReturnType<typeof useSnapshot> } = {}

/** Renders what `useSnapshot` holds, so every assertion reads the hook's state. */
function SnapshotProbe(props: ProbeProps): ReactNode {
  const state = useSnapshot(props.visible, props.refreshMs, props.path)
  probe.state = state
  const picture = state.snapshot === undefined ? 'no picture' : `${state.snapshot.projects.length} project(s)`
  return h('span', null, `${picture} · ${state.error ?? 'no error'} · ${state.busy ? 'busy' : 'quiet'}`)
}

function mountProbe(props: Partial<ProbeProps> = {}): ReturnType<typeof mountComponent<ProbeProps>> {
  return mountComponent(SnapshotProbe, { visible: true, refreshMs: 5_000, ...props })
}

describe('useSnapshot', () => {
  it('reads the snapshot route on mount and starts with no picture', async () => {
    const calls = fetchCalls(() => ok(snapshotOf(project())))
    const view = mountProbe()

    expect(texts(view.tree).join('')).toBe('no picture · no error · quiet')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${ROUTE_PREFIX}/${ROUTE_ACTIONS.snapshot}`)
    // A read: the action decides the method, and a read has no init at all.
    expect(calls[0]?.init).toEqual({})

    await settle()
    expect(texts(view.rerender()).join('')).toBe('1 project(s) · no error · quiet')
  })

  it('reads a route of its own when a surface asks for another one', async () => {
    const calls = fetchCalls(() => ok({ events: [], total: 0, more: false }))
    mountProbe({ path: ROUTE_ACTIONS.logs })

    expect(calls[0]?.url).toBe(`${ROUTE_PREFIX}/${ROUTE_ACTIONS.logs}`)
  })

  it('keeps the last picture when a poll fails, and names the host’s reason', async () => {
    const answers = [ok(snapshotOf(project())), refuse('the host said no')]
    const calls = fetchCalls(() => answers.shift() ?? refuse('no answer left'))
    vi.useFakeTimers()
    const view = mountProbe({ refreshMs: 1_000 })

    await settle()
    expect(texts(view.rerender()).join('')).toBe('1 project(s) · no error · quiet')

    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    expect(calls).toHaveLength(2)
    expect(texts(view.rerender()).join('')).toBe('1 project(s) · the host said no · quiet')
  })

  it('reports a thrown non-Error as its own text, and a body without a value as a refusal', async () => {
    Reflect.set(globalThis, 'fetch', () => Promise.reject('offline'))
    const view = mountProbe()
    await settle()

    expect(texts(view.rerender()).join('')).toBe('no picture · offline · quiet')

    fetchCalls(() => ({ ok: true }))
    const second = mountProbe()
    await settle()

    // `ok: true` with no `value` is a failure the panel cannot read.
    expect(texts(second.rerender()).join('')).toBe('no picture · request failed (200) · quiet')
  })

  it('polls no faster than one second, and only while it is visible', async () => {
    const calls = fetchCalls(() => ok(snapshotOf(project())))
    vi.useFakeTimers()
    const hidden = mountProbe({ visible: false, refreshMs: 50 })

    expect(calls).toHaveLength(0)
    const view = hidden.rerender({ visible: true, refreshMs: 50 })
    expect(calls).toHaveLength(1)
    expect(texts(view).join('')).toBe('no picture · no error · quiet')

    // 50ms is below the floor: the second read comes at 1000ms, not at 50.
    await vi.advanceTimersByTimeAsync(999)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(calls).toHaveLength(2)

    // Going hidden again stops the timer: the cleanup is what suspends it.
    hidden.rerender({ visible: false, refreshMs: 50 })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(calls).toHaveLength(2)
  })

  it('subscribes to the status channel and applies a whole pushed picture', async () => {
    const calls = fetchCalls(() => ok(snapshotOf()))
    Reflect.set(globalThis, 'EventSource', FakeEventSource)
    const view = mountProbe()

    const source = FakeEventSource.opened[0]
    expect(source?.url).toBe(`${ROUTE_PREFIX}/${ROUTE_ACTIONS.events}`)
    expect(source?.subscribed()).toEqual(['hello', 'change', 'open', 'error'])

    await settle()
    expect(texts(view.rerender()).join('')).toBe('0 project(s) · no error · quiet')

    source?.emit('hello', { revision: 0, snapshot: snapshotOf(project()) })
    expect(texts(view.rerender()).join('')).toBe('1 project(s) · no error · quiet')

    // Every frame carries the whole picture, so a later one replaces it outright.
    source?.emit('change', { revision: 1, snapshot: snapshotOf() })
    expect(texts(view.rerender()).join('')).toBe('0 project(s) · no error · quiet')
    expect(calls).toHaveLength(1)
  })

  it('stops polling while the channel is open and resumes when it drops', async () => {
    const calls = fetchCalls(() => ok(snapshotOf(project())))
    Reflect.set(globalThis, 'EventSource', FakeEventSource)
    vi.useFakeTimers()
    const view = mountProbe({ refreshMs: 1_000 })

    await settle()
    const source = FakeEventSource.opened[0]
    source?.emit('open')
    view.rerender()

    await vi.advanceTimersByTimeAsync(4_000)
    expect(calls).toHaveLength(1)

    source?.emit('error')
    view.rerender()
    // A dropped channel starts polling again at once, then on the interval.
    await settle()
    expect(calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    expect(calls).toHaveLength(3)
  })

  it('ignores a frame it cannot read and closes the channel on unmount', async () => {
    fetchCalls(() => ok(snapshotOf(project())))
    Reflect.set(globalThis, 'EventSource', FakeEventSource)
    const view = mountProbe()

    await settle()
    view.rerender()
    const source = FakeEventSource.opened[0]
    source?.emitRaw('change', 'not json at all')

    // An unreadable frame is one poll away; the connection and the picture stay.
    expect(texts(view.rerender()).join('')).toBe('1 project(s) · no error · quiet')

    view.unmount()
    expect(source?.closed).toBe(true)
  })

  it('runs an action as a POST, shows it in flight, and reports a refusal', async () => {
    const answers = [ok(snapshotOf()), ok(snapshotOf(project())), refuse('the pin was refused')]
    const calls = fetchCalls(() => answers.shift() ?? refuse('no answer left'))
    const view = mountProbe()
    await settle()
    view.rerender()

    const action = probe.state?.run(ROUTE_ACTIONS.sync, { projectRoot: '/repo' })
    // In flight: `busy` is what the toolbar disables its buttons with.
    expect(texts(view.rerender()).join('')).toBe('0 project(s) · no error · busy')
    await action
    expect(texts(view.rerender()).join('')).toBe('1 project(s) · no error · quiet')
    expect(calls[1]?.url).toBe(`${ROUTE_PREFIX}/${ROUTE_ACTIONS.sync}`)
    expect(calls[1]?.init).toEqual({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectRoot: '/repo' }),
    })

    await probe.state?.run(ROUTE_ACTIONS.pin, { projectRoot: '/repo' })
    expect(texts(view.rerender()).join('')).toBe('1 project(s) · the pin was refused · quiet')
  })

  it('sends one request per body on a batch, and nothing at all for an empty one', async () => {
    const calls = fetchCalls(() => ok(snapshotOf(project())))
    const view = mountProbe()
    await settle()
    view.rerender()

    // The empty batch is the one a surface reaches when the set it speaks for is
    // empty: no request, no busy frame, and the picture it already had.
    await probe.state?.runAll(ROUTE_ACTIONS.pin, [])
    expect(calls).toHaveLength(1)
    expect(texts(view.rerender()).join('')).toBe('1 project(s) · no error · quiet')

    await probe.state?.runAll(ROUTE_ACTIONS.pin, [
      { projectRoot: '/repo', tool: 'mcp__tglider__symbol', pinned: true },
      { projectRoot: '/repo', tool: 'mcp__tglider__graph', pinned: true },
    ])
    view.rerender()

    expect(calls).toHaveLength(3)
    expect(calls.slice(1).map((call) => call.url)).toEqual([
      `${ROUTE_PREFIX}/${ROUTE_ACTIONS.pin}`,
      `${ROUTE_PREFIX}/${ROUTE_ACTIONS.pin}`,
    ])
    expect(calls[1]?.init).toEqual({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectRoot: '/repo', tool: 'mcp__tglider__symbol', pinned: true }),
    })
    // One batch, one picture: the state carries the last answer and no error.
    expect(texts(view.rerender()).join('')).toBe('1 project(s) · no error · quiet')
  })

  it('re-reads the same route on reload', async () => {
    const calls = fetchCalls(() => ok(snapshotOf(project())))
    const view = mountProbe()
    await settle()
    view.rerender()

    await probe.state?.reload()

    expect(calls).toHaveLength(2)
    expect(calls[1]?.url).toBe(calls[0]?.url)
    expect(probe.state?.run).toBeTypeOf('function')
  })
})

/* -------------------------------------------------------------------------- */
/* The sidebar panel                                                           */
/* -------------------------------------------------------------------------- */

function mountPanel(
  props: Partial<{
    visible: boolean
    sessionId: string | undefined
    refreshMs: number
    hostT: Translate
  }> = {},
): ReturnType<typeof mountComponent<Parameters<typeof ProjectMcpPanel>[0]>> {
  return mountComponent(ProjectMcpPanel, {
    visible: true,
    sessionId: 'session-aaaa1111',
    refreshMs: 5_000,
    t,
    ...props,
  })
}

/**
 * The disclosure head whose text names `label`, wherever it sits.
 *
 * The head is the one control the label-addressed {@link button} walker cannot
 * find: the count badge is a chip of its own, so the head's text is the label
 * and the number, not the label alone.
 */
function head(node: unknown, label: string): Element | undefined {
  return elements(node).find(
    (element) =>
      element.type === 'button' &&
      element.props['aria-expanded'] !== undefined &&
      texts(element).join(' ').includes(label),
  )
}

/** Open or close one disclosure of the one surface. */
function toggle(node: unknown, label: string): void {
  const control = head(node, label)
  if (control === undefined) throw new Error(`no disclosure labelled ${label}`)
  ;(control.props.onClick as () => void)()
}

/**
 * Every control the panel carries the `aria-pressed` attribute on.
 *
 * Two places may have one since F-43: the logs body's own filter chips (F-10)
 * and the tools block's counter chips, which are the filter's tier half. The
 * mode switch F-26 removed would be a third, and {@link applied} is what reads
 * whether any of them is actually on.
 */
function pressed(node: unknown): Element[] {
  return elements(node).filter((element) => element.props['aria-pressed'] !== undefined)
}

/**
 * The controls the panel has actually applied — `aria-pressed="true"`.
 *
 * A chip answers `false` until the user presses it, so "is anything switched on"
 * is read off the value, not off the attribute's presence; a mode segment that
 * came back would be on for the segment in force and this is where it would show.
 */
function applied(node: unknown): Element[] {
  return pressed(node).filter((element) => element.props['aria-pressed'] === true)
}

/**
 * The open tool row's own detail block, read where it is drawn.
 *
 * Found structurally — the row wrapper's child that is neither the row's own
 * `button[aria-expanded]` head nor its action button — never by searching the
 * tree for a name. The row's header prints the same full name, so a whole-tree
 * reading would pass even for a body that printed a short one; this returns ''
 * while the row is folded.
 */
function toolDetail(node: unknown, name: string): string {
  const head = button(node, name)
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

describe('the sidebar panel', () => {
  it('shows the tab session’s own project and counts it on one toolbar row', async () => {
    const calls = fetchCalls(() => ok(panelSnapshot()))
    const view = mountPanel()
    await settle()
    const rendered = texts(view.rerender())

    expect(rendered).toContain('repo')
    expect(rendered).toContain('this session')
    expect(rendered).toContain('Sync')
    // The one summary reading the toolbar's right edge keeps (F-26).
    expect(rendered).toContain('1 session')
    // The session's own declared rows, with the failing one's own detail.
    expect(rendered).toContain('alpha')
    expect(rendered).toContain('gateway')
    // The declared-server rows carry the status, not the diagnostic (F-26): the
    // host's text lives in the errors disclosure, which is closed.
    expect(flat(view.tree)).not.toContain(detailOf('gateway'))
    expect(button(view.tree, t('retryFailed'))).toBeUndefined()
    // The one surface's blocks: what the model sees, then the two disclosures.
    expect(flat(view.tree)).toContain(t('toolsSeeModel'))
    expect(flat(view.tree)).toContain(`▸ ${t('errorsSection')}`)
    expect(flat(view.tree)).toContain(`▸ ${t('logsSection')}`)
    // The segment bar is gone: no Tools badge, nothing switched on. The counter
    // chips of the tools block carry the attribute as the filter's tier half
    // (F-43), and not one of them is applied until the user presses it.
    expect(rendered).not.toContain('Tools 1')
    expect(applied(view.tree)).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('reads no host route at all while the tab is hidden', async () => {
    const calls = fetchCalls(() => ok(panelSnapshot()))
    const view = mountPanel({ visible: false })

    expect(calls).toHaveLength(0)

    view.rerender({ visible: true, sessionId: 'session-aaaa1111', refreshMs: 5_000, t })
    await settle()
    expect(texts(view.rerender())).toContain('repo')
    expect(calls).toHaveLength(1)
  })

  it('names the missing session and the project its session is not in', async () => {
    fetchCalls(() => ok(snapshotOf(project())))
    const withoutSession = mountPanel({ sessionId: undefined })
    const elsewhere = mountPanel({ sessionId: 'session-zzz' })
    await settle()

    expect(flat(withoutSession.rerender())).toContain('No session is attached to this tab.')
    expect(flat(elsewhere.rerender())).toContain('not inside a project yet')
  })

  it('expands a tool row into its name, keeps the pin working, and closes it again', async () => {
    const calls = fetchCalls(() => ok(panelSnapshot()))
    const view = mountPanel()
    await settle()
    const collapsed = view.rerender()

    // The header names the tool, and the body is not drawn at all: the row's
    // wrapper holds nothing to read while it is folded.
    expect(flat(collapsed)).toContain('mcp__tglider__workspace')
    expect(toolDetail(collapsed, 'mcp__tglider__workspace')).toBe('')
    const line = button(collapsed, 'mcp__tglider__workspace')
    expect(line?.props['aria-expanded']).toBe(false)
    ;(line?.props.onClick as () => void)()

    const open = view.rerender()
    const body = toolDetail(open, 'mcp__tglider__workspace')

    expect(button(open, 'mcp__tglider__workspace')?.props['aria-expanded']).toBe(true)
    // The body itself prints the full public name, the server it was registered
    // under and the tier that offered it. The header prints that same name, so
    // reading the whole tree would not show the body carries it.
    expect(body).toContain('mcp__tglider__workspace')
    expect(body).toContain(t('toolServer', { server: 'tglider' }))
    expect(body).toContain(t('toolTierPinned'))
    // A short display name in the body is not the registry name.
    expect(body).not.toContain('tglider/workspace')
    // Still no mode switch anywhere, with a row open: the pressed controls the
    // block does hold are the tier chips of its filter, none of them applied.
    expect(applied(open)).toEqual([])

    // The row's own action stays beside the line and still writes the pin.
    click(open, t('toolsUnpin'))
    expect(button(view.rerender(), t('toolsUnpin'))?.props.disabled).toBe(true)
    await settle()
    expect(button(view.rerender(), t('toolsUnpin'))?.props.disabled).toBe(false)

    expect(calls[1]?.url).toBe(`${ROUTE_PREFIX}/${ROUTE_ACTIONS.pin}`)
    expect(calls[1]?.init).toEqual({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectRoot: '/repo',
        tool: 'mcp__tglider__workspace',
        pinned: false,
      }),
    })

    // A second press folds the row back up, and the body goes with it.
    ;(button(view.rerender(), 'mcp__tglider__workspace')?.props.onClick as () => void)()
    expect(button(view.rerender(), 'mcp__tglider__workspace')?.props['aria-expanded']).toBe(false)
    expect(toolDetail(view.rerender(), 'mcp__tglider__workspace')).toBe('')
  })

  it('draws no step on a tool row the host published no step for', async () => {
    fetchCalls(() =>
      ok(
        snapshotOf(
          project({
            sessions: [
              session('session-aaaa1111', [row('alpha', 'active')], {
                tools: {
                  ...TOOLS,
                  baseline: [],
                  activated: [{ name: 'mcp__tglider__find_references', via: 'session' }],
                },
                logCount: 0,
              }),
            ],
            policy: { ...PINNED, pins: ['mcp__tglider__find_references'] },
          }),
        ),
      ),
    )
    const view = mountPanel()
    await settle()
    const line = button(view.rerender(), 'mcp__tglider__find_references')
    ;(line?.props.onClick as () => void)()
    const open = view.rerender()
    const body = toolDetail(open, 'mcp__tglider__find_references')

    // The body prints the host's own facts, and neither a step nor a clock the
    // host never published — an invented `step 4` would be exactly this failure.
    expect(body).toContain(t('toolServer', { server: 'tglider' }))
    expect(body).toContain(t('toolTierPinned'))
    expect(body).not.toContain('step ')
    expect(body.split(' · ').some((part) => /^\d{2}:\d{2}$/.test(part))).toBe(false)
  })

  it('posts Sync, and Retry failed from inside the errors block', async () => {
    const calls = fetchCalls(() => ok(panelSnapshot()))
    const view = mountPanel()
    await settle()
    click(view.rerender(), t('sync'))

    expect(button(view.rerender(), t('sync'))?.props.disabled).toBe(true)
    await settle()
    expect(button(view.rerender(), t('sync'))?.props.disabled).toBe(false)
    expect(calls[1]?.init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ projectRoot: '/repo' }),
    })

    // The block is closed by default, and its action lives inside it (F-26):
    // the toolbar no longer carries `Retry failed`.
    expect(flat(view.rerender())).not.toContain(t('retryFailed'))
    expect(flat(view.rerender())).not.toContain(detailOf('gateway'))
    toggle(view.rerender(), t('errorsSection'))
    const errors = view.rerender()
    expect(texts(errors)).toContain(t('retryFailed'))
    expect(texts(errors)).toContain('error · 1')
    // `IssueView`'s rows are where the host's diagnostic is read out in full.
    expect(flat(errors)).toContain(detailOf('gateway'))
    expect(applied(errors)).toEqual([])
    click(errors, t('retryFailed'))
    await settle()

    expect(calls[2]?.url).toBe(`${ROUTE_PREFIX}/${ROUTE_ACTIONS.retry}`)
    expect(calls[2]?.init).toMatchObject({ body: JSON.stringify({ projectRoot: '/repo' }) })
  })

  it('retries a failed server from its own row, without opening the errors block', async () => {
    const calls = fetchCalls(() => ok(panelSnapshot()))
    const view = mountPanel()
    await settle()
    const closed = view.rerender()

    // The block is shut, so the button on the row is the servers block's own and
    // not the disclosure's: the failure can be pressed where the eye already is,
    // instead of behind a disclosure the reader has to open first.
    expect(flat(closed)).not.toContain(t('retryFailed'))
    expect(texts(closed)).toContain('gateway')
    click(closed, t('retry'))
    await settle()

    expect(calls[1]?.url).toBe(`${ROUTE_PREFIX}/${ROUTE_ACTIONS.retry}`)
    expect(calls[1]?.init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ projectRoot: '/repo' }),
    })
  })

  it('reads out every triaged status inside the errors block, and none before it', async () => {
    const rows = [
      row('alpha', 'active'),
      row('gateway', 'error', { detail: detailOf('gateway') }),
      row('locked', 'conflict', { detail: detailOf('locked') }),
      row('slow', 'connecting', { detail: detailOf('slow') }),
    ]
    const mine = session('session-aaaa1111', rows, { tools: TOOLS, logCount: 0 })
    fetchCalls(() =>
      ok(snapshotOf(project({ rows, sessions: [mine], policy: { ...PINNED } }))),
    )
    const view = mountPanel()
    await settle()
    const closed = view.rerender()

    // The block lists the rows; their diagnostics wait behind the disclosure.
    for (const name of ['gateway', 'locked', 'slow']) {
      expect(texts(closed)).toContain(name)
      expect(flat(closed)).not.toContain(detailOf(name))
    }

    toggle(view.rerender(), t('errorsSection'))
    const open = view.rerender()

    for (const name of ['gateway', 'locked', 'slow']) {
      expect(flat(open)).toContain(detailOf(name))
    }
    // One group per triage rung, each with the row's own in-place Retry.
    expect(texts(open)).toContain('error · 1')
    expect(texts(open)).toContain('conflict · 1')
    expect(texts(open)).toContain('connecting · 1')
    expect(texts(open)).toContain(t('retryFailed'))
  })

  it('keeps the errors block out of the panel while nothing needs a look', async () => {
    fetchCalls(() => ok(snapshotOf(project())))
    const view = mountPanel()
    await settle()
    const rendered = view.rerender()

    // The disclosure is not drawn at all: an absent block is the quiet answer,
    // and with no failing row there is no diagnostic to hide either.
    expect(flat(rendered)).not.toContain(t('errorsSection'))
    expect(flat(rendered)).not.toContain(t('nothingNeedsAttention'))
    expect(flat(rendered)).not.toContain(t('retryFailed'))
    expect(
      elements(rendered).filter((element) => element.props['aria-expanded'] !== undefined),
    ).toHaveLength(1)
  })

  it('releases one session of the project from the disclosure', async () => {
    // The section exists only while a session disagrees with the merged rows:
    // here the project merged a beta the session never mounted.
    const calls = fetchCalls(() =>
      ok(snapshotOf(project({ rows: [row('alpha', 'active'), row('beta', 'idle')] }))),
    )
    const view = mountPanel()
    await settle()
    // The one session is out of step, but the project's rows are merged across
    // no other session, so the note stays off.
    expect(flat(view.rerender())).not.toContain(t('mergedAcrossSessions'))
    click(view.rerender(), `▸ ${t('sessionsSection')}`)
    const open = view.rerender()
    expect(button(open, '▸ aaaa1111')).toBeDefined()

    click(open, t('release'))
    await settle()

    expect(calls[1]?.url).toBe(`${ROUTE_PREFIX}/${ROUTE_ACTIONS.release}`)
    expect(calls[1]?.init).toMatchObject({ body: JSON.stringify({ sessionId: 'session-aaaa1111' }) })
  })

  it('hides the sessions section entirely while the tab’s session reads like the project', async () => {
    const calls = fetchCalls(() => ok(panelSnapshot()))
    const view = mountPanel()
    await settle()
    const rendered = flat(view.rerender())

    // One session, reading exactly like the merged rows: no header, no rows.
    expect(rendered).not.toContain(t('sessionsSection'))
    expect(rendered).not.toContain(t('differsOne'))
    // The session's own declared rows are what is left.
    expect(rendered).toContain('alpha')
    expect(rendered).toContain('gateway')
    expect(calls).toHaveLength(1)
  })

  it('lists only the session that disagrees, and says how many do', async () => {
    const merged = project({
      rows: [row('alpha', 'active'), row('beta', 'idle')],
      sessionIds: ['session-aaaa1111', 'session-bbb22222'],
      sessions: [
        session('session-aaaa1111', [row('alpha', 'active'), row('beta', 'idle')]),
        session('session-bbb22222', [row('alpha', 'active')]),
      ],
    })
    fetchCalls(() => ok(snapshotOf(merged)))
    const view = mountPanel()
    await settle()
    const rendered = texts(view.rerender())

    expect(rendered).toContain(`▸ ${t('sessionsSection')}`)
    expect(rendered).toContain(t('differsOne'))
    // Two sessions feed the project, so the note is drawn even though only one of
    // them is the section's subject.
    expect(rendered).toContain(t('mergedAcrossSessions'))
    click(view.rerender(), `▸ ${t('sessionsSection')}`)
    const open = view.rerender()

    expect(button(open, `▾ ${t('sessionsSection')}`)).toBeDefined()
    expect(button(open, '▸ bbb22222')).toBeDefined()
    expect(button(open, '▸ aaaa1111')).toBeUndefined()
  })

  it('syncs globally when the tab’s session has no project to scope it to', async () => {
    const calls = fetchCalls(() =>
      ok(
        snapshotOf(
          project({
            projectRoot: '/other',
            sessionIds: ['session-zzz'],
            sessions: [session('session-zzz', [])],
          }),
        ),
      ),
    )
    const view = mountPanel()
    await settle()
    expect(texts(view.rerender())).toContain('no project')

    click(view.tree, t('sync'))
    await settle()

    expect(calls[1]?.url).toBe(`${ROUTE_PREFIX}/${ROUTE_ACTIONS.sync}`)
    // Nothing to scope: an empty operator body, never another project's root.
    expect(calls[1]?.init).toEqual({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
  })

  it('keeps the logs block closed, with this session’s own count on its head', async () => {
    // The level filter opens on `errors` (the owner's call); this check is about
    // the block drawing its rows at all, so it asks for every level.
    installStorage({ [LOG_LEVEL_KEY]: 'all' })
    fetchCalls(() => ok(panelSnapshot()))
    const view = mountPanel()
    await settle()
    const closed = view.rerender()

    // The project's ring holds 40; this session's own count is 3 (contract C1).
    expect(flat(closed)).toContain(`▸ ${t('logsSection')} 3`)
    expect(flat(closed)).not.toContain('tglider is up in 812ms')

    toggle(closed, t('logsSection'))
    const open = view.rerender()

    expect(texts(open)).toContain('tglider is up in 812ms')
    expect(texts(open)).toContain(t('logsClear'))
    expect(texts(open)).toContain('40 in this project')
    // The ring's own two filter pairs are the only applied controls in the
    // panel, and they are inside the logs body: the tier chips of the tools
    // block carry the attribute (F-43) but answer `false` until they are
    // pressed, and the mode switch F-26 removed had an applied segment of its
    // own — this is the row that would catch it coming back.
    expect(applied(open).map((element) => texts(element).join(''))).toEqual([
      t('logsThisSession'),
      t('logsAllLevels'),
    ])
  })

  it('shows the host’s refusal above the body instead of an empty body', async () => {
    fetchCalls(() => refuse('the snapshot could not be read'))
    const view = mountPanel()
    await settle()

    const rendered = texts(view.rerender())
    expect(rendered).toContain('the snapshot could not be read')
    // The body is still drawn under it, so the tab is usable while it retries.
    expect(flat(view.tree)).toContain('not inside a project yet')
  })
})

/* -------------------------------------------------------------------------- */
/* The disclosures                                                             */
/* -------------------------------------------------------------------------- */

describe('Disclosure', () => {
  it('draws its head closed, and its body only while it is open', () => {
    const view = mountComponent(Disclosure, { label: 'ring', count: 0, body: 'the events', t })

    expect(head(view.tree, 'ring')?.props['aria-expanded']).toBe(false)
    expect(texts(view.tree)).not.toContain('the events')
    // The count badge is the head's own; zero is a reading, not an absence.
    expect(flat(view.tree)).toContain('▸ ring 0')

    toggle(view.tree, 'ring')
    const open = view.rerender()
    expect(head(open, 'ring')?.props['aria-expanded']).toBe(true)
    expect(texts(open)).toContain('the events')

    toggle(open, 'ring')
    expect(texts(view.rerender())).not.toContain('the events')
  })

  it('draws no badge at all for a disclosure the host gave no count', () => {
    const view = mountComponent(Disclosure, { label: 'ring', body: 'the events', t })

    expect(flat(view.tree)).toBe('▸ ring')
  })
})

/* -------------------------------------------------------------------------- */
/* The Logs mode                                                               */
/* -------------------------------------------------------------------------- */

function mountLogs(
  snapshot: ProjectSnapshot,
  storage: PanelStorage | undefined = undefined,
): ReturnType<typeof mountComponent<Parameters<typeof LogsView>[0]>> {
  return mountComponent(LogsView, {
    project: snapshot,
    sessionId: 'session-aaaa1111',
    storage,
    t,
  })
}

/** Two newest events on screen, 60 in the ring. */
function logsProject(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return project({
    logs: [
      event({ at: 3_000, message: 'older one' }),
      event({ at: 2_000, message: 'newest one' }),
    ],
    logCount: 60,
    ...overrides,
  })
}

describe('the Logs mode', () => {
  it('seeds the filters from the tab’s storage and draws that slice', () => {
    const storage = installStorage({
      [LOG_SCOPE_KEY]: 'all',
      [LOG_LEVEL_KEY]: 'error',
      [LOGS_CLEARED_KEY]: '2500',
    })
    const view = mountLogs(
      logsProject({
        logs: [
          event({ at: 2_000, level: 'error', message: 'cleared away' }),
          event({ at: 3_000, level: 'error', message: 'still here' }),
          event({ at: 4_000, level: 'info', message: 'not an error' }),
        ],
      }),
      storage,
    )
    const rendered = texts(view.tree)

    expect(rendered).toContain('still here')
    expect(rendered).not.toContain('cleared away')
    expect(rendered).not.toContain('not an error')
    // The pressed chip of each pair is the one the storage held.
    const applied = elements(view.tree).filter((element) => element.props['aria-pressed'] === true)
    expect(applied.map((element) => texts(element).join(''))).toEqual([
      t('logsAllSessions'),
      t('logsErrorsOnly'),
    ])
  })

  it('remembers the scope and the level it switched to', () => {
    const storage = installStorage()
    const view = mountLogs(
      logsProject({
        logs: [
          event({ at: 3_000, message: 'mine' }),
          event({ at: 2_000, level: 'error', sessionId: 'session-bbbb2222', message: 'theirs' }),
        ],
      }),
      storage,
    )

    // The tab opens on errors only, and on this tab's own session: neither the
    // other session's failure nor this session's quiet line is drawn, and the
    // list says the ring holds events the filter is hiding.
    expect(texts(view.tree)).not.toContain('mine')
    expect(texts(view.tree)).not.toContain('theirs')
    expect(texts(view.tree)).toContain(t('logsNoErrorsTitle'))

    click(view.tree, t('logsAllLevels'))
    expect(storage.values[LOG_LEVEL_KEY]).toBe('all')
    // Every level of this session now, and still only of this session.
    expect(texts(view.rerender())).toContain('mine')
    expect(texts(view.rerender())).not.toContain('theirs')

    click(view.rerender(), t('logsAllSessions'))
    expect(storage.values[LOG_SCOPE_KEY]).toBe('all')
    expect(texts(view.rerender())).toContain('theirs')

    click(view.rerender(), t('logsErrorsOnly'))
    expect(storage.values[LOG_LEVEL_KEY]).toBe('error')
    const errorsOnly = texts(view.rerender())
    expect(errorsOnly).not.toContain('mine')
    expect(errorsOnly).toContain('theirs')
  })

  it('clears locally: it marks the moment and stops drawing what it covers', () => {
    // Clear is about the mark, not about the level: read every level here.
    const storage = installStorage({ [LOG_LEVEL_KEY]: 'all' })
    const calls = fetchCalls(() => ok({ events: [], total: 0, more: false }))
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    const view = mountLogs(
      logsProject({
        logs: [
          event({ at: 1_699_999_999_998, message: 'before the click' }),
          event({ at: 1_699_999_999_999, level: 'up', message: 'the same millisecond' }),
          event({ at: 1_700_000_000_000, level: 'warn', message: 'after the click' }),
        ],
      }),
      storage,
    )

    expect(texts(view.tree)).toContain('before the click')
    expect(texts(view.tree)).toContain('the same millisecond')

    click(view.tree, t('logsClear'))
    const cleared = texts(view.rerender())

    // One millisecond back, so an event landing in the click's own millisecond
    // is still drawn: the mark is exclusive.
    expect(storage.values[LOGS_CLEARED_KEY]).toBe('1699999999999')
    expect(cleared).not.toContain('before the click')
    expect(cleared).not.toContain('the same millisecond')
    expect(cleared).toContain('after the click')
    // Clear has no route: the host's ring is untouched.
    expect(calls).toHaveLength(0)
  })

  it('pages older events over the contract’s route and merges them without repeats', async () => {
    const page = [
      event({ at: 1_000, message: 'one page older' }),
      event({ at: 900, message: 'oldest' }),
    ]
    const calls = fetchCalls(() =>
      ok({ events: page, total: 60, more: true }),
    )
    const view = mountLogs(logsProject(), installStorage({ [LOG_LEVEL_KEY]: 'all' }))

    const paged = view.tree
    expect(texts(paged)).toContain('showing 2 of 60')
    click(paged, t('logsMore'))

    // In flight: the button becomes the loading line, so it cannot be pressed twice.
    expect(texts(view.rerender())).toContain(t('logsLoading'))
    await settle()
    const merged = texts(view.rerender())

    expect(calls[0]?.url).toBe(
      `${ROUTE_PREFIX}/${ROUTE_ACTIONS.logs}?projectRoot=%2Frepo&limit=50&before=2000`,
    )
    expect(merged).toContain('one page older')
    expect(merged).toContain('oldest')
    expect(merged).toContain('showing 4 of 60')
    // The snapshot's own events are still there, once each.
    expect(merged.filter((line) => line === 'newest one')).toHaveLength(1)
  })

  it('reports a page that never arrived and never re-asks its cursor', async () => {
    fetchCalls(() => refuse('the ring is unreadable'))
    const view = mountLogs(logsProject(), installStorage({ [LOG_LEVEL_KEY]: 'all' }))
    click(view.tree, t('logsMore'))
    // The effect that asks for the page runs on the render the click causes.
    expect(texts(view.rerender())).toContain(t('logsLoading'))
    await settle()

    const rendered = view.rerender()
    expect(texts(rendered)).toContain(t('logsLoadFailed'))
    // The cursor was asked for, so the button does not offer itself again.
    expect(button(rendered, t('logsMore'))).toBeUndefined()
  })

  it('draws the empty state and the ring’s own total when nothing was recorded', () => {
    const view = mountLogs(project())

    expect(texts(view.tree)).toContain(t('logsEmptyTitle'))
    expect(texts(view.tree)).toContain(t('logsEmptyHint'))
    expect(button(view.tree, t('logsMore'))).toBeUndefined()
  })

  it('takes the project’s total from the snapshot when the host publishes no count', () => {
    const view = mountLogs(
      project({ logs: [event({ at: 3_000, message: 'only one' })] }),
      installStorage({ [LOG_LEVEL_KEY]: 'all' }),
    )

    expect(texts(view.tree)).toContain('1 in this project')
    // The snapshot carried the whole ring, so there is nothing older to ask for.
    expect(button(view.tree, t('logsMore'))).toBeUndefined()
  })
})

/* -------------------------------------------------------------------------- */
/* The side-card settings popup                                                */
/* -------------------------------------------------------------------------- */

function mountSettings(
  props: Partial<{
    pluginSettings: Record<string, unknown>
    updatePluginSetting: (key: string, value: unknown) => void
    onClose: (() => void) | undefined
    t: Translate | undefined
  }> = {},
): ReturnType<typeof mountComponent<Parameters<typeof ProjectMcpSettings>[0]>> {
  return mountComponent(ProjectMcpSettings, {
    pluginSettings: { [REFRESH_KEY]: 2_000 },
    updatePluginSetting: () => undefined,
    t,
    ...props,
  })
}

describe('the side-card settings popup', () => {
  it('polls the whole picture and lists every project with a session', async () => {
    const calls = fetchCalls(() =>
      ok(
        snapshotOf(
          project(),
          project({ projectRoot: '/other', sessionIds: ['session-zzz'], rows: [row('beta', 'idle')] }),
        ),
      ),
    )
    const view = mountSettings()
    await settle()
    const rendered = texts(view.rerender())

    // No session to wait for: the popup reads the host unconditionally.
    expect(calls[0]?.url).toBe(`${ROUTE_PREFIX}/${ROUTE_ACTIONS.snapshot}`)
    expect(rendered).toContain(t('mountedPerProject'))
    expect(rendered).toContain('2 project(s)')
    expect(rendered).toContain('repo')
    expect(rendered).toContain('other')
    expect(rendered).toContain('beta')
  })

  it('says nothing is mounted rather than drawing an empty list', async () => {
    fetchCalls(() => ok(snapshotOf()))
    const view = mountSettings()
    await settle()

    expect(texts(view.rerender())).toContain(t('nothingMounted'))
  })

  it('syncs the whole picture, and closes only when the surface offers it', async () => {
    const calls = fetchCalls(() => ok(snapshotOf(project())))
    const closed: string[] = []
    const view = mountSettings({ onClose: () => closed.push('close') })
    await settle()

    expect(button(view.rerender(), t('close'))).toBeDefined()
    click(view.tree, t('close'))
    expect(closed).toEqual(['close'])

    click(view.rerender(), t('sync'))
    await settle()
    expect(calls[1]?.url).toBe(`${ROUTE_PREFIX}/${ROUTE_ACTIONS.sync}`)
    // The popup lists every project, so its Sync names none of them.
    expect(calls[1]?.init).toEqual({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })

    // Without a close seat there is no Close button at all.
    const bare = mountSettings()
    await settle()
    expect(button(bare.rerender(), t('close'))).toBeUndefined()
  })

  it('releases a session through the same route the tab uses', async () => {
    // The section appears only when a session disagrees, so this project merges
    // a beta the session never mounted.
    const calls = fetchCalls(() =>
      ok(snapshotOf(project({ rows: [row('alpha', 'active'), row('beta', 'idle')] }))),
    )
    const view = mountSettings()
    await settle()
    click(view.rerender(), `▸ ${t('sessionsSection')}`)
    click(view.rerender(), t('release'))
    await settle()

    expect(calls[1]?.url).toBe(`${ROUTE_PREFIX}/${ROUTE_ACTIONS.release}`)
    expect(calls[1]?.init).toMatchObject({ body: JSON.stringify({ sessionId: 'session-aaaa1111' }) })
  })

  it('falls back to the module’s own English copy without a seat', async () => {
    fetchCalls(() => ok(snapshotOf(project())))
    const view = mountSettings({ t: undefined })
    await settle()

    expect(texts(view.rerender())).toContain('Mounted per project')
  })
})

/* -------------------------------------------------------------------------- */
/* The sessions disclosure                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The section as the project block hands it over: only the sessions whose own
 * reading disagrees with the project's merged rows.
 */
function mountSessions(
  projectSnapshot: ProjectSnapshot,
  released: string[] = [],
): ReturnType<typeof mountComponent<Parameters<typeof SessionList>[0]>> {
  return mountComponent(SessionList, {
    sessions: sessionBreakdown(projectSnapshot, 'session-aaaa1111').filter(
      (session) => session.deviates,
    ),
    busy: false,
    merged: true,
    onRelease: (sessionId) => released.push(sessionId),
    t,
  })
}

// Both sessions disagree with the merged rows: each holds a server the other
// does not, so both are worth a row under the project.
const TWO_SESSIONS = project({
  rows: [row('alpha', 'active'), row('beta', 'idle')],
  sessionIds: ['session-aaaa1111', 'session-abcdefghijkl'],
  sessions: [
    session('session-aaaa1111', [row('alpha', 'active')]),
    session('session-abcdefghijkl', [row('beta', 'idle')]),
  ],
})

describe('the sessions disclosure', () => {
  it('starts collapsed, opens the sessions, and opens one session’s own rows', () => {
    const view = mountSessions(TWO_SESSIONS)
    const collapsed = texts(view.tree)

    expect(collapsed).toContain(`▸ ${t('sessionsSection')}`)
    expect(collapsed).toContain(t('differsMany', { count: 2 }))
    expect(collapsed).toContain(t('mergedAcrossSessions'))
    // Collapsed means the rows are not merely hidden behind an indent.
    expect(collapsed).not.toContain('alpha')

    click(view.tree, `▸ ${t('sessionsSection')}`)
    const open = view.rerender()
    expect(texts(open)).toContain(`▾ ${t('sessionsSection')}`)
    expect(button(open, `▸ aaaa1111`)).toBeDefined()
    // A long id is shortened for the narrow sidebar.
    expect(button(open, `▸ abcdefgh…`)).toBeDefined()

    click(open, `▸ aaaa1111`)
    const expanded = view.rerender()
    expect(texts(expanded)).toContain('alpha')
    expect(texts(expanded)).not.toContain('beta')
    expect(button(expanded, 'aaaa1111')?.props['aria-expanded']).toBe(true)

    // The row is still the control that folds it back up.
    click(expanded, 'aaaa1111')
    expect(texts(view.rerender())).not.toContain('alpha')
  })

  it('releases exactly the session whose row was pressed', () => {
    const released: string[] = []
    const view = mountSessions(TWO_SESSIONS, released)
    click(view.tree, `▸ ${t('sessionsSection')}`)
    click(view.rerender(), t('release'))

    expect(released).toEqual(['session-aaaa1111'])
  })

  it('renders nothing for a project the host published no session for', () => {
    const view = mountComponent(SessionList, {
      sessions: [],
      busy: false,
      onRelease: () => undefined,
      t,
    })

    expect(view.tree).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* The storage and settings seams the surfaces read through                    */
/* -------------------------------------------------------------------------- */

describe('the panel’s storage and settings seams', () => {
  it('reads and writes the browser’s own storage when no seam is handed over', () => {
    const storage = installStorage({ [LOG_SCOPE_KEY]: 'all', [LOGS_CLEARED_KEY]: '2500' })

    expect(logScopeOf()).toBe('all')
    expect(logsClearedAt()).toBe(2_500)
    persistLogFilter(LOG_LEVEL_KEY, 'error')
    expect(storage.values[LOG_LEVEL_KEY]).toBe('error')
    expect(logLevelOf()).toBe('error')
  })

  it('falls back to the defaults when the browser has no storage', () => {
    expect(logScopeOf()).toBe(DEFAULT_LOG_SCOPE)
    expect(logLevelOf()).toBe(DEFAULT_LOG_LEVEL)
    expect(logsClearedAt()).toBeUndefined()
  })

  it('treats a storage that refuses to be read as no storage at all', () => {
    // A policy can make the property itself throw, which is why the read is
    // guarded rather than assumed: the choice is lost, the panel is not.
    Reflect.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('blocked')
      },
    })

    expect(logScopeOf()).toBe(DEFAULT_LOG_SCOPE)
    expect(logsClearedAt()).toBeUndefined()
    expect(() => persistLogFilter(LOG_LEVEL_KEY, 'all')).not.toThrow()
    expect(() => persistLogsClearedAt(1_000)).not.toThrow()
  })

  it('reads the poll interval out of the settings blob, and defaults anything else', () => {
    expect(refreshMsOf({ [REFRESH_KEY]: 2_500 })).toBe(2_500)
    for (const value of ['soon', 0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(refreshMsOf({ [REFRESH_KEY]: value })).toBe(DEFAULT_REFRESH_MS)
    }
    expect(refreshMsOf({})).toBe(DEFAULT_REFRESH_MS)
  })

  it('reads this plugin’s own blob out of the sidebar snapshot', () => {
    const blob = { [REFRESH_KEY]: 1_000 }

    expect(pluginSettingsOf({ prefs: { pluginSettings: { [TAB_ID]: blob } } })).toBe(blob)
    expect(pluginSettingsOf({ prefs: {} })).toEqual({})
    expect(pluginSettingsOf({ prefs: { pluginSettings: { other: { x: 1 } } } })).toEqual({})
  })

  it('names a project by its last path segment, and has nothing to name for an empty path', () => {
    expect(basename('/repo')).toBe('repo')
    expect(basename('/repo/')).toBe('repo')
    expect(basename('')).toBe('')
  })
})

describe('the host’s idle figure on a server row (F-32)', () => {
  const DAY = 24 * 60 * 60 * 1000

  /** The counters of one recorded server, last used `days` ago. */
  const counters = (days: number): ProjectSnapshot['usage'] => ({
    'grafana-local': {
      calls: 3,
      errors: 0,
      lastUsedAt: new Date(Date.now() - days * DAY).toISOString(),
      tools: {},
    },
  })

  it('writes the figure beside a quiet status word', () => {
    const view = mountComponent(ServersBlock, {
      rows: [row('grafana-local', 'idle')],
      usage: counters(3),
      t,
    })
    expect(flat(view.tree)).toContain('idle 3d')
  })

  it('leaves a working row alone, even while the counters hold a date', () => {
    const view = mountComponent(ServersBlock, {
      rows: [row('grafana-local', 'active')],
      usage: counters(3),
      t,
    })
    expect(flat(view.tree)).not.toContain('idle 3d')
  })

  it('prints no figure at all for a server the counters never recorded', () => {
    // The status word itself is still `idle`; what must not appear is a number
    // nobody counted, so the assertion is about the figure, not the word.
    const view = mountComponent(ServersBlock, { rows: [row('ghost', 'idle')], t })
    expect(flat(view.tree)).not.toMatch(/idle \d/u)
  })
})

describe('the status word on screen (F-47)', () => {
  it('names a server status in words rather than echoing the enum', () => {
    // A seat that answers the status word in another language and lets every
    // other key fall through to English: the row must read from the seat, so
    // the raw `ServerStatus` token cannot reach the screen in any language.
    const seat: Translate = (key, params) =>
      key === 'statusError' ? 'сбой' : fallbackTranslate(key, params)
    const view = mountComponent(ServersBlock, { rows: [row('tglider', 'error')], t: seat })
    expect(flat(view.tree)).toContain('сбой')
    expect(flat(view.tree)).not.toContain('error')
  })
})

/* -------------------------------------------------------------------------- */
/* The tools block's filter (F-43)                                             */
/* -------------------------------------------------------------------------- */

/**
 * The tool offer the filter tests drive: one pinned name, one disclosed, three
 * hidden across three servers.
 *
 * Wider than {@link TOOLS}, which is one name and no hidden tier: the filter
 * exists for the block that has more rows than a glance can hold, and a fixture
 * with one row would prove nothing about narrowing it.
 */
const FILTER_TOOLS: SessionTools = {
  sessionId: 'session-aaaa1111',
  baseline: ['mcp__tglider__workspace'],
  activated: [{ name: 'mcp__tglider__find_references', via: 'session', at: 1_700_000_000_000 }],
  context: [],
  deferred: [
    'mcp__tglider__symbol',
    'mcp__grafana-local__query_prometheus',
    'mcp__memory__search_nodes',
  ],
  mounted: 47,
  surfaceChars: 40,
  budgetChars: 400,
  deferring: false,
}

/** The same picture as {@link panelSnapshot}, with the wider tool offer. */
function filterSnapshot(): McpSnapshot {
  const mine = session('session-aaaa1111', [row('alpha', 'active')], {
    tools: FILTER_TOOLS,
    logCount: 0,
  })
  return snapshotOf(project({ rows: mine.rows, sessions: [mine], policy: { ...PINNED } }))
}

describe('the tools block’s filter (F-43)', () => {
  /** The panel over {@link filterSnapshot}, read after its snapshot has landed. */
  async function mountFiltered(): Promise<ReturnType<typeof mountPanel>> {
    fetchCalls(() => ok(filterSnapshot()))
    const view = mountPanel()
    await settle()
    // The picture arrives in an effect, so the tree drawn before it is the empty
    // toolbar: one pass reads what the state now holds, as the panel tests do.
    view.rerender()
    return view
  }

  /** The filter field of the tools block. */
  function field(node: unknown): Element {
    const input = elements(node).find(
      (element) => element.type === 'input' && element.props['aria-label'] === t('toolsFilterLabel'),
    )
    if (input === undefined) throw new Error('no filter field in the tools block')
    return input
  }

  /** Type into the field, the way the browser reports it. */
  function type(node: unknown, value: string): void {
    ;(field(node).props.onChange as (event: { target: { value: string } }) => void)({
      target: { value },
    })
  }

  it('narrows the block to the names the query matches, and says what is left', async () => {
    const view = await mountFiltered()

    expect(flat(view.tree)).toContain('mcp__tglider__workspace')

    type(view.tree, 'grafana')
    const filtered = view.rerender()

    // The one name the query matches is drawn; the pin and the other hidden
    // names are not. Five rows before the filter: one pin, one disclosure, three
    // hidden names in three groups.
    expect(flat(filtered)).toContain('mcp__grafana-local__query_prometheus')
    expect(flat(filtered)).not.toContain('mcp__tglider__workspace')
    expect(flat(filtered)).not.toContain('mcp__memory__search_nodes')
    expect(flat(filtered)).toContain(t('toolsFilterShown', { shown: 1, total: 5 }))
    // The field keeps what was typed: it is the panel's own state, not a value
    // the snapshot refresh hands back.
    expect(field(filtered).props.value).toBe('grafana')
  })

  it('draws the empty state when nothing matches, and hands the list back on Clear', async () => {
    const view = await mountFiltered()

    type(view.tree, 'no tool is called this')
    const empty = view.rerender()

    expect(flat(empty)).toContain(t('toolsFilterNone'))
    expect(flat(empty)).not.toContain(t('toolsGroupPinned'))
    expect(flat(empty)).not.toContain(t('toolsGroupDisclosed'))

    click(empty, t('toolsFilterClear'))
    const restored = view.rerender()

    expect(flat(restored)).toContain(t('toolsGroupPinned'))
    expect(flat(restored)).toContain(t('toolsGroupDisclosed'))
    // The hidden tier is back to its folded default, with all three names under
    // its head: the filter opened it, and dropping the filter closes it again.
    expect(texts(head(restored, t('toolsGroupHidden'))).join('')).toBe(
      `▸ ${t('toolsGroupHidden')}3`,
    )
    expect(field(restored).props.value).toBe('')
    // Nothing is applied any more, so the Clear is gone with the filter it cleared.
    expect(button(restored, t('toolsFilterClear'))).toBeUndefined()
  })

  it('shows one tier alone while its chip is pressed, and every tier again after the second press', async () => {
    const view = await mountFiltered()

    expect(flat(view.tree)).toContain(t('toolsGroupPinned'))
    expect(flat(view.tree)).toContain(t('toolsGroupDisclosed'))

    click(view.tree, '1 pinned')
    const pinnedOnly = view.rerender()

    expect(flat(pinnedOnly)).toContain(t('toolsGroupPinned'))
    expect(flat(pinnedOnly)).not.toContain(t('toolsGroupDisclosed'))
    expect(flat(pinnedOnly)).not.toContain('mcp__memory__search_nodes')
    // The pressed chip is the applied control of the block; the other two answer
    // `false` and switch nothing.
    expect(applied(pinnedOnly).map((element) => texts(element).join(''))).toEqual(['1 pinned'])
    expect(flat(pinnedOnly)).toContain(t('toolsFilterShown', { shown: 1, total: 5 }))

    click(pinnedOnly, '1 pinned')
    const every = view.rerender()

    expect(flat(every)).toContain(t('toolsGroupDisclosed'))
    expect(applied(every)).toEqual([])
  })

  it('opens the hidden tier itself when a query finds names inside it', async () => {
    const view = await mountFiltered()

    // Folded by default: the tier's names are not drawn, and its head counts all
    // three of them.
    expect(flat(view.tree)).not.toContain('mcp__memory__search_nodes')
    expect(texts(head(view.tree, t('toolsGroupHidden'))).join('')).toBe(`▸ ${t('toolsGroupHidden')}3`)

    type(view.tree, 'memory')
    const found = view.rerender()

    // The match is drawn without a click on the fold, and the head answers for
    // the list under it: one name.
    expect(flat(found)).toContain('mcp__memory__search_nodes')
    expect(texts(head(found, t('toolsGroupHidden'))).join('')).toBe(`▾ ${t('toolsGroupHidden')}1`)
  })

  it('lets the user’s own press of the hidden head outrank the filter that opened it', async () => {
    const view = await mountFiltered()

    type(view.tree, 'memory')
    const found = view.rerender()
    expect(flat(found)).toContain('mcp__memory__search_nodes')

    // The head is a live control while the filter is on: pressing it closes the
    // list the filter opened, and the badge keeps counting the matches.
    toggle(found, t('toolsGroupHidden'))
    const closed = view.rerender()

    expect(flat(closed)).not.toContain('mcp__memory__search_nodes')
    expect(texts(head(closed, t('toolsGroupHidden'))).join('')).toBe(`▸ ${t('toolsGroupHidden')}1`)

    // Dropping the filter does not reopen a tier the user closed by hand: their
    // press is the later word, and the badge answers for the whole tier again.
    click(closed, t('toolsFilterClear'))
    const restored = view.rerender()

    expect(flat(restored)).not.toContain('mcp__memory__search_nodes')
    expect(texts(head(restored, t('toolsGroupHidden'))).join('')).toBe(`▸ ${t('toolsGroupHidden')}3`)
  })
})

/* -------------------------------------------------------------------------- */
/* The server-level pin (F-44)                                                 */
/* -------------------------------------------------------------------------- */

/** The offer the server-pin test drives: `tglider` hides two names, `memory` one. */
const SERVER_TOOLS: SessionTools = {
  sessionId: 'session-aaaa1111',
  baseline: ['mcp__tglider__workspace'],
  activated: [],
  context: [],
  deferred: ['mcp__tglider__symbol', 'mcp__tglider__graph', 'mcp__memory__search_nodes'],
  mounted: 47,
  surfaceChars: 40,
  budgetChars: 400,
  deferring: false,
}

/** The same picture as {@link panelSnapshot}, with that offer. */
function serverSnapshot(): McpSnapshot {
  const mine = session('session-aaaa1111', [row('alpha', 'active')], {
    tools: SERVER_TOOLS,
    logCount: 0,
  })
  return snapshotOf(project({ rows: mine.rows, sessions: [mine], policy: { ...PINNED } }))
}

describe('the server-level pin (F-44)', () => {
  it('pins every hidden name of one server in a single press', async () => {
    const calls = fetchCalls(() => ok(serverSnapshot()))
    const view = mountPanel()
    await settle()
    view.rerender()

    // The tier is folded by default; its head opens it, and each server's line
    // then carries the press that takes that whole group.
    toggle(view.tree, t('toolsGroupHidden'))
    const open = view.rerender()

    expect(flat(open)).toContain('mcp__tglider__symbol')
    expect(flat(open)).toContain('mcp__memory__search_nodes')

    click(open, t('toolsPinAll'))
    await settle()

    // One press, one name per request — the route writes a single name — and
    // only this server's: the other group's name is not touched, and a name the
    // project already pins is not re-pinned.
    const pins = calls.filter((call) => call.url === `${ROUTE_PREFIX}/${ROUTE_ACTIONS.pin}`)
    expect(pins.map((call) => JSON.parse(String(call.init?.body)))).toEqual([
      { projectRoot: '/repo', tool: 'mcp__tglider__symbol', pinned: true },
      { projectRoot: '/repo', tool: 'mcp__tglider__graph', pinned: true },
    ])
  })

  it('says Unpin all for a pinned name the snapshot still defers, and releases it', async () => {
    // A pin can sit in `deferred` between two assemblies — and `Pin all` over a
    // group that is already pinned whole would release it. The label follows the
    // reading, and the press follows the label.
    const mine = session('session-aaaa1111', [row('alpha', 'active')], {
      tools: { ...SERVER_TOOLS, deferred: ['mcp__tglider__symbol'] },
      logCount: 0,
    })
    const calls = fetchCalls(() =>
      ok(
        snapshotOf(
          project({
            rows: mine.rows,
            sessions: [mine],
            policy: { mode: 'disclosure', pins: ['mcp__tglider__symbol'] },
          }),
        ),
      ),
    )
    const view = mountPanel()
    await settle()
    view.rerender()

    toggle(view.tree, t('toolsGroupHidden'))
    const open = view.rerender()

    expect(button(open, t('toolsPinAll'))).toBeUndefined()

    click(open, t('toolsUnpinAll'))
    await settle()

    const pins = calls.filter((call) => call.url === `${ROUTE_PREFIX}/${ROUTE_ACTIONS.pin}`)
    expect(pins.map((call) => JSON.parse(String(call.init?.body)))).toEqual([
      { projectRoot: '/repo', tool: 'mcp__tglider__symbol', pinned: false },
    ])
  })

  it('releases a whole server from the pinned tier, per its own group', async () => {
    // The pinned list is grouped by server since F-44, and the group carries the
    // press that releases it: two names of `tglider` go in one press, and the
    // other server's pin is not touched.
    const mine = session('session-aaaa1111', [row('alpha', 'active')], {
      tools: SERVER_TOOLS,
      logCount: 0,
    })
    const calls = fetchCalls(() =>
      ok(
        snapshotOf(
          project({
            rows: mine.rows,
            sessions: [mine],
            policy: {
              mode: 'disclosure',
              pins: [
                'mcp__tglider__workspace',
                'mcp__tglider__symbol',
                'mcp__memory__search_nodes',
              ],
            },
          }),
        ),
      ),
    )
    const view = mountPanel()
    await settle()
    const rendered = view.rerender()

    expect(flat(rendered)).toContain('tglider · 2')
    expect(flat(rendered)).toContain('memory · 1')

    click(rendered, t('toolsUnpinAll'))
    await settle()

    const pins = calls.filter((call) => call.url === `${ROUTE_PREFIX}/${ROUTE_ACTIONS.pin}`)
    expect(pins.map((call) => JSON.parse(String(call.init?.body)))).toEqual([
      { projectRoot: '/repo', tool: 'mcp__tglider__workspace', pinned: false },
      { projectRoot: '/repo', tool: 'mcp__tglider__symbol', pinned: false },
    ])
  })

  it('draws no server press for a session with no tools to pin', async () => {
    fetchCalls(() => ok({ ready: true, projects: [], watchedFiles: [] }))
    const view = mountPanel()
    await settle()
    view.rerender()

    expect(button(view.tree, t('toolsPinAll'))).toBeUndefined()
  })
})

/* -------------------------------------------------------------------------- */
/* The host-coded row details, end to end through the panel (F-48, Task 4)     */
/* -------------------------------------------------------------------------- */

describe('the panel resolves a row’s coded detail (F-48)', () => {
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

  /** The failing row, with the coded companions the host publishes beside the prose. */
  const broken = (coded: boolean): ServerRow =>
    row('gateway', 'error', {
      transport: 'stdio',
      detail: DETAIL,
      ...(coded
        ? {
            detailCode: 'mount.stalledDetail',
            detailParams: {
              name: 'gateway',
              elapsed: '60.2s',
              endpoint: 'stdio docker',
              source: '/repo/.dsh/mcp.json',
            },
          }
        : {}),
    })

  const snapshotWith = (gateway: ServerRow): McpSnapshot => {
    const mine = session('session-aaaa1111', [row('alpha', 'active'), gateway], { tools: TOOLS })
    return snapshotOf(project({ rows: mine.rows, sessions: [mine] }))
  }

  it('translates the servers block tooltip and the errors disclosure banner', async () => {
    fetchCalls(() => ok(snapshotWith(broken(true))))
    const view = mountPanel({ hostT })
    await settle()

    // The servers block's row carries the resolved detail as its tooltip.
    let tree = view.rerender()
    expect(elements(tree).some((element) => element.props.title === TRANSLATED)).toBe(true)
    expect(elements(tree).some((element) => element.props.title === DETAIL)).toBe(false)

    // The errors disclosure's banner reads the same translated text.
    toggle(tree, t('errorsSection'))
    tree = view.rerender()
    expect(texts(tree).join(' | ')).toContain(TRANSLATED)
    // The raw code never reaches the screen.
    expect(texts(tree).join(' | ')).not.toContain('mount.stalledDetail')
  })

  it('renders an uncoded row’s prose exactly as before', async () => {
    fetchCalls(() => ok(snapshotWith(broken(false))))
    const view = mountPanel({ hostT })
    await settle()

    let tree = view.rerender()
    expect(elements(tree).some((element) => element.props.title === DETAIL)).toBe(true)
    toggle(tree, t('errorsSection'))
    tree = view.rerender()
    expect(texts(tree).join(' | ')).toContain(DETAIL)
  })
})
