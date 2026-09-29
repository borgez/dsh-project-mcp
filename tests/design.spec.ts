/**
 * The design-only render mode (`src/client/design.ts` + its fixtures).
 *
 * Two things are worth checking, and they are different things. First the
 * **pictures**: that each variant really carries the state the docs claim for it
 * — the full one covers every status tone and a disagreement, the quiet one
 * agrees with itself, the empty ones publish nothing at all. Second the
 * **wiring**: that the mode registers the same three surfaces the product does,
 * from the same components, and that it is off unless the flag names a picture —
 * a typo must never swap the real interface for a fixture.
 *
 * React is mocked at the module boundary, as in `tests/client-entry.spec.ts`: the
 * element trees the mode builds stay plain objects, so every assertion here is
 * about what would be rendered rather than about a DOM.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  DESIGN_FLAG_KEY,
  DesignPanel,
  DesignPopup,
  DesignSettingsTab,
  LocalizedDesignPanel,
  LocalizedDesignPopup,
  designModeEnabled,
  designVariantOf,
  registerDesignSurfaces,
  registerDesignToasts,
} from '../src/client/design.ts'
import {
  SETTINGS_DIALOG_SLOT,
  TAB_GUIDE_ORDER,
  TAB_KIND,
  TAB_MENU_SLOT,
  TAB_SLOT,
  TAB_TITLE_SLOT,
  TabBody,
  TabChipTitle,
  SettingsDialog,
} from '../src/client/sidebar-tab.ts'
import type { SidebarRightTabDefinition } from '../src/client/sidebar-tab.ts'
import {
  DESIGN_DOCUMENT,
  DESIGN_EVENTS,
  DESIGN_PENDING_EVENT,
  DESIGN_PROJECT_ROOT,
  DESIGN_SESSION,
  DESIGN_TOASTS,
  DESIGN_VARIANTS,
  designPicture,
  designPolicy,
  designProject,
  designSessionId,
  designTools,
  isDesignVariant,
} from '../src/client/design-fixtures.ts'
import { apply } from '../src/client/index.ts'
import { NS, SETTINGS_SLOT, SettingsPage } from '../src/client/settings.ts'
import { NS_HOST } from '../src/client/locales/host.ts'
import { TOASTS_ID, TOASTS_ORDER, TOASTS_SLOT, ToastStack } from '../src/client/toasts.ts'
import { ProjectBlock, STATUS_COLOR, sessionBreakdown, statusGroups } from '../src/client/view.ts'
import { TAB_ID } from '../src/shared.ts'
import { localeService } from './helpers/locale.ts'

/** Mutable stand-ins for the hooks the surfaces call, so no renderer is needed. */
vi.mock('react', () => ({
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
    type,
    props: { ...(props as Record<string, unknown>), children },
  }),
  useCallback: (callback: unknown) => callback,
  // One element is built per call and never re-rendered here, so the initial
  // value is the whole state: a fresh read per call is what the first render sees.
  useState: <T,>(initial: T | (() => T)): [T, (next: T) => void] => [
    typeof initial === 'function' ? (initial as () => T)() : initial,
    () => undefined,
  ],
  useEffect: () => undefined,
  useRef: (initial: unknown) => ({ current: initial }),
  useMemo: (factory: () => unknown) => factory(),
}))

/** A React element as the mocked `createElement` builds it. */
interface Element {
  type: unknown
  props: Record<string, unknown>
}

/**
 * Render a tree the way React would, without a renderer.
 *
 * Every function component is invoked with the props its element carries, so the
 * text below a component — `PanelHeader`, `ServersBlock`, `ToolsSection`, a
 * disclosure body — is visible to {@link texts}. Hooks are the mocked ones: one
 * pass, one state value, no effects, which is exactly the first render.
 */
function renderTree(node: unknown): unknown {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child) => renderTree(child))
  const element = node as Element
  if (typeof element.type === 'function') {
    return renderTree((element.type as (props: unknown) => unknown)(element.props))
  }
  return { type: element.type, props: { ...element.props, children: renderTree(element.props.children) } }
}

/** Every string a user would read under this node, in tree order. */
function texts(node: unknown): string[] {
  const rendered = renderTree(node)
  if (rendered === null) return []
  if (typeof rendered === 'string') return [rendered]
  if (Array.isArray(rendered)) return rendered.flatMap((child) => texts(child))
  const element = rendered as Element
  return texts(element.props.children)
}

/** Every element in the tree, the root included. */
function elements(node: unknown): Element[] {
  if (node === null || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap((child) => elements(child))
  const element = node as Element
  return [element, ...elements(element.props.children)]
}

/** A storage with one value in it, or one that refuses to be read. */
function storageOf(value: string | undefined): { getItem(key: string): string | null; setItem(): void } {
  return {
    getItem: (key: string) => (key === DESIGN_FLAG_KEY ? value ?? null : null),
    setItem: () => undefined,
  }
}

/** Read a registered label that may be a plain string or a per-render function. */
function labelOf(value: string | (() => string) | undefined): string | undefined {
  return typeof value === 'function' ? value() : value
}

/** Read a tab type's chip title, which the registry writes per opened address. */
function titleOf(definition: SidebarRightTabDefinition): string {
  return definition.title('')
}

/** The options a registration carries, as these checks read them. */
interface RecordedRegistration {
  name: string
  id?: string | undefined
  order?: number | undefined
  key?: string | undefined
  label?: (() => string) | undefined
}

/** A composition already settled: the services exist, so every inject runs at once. */
function fakeComposition() {
  const recorded = {
    injects: [] as string[][],
    slotInjects: [] as string[],
    effectLabels: [] as (string | undefined)[],
    tabs: [] as SidebarRightTabDefinition[],
    registrations: [] as RecordedRegistration[],
    components: [] as unknown[],
    namespaces: [] as string[],
    dictionaries: [] as { namespace: string; tables: Record<string, Record<string, string>> }[],
  }
  const sidebarRightTabs = {
    register: (definition: SidebarRightTabDefinition): (() => void) => {
      recorded.tabs.push(definition)
      return () => undefined
    },
  }
  const slots = {
    inject: (slot: string, callback: () => unknown) => {
      recorded.slotInjects.push(slot)
      return callback()
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
    bind: () => (key: string) => key,
  }
  const scope = {
    sidebarRightTabs,
    slots,
    locale: settingsLocale,
    effect: (execute: () => unknown, label?: string) => {
      recorded.effectLabels.push(label)
      return execute()
    },
    get: (service: string) => (service === 'locale' ? localeService : undefined),
  }
  const ctx = {
    inject: (names: readonly string[], callback: (injected: unknown) => unknown) => {
      recorded.injects.push([...names])
      callback(scope)
      return () => undefined
    },
    get: scope.get,
  }
  return { ctx: ctx as unknown as Context, recorded }
}

/** Install a browser-local stand-in for one check, and hand back its removal. */
function withStorage(value: string | undefined): () => void {
  const host = globalThis as { localStorage?: unknown }
  const previous = host.localStorage
  host.localStorage = storageOf(value)
  return () => {
    if (previous === undefined) delete host.localStorage
    else host.localStorage = previous
  }
}

function first<T>(items: readonly T[]): T {
  const value = items[0]
  if (value === undefined) throw new Error('expected at least one entry')
  return value
}

afterEach(() => {
  vi.useRealTimers()
})

describe('designVariantOf', () => {
  it('is off without the flag, and off for a value no picture answers to', () => {
    expect(designVariantOf(storageOf(undefined))).toBeUndefined()
    expect(designVariantOf(storageOf('nonsense'))).toBeUndefined()
    expect(designModeEnabled(storageOf(undefined))).toBe(false)
    expect(designModeEnabled(storageOf('nonsense'))).toBe(false)
  })

  it('reads a picture by name and the plain "on" spellings as the full one', () => {
    for (const variant of DESIGN_VARIANTS) {
      expect(designVariantOf(storageOf(variant))).toBe(variant)
    }
    for (const alias of ['on', 'true', 'yes', '1']) {
      expect(designVariantOf(storageOf(alias))).toBe('full')
      expect(designModeEnabled(storageOf(alias))).toBe(true)
    }
  })

  it('stays off when storage itself refuses to be read', () => {
    const hostile = {
      getItem: (): string | null => {
        throw new Error('blocked by policy')
      },
      setItem: () => undefined,
    }
    expect(designVariantOf(hostile)).toBeUndefined()
    expect(designModeEnabled(hostile)).toBe(false)
  })
})

describe('design fixtures', () => {
  it('lists every variant once, and recognises exactly those', () => {
    expect(new Set(DESIGN_VARIANTS).size).toBe(DESIGN_VARIANTS.length)
    for (const variant of DESIGN_VARIANTS) expect(isDesignVariant(variant)).toBe(true)
    expect(isDesignVariant('full ')).toBe(false)
    expect(isDesignVariant(7)).toBe(false)
    expect(isDesignVariant(undefined)).toBe(false)
  })

  it('gives the full picture every status tone, a disagreement and a real offer', () => {
    const project = designProject('full')
    if (project === undefined) throw new Error('the full picture has a project')

    expect(project.projectRoot).toBe(DESIGN_PROJECT_ROOT)
    expect(project.rows.map((row) => row.status)).toEqual([
      'active',
      'active',
      'error',
      'connecting',
      'conflict',
      'idle',
      'disabled',
    ])
    // Four distinct tones are what the mockup's whole status vocabulary rests on.
    const tones = new Set(project.rows.map((row) => STATUS_COLOR[row.status]))
    expect(tones.size).toBe(4)

    const [session] = project.sessions
    expect(session?.id).toBe(DESIGN_SESSION)
    // This session reads `grafana-local` as idle while the project merges it as
    // active — the one honest disagreement the project-first view exists for.
    const breakdown = sessionBreakdown(project, DESIGN_SESSION)
    expect(breakdown.some((entry) => entry.current)).toBe(true)
    expect(breakdown.filter((entry) => entry.deviates).length).toBe(1)
    expect(session?.rows.find((row) => row.name === 'grafana-local')?.status).toBe('idle')

    const tools = designTools('full')
    expect(tools?.mounted).toBe(5)
    expect(tools?.deferred).toHaveLength(2)
    expect(tools?.deferring).toBe(true)
    // One name is pinned by hand, one was offered by the counters alone: the
    // block has to show both tiers, and the second one carries the pin action.
    const policy = designPolicy('full')
    expect(tools?.baseline).toHaveLength(2)
    expect(tools?.baseline.filter((name) => !policy.pins.includes(name))).toEqual([
      'mcp__tglider__catalog',
    ])
    expect(project.logs).toHaveLength(DESIGN_EVENTS.length)
    expect(project.logCount).toBe(DESIGN_EVENTS.length)
  })

  it('lets the quiet picture agree with itself and publish no problems', () => {
    const project = designProject('quiet')
    if (project === undefined) throw new Error('the quiet picture has a project')
    expect(sessionBreakdown(project, DESIGN_SESSION).filter((entry) => entry.deviates)).toEqual([])
    expect(statusGroups(project.rows)).toEqual([])
    expect(designTools('quiet')?.deferred).toEqual([])
    expect(project.logs).toBeUndefined()
  })

  it('stops at the declaration when the host published no offer', () => {
    const absent = designProject('tools-absent')
    expect(absent?.rows).toHaveLength(1)
    expect(designTools('tools-absent')).toBeUndefined()
    expect(absent?.logs).toHaveLength(DESIGN_PENDING_EVENT.length)
  })

  it('carries the two modes that are not disclosure', () => {
    expect(designPolicy('off').mode).toBe('off')
    expect(designTools('off')?.baseline).toEqual([])
    expect(designTools('off')?.deferred).toHaveLength(1)
    expect(designPolicy('direct').mode).toBe('direct')
    expect(designTools('direct')?.deferred).toEqual([])
    expect(designPolicy('quiet').pins).toHaveLength(2)
    expect(designPolicy('empty').mode).toBe('disclosure')
  })

  it('publishes nothing for the two pictures that resolve to no project', () => {
    for (const variant of ['no-project', 'no-session'] as const) {
      expect(designProject(variant)).toBeUndefined()
      expect(designPicture(variant).projects).toEqual([])
      expect(designPicture(variant).watchedFiles).toEqual([])
    }
    expect(designSessionId('no-session')).toBeUndefined()
    expect(designSessionId('full')).toBe(DESIGN_SESSION)
    expect(designProject('empty')?.rows).toEqual([])
  })

  it('wraps one project in the envelope the host publishes, with its document watched', () => {
    const picture = designPicture('full')
    expect(picture.ready).toBe(true)
    expect(picture.projects).toHaveLength(1)
    expect(picture.watchedFiles).toEqual([DESIGN_DOCUMENT])
    expect(designPicture('empty').projects[0]?.rows).toEqual([])
    expect(designTools('empty')).toBeUndefined()
  })

  it('names three banners, one per lifecycle moment worth announcing', () => {
    expect(DESIGN_TOASTS.map((toast) => toast.level)).toEqual(['up', 'error', 'released'])
    // Keyed drafts, as the real transition diff writes them: the stack
    // resolves the keys at render, so the stand follows the shell's language.
    expect(DESIGN_TOASTS.map((toast) => toast.textKey)).toEqual([
      'toastUp',
      'toastFailed',
      'toastReleased',
    ])
    for (const toast of DESIGN_TOASTS) expect(toast.detail ?? toast.detailKey).toBeTruthy()
    expect(new Set(DESIGN_TOASTS.map((toast) => toast.level)).size).toBe(3)
  })
})

/** `true` when a picture's project exists but declares nothing. */
function designSetOf(variant: 'empty'): boolean {
  return designProject(variant)?.rows.length === 0
}

describe('DesignPanel', () => {
  it('draws the toolbar and the one body of the single surface', () => {
    const tree = DesignPanel({ variant: 'full', sessionId: DESIGN_SESSION, t: undefined })
    const read = texts(tree).join(' ')
    expect(read).toContain('service')
    expect(read).toContain('this session')
    expect(read).toContain('Sync')
    expect(read).toContain('1 session')
    expect(read).toContain('Servers')
    expect(read).toContain('gateway')
    expect(read).toContain('Problems')
    expect(read).toContain('Logs')
    // The body is a scroller, exactly as the contract's own anchor reads it.
    const body = elements(tree).find(
      (element) => (element.props.style as { overflow?: string } | undefined)?.overflow === 'auto',
    )
    expect(body).toBeDefined()
  })

  it('answers the two empty states with their own words', () => {
    const noSession = texts(DesignPanel({ variant: 'no-session', sessionId: undefined })).join(' ')
    expect(noSession).toContain('No session is attached to this tab.')
    expect(noSession).toContain('no project')
    const noProject = texts(DesignPanel({ variant: 'no-project', sessionId: DESIGN_SESSION })).join(' ')
    expect(noProject).toContain('This session’s folder is not inside a project yet.')
    const empty = texts(DesignPanel({ variant: 'empty', sessionId: DESIGN_SESSION })).join(' ')
    expect(empty).toContain('This project declares no MCP servers.')
    expect(empty).toContain('Nothing to hide yet')
  })

  it('draws the two non-disclosure modes and the not-yet-mounted offer', () => {
    const off = texts(DesignPanel({ variant: 'off', sessionId: DESIGN_SESSION })).join(' ')
    expect(off).toContain('this project’s MCP tools are switched off')
    const direct = texts(DesignPanel({ variant: 'direct', sessionId: DESIGN_SESSION })).join(' ')
    expect(direct).toContain('nothing is deferred')
    const absent = texts(DesignPanel({ variant: 'tools-absent', sessionId: DESIGN_SESSION })).join(' ')
    expect(absent).toContain('Nothing to hide yet')
    const quiet = texts(DesignPanel({ variant: 'quiet', sessionId: DESIGN_SESSION })).join(' ')
    // The quiet project hides nothing and discloses nothing, so the block draws
    // no group, no empty row and no sentence about either: the one number it has
    // is a chip on the summary line.
    expect(quiet).toContain('2 pinned')
    expect(quiet).not.toContain('nothing is hidden')
    expect(quiet).not.toContain('hidden ·')
    // The quiet project agrees with itself, so the breakdown section is absent
    // rather than empty — the F-24 rule, visible in the tree.
    expect(quiet).not.toContain('merged across sessions')
  })
})

describe('DesignPopup', () => {
  it('names the surface and lists one block per project', () => {
    const tree = DesignPopup({ variant: 'full', refreshMs: 2_000, onClose: () => undefined })
    const read = texts(tree).join(' ')
    expect(read).toContain('Mounted per project')
    expect(read).toContain('1 project(s)')
    expect(read).toContain('Close')
    // The body is the product's own `ProjectBlock` — one per project, fed the
    // fixture rather than a polled snapshot.
    const blocks = elements(tree).filter((element) => element.type === ProjectBlock)
    expect(blocks).toHaveLength(1)
    expect((blocks[0]?.props.project as { projectRoot: string }).projectRoot).toBe(DESIGN_PROJECT_ROOT)
  })

  it('says nothing is mounted when no project resolved', () => {
    const read = texts(DesignPopup({ variant: 'no-project', refreshMs: 2_000 })).join(' ')
    expect(read).toContain('Nothing is mounted yet.')
    expect(read).toContain('0 project(s)')
  })
})

describe('DesignSettingsTab', () => {
  it('hands the fixture picture to the real settings page', () => {
    const element = DesignSettingsTab({ variant: 'full' }) as unknown as Element
    expect(element.type).toBe(SettingsPage)
    const snapshot = element.props.snapshot as { projects: { projectRoot: string }[] }
    expect(snapshot.projects[0]?.projectRoot).toBe(DESIGN_PROJECT_ROOT)
    expect(element.props.selectedRoot).toBe(DESIGN_PROJECT_ROOT)
    expect(element.props.view).toBe('table')
    expect(element.props.page).toBe('servers')
    expect(element.props.busy).toBe(false)
    expect(element.props.error).toBeUndefined()
  })

  it('renders the page for a project that declares nothing', () => {
    const element = DesignSettingsTab({ variant: 'empty' }) as unknown as Element
    const snapshot = element.props.snapshot as { projects: { rows: unknown[] }[] }
    expect(snapshot.projects).toHaveLength(1)
    expect(snapshot.projects[0]?.rows).toEqual([])
    expect(element.props.selectedRoot).toBe(DESIGN_PROJECT_ROOT)
    // `SettingsPage` is handed the picture, so the page's own body branch — not a
    // fixture — decides what an empty project says.
    expect(element.type).toBe(SettingsPage)
  })

  it('renders the whole settings page from the fixture without a host', () => {
    // The page below `DesignSettingsTab` is the product's own, invoked here with
    // the fixture props: a runtime that only the fixture path can reach (the
    // table, the source labels, the enabled switches) is exercised this way.
    const read = texts(DesignSettingsTab({ variant: 'full' })).join(' ')
    expect(read).toContain('Servers')
    expect(read).toContain('tglider')
    expect(read).toContain('.dsh/mcp.json')
    expect(read).toContain('gateway')
    expect(read).toContain('Retry')
  })

  it('carries no project when the session resolved to none', () => {
    const element = DesignSettingsTab({ variant: 'no-project' }) as unknown as Element
    expect((element.props.snapshot as { projects: unknown[] }).projects).toEqual([])
    expect(element.props.selectedRoot).toBeUndefined()
  })
})

describe('registerDesignSurfaces', () => {
  it('registers the same three surfaces the product does, from the fixture pages', () => {
    const { ctx, recorded } = fakeComposition()
    registerDesignSurfaces(ctx, 'full')

    expect(recorded.injects).toEqual([['slots', 'sidebarRightTabs'], ['slots', 'locale'], ['slots', 'locale']])
    expect(recorded.slotInjects).toEqual([
      TAB_SLOT,
      TAB_TITLE_SLOT,
      TAB_MENU_SLOT,
      SETTINGS_DIALOG_SLOT,
      SETTINGS_SLOT,
      TOASTS_SLOT,
    ])
    expect(recorded.namespaces).toEqual([NS, NS_HOST])
    // The fixture surfaces register the same one call per namespace with all
    // three languages the product entry does — the design mode is a drop-in
    // replacement.
    expect(recorded.dictionaries).toHaveLength(2)
    for (const dictionary of recorded.dictionaries) {
      expect(Object.keys(dictionary.tables).sort()).toEqual(['en', 'ru', 'zh'])
    }
    // Four effects in the product (the tab type, `addLanguage`, the two
    // dictionaries); the stand names no new language, so its three.
    expect(recorded.effectLabels).toEqual([
      'dsh-project-mcp: sidebar tab type',
      'dsh-project-mcp: design settings dictionary',
      'dsh-project-mcp: design host dictionary',
    ])

    const descriptor = first(recorded.tabs)
    expect(descriptor.id).toBe(TAB_ID)
    expect(descriptor.kind).toBe(TAB_KIND)
    // A page type: it claims no address, so the guide entry is the only way in.
    expect(first(descriptor.guide ?? []).order).toBe(TAB_GUIDE_ORDER)
    expect(titleOf(descriptor)).toContain('design (full)')
    expect(labelOf(first(descriptor.guide ?? []).description)).toContain('full')

    // The tab body is built from the fixture, through the same localized wrapper
    // the product entry uses: the registered component is the framework adapter,
    // which hands the fixture body to the shared `TabBody`.
    const body = first(recorded.components) as (props: unknown) => unknown
    const adapter = body({ sessionId: DESIGN_SESSION }) as Element
    expect(adapter.type).toBe(TabBody)
    // `TabBody` renders the entry's own body component, which is the stand's
    // variant-bound wrapper around the fixture panel.
    const wrapper = (adapter.type as (props: unknown) => unknown)(adapter.props) as Element
    const panelElement = (wrapper.type as (props: unknown) => unknown)(wrapper.props) as Element
    expect(panelElement.type).toBe(LocalizedDesignPanel)
    expect(panelElement.props.variant).toBe('full')
    expect(panelElement.props.sessionId).toBe(DESIGN_SESSION)

    // The chip title is the stand's own copy, read on every render.
    const titleEntry = first(recorded.components.slice(1)) as (props: unknown) => unknown
    const titleElement = titleEntry({}) as Element
    expect(titleElement.type).toBe(TabChipTitle)
    expect((titleElement.type as (props: unknown) => unknown)(titleElement.props)).toContain('design (full)')

    // The popup is the same story: the floating layer's entry draws the shared
    // `SettingsDialog`, which is handed the fixture's own content.
    const dialogEntry = first(recorded.components.slice(3)) as (props: unknown) => unknown
    const dialogElement = dialogEntry({}) as Element
    expect(dialogElement.type).toBe(SettingsDialog)
    const render = dialogElement.props.settings as (props: unknown) => unknown
    const popupElement = render({
      refreshMs: 2_000,
      onRefreshMs: () => undefined,
      onClose: () => undefined,
      t: undefined,
      hostT: undefined,
    }) as Element
    expect(popupElement.type).toBe(LocalizedDesignPopup)
    expect(popupElement.props.variant).toBe('full')
    expect(typeof popupElement.props.onClose).toBe('function')

    // The settings slot got the fixture page, not the polling one. The slot
    // components are read by the name they registered under, because the sidebar
    // seats fill the front of the list.
    const settings = recorded.components[
      recorded.registrations.findIndex((entry) => entry.name === SETTINGS_SLOT)
    ] as (props: { t?: unknown }) => unknown
    const settingsElement = settings({}) as Element
    expect(settingsElement.type).toBe(DesignSettingsTab)
    const page = (settingsElement.type as (props: unknown) => unknown)(settingsElement.props) as Element
    expect(page.type).toBe(SettingsPage)
    expect((page.props.snapshot as { projects: unknown[] }).projects).toHaveLength(1)

    expect(recorded.registrations.find((entry) => entry.name === SETTINGS_SLOT)).toMatchObject({
      id: 'dsh-project-mcp',
    })
    // By id, not by slot: the popup and the stack share `shell.overlay`.
    expect(recorded.registrations.find((entry) => entry.id === TOASTS_ID)).toMatchObject({
      name: TOASTS_SLOT,
      order: TOASTS_ORDER,
    })
    expect(recorded.registrations.find((entry) => entry.name === TAB_SLOT)).toMatchObject({ key: TAB_ID })
  })

  it('reads the picture off storage when none is passed', () => {
    const restore = withStorage('quiet')
    try {
      const { ctx, recorded } = fakeComposition()
      registerDesignSurfaces(ctx)
      expect(titleOf(first(recorded.tabs))).toContain('design (quiet)')
    } finally {
      restore()
    }
  })
})

describe('registerDesignToasts', () => {
  it('fills the store at once and keeps repeating the three banners', () => {
    vi.useFakeTimers()
    const injections: (() => unknown)[] = []
    let stack: (() => unknown) | undefined
    const services = {
      slots: {
        inject: (_slot: string, callback: () => unknown) => {
          injections.push(callback)
          callback()
          return () => undefined
        },
        register: (_options: { name: string; id: string; order: number }, component: unknown) => {
          stack = component as () => unknown
          return () => undefined
        },
      },
    }
    registerDesignToasts(services)
    expect(injections).toHaveLength(1)
    const element = stack?.() as Element
    expect(element.type).toBe(ToastStack)
    const store = element.props.store as { getSnapshot(): readonly unknown[] }
    expect(store.getSnapshot()).toHaveLength(1)
    vi.advanceTimersByTime(2_500)
    vi.advanceTimersByTime(2_500)
    // Three kept at once: the older ones drop off the tail, as MAX_TOASTS says.
    expect(store.getSnapshot()).toHaveLength(3)
    vi.advanceTimersByTime(2_500)
    expect(store.getSnapshot()).toHaveLength(3)
  })

  it('stops the rotation when the slot registration is torn down', () => {
    vi.useFakeTimers()
    let dispose: (() => unknown) | undefined
    let stack: (() => unknown) | undefined
    const services = {
      slots: {
        inject: (_slot: string, callback: () => unknown) => {
          // A settled composition runs the callback and keeps what it returns;
          // that return value is the disposer under test.
          dispose = callback() as () => unknown
          return () => undefined
        },
        register: (_options: { name: string; id: string; order: number }, component: unknown) => {
          stack = component as () => unknown
          return () => undefined
        },
      },
    }
    registerDesignToasts(services)
    const store = (stack?.() as Element).props.store as { getSnapshot(): readonly unknown[] }
    expect(typeof dispose).toBe('function')
    ;(dispose as () => unknown)()
    vi.advanceTimersByTime(10_000)
    expect(store.getSnapshot()).toHaveLength(1)
  })
})

describe('apply in design mode', () => {
  it('registers the fixture surfaces instead of the real ones, and only when asked', () => {
    const restore = withStorage('full')
    try {
      const design = fakeComposition()
      apply(design.ctx)
      expect(titleOf(first(design.recorded.tabs))).toContain('design (full)')
      // The product path registers its own page; the fixture path must not.
      expect(first(design.recorded.components)).not.toBe(SettingsPage)
    } finally {
      restore()
    }

    const product = fakeComposition()
    apply(product.ctx)
    const descriptor = first(product.recorded.tabs)
    // The real descriptor's title is the localized tab label, not a fixture name.
    expect(titleOf(descriptor)).not.toContain('design')
    expect(descriptor.id).toBe(TAB_ID)
  })

  it('stays on the product path for a flag no picture answers to', () => {
    const restore = withStorage('nonsense')
    try {
      const composition = fakeComposition()
      apply(composition.ctx)
      expect(titleOf(first(composition.recorded.tabs))).not.toContain('design')
    } finally {
      restore()
    }
  })
})
