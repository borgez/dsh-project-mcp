/**
 * Load-path guard for the shipped browser half.
 *
 * The web client never `import`s a plugin bundle: it evaluates several of them
 * concatenated into one **classic script** and materializes each through the
 * Lazy-CJS module table (`factory(require)` → exports). This spec replays that
 * exact path against the built `lib/client.js`, so a bundle that would take the
 * whole boot down — ESM syntax, an unresolvable `require`, a missing factory, a
 * drifted descriptor — fails here instead of in the browser.
 *
 * Build first: `pnpm build`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'lib', 'client.js')

interface LoadedFactory {
  id?: string
  factory?: (require: (specifier: string) => unknown) => Record<string, unknown>
}

/** Minimal React surface the bundle may `require`, per the platform seed table. */
const react = {
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
    type,
    props,
    children,
  }),
  useCallback: (callback: unknown) => callback,
  useEffect: () => undefined,
  // The seat's lazy initializer is honoured so the descriptor's own copy is read
  // the way the browser reads it; the setter is a no-op outside a renderer.
  useState: (initial: unknown) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => undefined],
  Fragment: Symbol('Fragment'),
}

/** A `SidebarStore`-shaped snapshot with this descriptor's settings blob. */
function snapshotWith(settings: Record<string, unknown>) {
  return { sessionId: 's1', state: undefined, prefs: { pluginSettings: { 'dsh-project-mcp:servers': settings } } }
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
 * @param settings - persisted plugin settings handed to the panel through prefs.
 */
function load(settings: Record<string, unknown> = {}) {
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
  const registered: Record<string, unknown>[] = []
  const injected: unknown[][] = []
  const services: Record<string, unknown> = {
    betterSidebar: {
      registerTab: (descriptor: Record<string, unknown>) => {
        registered.push(descriptor)
        return () => undefined
      },
      getSnapshot: () => snapshotWith(settings),
    },
  }
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
    // Cordis runs the callback once every declared service exists; the tab's
    // registration is parked behind the one service it needs.
    inject: (deps: string[], callback: (scope: unknown) => void) => {
      injected.push(deps)
      if (deps.every((name) => services[name] !== undefined)) callback(scopeFor(deps))
    },
    get: (name: string) => services[name],
  })
  return { entry, exports, ctx, services, effects, injected, registered, requests }
}

describe.skipIf(!existsSync(bundlePath))('lib/client.js load path', () => {
  it('registers a factory under the package name', () => {
    const { entry, exports, requests } = load()

    expect(entry.id).toBe('dsh-project-mcp')
    expect(exports?.name).toBe('dsh-project-mcp')
    expect(exports?.inject).toEqual([])
    expect(typeof exports?.apply).toBe('function')
    // Only baseline modules may be requested; anything else throws mid-load.
    // The plugin reaches the slot service through `ctx.slots`, so `react` is the
    // whole list — and the smallest possible surface for this bundle to break on.
    expect([...new Set(requests)]).toEqual(['react'])
  })

  it('parks the tab, the settings page and the toast stack behind the services they need', () => {
    const { exports, ctx, injected, registered } = load()
    ;(exports?.apply as (ctx: unknown) => void)(ctx)

    // The sidebar service is optional; this plugin must not force-load the
    // incompatible sidebar bundle during web boot, and must not gate the entry
    // on it either.
    expect(exports?.inject).toEqual([])
    expect(registered).toHaveLength(1)
    // Each surface waits only for what it needs: the tab for the sidebar, the
    // settings page for the slot registry plus the locale, the configuration
    // card (F-54) for the same pair plus `configForms` — in an inject of its
    // own, so the settings tab never depends on it — and the toast stack for
    // the same pair again: the locale seat is what lets a language switch
    // repaint the banners on screen.
    expect(injected).toEqual([
      ['betterSidebar'],
      ['slots', 'locale'],
      ['slots', 'locale', 'configForms'],
      ['slots', 'locale'],
    ])
  })

  it('keeps the browser half bootable without the optional sidebar service', () => {
    const { exports, ctx, services, effects, registered } = load()
    delete services.betterSidebar

    ;(exports?.apply as (ctx: unknown) => void)(ctx)

    expect(effects).toHaveLength(0)
    expect(registered).toHaveLength(0)
  })

  it('reads the optional sidebar through ctx.get, so an undeclared service cannot throw', () => {
    const { exports, ctx } = load()

    // The proxy above is the real rule: any other property read throws. `apply`
    // completing proves every optional service went through `get`.
    expect(() => {
      ;(exports?.apply as (ctx: unknown) => void)(ctx)
    }).not.toThrow()
  })

  it('registers exactly one tab descriptor and disposes it through ctx.effect', () => {
    const { exports, ctx, effects, registered } = load()
    ;(exports?.apply as (ctx: unknown) => void)(ctx)

    expect(registered).toHaveLength(1)
    expect(effects).toHaveLength(1)

    const descriptor = registered[0] as Record<string, unknown>
    expect(descriptor.id).toBe('dsh-project-mcp:servers')
    expect(descriptor.order).toBe(55)
    expect(descriptor.single).toBe(true)
    // The host renders descriptions only while the guide lists ≤ 4 entries.
    // The descriptor's own copy is read without a locale service here, so it is
    // the panel's English table; `tests/tab-locale.spec.ts` covers the bound seat.
    expect((descriptor.title as () => string)()).toBe('Project MCP')
    expect((descriptor.description as () => string)()).toBe(
      'MCP servers each project declares, and what is mounted for its sessions',
    )
    // Without a locale service in the composition the tab's own English table
    // answers; `tests/tab-locale.spec.ts` covers the bound seat.
    expect('locale' in ctx).toBe(false)

    const settings = descriptor.settings as {
      pluginToggles: Record<string, unknown>[]
      render: (props: Record<string, unknown>) => unknown
    }
    expect(settings.pluginToggles.map((row) => row.key)).toEqual(['refreshMs'])
    expect(typeof settings.render).toBe('function')
    expect(typeof descriptor.component).toBe('function')
  })

  it('renders the panel without polling while the tab is hidden', () => {
    const { exports, ctx, registered } = load({ refreshMs: 1_500 })
    ;(exports?.apply as (ctx: unknown) => void)(ctx)

    const descriptor = registered[0] as Record<string, unknown>
    const element = (
      descriptor.component as (props: Record<string, unknown>) => {
        type: unknown
        props: Record<string, any>
      }
    )({
      ctx,
      store: {},
      scope: { sessionId: 's1' },
      tab: { id: 'dsh-project-mcp:servers' },
      visible: false,
    })

    // The descriptor composes the panel with the shell's translate seat, so the
    // tab's copy can follow the language preference — and it still renders when
    // the composition has no locale service, falling back to English.
    expect(element.type).toBe(exports?.LocalizedPanel)
    expect(element.props.locale).toBeUndefined()
    // The poll interval travels from `prefs.pluginSettings[TAB_ID]` into the
    // panel as a plain prop — no settings read inside render code.
    expect(element.props.refreshMs).toBe(1_500)
    expect(element.props.visible).toBe(false)
    expect(element.props.sessionId).toBe('s1')
  })

  it('hands the settings popup this descriptor’s own blob', () => {
    const { exports, ctx, registered } = load()
    ;(exports?.apply as (ctx: unknown) => void)(ctx)

    const settings = (registered[0] as Record<string, unknown>).settings as {
      render: (props: Record<string, unknown>) => { props: { pluginSettings: unknown } }
    }
    // `settings.render` receives the blob itself, not the whole prefs document.
    const rendered = settings.render({
      pluginSettings: { refreshMs: 1_500 },
      updatePluginSetting: () => undefined,
      close: () => undefined,
    })

    expect(rendered.props.pluginSettings).toEqual({ refreshMs: 1_500 })
  })
})
