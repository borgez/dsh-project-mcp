/**
 * The plugin's own configuration card (F-54): the served values, the edit and
 * reset paths, and every quiet state (loading, unavailable, read-only).
 *
 * Same discipline as `settings.spec.ts`: plain React element trees, no DOM and
 * no renderer. The card's hooks are the difference — `useSyncExternalStore`,
 * `useMemo` and the per-control drafts — so the walk below keeps hook cells per
 * component instance (keyed by the component's name and its path in the tree)
 * instead of answering every hook with its first render. That lets a test
 * invoke a control's handler and then re-walk the tree to read the state the
 * handler produced, which is how "an invalid draft never reaches the form" is
 * checked without a browser.
 */

import { describe, expect, it } from 'vitest'
import * as React from 'react'
import { PACKAGE_NAME } from '../src/shared.ts'
import { NS } from '../src/client/settings.ts'
import { PluginConfigCard, registerPluginConfigCard, translateOf } from '../src/client/plugin-config.ts'
import type {
  ConfigFormLike,
  ConfigFormSnapshotLike,
  ConfigFormsLike,
  PluginConfigSlotServices,
} from '../src/client/plugin-config.ts'

const t = translateOf(undefined)

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

/** React's current-dispatcher holder: the seam `react-test-renderer` itself uses. */
function dispatcherHolder(): { current: unknown } {
  const internals = (React as unknown as {
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: {
      ReactCurrentDispatcher: { current: unknown }
    }
  }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  return internals.ReactCurrentDispatcher
}

/**
 * The dispatcher one component instance gets: hook cells in invocation order.
 * `useState` setters write their cell, `useMemo`/`useCallback` compute inline,
 * effects never run (nothing here depends on one), and the external store
 * answers its snapshot directly — the walk re-reads it on every pass, exactly
 * like a re-render would.
 */
function dispatcherOf(cells: unknown[]): Record<string, unknown> {
  let cursor = 0
  return {
    useState: (initial?: unknown): [unknown, (value: unknown) => void] => {
      const index = cursor++
      if (!(index in cells)) {
        cells[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
      }
      const set = (value: unknown): void => {
        cells[index] =
          typeof value === 'function' ? (value as (previous: unknown) => unknown)(cells[index]) : value
      }
      return [cells[index], set]
    },
    useRef: (initial?: unknown): { current: unknown } => ({ current: initial }),
    useEffect: (): void => undefined,
    useLayoutEffect: (): void => undefined,
    useMemo: (create: () => unknown): unknown => create(),
    useCallback: (create: unknown): unknown => create,
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown): unknown => getSnapshot(),
  }
}

/**
 * A re-renderable walk: hook state lives in {@link instances} keyed by the
 * component's name and tree path, so invoking a handler and walking again is a
 * re-render. One renderer per test keeps the cells from leaking between cases.
 */
function createRenderer(): { render: (node: unknown) => unknown } {
  const instances = new Map<string, unknown[]>()

  function walkTree(node: unknown, path: string): unknown {
    if (Array.isArray(node)) return node.map((child, index) => walkTree(child, `${path}/${index}`))
    if (node === null || typeof node !== 'object') return node
    const element = node as Element
    if (typeof element.type === 'function') {
      const component = element.type as (props: Record<string, unknown>) => unknown
      const key = `${component.name}@${path}`
      let cells = instances.get(key)
      if (cells === undefined) {
        cells = []
        instances.set(key, cells)
      }
      const holder = dispatcherHolder()
      const previous = holder.current
      holder.current = dispatcherOf(cells)
      let output: unknown
      try {
        output = component(element.props)
      } finally {
        holder.current = previous
      }
      return walkTree(output, path)
    }
    const children = element.props.children
    const walked = Array.isArray(children)
      ? children.map((child, index) => walkTree(child, `${path}/${index}`))
      : walkTree(children, `${path}/0`)
    return { type: element.type, props: { ...element.props, children: walked } }
  }

  return { render: (node) => walkTree(node, '') }
}

/**
 * The served form, faked: a snapshot the card reads, a log of writes, and
 * synchronous notifications so a write is visible to the next render.
 */
class FakeForm implements ConfigFormLike {
  snapshot: ConfigFormSnapshotLike
  readonly sets: Array<readonly [string, unknown]> = []
  readonly unsets: string[] = []
  private readonly listeners = new Set<() => void>()

  constructor(overrides: Partial<ConfigFormSnapshotLike> = {}) {
    this.snapshot = {
      status: 'ready',
      value: {},
      user: {},
      writable: true,
      ...overrides,
    }
  }

  getSnapshot(): ConfigFormSnapshotLike {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async set(field: string, value: unknown): Promise<boolean> {
    this.sets.push([field, value])
    return true
  }

  async unset(field: string): Promise<boolean> {
    this.unsets.push(field)
    return true
  }
}

/** The card element for a case, with only what the case cares about overridden. */
function cardOf(overrides: Record<string, unknown> = {}): unknown {
  return React.createElement(PluginConfigCard, { view: 'page', t, ...overrides })
}

/** The one input or switch whose accessible label is exactly this. */
function labeled(tree: unknown, label: string): Element {
  const found = elements(tree).filter((element) => element.props['aria-label'] === label)
  expect(found).toHaveLength(1)
  return found[0] as Element
}

describe('plugin config card', () => {
  it('renders the served values, falling back to the defaults', () => {
    const form = new FakeForm({ value: { activationSeeded: 12 } })
    const tree = createRenderer().render(cardOf({ form }))

    expect(texts(tree)).toContain('Tool activation')
    expect(texts(tree)).toContain('Seeded tools')
    expect(texts(tree)).toContain('Runtime')
    // The served value wins for activationSeeded; the mirrored default fills in
    // the fields the snapshot carries no value for.
    expect(labeled(tree, 'Seeded tools').props.value).toBe('12')
    expect(labeled(tree, 'Calls to pin').props.value).toBe('1')
    expect(labeled(tree, 'Tool activation').props['aria-checked']).toBe(true)
    expect(labeled(tree, 'Global writes').props['aria-checked']).toBe(false)
  })

  it('commits a boolean through the switch', () => {
    const form = new FakeForm()
    const tree = createRenderer().render(cardOf({ form }))

    const toggle = labeled(tree, 'Tool activation')
    ;(toggle.props.onClick as () => void)()

    expect(form.sets).toEqual([['activationEnabled', false]])
  })

  it('never writes an out-of-range number, and says so', () => {
    const form = new FakeForm()
    const renderer = createRenderer()
    let tree = renderer.render(cardOf({ form }))

    ;(labeled(tree, 'Auto-activation limit').props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: '999' },
    })
    // React flushes the draft state before the next gesture: re-render, then blur.
    tree = renderer.render(cardOf({ form }))
    ;(labeled(tree, 'Auto-activation limit').props.onBlur as (event: { target: { value: string } }) => void)({
      target: { value: '999' },
    })

    expect(form.sets).toEqual([])

    tree = renderer.render(cardOf({ form }))
    const after = labeled(tree, 'Auto-activation limit')
    expect(after.props['aria-invalid']).toBe(true)
    expect(texts(tree)).toContain('Enter a whole number between 0 and 50')
  })

  it('commits a valid number on blur', () => {
    const form = new FakeForm()
    const renderer = createRenderer()
    let tree = renderer.render(cardOf({ form }))

    ;(labeled(tree, 'Auto-activation limit').props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: '30' },
    })
    tree = renderer.render(cardOf({ form }))
    ;(labeled(tree, 'Auto-activation limit').props.onBlur as (event: { target: { value: string } }) => void)({
      target: { value: '30' },
    })

    expect(form.sets).toEqual([['activationAutoLimit', 30]])
  })

  it('writes nothing on a blur with no edit', () => {
    const form = new FakeForm()
    const renderer = createRenderer()
    const tree = renderer.render(cardOf({ form }))

    // Tabbing through the page: blur fires with the displayed snapshot value
    // and no prior edit — the host must not see a write.
    const input = labeled(tree, 'Auto-activation limit')
    expect(input.props.value).toBe('12')
    ;(input.props.onBlur as (event: { target: { value: string } }) => void)({ target: { value: '12' } })

    expect(form.sets).toEqual([])
  })

  it('commits an Enter edit exactly once when blur follows before the snapshot lands', () => {
    const form = new FakeForm()
    const renderer = createRenderer()
    let tree = renderer.render(cardOf({ form }))

    const input = labeled(tree, 'Auto-activation limit')
    ;(input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: '30' } })
    tree = renderer.render(cardOf({ form }))
    ;(labeled(tree, 'Auto-activation limit').props.onKeyDown as (event: { key: string }) => void)({ key: 'Enter' })
    expect(form.sets).toEqual([['activationAutoLimit', 30]])

    // The host round-trip has not landed yet: the commit cleared the draft, so
    // the input shows the OLD snapshot value again. A blur in this window must
    // not commit that stale value over the write that is still in flight.
    tree = renderer.render(cardOf({ form }))
    const stale = labeled(tree, 'Auto-activation limit')
    expect(stale.props.value).toBe('12')
    ;(stale.props.onBlur as (event: { target: { value: string } }) => void)({ target: { value: '12' } })

    expect(form.sets).toEqual([['activationAutoLimit', 30]])
  })

  it('rejects a prefix outside the shape rule, accepts an empty one', () => {
    const form = new FakeForm()
    const renderer = createRenderer()
    let tree = renderer.render(cardOf({ form }))

    const input = labeled(tree, 'Local prefix')
    ;(input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'a b' } })
    tree = renderer.render(cardOf({ form }))
    ;(labeled(tree, 'Local prefix').props.onBlur as (event: { target: { value: string } }) => void)({
      target: { value: 'a b' },
    })
    expect(form.sets).toEqual([])

    tree = renderer.render(cardOf({ form }))
    expect(labeled(tree, 'Local prefix').props['aria-invalid']).toBe(true)

    ;(labeled(tree, 'Local prefix').props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: '' },
    })
    tree = renderer.render(cardOf({ form }))
    ;(labeled(tree, 'Local prefix').props.onBlur as (event: { target: { value: string } }) => void)({
      target: { value: '' },
    })
    expect(form.sets).toEqual([['localPrefix', '']])
  })

  it('offers reset only for fields the user layer overrides', () => {
    const form = new FakeForm({ user: { activationSeeded: 12 } })
    const tree = createRenderer().render(cardOf({ form }))

    expect(texts(tree)).toContain('overridden')
    const reset = labeled(tree, 'Reset: Seeded tools')
    expect(elements(tree).some((element) => element.props['aria-label'] === 'Reset: Calls to pin')).toBe(false)

    ;(reset.props.onClick as () => void)()
    expect(form.unsets).toEqual(['activationSeeded'])
    expect(form.sets).toEqual([])
  })

  it('renders the quiet note while the form is unavailable or loading', () => {
    const unavailable = createRenderer().render(cardOf({ form: new FakeForm({ status: 'unavailable' }) }))
    expect(texts(unavailable)).toContain('The host does not serve this plugin’s configuration to this client.')

    const loading = createRenderer().render(cardOf({ form: new FakeForm({ status: 'loading' }) }))
    expect(texts(loading)).toContain('Loading the configuration…')
  })

  it('renders the quiet note when the form prop is absent or unusable', () => {
    const absent = createRenderer().render(cardOf({ form: undefined }))
    expect(texts(absent)).toContain('The host does not serve this plugin’s configuration to this client.')

    const throwing = createRenderer().render(
      cardOf({
        form: (): never => {
          throw new Error('no session')
        },
      }),
    )
    expect(texts(throwing)).toContain('The host does not serve this plugin’s configuration to this client.')
  })

  it('resolves the injected factory face to the form', () => {
    const form = new FakeForm()
    const tree = createRenderer().render(cardOf({ form: () => form }))

    expect(texts(tree)).toContain('Tool activation')
    expect(labeled(tree, 'Tool activation').props['aria-checked']).toBe(true)
  })

  it('keeps the summary view to one line', () => {
    const tree = createRenderer().render(cardOf({ view: 'summary', form: new FakeForm() }))

    expect(texts(tree)).toEqual(['Edit this plugin’s activation and runtime configuration'])
  })

  it('disables every control while the form is read-only', () => {
    const form = new FakeForm({ writable: false, user: { activationSeeded: 12 } })
    const tree = createRenderer().render(cardOf({ form }))

    expect(texts(tree)).toContain('This client keeps its preferences process-local, so these values are read-only here.')
    const switches = elements(tree).filter((element) => element.props.role === 'switch')
    expect(switches.length).toBeGreaterThan(0)
    for (const control of switches) expect(control.props.disabled).toBe(true)
    const inputs = elements(tree).filter((element) => element.type === 'input')
    for (const input of inputs) expect(input.props.disabled).toBe(true)
    // The reset affordance is disabled too — read-only means no writes at all.
    expect(labeled(tree, 'Reset: Seeded tools').props.disabled).toBe(true)
  })
})

describe('plugin config registration', () => {
  /**
   * The registration parked on the fake services: `effect` runs immediately,
   * `whileServed` and the slot registry record what they are asked for.
   */
  function parked(served: ReadonlySet<string>): {
    registrations: Array<{ options: Record<string, unknown>; component: unknown }>
    watched: string[][]
    forms: ConfigFormsLike & { wanted: string[] }
    run: () => unknown
  } {
    const registrations: Array<{ options: Record<string, unknown>; component: unknown }> = []
    const watched: string[][] = []
    const wanted: string[] = []
    let register: ((set: ReadonlySet<string>) => () => void) | undefined
    const forms: ConfigFormsLike & { wanted: string[] } = {
      wanted,
      get<T>(namespace: string): ConfigFormLike {
        wanted.push(namespace)
        return new FakeForm()
      },
      whileServed(namespaces: readonly string[], cb: (set: ReadonlySet<string>) => () => void): () => void {
        watched.push([...namespaces])
        register = cb
        return () => undefined
      },
    }
    const services: PluginConfigSlotServices = {
      effect: (execute: () => unknown) => execute(),
      slots: {
        inject: (_slot: string, callback: () => unknown) => callback(),
        register: (options: Record<string, unknown>, component: unknown) => {
          registrations.push({ options, component })
        },
      },
      configForms: forms,
    }
    registerPluginConfigCard(services)
    if (register === undefined) throw new Error('whileServed never received its register callback')
    return { registrations, watched, forms, run: () => register?.(served) }
  }

  it('registers a keyed entry behind both namespaces, preferring the plugin’s own', () => {
    const both = parked(new Set(['dsh-project-mcp', 'project-mcp']))
    both.run()

    expect(both.watched).toEqual([['dsh-project-mcp', 'project-mcp']])
    expect(both.registrations).toHaveLength(1)
    const { options } = both.registrations[0] as { options: Record<string, unknown> }
    expect(options.name).toBe('plugins.bundle.config')
    expect(options.key).toBe(PACKAGE_NAME)
    expect(options.locale).toBe(NS)
    const face = (options.inject as () => { form: () => unknown })()
    expect(typeof face.form).toBe('function')
    face.form()
    expect(both.forms.wanted).toEqual(['dsh-project-mcp'])

    const legacy = parked(new Set(['project-mcp']))
    legacy.run()
    ;((legacy.registrations[0] as { options: Record<string, unknown> }).options.inject as () => {
      form: () => unknown
    })().form()
    expect(legacy.forms.wanted).toEqual(['project-mcp'])
  })

  it('renders the card component the registration hands the slot', () => {
    const { registrations, run } = parked(new Set(['dsh-project-mcp']))
    run()
    const { component } = registrations[0] as { component: (props: Record<string, unknown>) => unknown }
    const tree = createRenderer().render(component({ view: 'page', form: () => new FakeForm(), t }))
    expect(texts(tree)).toContain('Tool activation')
  })
})
