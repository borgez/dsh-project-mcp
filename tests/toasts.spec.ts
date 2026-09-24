/**
 * Frame-wide toasts: what earns a banner, and what the floating layer renders.
 *
 * React is mocked at the module boundary (the technique `tests/tab-translate.spec.ts`
 * uses) with a miniature renderer: the hooks the stack calls are replayed on
 * demand, so a store push repaints the tree and a timer-driven fade can be
 * followed all the way to the dismiss, without a DOM. Everything else — the
 * transition diff, the frame reader and the channel — is plain module code
 * driven directly.
 *
 * The two properties worth checking first:
 * - a picture the module has no baseline for (page load, reconnect, a frame
 *   that arrives before `hello`) raises **nothing**: an already-running server
 *   is not a fresh start;
 * - a repeat of the registration closes the first channel and leaves one entry,
 *   because DSH's slot core throws on a duplicate list id and a second channel
 *   would double every banner.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ROUTE_ACTIONS, ROUTE_PREFIX } from '../src/shared.ts'
import type { McpSnapshot, ProjectSnapshot, ServerRow, ServerStatus } from '../src/types.ts'
import { localeService } from './helpers/locale.ts'

/** One component instance the miniature renderer keeps between draws. */
interface Instance {
  readonly component: (props: never) => unknown
  readonly props: unknown
  states: unknown[]
  deps: (readonly unknown[] | undefined)[]
  cleanups: ((() => void) | undefined)[]
  tree: unknown
}

/** The instance currently being drawn, and its hook cursor. */
let drawing: Instance | undefined
let cursor = 0

/** Draw one component, letting the mocked hooks reach its instance. */
function draw(instance: Instance): unknown {
  const outer = drawing
  const outerCursor = cursor
  drawing = instance
  cursor = 0
  instance.tree = (instance.component as (props: unknown) => unknown)(instance.props)
  drawing = outer
  cursor = outerCursor
  return instance.tree
}

/**
 * Mount one component and keep its tree.
 * @param component - the component to draw.
 * @param props - its props.
 * @returns the instance, whose `tree` is re-read after every state change.
 */
function mount(component: (props: never) => unknown, props: unknown = {}): Instance {
  const instance: Instance = { component, props, states: [], deps: [], cleanups: [], tree: null }
  draw(instance)
  return instance
}

/** Run every cleanup the instance kept, as unmounting does. */
function unmount(instance: Instance): void {
  for (const cleanup of instance.cleanups) cleanup?.()
  instance.cleanups = []
}

vi.mock('react', () => ({
  // React keeps one child as that child and several as an array; the walkers
  // below rely on the same shapes the real renderer would produce.
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
    type,
    props,
    children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children,
  }),
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useState: (initial: unknown): [unknown, (next: unknown) => void] => {
    const instance = drawing as Instance
    const at = cursor
    cursor += 1
    if (!(at in instance.states)) {
      instance.states[at] = typeof initial === 'function' ? (initial as () => unknown)() : initial
    }
    const set = (next: unknown): void => {
      instance.states[at] =
        typeof next === 'function' ? (next as (previous: unknown) => unknown)(instance.states[at]) : next
      draw(instance)
    }
    return [instance.states[at], set]
  },
  useEffect: (callback: () => unknown, deps?: readonly unknown[]): void => {
    const instance = drawing as Instance
    const at = cursor
    cursor += 1
    const previous = instance.deps[at]
    const changed =
      deps === undefined ||
      previous === undefined ||
      deps.length !== previous.length ||
      deps.some((value, index) => !Object.is(value, previous[index]))
    if (!changed) return
    instance.cleanups[at]?.()
    instance.deps[at] = deps
    instance.cleanups[at] = callback() as (() => void) | undefined
  },
}))

// The module under test and the view module it reads the status palette from
// both pull react in, so both are imported after the mocked hooks' own state
// exists — the same reason `tab-translate.spec.ts` imports its seat dynamically.
const toasts = await import('../src/client/toasts.ts')
const view = await import('../src/client/view.ts')

/** One row of a picture; the project root keeps a banner one line wide. */
function row(name: string, status: ServerStatus, projectRoot = '/repo/project1'): ServerRow {
  return { name, status, projectRoot }
}

/**
 * Every string a user would read under this node, invoking function components
 * the way the renderer would. The mocked `createElement` keeps children beside
 * the element, so both seats are walked.
 */
function textsOf(node: unknown): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap((child) => textsOf(child))
  const element = node as { type: unknown; props: Record<string, unknown> | null; children?: unknown }
  if (typeof element.type === 'function') {
    return textsOf(mount(element.type as never, element.props).tree)
  }
  return [...textsOf(element.props?.children), ...textsOf(element.children)]
}

/** One project of a picture, with the rows under test. */
function project(projectRoot: string, rows: ServerRow[]): ProjectSnapshot {
  return { projectRoot, sessionIds: ['session-1'], rows, issues: [], sessions: [] }
}

/** A whole picture, as the status channel carries it. */
function snapshot(...projects: ProjectSnapshot[]): McpSnapshot {
  return { ready: true, projects, watchedFiles: [] }
}

/** One frame's payload, wire-shaped like the host writes it. */
function frame(revision: number, picture: McpSnapshot): string {
  return JSON.stringify({ revision, snapshot: picture })
}

/** A stand-in for `EventSource`: holds its listeners, can be driven, counts closes. */
class FakeSource {
  static readonly live: FakeSource[] = []
  readonly url: string
  closed = 0
  private readonly listeners = new Map<string, ((event: Event) => void)[]>()

  constructor(url: string) {
    this.url = url
    FakeSource.live.push(this)
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  close(): void {
    this.closed += 1
  }

  /** Deliver one frame to every listener of that kind. */
  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data } as unknown as Event)
  }
}

beforeEach(() => {
  FakeSource.live.length = 0
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the store the stack renders from', () => {
  it('mints identity, newest first, and keeps the newest banners only', () => {
    const store = toasts.createToastStore()
    for (const name of ['alpha', 'beta', 'gamma', 'delta']) {
      store.push({ level: 'up', server: name, project: 'project1', textKey: 'toastUp', textParams: { server: name } })
    }

    expect(toasts.MAX_TOASTS).toBe(3)
    expect(store.getSnapshot().map((toast) => toast.server)).toEqual(['delta', 'gamma', 'beta'])
    expect(store.getSnapshot().map((toast) => toast.id)).toEqual([4, 3, 2])
  })

  it('honours a smaller limit than the module default', () => {
    const store = toasts.createToastStore(1)
    store.push({ level: 'up', server: 'alpha', project: 'project1', textKey: 'toastUp', textParams: { server: 'alpha' } })
    store.push({ level: 'up', server: 'beta', project: 'project1', textKey: 'toastUp', textParams: { server: 'beta' } })

    expect(store.getSnapshot().map((toast) => toast.server)).toEqual(['beta'])
  })

  it('notifies its subscribers and forgets the one that left', () => {
    const store = toasts.createToastStore()
    const seen: number[] = []
    const stop = store.subscribe(() => seen.push(store.getSnapshot().length))

    store.push({ level: 'error', server: 'alpha', project: 'project1', textKey: 'toastFailed', textParams: { server: 'alpha' } })
    stop()
    store.push({ level: 'up', server: 'beta', project: 'project1', textKey: 'toastUp', textParams: { server: 'beta' } })

    expect(seen).toEqual([1])
  })

  it('retires one banner by id and ignores an id it never minted', () => {
    const store = toasts.createToastStore()
    store.push({ level: 'up', server: 'alpha', project: 'project1', textKey: 'toastUp', textParams: { server: 'alpha' } })
    const [toast] = store.getSnapshot()

    store.dismiss(999)
    expect(store.getSnapshot()).toHaveLength(1)
    store.dismiss(toast?.id ?? 0)
    expect(store.getSnapshot()).toEqual([])
  })
})

describe('reading one frame', () => {
  it('takes a well-formed change', () => {
    const pictured = snapshot(project('/repo/project1', [row('alpha', 'active')]))

    expect(toasts.parseChange(frame(3, pictured))).toEqual({ revision: 3, snapshot: pictured })
  })

  it.each([
    ['a payload that is not text', 42],
    ['text that is not JSON', '{'],
    ['JSON that is not an object', '"missing"'],
    ['a frame with no revision', JSON.stringify({ snapshot: { projects: [] } })],
    ['a frame whose snapshot is not a picture', JSON.stringify({ revision: 1, snapshot: null })],
    ['a frame whose snapshot carries no projects', JSON.stringify({ revision: 1, snapshot: {} })],
  ])('drops %s', (_label, data) => {
    expect(toasts.parseChange(data)).toBeUndefined()
  })
})

describe('what earns a banner', () => {
  it('says nothing about a picture it has no baseline for', () => {
    const picture = snapshot(project('/repo/project1', [row('alpha', 'active'), row('beta', 'error')]))

    expect(toasts.serverTransitions(undefined, picture)).toEqual([])
  })

  it('announces a server that came up, with its project as the detail', () => {
    const before = snapshot(project('/repo/project1', [row('alpha', 'connecting')]))
    const after = snapshot(project('/repo/project1', [row('alpha', 'active')]))

    expect(toasts.serverTransitions(before, after)).toEqual([
      { level: 'up', server: 'alpha', project: 'project1', textKey: 'toastUp', textParams: { server: 'alpha' }, detail: 'project1' },
    ])
  })

  it('announces an idle server that came back up', () => {
    const before = snapshot(project('/repo/project1', [row('alpha', 'idle')]))
    const after = snapshot(project('/repo/project1', [row('alpha', 'active')]))

    expect(toasts.serverTransitions(before, after)).toHaveLength(1)
  })

  it('announces a server that appears already up', () => {
    const before = snapshot(project('/repo/project1', []))
    const after = snapshot(project('/repo/project1', [row('alpha', 'active')]))

    expect(toasts.serverTransitions(before, after)).toHaveLength(1)
  })

  it('announces a failure with the fact the row carries', () => {
    const before = snapshot(project('/repo/project1', [row('alpha', 'connecting')]))
    const after = snapshot(
      project('/repo/project1', [{ ...row('alpha', 'error'), detail: 'no tool appeared in 60s' }]),
    )

    expect(toasts.serverTransitions(before, after)).toEqual([
      {
        level: 'error',
        server: 'alpha',
        project: 'project1',
        textKey: 'toastFailed',
        textParams: { server: 'alpha' },
        detailKey: view.STATUS_HINT.error,
        detail: 'no tool appeared in 60s',
      },
    ])
  })

  it('falls back to the status hint when a failure carries no detail', () => {
    const before = snapshot(project('/repo/project1', [row('alpha', 'connecting')]))
    const after = snapshot(project('/repo/project1', [row('alpha', 'error')]))

    const [draft] = toasts.serverTransitions(before, after)
    expect(draft?.detailKey).toBe(view.STATUS_HINT.error)
    expect(draft?.detail).toBeUndefined()
  })

  it('carries a row’s coded detail onto the failure banner (F-48)', () => {
    const before = snapshot(project('/repo/project1', [row('alpha', 'connecting')]))
    const after = snapshot(
      project('/repo/project1', [
        {
          ...row('alpha', 'error'),
          detail: 'no tool appeared in 60s',
          detailCode: 'mount.stalledDetail',
          detailParams: {
            name: 'alpha',
            elapsed: '60s',
            endpoint: 'stdio npx',
            source: '/repo/project1/.dsh/mcp.json',
          },
        },
      ]),
    )

    const [draft] = toasts.serverTransitions(before, after)
    expect(draft?.detail).toBe('no tool appeared in 60s')
    expect(draft?.detailCode).toBe('mount.stalledDetail')
    expect(draft?.detailParams?.name).toBe('alpha')
  })

  it('announces a release only when an active server lost its mounts', () => {
    const active = snapshot(project('/repo/project1', [row('alpha', 'active')]))
    const idle = snapshot(project('/repo/project1', [row('alpha', 'idle')]))
    const neverUp = snapshot(project('/repo/project1', [row('alpha', 'disabled')]))

    expect(toasts.serverTransitions(active, idle)).toEqual([
      {
        level: 'released',
        server: 'alpha',
        project: 'project1',
        textKey: 'toastReleased',
        textParams: { server: 'alpha' },
        detailKey: view.STATUS_HINT.idle,
      },
    ])
    expect(toasts.serverTransitions(neverUp, idle)).toEqual([])
  })

  it('stays quiet for states that are not a lifecycle moment', () => {
    const idle = snapshot(project('/repo/project1', [row('alpha', 'idle'), row('beta', 'disabled')]))
    const remounting = snapshot(
      project('/repo/project1', [row('alpha', 'connecting'), row('beta', 'disabled')]),
    )
    const conflicted = snapshot(project('/repo/project1', [row('alpha', 'conflict')]))

    expect(toasts.serverTransitions(idle, remounting)).toEqual([])
    expect(toasts.serverTransitions(idle, idle)).toEqual([])
    expect(toasts.serverTransitions(remounting, conflicted)).toEqual([])
  })

  it('keeps one server name of two projects apart', () => {
    const before = snapshot(
      project('/repo/project1', [row('alpha', 'connecting', '/repo/project1')]),
      project('/repo/project2', [row('alpha', 'connecting', '/repo/project2')]),
    )
    const after = snapshot(
      project('/repo/project1', [row('alpha', 'active', '/repo/project1')]),
      project('/repo/project2', [row('alpha', 'active', '/repo/project2')]),
    )

    expect(toasts.serverTransitions(before, after).map((draft) => draft.project)).toEqual([
      'project1',
      'project2',
    ])
  })
})

describe('following the host channel', () => {
  it('closes the source it opened when the entry goes away', () => {
    const source = new FakeSource('x')
    const store = toasts.createToastStore()
    const stop = toasts.followServers(store, () => source)

    expect(source.closed).toBe(0)
    stop()
    expect(source.closed).toBe(1)
  })

  it('takes the first picture as a baseline, then every announced change', () => {
    const source = new FakeSource('x')
    const store = toasts.createToastStore()
    toasts.followServers(store, () => source)

    source.emit('hello', frame(0, snapshot(project('/repo/project1', [row('alpha', 'connecting')]))))
    expect(store.getSnapshot()).toEqual([])

    source.emit('change', frame(1, snapshot(project('/repo/project1', [row('alpha', 'active')]))))
    expect(store.getSnapshot().map((toast) => toast.textKey)).toEqual(['toastUp'])

    source.emit('change', frame(2, snapshot(project('/repo/project1', [row('alpha', 'idle')]))))
    expect(store.getSnapshot().map((toast) => toast.level)).toEqual(['released', 'up'])
  })

  it('ignores a frame that is not newer than the one already applied', () => {
    const source = new FakeSource('x')
    const store = toasts.createToastStore()
    toasts.followServers(store, () => source)
    const up = frame(4, snapshot(project('/repo/project1', [row('alpha', 'active')])))

    source.emit('hello', up)
    source.emit('change', up)
    source.emit('change', frame(3, snapshot(project('/repo/project1', [row('alpha', 'idle')]))))

    expect(store.getSnapshot()).toEqual([])
  })

  it('drops a frame it cannot read and keeps following', () => {
    const source = new FakeSource('x')
    const store = toasts.createToastStore()
    toasts.followServers(store, () => source)

    // The unreadable frame leaves no baseline behind it: the next readable
    // picture is still the baseline, and the change after that is announced.
    source.emit('change', '{')
    source.emit('change', frame(1, snapshot(project('/repo/project1', [row('alpha', 'connecting')]))))
    source.emit('change', frame(2, snapshot(project('/repo/project1', [row('alpha', 'active')]))))

    expect(store.getSnapshot().map((toast) => toast.textKey)).toEqual(['toastUp'])
  })

  it('takes a change that arrives before any hello as the baseline', () => {
    const source = new FakeSource('x')
    const store = toasts.createToastStore()
    toasts.followServers(store, () => source)

    source.emit('change', frame(7, snapshot(project('/repo/project1', [row('alpha', 'active')]))))
    source.emit('change', frame(8, snapshot(project('/repo/project1', [row('alpha', 'idle')]))))

    expect(store.getSnapshot().map((toast) => toast.level)).toEqual(['released'])
  })

  it('follows nothing in an environment without EventSource', () => {
    vi.stubGlobal('EventSource', undefined)
    const store = toasts.createToastStore()
    const stop = toasts.followServers(store)

    expect(typeof stop).toBe('function')
    expect(() => stop()).not.toThrow()
    expect(store.getSnapshot()).toEqual([])
  })

  it('opens a real EventSource on the status route when the environment has one', () => {
    vi.stubGlobal('EventSource', FakeSource)
    const store = toasts.createToastStore()
    const stop = toasts.followServers(store)

    expect(FakeSource.live.map((source) => source.url)).toEqual([
      `${ROUTE_PREFIX}/${ROUTE_ACTIONS.events}`,
    ])
    stop()
    expect(FakeSource.live[0]?.closed).toBe(1)
  })
})

describe('registering the stack', () => {
  /**
   * The slot service, recorded rather than declared: this file owns only the
   * registrant. `inject` answers the way the real registry does — the callback
   * runs while the declaration is live, and its own return value is the effect's
   * disposer.
   */
  function fakeSlots() {
    const injected: string[] = []
    const callbacks: (() => unknown)[] = []
    const effects: unknown[] = []
    const registrations: { options: { name: string; id: string; order: number }; component: unknown }[] = []
    const disposed: number[] = []
    const slots = {
      inject(slot: string, callback: () => unknown): unknown {
        injected.push(slot)
        callbacks.push(callback)
        const effect = callback()
        effects.push(effect)
        return effect
      },
      register<Props>(
        options: { name: string; id: string; order: number },
        component: (props: Props) => unknown,
      ): () => void {
        const at = registrations.push({ options, component }) - 1
        return () => disposed.push(at)
      },
    }
    return { slots, injected, callbacks, effects, registrations, disposed }
  }

  it('claims one cell of the floating layer and follows the channel', () => {
    vi.stubGlobal('EventSource', FakeSource)
    const fake = fakeSlots()

    toasts.registerToasts({ slots: fake.slots })

    expect(fake.injected).toEqual([toasts.TOASTS_SLOT])
    expect(toasts.TOASTS_SLOT).toBe('shell.overlay')
    expect(fake.registrations.map(({ options }) => options)).toEqual([
      { name: toasts.TOASTS_SLOT, id: toasts.TOASTS_ID, order: toasts.TOASTS_ORDER },
    ])
    expect(FakeSource.live).toHaveLength(1)
  })

  it('hands the layer a component rendering the store its own channel writes into', () => {
    vi.stubGlobal('EventSource', FakeSource)
    const fake = fakeSlots()
    toasts.registerToasts({ slots: fake.slots })

    const component = fake.registrations[0]?.component as () => { props: unknown }
    const element = component()
    const instance = mount(toasts.ToastStack, element.props)
    expect(instance.tree).toBeNull()

    // The first frame is the baseline, however it is labelled; the second is a
    // real change, and it reaches the store this component renders from.
    FakeSource.live[0]?.emit(
      'change',
      frame(1, snapshot(project('/repo/project1', [row('alpha', 'connecting')]))),
    )
    FakeSource.live[0]?.emit(
      'change',
      frame(2, snapshot(project('/repo/project1', [row('alpha', 'active')]))),
    )

    const rows = (instance.tree as { children: unknown[] }).children
    expect(rows).toHaveLength(1)
    expect((rows[0] as { props: { toast: { textKey: string } } }).props.toast.textKey).toBe('toastUp')
  })

  it('leaves one channel and one entry behind when the injection runs again', () => {
    vi.stubGlobal('EventSource', FakeSource)
    const fake = fakeSlots()
    toasts.registerToasts({ slots: fake.slots })
    const again = fake.callbacks[0] as () => unknown

    // The layer's declaration collapsing and coming back runs the callback a
    // second time; because the slot core throws on a duplicate list id, the
    // first activation has to be torn down before the second registers.
    again()

    expect(FakeSource.live).toHaveLength(2)
    expect(FakeSource.live[0]?.closed).toBe(1)
    expect(FakeSource.live[1]?.closed).toBe(0)
    expect(fake.registrations).toHaveLength(2)
    expect(fake.disposed).toEqual([0])
  })

  it('closes the channel and drops the entry when the injection is torn down', () => {
    vi.stubGlobal('EventSource', FakeSource)
    const fake = fakeSlots()
    toasts.registerToasts({ slots: fake.slots })
    const effect = fake.effects[0] as () => void

    effect()

    expect(FakeSource.live[0]?.closed).toBe(1)
    expect(fake.disposed).toEqual([0])
  })
})

describe('the banners the layer renders', () => {
  it('renders toast copy in the active language, and repaints on a switch', () => {
    const { service, setActive } = localeService({ ru: { toastUp: '{server} поднят' } }, 'ru')
    const store = toasts.createToastStore()
    const before = snapshot(project('/repo/project1', [row('tglider', 'connecting')]))
    const after = snapshot(project('/repo/project1', [row('tglider', 'active')]))
    const [draft] = toasts.serverTransitions(before, after)

    // The draft carries a key and parameters, never a finished sentence: the
    // stack resolves them at render, so a stored banner follows the language.
    expect(draft?.textKey).toBe('toastUp')
    if (draft === undefined) throw new Error('a transition to active earns a banner')
    store.push(draft)

    const instance = mount(toasts.ToastStack, { store, locale: service })
    expect(textsOf(instance.tree)).toContain('tglider поднят')

    setActive('en')
    expect(textsOf(instance.tree)).toContain('tglider is up')
  })

  it('renders nothing while there is nothing to say', () => {
    const store = toasts.createToastStore()

    expect(mount(toasts.ToastStack, { store }).tree).toBeNull()
  })

  it('renders the newest banner first, with the level’s own dot', () => {
    const store = toasts.createToastStore()
    store.push({
      level: 'up',
      server: 'alpha',
      project: 'project1',
      textKey: 'toastUp',
      textParams: { server: 'alpha' },
      detail: 'project1',
    })
    store.push({
      level: 'error',
      server: 'beta',
      project: 'project1',
      textKey: 'toastFailed',
      textParams: { server: 'beta' },
    })

    const stack = mount(toasts.ToastStack, { store }).tree as {
      type: unknown
      props: Record<string, unknown>
      children: unknown[]
    }

    expect(stack.type).toBe('div')
    expect(stack.props.role).toBe('status')
    expect(stack.props['aria-live']).toBe('polite')
    expect(stack.props.style).toMatchObject({ pointerEvents: 'none' })
    expect(
      stack.children.map(
        (child) => (child as { props: { toast: { server: string } } }).props.toast.server,
      ),
    ).toEqual(['beta', 'alpha'])
  })

  it('repaints when the channel pushes, and unpaints when the last banner retires', () => {
    const store = toasts.createToastStore()
    const instance = mount(toasts.ToastStack, { store })

    store.push({ level: 'up', server: 'alpha', project: 'project1', textKey: 'toastUp', textParams: { server: 'alpha' } })
    expect((instance.tree as { children: unknown[] }).children).toHaveLength(1)

    store.dismiss(1)
    expect(instance.tree).toBeNull()
  })

  it('leaves a subscriber behind in the store only for as long as it is mounted', () => {
    const store = toasts.createToastStore()
    const instance = mount(toasts.ToastStack, { store })

    unmount(instance)
    store.push({ level: 'up', server: 'alpha', project: 'project1', textKey: 'toastUp', textParams: { server: 'alpha' } })

    expect(instance.tree).toBeNull()
  })

  it('draws the detail line a banner carries', () => {
    const store = toasts.createToastStore()
    store.push({
      level: 'error',
      server: 'alpha',
      project: 'project1',
      textKey: 'toastFailed',
      textParams: { server: 'alpha' },
      detailKey: view.STATUS_HINT.error,
      detail: 'no tool appeared in 60s',
    })
    const [toast] = store.getSnapshot()

    const row = mount(toasts.ToastRow, { toast, store }).tree as { children: unknown[] }
    const body = row.children[1] as { children: unknown[] }

    expect(body.children).toHaveLength(2)
    expect((body.children[1] as { children: unknown }).children).toBe(
      'project1 · no tool appeared in 60s',
    )
  })

  it('prefers a coded detail resolved through the host seat, prose when there is no code (F-48)', () => {
    // A bound host namespace, as the harness answers one: the template with
    // its params on a hit, the key itself on a miss.
    const hostT = (key: string, params?: Record<string, unknown>): string => {
      const table: Record<string, string> = {
        'mount.stalledDetail': '{name}: за {elapsed} нет инструментов\nэндпоинт: {endpoint}',
      }
      const template = table[key] ?? key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
        name in params ? String(params[name]) : whole,
      )
    }
    const store = toasts.createToastStore()
    store.push({
      level: 'error',
      server: 'alpha',
      project: 'project1',
      textKey: 'toastFailed',
      textParams: { server: 'alpha' },
      detailKey: view.STATUS_HINT.error,
      detail: 'no tool appeared in 60s',
      detailCode: 'mount.stalledDetail',
      detailParams: { name: 'alpha', elapsed: '60s', endpoint: 'stdio npx' },
    })
    const [coded] = store.getSnapshot()

    const drawn = mount(toasts.ToastRow, { toast: coded, store, hostT }).tree as { children: unknown[] }
    const body = drawn.children[1] as { children: unknown[] }
    // The translated template wins over the English prose the draft carries.
    expect((body.children[1] as { children: unknown }).children).toContain('за 60s нет инструментов')

    store.push({
      level: 'error',
      server: 'beta',
      project: 'project1',
      textKey: 'toastFailed',
      textParams: { server: 'beta' },
      detailKey: view.STATUS_HINT.error,
      detail: 'no tool appeared in 61s',
    })
    const [uncoded] = store.getSnapshot()
    const plain = mount(toasts.ToastRow, { toast: uncoded, store, hostT }).tree as { children: unknown[] }
    const plainBody = plain.children[1] as { children: unknown[] }
    expect((plainBody.children[1] as { children: unknown }).children).toBe(
      'project1 · no tool appeared in 61s',
    )
  })

  it('draws no detail line for a banner without one', () => {
    const store = toasts.createToastStore()
    store.push({ level: 'up', server: 'alpha', project: 'project1', textKey: 'toastUp', textParams: { server: 'alpha' } })
    const [toast] = store.getSnapshot()

    const row = mount(toasts.ToastRow, { toast, store }).tree as { children: unknown[] }
    const body = row.children[1] as { children: unknown[] }

    expect(body.children).toHaveLength(2)
    expect(body.children[1]).toBeNull()
  })

  it('takes the dot colour from the plugin’s status palette', () => {
    const store = toasts.createToastStore()
    store.push({ level: 'released', server: 'alpha', project: 'project1', textKey: 'toastReleased', textParams: { server: 'alpha' } })
    const [toast] = store.getSnapshot()

    const row = mount(toasts.ToastRow, { toast, store }).tree as { children: unknown[] }
    const dot = row.children[0] as { props: { style: { background: string } } }

    expect(dot.props.style.background).toBe(view.STATUS_COLOR.idle)
  })

  it('holds a banner, fades it, then retires it from the store', () => {
    const store = toasts.createToastStore()
    store.push({ level: 'up', server: 'alpha', project: 'project1', textKey: 'toastUp', textParams: { server: 'alpha' } })
    const [toast] = store.getSnapshot()
    const instance = mount(toasts.ToastRow, { toast, store })

    expect((instance.tree as { props: { style: { opacity?: number } } }).props.style.opacity).toBeUndefined()

    vi.advanceTimersByTime(toasts.TOAST_HOLD_MS)
    expect((instance.tree as { props: { style: { opacity?: number } } }).props.style.opacity).toBe(0)
    expect(store.getSnapshot()).toHaveLength(1)

    vi.advanceTimersByTime(toasts.TOAST_FADE_MS)
    expect(store.getSnapshot()).toEqual([])
  })

  it('drops the pending timer when the layer unmounts a faded banner early', () => {
    const store = toasts.createToastStore()
    store.push({ level: 'up', server: 'alpha', project: 'project1', textKey: 'toastUp', textParams: { server: 'alpha' } })
    const [toast] = store.getSnapshot()
    const instance = mount(toasts.ToastRow, { toast, store })

    vi.advanceTimersByTime(toasts.TOAST_HOLD_MS)
    unmount(instance)
    vi.advanceTimersByTime(toasts.TOAST_FADE_MS * 2)

    expect(store.getSnapshot()).toHaveLength(1)
  })
})
