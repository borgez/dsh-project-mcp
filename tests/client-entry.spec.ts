/**
 * Entry wiring of the browser half (`src/client/index.ts`).
 *
 * Every other client test drives one surface — the panel, the settings popup,
 * the settings page, the toast stack — but nothing checked that **this** module
 * composes them the way the shell calls it: one tab *type* of DSH's own right
 * sidebar with its body under the keyed seat, one settings row in the tab chip's
 * actions menu with the popup it opens in the frame-wide floating layer, one page
 * through `slots` + `locale` behind its own `ctx.inject`, and one toast stack
 * behind the slot registry alone. That wiring is what registers the surfaces, so
 * it is driven here against a fake client context whose `ctx.inject` mirrors
 * Cordis: a callback runs at once when every service it names is provided, and is
 * parked until then when one is missing — so both a settled composition and a
 * locale service that arrives after activation are driven honestly.
 *
 * React is mocked at the module boundary — the same technique
 * `tests/tab-translate.spec.ts` uses — so the element trees the entry builds are
 * plain objects: nothing is rendered and there is no DOM. The registered slot
 * components are invoked by hand, which is also how the two seats of the tab
 * (body and popup) are checked: the registry adapter first, the shared
 * `TabBody` / `SettingsDialog` it hands the surface to second.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { LocalizedPanel, LocalizedSettings, apply, inject, name } from '../src/client/index.ts'
import { NS, SETTINGS_SLOT } from '../src/client/settings.ts'
import { NS_HOST } from '../src/client/locales/host.ts'
import { TOASTS_ID, TOASTS_ORDER, TOASTS_SLOT } from '../src/client/toasts.ts'
import {
  DEFAULT_REFRESH_MS,
  ProjectMcpPanel,
  ProjectMcpSettings,
  REFRESH_STORAGE_KEY,
  fallbackTranslate,
} from '../src/client/view.ts'
import type { PanelStorage } from '../src/client/view.ts'
import {
  MenuRow,
  SETTINGS_DIALOG_ID,
  SETTINGS_DIALOG_ORDER,
  SETTINGS_DIALOG_SLOT,
  TAB_GUIDE_ORDER,
  TAB_KIND,
  TAB_MENU_ID,
  TAB_MENU_ORDER,
  TAB_MENU_SLOT,
  TAB_SLOT,
  TAB_TITLE_SLOT,
  SettingsDialog,
  TabBody,
  TabChipTitle,
} from '../src/client/sidebar-tab.ts'
import type { SettingsDialogStore, SidebarRightTabDefinition } from '../src/client/sidebar-tab.ts'
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

/** A typed read of the element the entry builds for one seat. */
interface SeatElement<P> {
  type: unknown
  props: P
  children: unknown[]
}

/**
 * Options a registration carries, as this file records them.
 *
 * The keyed tab body names a `key`; the settings page adds a `locale` and an
 * `inject` face; the two list entries claim an `id` and an `order`, which the
 * toast stack and the actions-menu row both declare.
 */
interface RecordedRegistration {
  name: string
  id?: string | undefined
  order?: number | undefined
  key?: string | undefined
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
    /** Services provided from the start; defaults to all three the entry names. */
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
    /** Tab types registered with the right sidebar's registry. */
    tabs: [] as SidebarRightTabDefinition[],
    registrations: [] as RecordedRegistration[],
    components: [] as unknown[],
    namespaces: [] as string[],
    dictionaries: [] as RecordedDictionary[],
  }
  const disposers: unknown[] = []

  const sidebarRightTabs = {
    register: (definition: SidebarRightTabDefinition): (() => void) => {
      recorded.tabs.push(definition)
      return () => undefined
    },
  }

  const slots = {
    inject: (slot: string, callback: () => unknown) => {
      recorded.slotInjects.push(slot)
      // The slot is declared by its owner at runtime; this fake has every seat
      // declared, so the registration that would throw on an undeclared slot
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
      (namespace: string): ((key: string) => string) =>
      (key: string) =>
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
  const initial = options.services ?? ['slots', 'sidebarRightTabs', 'locale']
  if (initial.includes('slots')) provide('slots', slots)
  if (initial.includes('sidebarRightTabs')) provide('sidebarRightTabs', sidebarRightTabs)
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
    sidebarRightTabs,
    slots,
    provide,
    activate() {
      apply(ctx as unknown as Context)
      return composition
    },
  }
  return composition
}

/** Drive `apply` the way the shell does, against a settled composition. */
function activate(options: { locale?: unknown } = {}) {
  return fakeComposition(options).activate()
}

function first<T>(items: readonly T[]): T {
  const value = items[0]
  if (value === undefined) throw new Error('expected at least one entry')
  return value
}

/** Read a registered label that may be a plain string or a per-render function. */
function labelOf(value: string | (() => string) | undefined): string | undefined {
  return typeof value === 'function' ? value() : value
}

/** The tab type the entry registered. */
function tabOf(composition: ReturnType<typeof activate>): SidebarRightTabDefinition {
  return first(composition.recorded.tabs)
}

/** Where the four sidebar seats land in the registration order. */
const BODY_INDEX = 0
const TITLE_INDEX = 1
const MENU_INDEX = 2
const DIALOG_INDEX = 3

/** Invoke one registered slot component and read the element it builds. */
function seatAt<P>(
  composition: ReturnType<typeof activate>,
  index: number,
  props: unknown,
): SeatElement<P> {
  const component = composition.recorded.components[index] as (props: unknown) => SeatElement<P>
  return component(props)
}

/** Invoke the registered tab body's adapter, then the shared `TabBody` under it. */
function panelElement(
  composition: ReturnType<typeof activate>,
  props: { visible: boolean; sessionId: string | undefined },
): FakeElement {
  const adapter = seatAt<Parameters<typeof TabBody>[0]>(composition, BODY_INDEX, {
    sessionId: props.sessionId,
    useTabInfo: () => ({ tab: { visible: props.visible } }),
  })
  expect(adapter.type).toBe(TabBody)
  return (adapter.type as (props: unknown) => unknown)(adapter.props) as FakeElement
}

/** Invoke the actions-menu row the entry registered. */
function menuElement(
  composition: ReturnType<typeof activate>,
  dismiss?: () => void,
): FakeElement {
  const row = seatAt<Parameters<typeof MenuRow>[0]>(composition, MENU_INDEX, { dismiss })
  expect(row.type).toBe(MenuRow)
  return (row.type as (props: unknown) => unknown)(row.props) as FakeElement
}

/** Every element in a tree the mocked `createElement` built, the root included. */
function elementsOf(node: unknown): FakeElement[] {
  if (node === null || node === undefined || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap((child) => elementsOf(child))
  const element = node as FakeElement
  const children = Array.isArray(element.children) ? element.children : []
  return [element, ...children.flatMap((child) => elementsOf(child))]
}

/** Read the popup entry's own props: the store, the interval and the content seat. */
function dialogElement(
  composition: ReturnType<typeof activate>,
): SeatElement<Parameters<typeof SettingsDialog>[0]> {
  const entry = seatAt<Parameters<typeof SettingsDialog>[0]>(composition, DIALOG_INDEX, {})
  expect(entry.type).toBe(SettingsDialog)
  return entry
}

/** The store both halves of the settings popup share. */
function storeOf(composition: ReturnType<typeof activate>): SettingsDialogStore {
  return dialogElement(composition).props.store
}

/** An in-memory `localStorage`, so the interval's persistence needs no browser. */
function installStorage(initial: Record<string, string> = {}): PanelStorage & { values: Record<string, string> } {
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

beforeEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage')
})

describe('the plugin identity the entry publishes', () => {
  it('is the package name, with no module-level dependency to leave the entry pending', () => {
    expect(name).toBe(PACKAGE_NAME)
    expect(inject).toEqual([])
  })
})

describe('apply against a settled composition', () => {
  it('registers the tab type, the settings page and the toast stack exactly once', () => {
    const composition = activate({ locale: localeService({ ru: RU }).service })

    // Each surface sits behind the services it needs, and behind no other: the
    // tab is a type of the right sidebar's registry plus four slot seats, while
    // the toast stack asks for the slot registry and the locale seat, so a
    // language switch repaints the banners on screen. The plugin's configuration
    // card (F-54) adds the third list — `configForms` — in an inject of its own,
    // so the settings tab never depends on it.
    expect(composition.recorded.injects).toEqual([
      ['slots', 'sidebarRightTabs'],
      ['slots', 'locale'],
      ['slots', 'locale', 'configForms'],
      ['slots', 'locale'],
    ])
    expect(composition.recorded.tabs).toHaveLength(1)
    expect(composition.recorded.slotInjects).toEqual([
      TAB_SLOT,
      TAB_TITLE_SLOT,
      TAB_MENU_SLOT,
      SETTINGS_DIALOG_SLOT,
      SETTINGS_SLOT,
      TOASTS_SLOT,
    ])
    expect(composition.recorded.registrations.map((registration) => registration.name)).toEqual([
      TAB_SLOT,
      TAB_TITLE_SLOT,
      TAB_MENU_SLOT,
      SETTINGS_DIALOG_SLOT,
      SETTINGS_SLOT,
      TOASTS_SLOT,
    ])
    expect(composition.recorded.components).toHaveLength(6)
    expect(composition.recorded.components.every((component) => typeof component === 'function')).toBe(true)
  })

  it('claims the frame-wide floating layer twice: the settings popup and the toast stack', () => {
    const composition = activate({ locale: localeService({ ru: RU }).service })

    expect(SETTINGS_DIALOG_SLOT).toBe('shell.overlay')
    expect(TOASTS_SLOT).toBe('shell.overlay')
    expect(composition.recorded.registrations[DIALOG_INDEX]).toEqual({
      name: SETTINGS_DIALOG_SLOT,
      id: SETTINGS_DIALOG_ID,
      order: SETTINGS_DIALOG_ORDER,
    })
    expect(composition.recorded.registrations[5]).toEqual({
      name: TOASTS_SLOT,
      id: TOASTS_ID,
      order: TOASTS_ORDER,
    })
    // The popup's cell comes after the stack's, so the card paints over a banner
    // rather than under one — the layer stacks in registration order.
    expect(SETTINGS_DIALOG_ORDER).toBeGreaterThan(TOASTS_ORDER)
  })

  it('floats the toast stack even when the shell has no locale service', () => {
    const composition = activate()

    // The stack's own copy is the module's English, so it does not ride the
    // settings page's locale seat: with no locale service in the composition,
    // the stack still registers and only the tab's translate seat is bare.
    expect(composition.recorded.slotInjects).toContain(TOASTS_SLOT)
    expect(composition.recorded.registrations.map((registration) => registration.id)).toContain(TOASTS_ID)
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
    // The row the port moved into the popup is dictionary copy like every other.
    expect(typeof call?.tables.en?.settingsMenuItem).toBe('string')
    expect(typeof call?.tables.zh?.settingsMenuItem).toBe('string')
    expect(typeof call?.tables.ru?.settingsMenuItem).toBe('string')
    expect(hostCall?.namespace).toBe(NS_HOST)
    expect(Object.keys(hostCall?.tables ?? {}).sort()).toEqual(['en', 'ru', 'zh'])
    expect(hostCall?.tables.en?.['write.blocked.notConfigured']).toContain('configures none to write')
  })

  it('keeps every disposer the services handed back, so HMR unregisters cleanly', () => {
    const composition = activate({ locale: localeService({ ru: RU }).service })

    expect(composition.recorded.effectLabels).toEqual([
      'dsh-project-mcp: sidebar tab type',
      'dsh-project-mcp: ru language',
      'dsh-project-mcp: settings dictionaries',
      'dsh-project-mcp: host dictionaries',
    ])
    // One for the tab type, one for `addLanguage`, one per dictionary
    // registration — all four effects.
    expect(composition.disposers).toHaveLength(4)
    expect(composition.disposers.every((disposer) => typeof disposer === 'function')).toBe(true)
  })

  it('registers the tab without a locale service, keeping its copy its own English', () => {
    const composition = activate()

    const descriptor = tabOf(composition)
    expect(composition.recorded.tabs).toHaveLength(1)
    expect(descriptor.title('')).toBe('Project MCP')
    expect(labelOf(first(descriptor.guide ?? []).description)).toBe(
      'MCP servers each project declares, and what is mounted for its sessions',
    )
  })
})

describe('apply against a composition that settles late', () => {
  it('registers the tab type when the sidebar registry arrives after activation', () => {
    const composition = fakeComposition({ services: ['slots', 'locale'] })
    composition.activate()
    expect(composition.recorded.tabs).toHaveLength(0)

    composition.provide('sidebarRightTabs', composition.sidebarRightTabs)

    expect(composition.recorded.tabs).toHaveLength(1)
  })

  it('registers its dictionaries when the locale service arrives after activation', () => {
    // The sibling plugin's issue #16 is the evidence this models: a client can
    // activate before the locale service exists, and a synchronous `inject`
    // double would pin it to English forever without a test noticing.
    const composition = fakeComposition({ services: ['slots', 'sidebarRightTabs'] })
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
    composition.provide('configForms', {})
    expect(composition.recorded.languages).toHaveLength(1)
    expect(composition.recorded.dictionaries).toHaveLength(2)
  })
})

describe('the sidebar tab the entry registers', () => {
  it('is the page type this plugin owns, opened from its own guide entry', () => {
    const composition = activate({ locale: localeService({ ru: RU }).service })
    const descriptor = tabOf(composition)

    expect(descriptor.id).toBe(TAB_ID)
    expect(descriptor.kind).toBe(TAB_KIND)
    const guide = first(descriptor.guide ?? [])
    expect(guide.order).toBe(TAB_GUIDE_ORDER)
    expect(guide.title()).toBe('Project MCP')
    // The descriptor is title-only (a page type claims no address), so the guide
    // entry is the surface that says what opening it does.
    expect(labelOf(guide.description)).toBe(
      'MCP servers each project declares, and what is mounted for its sessions',
    )
  })

  it('re-reads the chip title through the seat, so an open tab follows a language switch', () => {
    const { service, setActive } = localeService({ ru: RU })
    const composition = activate({ locale: service })

    const entry = seatAt<Parameters<typeof TabChipTitle>[0]>(composition, TITLE_INDEX, {})

    expect(entry.type).toBe(TabChipTitle)
    const render = entry.type as (props: unknown) => unknown
    expect(render(entry.props)).toBe('Project MCP')
    setActive('ru')
    // The registry's own `title` thunk only covers the moment a tab opens; a
    // record keeps the text it was minted with until this seat replaces it.
    expect(render(entry.props)).toBe('MCP проектов')
  })

  it('re-reads its title through the shell’s seat, so a language switch repaints it', () => {
    const { service, setActive } = localeService({ ru: RU })
    const composition = activate({ locale: service })
    const descriptor = tabOf(composition)

    expect(descriptor.title('')).toBe('Project MCP')
    expect(first(descriptor.guide ?? []).title()).toBe('Project MCP')
    setActive('ru')
    expect(descriptor.title('')).toBe('MCP проектов')
    expect(first(descriptor.guide ?? []).title()).toBe('MCP проектов')
  })
})

describe('the tab body the entry registers', () => {
  it('hands the panel this session, its visibility and the persisted poll interval', () => {
    installStorage({ [REFRESH_STORAGE_KEY]: '12000' })
    const { service } = localeService({ ru: RU })
    const composition = activate({ locale: service })

    const element = panelElement(composition, { visible: true, sessionId: 'session-42' })

    expect(element.type).toBe(LocalizedPanel)
    expect(element.props.sessionId).toBe('session-42')
    expect(element.props.refreshMs).toBe(12_000)
    const t = element.props.t as (key: string) => string
    expect(t('tab')).toBe('Project MCP')
  })

  it('hands the panel the framework’s own visibility, and falls back to the default interval', () => {
    const composition = activate()

    const element = panelElement(composition, { visible: false, sessionId: undefined })

    expect(element.props.sessionId).toBeUndefined()
    expect(element.props.refreshMs).toBe(DEFAULT_REFRESH_MS)
    expect(element.type).toBe(LocalizedPanel)
  })

  it('draws an on-screen tab when the composition hands the body no tab hook', () => {
    const composition = activate()
    const adapter = seatAt<Parameters<typeof TabBody>[0]>(composition, BODY_INDEX, {
      sessionId: 'session-9',
    })

    const element = (adapter.type as (props: unknown) => unknown)(adapter.props) as FakeElement

    // The framework always injects the hook; a composition that does not is
    // drawn rather than thrown, which is what keeps this seat boot-safe.
    expect(element.type).toBe(LocalizedPanel)
    expect(element.props.visible).toBe(true)
    expect(element.props.sessionId).toBe('session-9')
  })
})

describe('the settings popup the entry registers', () => {
  it('opens from the actions-menu row, which dismisses the menu first', () => {
    const composition = activate({ locale: localeService({ ru: RU }).service })
    let dismissed = 0
    const row = menuElement(composition, () => {
      dismissed += 1
    })
    const store = storeOf(composition)

    expect(store.isOpen()).toBe(false)
    ;(row.props.onClick as () => void)()
    expect(dismissed).toBe(1)
    expect(store.isOpen()).toBe(true)
  })

  it('hands the popup the live interval, a writer that persists it and the close seat', () => {
    const storage = installStorage({ [REFRESH_STORAGE_KEY]: '12000' })
    const composition = activate({ locale: localeService({ ru: RU }).service })
    const store = storeOf(composition)
    store.open()

    const dialog = dialogElement(composition)
    // The popup's frame is the floating layer's entry: the backdrop and the card
    // are its own chrome, and the content is the component the entry registered.
    const tree = (dialog.type as (props: unknown) => unknown)(dialog.props)
    const element = elementsOf(tree).find((candidate) => candidate.type === LocalizedSettings)

    expect(element).toBeDefined()
    if (element === undefined) throw new Error('the popup drew no settings panel')
    expect(element.type).toBe(LocalizedSettings)
    expect(element.props.refreshMs).toBe(12_000)
    ;(element.props.onRefreshMs as (value: number) => void)(30_000)
    expect(storage.values[REFRESH_STORAGE_KEY]).toBe('30000')
    // The panel follows the same store, so the press reaches the surface it paces.
    expect(panelElement(composition, { visible: true, sessionId: 's1' }).props.refreshMs).toBe(30_000)
    ;(element.props.onClose as () => void)()
    expect(store.isOpen()).toBe(false)
  })

  it('draws nothing at all while it is closed', () => {
    const composition = activate()
    const dialog = dialogElement(composition)

    expect((dialog.type as (props: unknown) => unknown)(dialog.props)).toBeNull()
  })
})

describe('the two localized surfaces', () => {
  it('LocalizedPanel composes the panel with the seats it was handed', () => {
    const element = LocalizedPanel({
      sessionId: 'session-7',
      visible: true,
      refreshMs: 2_500,
      t: fallbackTranslate,
      hostT: fallbackTranslate,
    }) as unknown as FakeElement

    expect(element.type).toBe(ProjectMcpPanel)
    expect(element.props.visible).toBe(true)
    expect(element.props.sessionId).toBe('session-7')
    expect(element.props.refreshMs).toBe(2_500)
    expect((element.props.t as (key: string) => string)('tab')).toBe('Project MCP')
    expect(element.props.hostT).toBe(fallbackTranslate)
  })

  it('LocalizedSettings composes the popup with the same seats', () => {
    const close = (): void => undefined
    const write = (): void => undefined

    const element = LocalizedSettings({
      refreshMs: 1_000,
      onRefreshMs: write,
      onClose: close,
      t: fallbackTranslate,
      hostT: fallbackTranslate,
    }) as unknown as FakeElement

    expect(element.type).toBe(ProjectMcpSettings)
    expect(element.props.refreshMs).toBe(1_000)
    expect(element.props.onRefreshMs).toBe(write)
    expect(element.props.onClose).toBe(close)
    expect((element.props.t as (key: string) => string)('tab')).toBe('Project MCP')
  })
})
