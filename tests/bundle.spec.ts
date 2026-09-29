/**
 * Load-path guard for the shipped browser half.
 *
 * The web client never `import`s a plugin bundle: it evaluates several of them
 * concatenated into one **classic script** and materializes each through the
 * Lazy-CJS module table (`factory(require)` → exports). This spec replays that
 * exact path against the built `lib/client.js`, so a bundle that would take the
 * whole boot down — ESM syntax, an unresolvable `require`, a missing factory, a
 * drifted registration — fails here instead of in the browser.
 *
 * Build first: `pnpm build`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'lib', 'client.js')

/** `localStorage` key the panel's poll interval is persisted under. */
const REFRESH_STORAGE_KEY = 'dsh-project-mcp:servers:refreshMs'

interface LoadedFactory {
  id?: string
  factory?: (require: (specifier: string) => unknown) => Record<string, unknown>
}

/** Minimal React surface the bundle may `require`, per the platform seed table. */
const react = {
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
    type,
    props: { ...(props as Record<string, unknown>), children },
  }),
  useCallback: (callback: unknown) => callback,
  useEffect: () => undefined,
  // A state hook honours the lazy initializer, so the persisted poll interval is
  // read the way the browser reads it; the setter is a no-op outside a renderer.
  useState: (initial: unknown) => [
    typeof initial === 'function' ? (initial as () => unknown)() : initial,
    () => undefined,
  ],
  Fragment: Symbol('Fragment'),
}

/**
 * A locale service that keeps what it was told.
 *
 * `bind` answers from the registered English table the way the shell's own
 * lookup chain ends in it, so a surface bound through this seat reads real copy
 * rather than raw keys — which is what makes the registry's title assertion here
 * mean something.
 */
function fakeLocale() {
  const calls = { languages: [] as unknown[], dictionaries: [] as string[] }
  const tables = new Map<string, Record<string, string>>()
  return {
    calls,
    tables,
    service: {
      register: (namespace: string, dictionaries: Record<string, Record<string, string>>) => {
        calls.dictionaries.push(namespace)
        tables.set(namespace, dictionaries.en ?? {})
        return () => undefined
      },
      addLanguage: (input: unknown) => {
        calls.languages.push(input)
        return () => undefined
      },
      bind: (namespace: string) => (key: string) => tables.get(namespace)?.[key] ?? key,
    },
  }
}

/**
 * Evaluate the bundle the way the browser does: `window.__ModuleLoader__.load`
 * is the only thing that runs at boot, and it merely registers a factory.
 *
 * The context double is deliberately hostile in the one way the real one is:
 * Cordis serves services as properties of a proxy that **throws**
 * `cannot get property "…" without inject` for a name the fiber did not declare
 * (`vendor/cordis/src/reflect.ts`). Reading an optional service as a property
 * therefore takes the entire web boot down, so this double throws the same way
 * and only answers `get(name)`.
 * @param options - services to leave out of the composition, and the interval
 *   to leave behind in browser storage before `apply` runs.
 * @returns the loaded entry, its exports, the context double and what it recorded.
 */
function load(options: { without?: readonly string[]; refreshMs?: number } = {}) {
  const source = readFileSync(bundlePath, 'utf8')
  const loaded: LoadedFactory[] = []
  const fakeWindow = {
    __ModuleLoader__: { load: (entry: LoadedFactory) => loaded.push(entry) },
  }
  const requests: string[] = []
  const require_ = (specifier: string) => {
    requests.push(specifier)
    if (specifier === 'react') return react
    throw new Error(`the DSH module table cannot supply "${specifier}"`)
  }

  const run = new Function('window', 'require', 'module', 'exports', source)
  run(fakeWindow, require_, { exports: {} }, {})

  expect(loaded).toHaveLength(1)
  const entry = loaded[0] as LoadedFactory
  const exports = entry.factory?.(require_)

  // `apply` registers through `ctx.effect`, which owns the disposer lifecycle.
  const effects: unknown[] = []
  /** Tab types claimed in the right sidebar's registry. */
  const tabs: Record<string, unknown>[] = []
  /** Slot registrations, with the component each one carries. */
  const registrations: { options: Record<string, unknown>; component: unknown }[] = []
  const injected: unknown[][] = []
  const locale = fakeLocale()
  const services: Record<string, unknown> = {
    slots: {
      inject: (_slot: string, callback: () => unknown) => {
        callback()
        return () => undefined
      },
      register: (options: Record<string, unknown>, component: unknown) => {
        registrations.push({ options, component })
        return () => undefined
      },
    },
    sidebarRightTabs: {
      register: (definition: Record<string, unknown>) => {
        tabs.push(definition)
        return () => undefined
      },
    },
    locale: locale.service,
  }
  for (const name of options.without ?? []) delete services[name]

  const strict = <T extends object>(target: T, deps: readonly string[] = []) => new Proxy(target, {
    get: (source, prop, receiver) => {
      if (Reflect.has(source, prop)) return Reflect.get(source, prop, receiver)
      if (typeof prop === 'string' && deps.includes(prop) && services[prop] !== undefined) return services[prop]
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
  const scopeFor = (deps: readonly string[]) => strict({
    effect: (run: () => unknown) => {
      effects.push(run())
    },
    get: (name: string) => services[name],
  }, deps)
  const ctx = strict({
    effect: (run: () => unknown) => {
      effects.push(run())
    },
    // Cordis runs the callback once every declared service exists; each surface
    // is parked behind the services it named.
    inject: (deps: string[], callback: (scope: unknown) => void) => {
      injected.push(deps)
      if (deps.every((name) => services[name] !== undefined)) callback(scopeFor(deps))
    },
    get: (name: string) => services[name],
  })
  const storage = installStorage(
    options.refreshMs === undefined ? {} : { [REFRESH_STORAGE_KEY]: String(options.refreshMs) },
  )
  return { entry, exports, ctx, effects, injected, tabs, registrations, requests, locale, storage }
}

/** An in-memory `localStorage`, removed by {@link uninstallStorage}. */
function installStorage(values: Record<string, string>) {
  const store: Record<string, string> = { ...values }
  Reflect.set(globalThis, 'localStorage', {
    getItem: (key: string): string | null => store[key] ?? null,
    setItem: (key: string, value: string): void => {
      store[key] = value
    },
  })
  return {
    values: store,
    uninstall: () => Reflect.deleteProperty(globalThis, 'localStorage'),
  }
}

/** Run `apply` and clean up the browser-local storage every run installs. */
function applyBundle(composition: ReturnType<typeof load>): void {
  try {
    ;(composition.exports?.apply as (ctx: unknown) => void)(composition.ctx)
  } finally {
    composition.storage.uninstall()
  }
}

describe.skipIf(!existsSync(bundlePath))('lib/client.js load path', () => {
  it('registers a factory under the package name', () => {
    const { entry, exports, requests } = load()

    expect(entry.id).toBe('dsh-project-mcp')
    expect(exports?.name).toBe('dsh-project-mcp')
    expect(exports?.inject).toEqual([])
    expect(typeof exports?.apply).toBe('function')
    // Only baseline modules may be requested; anything else throws mid-load.
    // The plugin reaches every service through `ctx`, so `react` is the whole
    // list — and the smallest possible surface for this bundle to break on.
    expect([...new Set(requests)]).toEqual(['react'])
  })

  it('parks the tab, the settings page and the toast stack behind the services they need', () => {
    const composition = load()
    applyBundle(composition)

    // Every service is optional; this plugin must not force-load another
    // plugin's bundle during web boot, and must not gate the entry on any of
    // them either.
    expect(composition.exports?.inject).toEqual([])
    expect(composition.tabs).toHaveLength(1)
    // Each surface waits only for what it needs: the tab type and its three
    // seats for the slot registry plus the right sidebar's tab registry, the
    // settings page for the slot registry plus the locale, the configuration
    // card (F-54) for the same pair plus `configForms` — in an inject of its
    // own, so the settings tab never depends on it — and the toast stack for the
    // same pair again: the locale seat is what lets a language switch repaint
    // the banners on screen.
    expect(composition.injected).toEqual([
      ['slots', 'sidebarRightTabs'],
      ['slots', 'locale'],
      ['slots', 'locale', 'configForms'],
      ['slots', 'locale'],
    ])
  })

  it('keeps the browser half bootable without the right sidebar', () => {
    const composition = load({ without: ['sidebarRightTabs'] })
    applyBundle(composition)

    // No tab type and no sidebar seat: the three surfaces that do not need a
    // sidebar — the settings page, its configuration card and the toast stack —
    // register exactly as before, and the dictionaries still land.
    expect(composition.tabs).toHaveLength(0)
    expect(composition.registrations).toHaveLength(2)
    expect(composition.effects).toHaveLength(3)
    expect(composition.locale.calls.dictionaries).toHaveLength(2)
  })

  it('reads every optional service through ctx.get, so an undeclared one cannot throw', () => {
    const composition = load()

    // The proxy above is the real rule: any other property read throws. `apply`
    // completing proves every optional service went through `get`.
    expect(() => {
      applyBundle(composition)
    }).not.toThrow()
  })

  it('claims one tab type, one body, one menu row, one popup and the two other surfaces', () => {
    const composition = load()
    applyBundle(composition)

    expect(composition.effects).toHaveLength(4)

    const descriptor = composition.tabs[0] as Record<string, unknown>
    expect(descriptor.id).toBe('dsh-project-mcp:servers')
    expect(descriptor.kind).toBe('project-mcp')
    // The host renders a guide description only while the guide lists few enough
    // entries. The copy is read without a locale service binding here, so it is
    // the panel's English table; `tests/tab-locale.spec.ts` covers the bound seat.
    expect((descriptor.title as (address: string) => string)('')).toBe('Project MCP')
    const guide = descriptor.guide as { order: number; title: () => string; description: () => string }[]
    expect(guide).toHaveLength(1)
    expect(guide[0]?.order).toBe(55)
    expect(guide[0]?.title()).toBe('Project MCP')
    expect(guide[0]?.description()).toBe(
      'MCP servers each project declares, and what is mounted for its sessions',
    )

    expect(composition.registrations.map((entry) => entry.options.name)).toEqual([
      'sidebar.right.pane.tab',
      'sidebar.right.pane.tab.title',
      'sidebar.right.tab.menu.item',
      'shell.overlay',
      'settings.section',
      'shell.overlay',
    ])
    expect(composition.registrations[0]?.options).toEqual({
      name: 'sidebar.right.pane.tab',
      key: 'dsh-project-mcp:servers',
    })
    expect(composition.registrations[1]?.options).toEqual({
      name: 'sidebar.right.pane.tab.title',
      key: 'dsh-project-mcp:servers',
    })
    expect(composition.registrations[2]?.options).toMatchObject({ id: 'dsh-project-mcp:settings' })
    expect(composition.registrations[3]?.options).toMatchObject({ id: 'dsh-project-mcp:settings-dialog' })
    expect(composition.registrations[4]?.options).toMatchObject({ id: 'dsh-project-mcp' })
    expect(composition.registrations[5]?.options).toMatchObject({ id: 'dsh-project-mcp:toasts' })
    expect('locale' in composition.ctx).toBe(false)
  })

  it('renders the panel without polling while the tab is hidden', () => {
    const composition = load({ refreshMs: 1_500 })
    applyBundle(composition)

    const body = composition.registrations[0]?.component as (props: unknown) => {
      type: (props: unknown) => unknown
      props: unknown
    }
    const adapter = body({
      sessionId: 's1',
      useTabInfo: () => ({ tab: { visible: false } }),
    })
    const element = adapter.type(adapter.props) as {
      type: unknown
      props: Record<string, unknown>
    }

    // The body composes the panel with the shell's translate seat, so the tab's
    // copy can follow the language preference — and it still renders when the
    // composition has no locale service, falling back to English.
    expect(element.type).toBe(composition.exports?.LocalizedPanel)
    // The poll interval now comes from browser storage rather than from a
    // sidebar-owned settings blob: the panel reads it, no service needed.
    expect(element.props.refreshMs).toBe(1_500)
    expect(element.props.visible).toBe(false)
    expect(element.props.sessionId).toBe('s1')
  })

  it('hands the settings popup the live interval and a writer that persists it', () => {
    const composition = load({ refreshMs: 1_500 })
    applyBundle(composition)

    const entry = composition.registrations[3]?.component as (props: unknown) => {
      type: (props: unknown) => unknown
      props: {
        store: { open(): void; isOpen(): boolean; close(): void }
        settings: (props: unknown) => unknown
      }
    }
    const dialog = entry({})
    // Closed at rest: the floating layer holds an empty cell until the menu row
    // opens the store.
    expect(dialog.props.store.isOpen()).toBe(false)
    expect(dialog.type(dialog.props)).toBeNull()

    dialog.props.store.open()
    const tree = dialog.type(dialog.props)
    const panel = elementsOf(tree).find(
      (element) => element.type === composition.exports?.LocalizedSettings,
    )
    expect(panel).toBeDefined()
    if (panel === undefined) throw new Error('the popup drew no settings panel')

    expect(panel.props.refreshMs).toBe(1_500)
    expect(panel.props.onClose).toBeTypeOf('function')
    // The writer the popup is handed is the shared store's, and it persists
    // before it publishes: the interval survives a reload.
    ;(panel.props.onRefreshMs as (value: number) => void)(4_000)
    expect(Reflect.get(composition.storage.values, REFRESH_STORAGE_KEY)).toBe('4000')
  })
})

/** Every element in a tree the bundled `createElement` built, the root included. */
function elementsOf(node: unknown): { type: unknown; props: Record<string, unknown> }[] {
  if (node === null || node === undefined || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap((child) => elementsOf(child))
  const element = node as { type: unknown; props: { children?: unknown } }
  const children = Array.isArray(element.props?.children) ? element.props.children : []
  return [
    element as { type: unknown; props: Record<string, unknown> },
    ...children.flatMap((child) => elementsOf(child)),
  ]
}
