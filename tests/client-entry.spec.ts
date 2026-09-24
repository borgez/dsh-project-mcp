/**
 * Entry wiring of the browser half (`src/client/index.ts`).
 *
 * Every other client test drives one surface — the panel, the settings page,
 * the translate seat, the toast stack — but nothing checked that **this** module
 * composes them the way the shell calls it: one sidebar tab through
 * `dsh-better-sidebar`, inside `ctx.inject`, one page through `slots` + `locale`
 * behind its own `ctx.inject`, and one frame-wide toast stack behind the slot
 * registry alone. That wiring is what registers the surfaces, so it is driven
 * here against a fake client context whose `ctx.inject` mirrors Cordis: a
 * callback runs at once when every service it names is provided, and is parked
 * until then when one is missing — so both a settled composition and a locale
 * service that arrives after activation are driven honestly.
 *
 * React is mocked at the module boundary — the same technique
 * `tests/tab-translate.spec.ts` uses — so the element trees the entry builds are
 * plain objects: nothing is rendered and there is no DOM. Two `createElement`
 * callbacks the entry hands to the sidebar are invoked to check the props they
 * carry; the two localized surfaces are invoked as functions for the same
 * reason.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { TabDescriptor } from 'dsh-better-sidebar'
import { LocalizedPanel, LocalizedSettings, apply, inject, name } from '../src/client/index.ts'
import { NS, SETTINGS_SLOT } from '../src/client/settings.ts'
import { NS_HOST } from '../src/client/locales/host.ts'
import { TOASTS_ID, TOASTS_ORDER, TOASTS_SLOT } from '../src/client/toasts.ts'
import {
  DEFAULT_REFRESH_MS,
  ProjectMcpPanel,
  ProjectMcpSettings,
  REFRESH_KEY,
} from '../src/client/view.ts'
import type { Translate } from '../src/client/view.ts'
import { PACKAGE_NAME, TAB_ID } from '../src/shared.ts'
import { RU, localeService } from './helpers/locale.ts'

/** Mutable stand-ins for the hooks the surfaces call, so no renderer is needed. */
vi.mock('react', () => ({
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
  useCallback: (callback: unknown) => callback,
  // An element is built once and never re-rendered here, so the initial value
  // is the whole state: a fresh read per call is what the first render sees.
  useState: <T,>(initial: T | (() => T)): [T, (next: T) => void] => [
    typeof initial === 'function' ? (initial as () => T)() : initial,
    () => undefined,
  ],
  useEffect: () => undefined,
}))

/** A React element as the mocked `createElement` builds it. */
interface FakeElement {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

/** The props `index.ts` reads off `TabComponentProps` for the tab body. */
interface PanelCallbackProps {
  visible: boolean
  scope: { sessionId: string | undefined }
}

/** The props `index.ts` reads off the settings popup's render seat. */
interface SettingsCallbackProps {
  pluginSettings: Record<string, unknown>
  updatePluginSetting: (key: string, value: unknown) => void
  close: () => void
}

/**
 * Options a registration carries, as this file records them.
 *
 * The settings page adds a `locale` and an `inject` face; the toast stack claims
 * a plain list cell and declares neither, so the recorded shape is the part both
 * have.
 */
interface RecordedRegistration {
  name: string
  id: string
  order: number
  label?: (() => string) | undefined
}

/** One `locale.register` call: the namespace and the per-language tables it carried. */
interface RecordedDictionary {
  namespace: string
  tables: Record<string, Record<string, string>>
}

/** One `locale.addLanguage` call: a language the shell does not ship. */
interface RecordedLanguage {
  id: string
  label: string
  fallback: string
}

/**
 * A composition of fake client services.
 *
 * `ctx.inject` mirrors Cordis honestly: the callback runs at once when every
 * named service is already provided, and is parked otherwise until {@link provide}
 * hands the missing one in — a composition settled at apply time behaves as it
 * always did, while a spec can arrive a service late and watch the parked
 * callback fire exactly once.
 */
function fakeComposition(
  options: {
    locale?: unknown
    pluginSettings?: Record<string, unknown>
    /** Services provided from the start; defaults to all three. */
    services?: readonly string[]
  } = {},
) {
  const recorded = {
    /** Name lists `ctx.inject` was called with, in call order. */
    injects: [] as string[][],
    /** Slot keys `services.slots.inject` was called with. */
    slotInjects: [] as string[],
    /** Effect labels, in call order; `undefined` for the unlabelled one. */
    effectLabels: [] as (string | undefined)[],
    /** Languages the entry named to the shell through `addLanguage`. */
    languages: [] as RecordedLanguage[],
    tabs: [] as TabDescriptor[],
    registrations: [] as RecordedRegistration[],
    components: [] as unknown[],
    namespaces: [] as string[],
    dictionaries: [] as RecordedDictionary[],
  }
  const disposers: unknown[] = []

  const betterSidebar = {
    registerTab: (descriptor: TabDescriptor): (() => void) => {
      recorded.tabs.push(descriptor)
      return () => undefined
    },
    getSnapshot: () => ({
      prefs: { pluginSettings: { [TAB_ID]: options.pluginSettings ?? {} } },
    }),
  }

  const slots = {
    inject: (slot: string, callback: () => unknown) => {
      recorded.slotInjects.push(slot)
      // The slot is declared by the settings section at runtime; this fake has
      // it declared, so the registration that would throw on an undeclared slot
      // runs now.
      callback()
      return () => undefined
    },
    register: (registration: RecordedRegistration, component: unknown) => {
      recorded.registrations.push(registration)
      recorded.components.push(component)
      return () => undefined
    },
  }

  const settingsLocale = {
    register: (namespace: string, tables: Record<string, Record<string, string>>) => {
      recorded.namespaces.push(namespace)
      recorded.dictionaries.push({ namespace, tables })
      return () => undefined
    },
    addLanguage: (input: RecordedLanguage) => {
      recorded.languages.push(input)
      return () => undefined
    },
    bind:
      (namespace: string): Translate =>
      (key) =>
        (namespace === NS
          ? recorded.dictionaries.find((entry) => entry.namespace === NS)?.tables.en?.[key]
          : undefined) ?? key,
  }

  const provided: Record<string, unknown> = {}
  const scope = {
    effect: (execute: () => unknown, label?: string) => {
      recorded.effectLabels.push(label)
      // Cordis runs the effect body when the dependency exists and keeps the
      // disposer it returns; the fake does the same.
      const disposer = execute()
      disposers.push(disposer)
      return disposer
    },
    get: (service: string) => (service === 'locale' ? options.locale : undefined),
  } as Record<string, unknown>

  const pending: { names: string[]; callback: (injected: unknown) => unknown }[] = []
  const provide = (name: string, service: unknown): void => {
    provided[name] = service
    scope[name] = service
    // A parked callback fires the moment its dependency list is complete, and
    // leaves the queue so a later `provide` of an unrelated service cannot
    // fire it twice.
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const parked = pending[index]
      if (parked !== undefined && parked.names.every((needed) => needed in provided)) {
        pending.splice(index, 1)
        parked.callback(scope)
      }
    }
  }
  // By default the composition is settled: every service the entry asks for is
  // provided up front. A spec can start with fewer and arrive the rest later.
  const initial = options.services ?? ['betterSidebar', 'slots', 'locale']
  if (initial.includes('betterSidebar')) provide('betterSidebar', betterSidebar)
  if (initial.includes('slots')) provide('slots', slots)
  if (initial.includes('locale')) provide('locale', settingsLocale)

  const ctx = {
    // `unknown` rather than `typeof scope`: a fake that named the object it is
    // declared beside made TypeScript read the annotation as its own type.
    inject: (names: readonly string[], callback: (injected: unknown) => unknown) => {
      recorded.injects.push([...names])
      if (names.every((name) => name in provided)) callback(scope)
      else pending.push({ names: [...names], callback })
      return () => undefined
    },
    get: scope.get,
  }

  const composition = {
    ctx,
    recorded,
    disposers,
    settingsLocale,
    provide,
    activate() {
      apply(ctx as unknown as Context)
      return composition
    },
  }
  return composition
}

/** Drive `apply` the way the shell does, against a settled composition. */
function activate(options: { locale?: unknown; pluginSettings?: Record<string, unknown> } = {}) {
  return fakeComposition(options).activate()
}

function first<T>(items: readonly T[]): T {
  const value = items[0]
  if (value === undefined) throw new Error('expected at least one entry')
  return value
}

/** Read a descriptor label that may be a plain string or a per-render function. */
function labelOf(value: string | (() => string) | undefined): string | undefined {
  return typeof value === 'function' ? value() : value
}

function tabOf(composition: ReturnType<typeof activate>): TabDescriptor {
  return first(composition.recorded.tabs)
}

/** Invoke the tab-body callback the sidebar received, without rendering it. */
function panelElement(descriptor: TabDescriptor, props: PanelCallbackProps): FakeElement {
  const invoke = descriptor.component as unknown as (props: PanelCallbackProps) => unknown
  return invoke(props) as FakeElement
}

/** Invoke the settings-popup callback the sidebar received, without rendering it. */
function settingsElement(descriptor: TabDescriptor, props: SettingsCallbackProps): FakeElement {
  const render = descriptor.settings?.render
  if (render === undefined) throw new Error('the descriptor declares no settings panel')
  const invoke = render as unknown as (props: SettingsCallbackProps) => unknown
  return invoke(props) as FakeElement
}

describe('the plugin identity the entry publishes', () => {
  it('is the package name, with no module-level dependency to leave the entry pending', () => {
    expect(name).toBe(PACKAGE_NAME)
    expect(inject).toEqual([])
  })
})

describe('apply against a settled composition', () => {
  it('registers the sidebar tab, the settings page and the toast stack exactly once', () => {
    const composition = activate({ locale: localeService({ ru: RU }).service })

    // Each surface sits behind the services it needs, and behind no other: the
    // toast stack asks for the slot registry and the locale seat, so a language
    // switch repaints the banners on screen.
    expect(composition.recorded.injects).toEqual([
      ['betterSidebar'],
      ['slots', 'locale'],
      ['slots', 'locale'],
    ])
    expect(composition.recorded.tabs).toHaveLength(1)
    expect(composition.recorded.slotInjects).toEqual([SETTINGS_SLOT, TOASTS_SLOT])
    expect(composition.recorded.registrations.map((registration) => registration.id)).toEqual([
      PACKAGE_NAME,
      TOASTS_ID,
    ])
    expect(composition.recorded.components).toHaveLength(2)
    expect(composition.recorded.components.every((component) => typeof component === 'function')).toBe(true)
  })

  it('claims one cell of the frame-wide floating layer, at the position it declares', () => {
    const composition = activate({ locale: localeService({ ru: RU }).service })

    expect(TOASTS_SLOT).toBe('shell.overlay')
    expect(composition.recorded.registrations[1]).toEqual({
      name: TOASTS_SLOT,
      id: TOASTS_ID,
      order: TOASTS_ORDER,
    })
  })

  it('floats the toast stack even when the shell has no locale service', () => {
    const composition = activate()

    // The stack's own copy is the module's English, so it does not ride the
    // settings page's locale seat: with no locale service in the composition,
    // the stack still registers and only the tab's translate seat is bare.
    expect(composition.recorded.slotInjects).toEqual([SETTINGS_SLOT, TOASTS_SLOT])
    expect(composition.recorded.registrations.map((registration) => registration.id)).toEqual([
      PACKAGE_NAME,
      TOASTS_ID,
    ])
  })

  it('registers all three languages in one call per namespace, and names Russian to the shell', () => {
    const composition = activate()

    // Russian is not a language the shell ships, so the entry adds it at
    // runtime — and the add must precede the dictionary that uses it.
    expect(composition.recorded.languages).toEqual([{ id: 'ru', label: 'Русский', fallback: 'en' }])
    // One call per namespace carries all three tables: the runtime throws when
    // the same (namespace, locale) pair is registered twice, so three calls
    // are not an option. The second namespace is the host's wire codes (F-48).
    expect(composition.recorded.dictionaries).toHaveLength(2)
    const [call, hostCall] = composition.recorded.dictionaries
    expect(call?.namespace).toBe(NS)
    expect(Object.keys(call?.tables ?? {}).sort()).toEqual(['en', 'ru', 'zh'])
    expect(typeof call?.tables.zh?.tab).toBe('string')
    expect(typeof call?.tables.ru?.tab).toBe('string')
    expect(call?.tables.en?.tab).toBe('Project MCP')
    expect(call?.tables.en?.viewTable).toBe('Table')
    expect(hostCall?.namespace).toBe(NS_HOST)
    expect(Object.keys(hostCall?.tables ?? {}).sort()).toEqual(['en', 'ru', 'zh'])
    expect(hostCall?.tables.en?.['write.blocked.notConfigured']).toContain('configures none to write')
  })

  it('keeps every disposer the services handed back, so HMR unregisters cleanly', () => {
    const composition = activate({ locale: localeService({ ru: RU }).service })

    expect(composition.recorded.effectLabels).toEqual([
      undefined,
      'dsh-project-mcp: ru language',
      'dsh-project-mcp: settings dictionaries',
      'dsh-project-mcp: host dictionaries',
    ])
    // One for `registerTab`, one for `addLanguage`, one per dictionary
    // registration — all four effects.
    expect(composition.disposers).toHaveLength(4)
    expect(composition.disposers.every((disposer) => typeof disposer === 'function')).toBe(true)
  })

  it('registers the tab without a locale service, keeping the panel its own English', () => {
    const composition = activate()

    const descriptor = tabOf(composition)
    expect(composition.recorded.tabs).toHaveLength(1)
    expect(labelOf(descriptor.title)).toBe('Project MCP')
    expect(labelOf(descriptor.description)).toBe(
      'MCP servers each project declares, and what is mounted for its sessions',
    )
  })
})

describe('apply against a composition that settles late', () => {
  it('registers its dictionaries when the locale service arrives after activation', () => {
    // The sibling plugin's issue #16 is the evidence this models: a client can
    // activate before the locale service exists, and a synchronous `inject`
    // double would pin it to English forever without a test noticing.
    const composition = fakeComposition({ services: ['slots'] })
    composition.activate()
    expect(composition.recorded.dictionaries).toHaveLength(0)

    composition.provide('locale', composition.settingsLocale)

    expect(composition.recorded.languages).toHaveLength(1)
    expect(composition.recorded.dictionaries).toHaveLength(2)
    for (const dictionary of composition.recorded.dictionaries) {
      expect(Object.keys(dictionary.tables).sort()).toEqual(['en', 'ru', 'zh'])
    }

    // A later, unrelated provide must not fire the parked callback a second
    // time: the pair-throw rule makes a double registration a boot failure.
    composition.provide('betterSidebar', {
      registerTab: () => () => undefined,
      getSnapshot: () => ({ prefs: { pluginSettings: {} } }),
    })
    expect(composition.recorded.languages).toHaveLength(1)
    expect(composition.recorded.dictionaries).toHaveLength(2)
  })
})

describe('the sidebar tab the entry registers', () => {
  it('is the single instance this plugin owns, in the position and shape it declares', () => {
    const composition = activate({ locale: localeService({ ru: RU }).service })
    const descriptor = tabOf(composition)

    expect(descriptor.id).toBe(TAB_ID)
    expect(descriptor.order).toBe(55)
    expect(descriptor.single).toBe(true)
    expect(labelOf(descriptor.title)).toBe('Project MCP')
  })

  it('declares one plugin setting: the poll interval, bounded and in milliseconds', () => {
    const composition = activate({ locale: localeService({ ru: RU }).service })
    const descriptor = tabOf(composition)

    const toggles = descriptor.settings?.pluginToggles ?? []
    expect(toggles).toHaveLength(1)
    expect(first(toggles)).toMatchObject({
      key: REFRESH_KEY,
      type: 'number',
      min: 1_000,
      max: 60_000,
      unit: 'ms',
    })
  })

  it('re-reads its title through the shell’s seat, so a language switch repaints it', () => {
    const { service, setActive } = localeService({ ru: RU })
    const composition = activate({ locale: service })
    const descriptor = tabOf(composition)

    expect(labelOf(descriptor.title)).toBe('Project MCP')
    setActive('ru')
    expect(labelOf(descriptor.title)).toBe('MCP проектов')
  })
})

describe('the callbacks the sidebar receives', () => {
  it('hands the panel this session, its visibility and the persisted poll interval', () => {
    const { service } = localeService({ ru: RU })
    const composition = activate({ locale: service, pluginSettings: { [REFRESH_KEY]: 12_000 } })

    const element = panelElement(tabOf(composition), { visible: true, scope: { sessionId: 'session-42' } })

    expect(element.type).toBe(LocalizedPanel)
    expect(element.props.locale).toBe(service)
    expect(element.props.visible).toBe(true)
    expect(element.props.sessionId).toBe('session-42')
    expect(element.props.refreshMs).toBe(12_000)
  })

  it('falls back to the default interval while the snapshot holds no choice of its own', () => {
    const composition = activate()

    const element = panelElement(tabOf(composition), {
      visible: false,
      scope: { sessionId: undefined },
    })

    expect(element.props.locale).toBeUndefined()
    expect(element.props.visible).toBe(false)
    expect(element.props.sessionId).toBeUndefined()
    expect(element.props.refreshMs).toBe(DEFAULT_REFRESH_MS)
  })

  it('hands the settings popup the descriptor’s blob, its writer and its close seat', () => {
    const composition = activate({ locale: localeService({ ru: RU }).service })
    const pluginSettings = { refreshMs: 30_000 }
    const updatePluginSetting = (): void => undefined
    const close = (): void => undefined

    const element = settingsElement(tabOf(composition), { pluginSettings, updatePluginSetting, close })

    expect(element.type).toBe(LocalizedSettings)
    expect(element.props.pluginSettings).toBe(pluginSettings)
    expect(element.props.updatePluginSetting).toBe(updatePluginSetting)
    expect(element.props.onClose).toBe(close)
  })
})

describe('the two localized surfaces', () => {
  it('LocalizedPanel composes the panel with the seat it bound', () => {
    const { service } = localeService({ ru: RU })

    const element = LocalizedPanel({
      locale: service,
      visible: true,
      sessionId: 'session-7',
      refreshMs: 2_500,
    }) as unknown as FakeElement

    expect(element.type).toBe(ProjectMcpPanel)
    expect(element.props.visible).toBe(true)
    expect(element.props.sessionId).toBe('session-7')
    expect(element.props.refreshMs).toBe(2_500)
    const t = element.props.t as Translate
    expect(typeof t).toBe('function')
    expect(t('tab')).toBe('Project MCP')
  })

  it('LocalizedPanel keeps its English seat when the composition has no locale service', () => {
    const element = LocalizedPanel({
      locale: undefined,
      visible: false,
      sessionId: undefined,
      refreshMs: DEFAULT_REFRESH_MS,
    }) as unknown as FakeElement

    expect(element.type).toBe(ProjectMcpPanel)
    expect((element.props.t as Translate)('tab')).toBe('Project MCP')
  })

  it('LocalizedSettings composes the popup with the same seat', () => {
    const { service } = localeService({ ru: RU })
    const pluginSettings = { refreshMs: 1_000 }
    const updatePluginSetting = (): void => undefined
    const close = (): void => undefined

    const element = LocalizedSettings({
      locale: service,
      pluginSettings,
      updatePluginSetting,
      onClose: close,
    }) as unknown as FakeElement

    expect(element.type).toBe(ProjectMcpSettings)
    expect(element.props.pluginSettings).toBe(pluginSettings)
    expect(element.props.updatePluginSetting).toBe(updatePluginSetting)
    expect(element.props.onClose).toBe(close)
    expect((element.props.t as Translate)('tab')).toBe('Project MCP')
  })

  it('LocalizedSettings leaves the close seat optional, as the descriptor passes it', () => {
    const element = LocalizedSettings({
      locale: undefined,
      pluginSettings: {},
      updatePluginSetting: () => undefined,
      onClose: undefined,
    }) as unknown as FakeElement

    expect(element.type).toBe(ProjectMcpSettings)
    expect(element.props.onClose).toBeUndefined()
  })
})
