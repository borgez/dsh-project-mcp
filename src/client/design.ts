/**
 * Design-only render mode: the browser half drawn from fixtures.
 *
 * This module exists so the interface can be reviewed **as the shell renders
 * it** on a machine where nothing is mounted: no project, no MCP server, no host
 * route. When the design flag is set (see {@link DESIGN_FLAG_KEY}) `./index.ts`
 * registers *these* surfaces instead of the real ones, and every one of them
 * renders the same components the product renders — `PanelHeader`, `tabBody`,
 * `SettingsPage`, `ProjectBlock`, `ToastStack` — fed from `./design-fixtures.ts`.
 *
 * What the mode is not: it is not a second UI. There is no markup here that the
 * real surfaces do not also produce; the only thing it swaps is where the
 * picture comes from. The host half is untouched, so a profile that has this
 * flag set still mounts whatever the project declares — the *drawing* is a
 * fixture, the *runtime* is real.
 *
 * Turning it on, from the web client's own console:
 *
 * ```js
 * localStorage.setItem('dsh-project-mcp:design', 'full')   // or quiet | empty | …
 * location.reload()                                        // back to the product
 * localStorage.removeItem('dsh-project-mcp:design')
 * ```
 *
 * @module dsh-project-mcp/client/design
 */

import { createElement as h, useState } from 'react'
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { en, ru, zh } from './locales/ui.ts'
import { NS_HOST, en as hostEn, ru as hostRu, zh as hostZh, hostTranslate } from './locales/host.ts'
import { registerSidebarTab } from './sidebar-tab.ts'
import type { SidebarSettingsProps, SidebarTabBodyProps, SidebarTabServices } from './sidebar-tab.ts'
import {
  DEFAULT_SETTINGS_VIEW,
  NS,
  SETTINGS_TAB_ID,
  SETTINGS_TAB_ORDER,
  SettingsPage,
  registerSettingsTab,
  useNarrowSettings,
} from './settings.ts'
import type { SettingsSlotServices, SettingsTabProps, SettingsView } from './settings.ts'
import { DEFAULT_SETTINGS_PAGE } from './settings-tools.ts'
import type { SettingsPageKey } from './settings-tools.ts'
import { localeServiceOf, tabTranslate, useTabTranslate } from './tab-locale.ts'
import type { TabLocale } from './tab-locale.ts'
import { TOASTS_ID, TOASTS_ORDER, TOASTS_SLOT, ToastStack, createToastStore } from './toasts.ts'
import type { ToastsServices } from './toasts.ts'
import {
  PanelHeader,
  ProjectBlock,
  RefreshRow,
  STYLE,
  browserStorage,
  createRefreshStore,
  sessionLogCount,
  statusGroups,
  storedString,
  tabBody,
  translateOf,
} from './view.ts'
import type { PanelStorage, Translate } from './view.ts'
import {
  DESIGN_TOASTS,
  designPicture,
  designPolicy,
  designProject,
  designSessionId,
  isDesignVariant,
} from './design-fixtures.ts'
import type { DesignVariant } from './design-fixtures.ts'

/**
 * Where the design mode is asked for.
 *
 * A browser-local preference rather than a build flag, for the same reason the
 * panel's own view and filters are: it must be switchable without a rebuild, and
 * it must be readable by the bundle that is already loaded.
 */
export const DESIGN_FLAG_KEY = 'dsh-project-mcp:design'

/** Values that mean "on" without naming a picture. */
const DESIGN_FLAG_ALIASES: readonly string[] = ['on', 'true', 'yes', '1']

/** How often the fixture stack repeats its three banners. */
const DESIGN_TOAST_ROTATE_MS = 2_500

/** A set that never changes, for the read-only props of the fixture settings page. */
const NO_PENDING: ReadonlySet<string> = new Set()

/** Do nothing: the fixture surfaces have no host to call. */
function noop(): void {
  // Intentionally empty: a design surface answers no route.
}

/**
 * The picture the flag asks for.
 *
 * The flag holds a variant name (`full`, `quiet`, …) or one of the plain "on"
 * spellings, which mean the all-states picture. Anything else — including a
 * value from a newer build — leaves the mode **off**, so a typo can never swap
 * the real interface for a fixture.
 * @param storage - storage to read; defaults to the browser's own.
 * @returns the variant, or undefined when the mode is off.
 */
export function designVariantOf(storage?: PanelStorage): DesignVariant | undefined {
  const value = storedString(DESIGN_FLAG_KEY, storage)
  if (value === undefined) return undefined
  if (DESIGN_FLAG_ALIASES.includes(value)) return 'full'
  return isDesignVariant(value) ? value : undefined
}

/**
 * `true` when the flag names a picture the mode can draw.
 * @param storage - storage to read; defaults to the browser's own.
 * @returns whether the design surfaces should be registered instead of the real ones.
 */
export function designModeEnabled(storage?: PanelStorage): boolean {
  return designVariantOf(storage) !== undefined
}

/**
 * The sidebar tab, drawn from a picture.
 *
 * The same two elements the real panel renders, in the same order: the toolbar
 * and the one body of the single surface. Nothing here fetches, so nothing here
 * needs the shell to be connected.
 * @param props - the picture, the tab's session and the translate seat.
 * @returns the panel element tree.
 */
export function DesignPanel(props: {
  variant: DesignVariant
  sessionId: string | undefined
  t?: Translate | undefined
  /** Host-namespace seat for the fixtures' coded events (F-48). */
  hostT?: Translate | undefined
}): ReactNode {
  const t = translateOf(props.t)
  const project = designProject(props.variant)
  const sessionId = designSessionId(props.variant)
  const groups = project === undefined ? [] : statusGroups(project.rows)
  const session = (project?.sessions ?? []).find((entry) => entry.id === sessionId)
  return h(
    'div',
    { style: STYLE.root },
    h(PanelHeader, {
      project,
      sessions: project?.sessionIds.length ?? 0,
      busy: false,
      onSync: noop,
      t,
    }),
    h(
      'div',
      { style: STYLE.body },
      tabBody({
        project,
        sessionId,
        groups,
        busy: false,
        policy: project === undefined ? undefined : designPolicy(props.variant),
        onRelease: noop,
        sessionLogCount: sessionLogCount(session),
        t,
        hostT: props.hostT,
      }),
    ),
  )
}

/**
 * The tab's own settings popup, drawn from a picture.
 *
 * Same shape as `ProjectMcpSettings`: the poll-interval row first, then the bar
 * that names the surface, counts the projects and offers `Sync`/`Close`, and a
 * body rendering one `ProjectBlock` per project — the product's own components,
 * fed here. The row is shared with the product rather than redrawn, so the two
 * cannot drift on the control this port moved into the popup.
 * @param props - the picture, the interval, the close seat and the translate seats.
 * @returns the popup element tree.
 */
export function DesignPopup(props: {
  variant: DesignVariant
  refreshMs: number
  onRefreshMs?: ((value: number) => void) | undefined
  onClose?: (() => void) | undefined
  t?: Translate | undefined
  /** Host-namespace seat for the fixtures' coded payload fields (F-48). */
  hostT?: Translate | undefined
}): ReactNode {
  const t = translateOf(props.t)
  const projects = designPicture(props.variant).projects
  return h(
    'div',
    { style: STYLE.root },
    h(
      'div',
      { style: STYLE.bar },
      h('span', { style: STYLE.name }, t('mountedPerProject')),
      h('span', { style: STYLE.muted }, t('projectsCount', { count: projects.length })),
      h('span', { style: { flex: 1 } }),
      h('button', { style: STYLE.button, onClick: noop }, t('sync')),
      props.onClose === undefined
        ? null
        : h('button', { style: STYLE.button, onClick: () => props.onClose?.() }, t('close')),
    ),
    h(RefreshRow, { refreshMs: props.refreshMs, onRefreshMs: props.onRefreshMs, t }),
    h(
      'div',
      { style: STYLE.body },
      projects.length === 0
        ? h('div', { style: { ...STYLE.muted, padding: 8 } }, t('nothingMounted'))
        : projects.map((project) =>
            h(ProjectBlock, {
              key: project.projectRoot,
              project,
              busy: false,
              onRelease: noop,
              t: props.t,
              hostT: props.hostT,
            }),
          ),
    ),
  )
}

/**
 * The native Settings page, drawn from a picture.
 *
 * `SettingsPage` is a pure function of its props, so the design mode supplies
 * the state the real `SettingsTab` owns — view, page, selection, JSON — and the
 * fixture snapshot, and lets the page render itself. The editor's write path is
 * the one thing the mode does not simulate: there is no host to write to, so the
 * draft stays empty and `Save…` never becomes live.
 * @param props - the picture and the translate seat.
 * @returns the settings page element tree.
 */
export function DesignSettingsTab(props: {
  variant: DesignVariant
  t?: Translate | undefined
  /** The host namespace's seat, forwarded to the page like the product does. */
  hostT?: Translate | undefined
}): ReactNode {
  const t = translateOf(props.t)
  const [view, setView] = useState<SettingsView>(DEFAULT_SETTINGS_VIEW)
  const [page, setPage] = useState<SettingsPageKey>(DEFAULT_SETTINGS_PAGE)
  const [selectedServer, setSelectedServer] = useState<string | undefined>(undefined)
  const [json, setJson] = useState(false)
  const narrow = useNarrowSettings()
  const snapshot = designPicture(props.variant)
  const project = snapshot.projects[0]
  return h(SettingsPage, {
    snapshot,
    error: undefined,
    busy: false,
    view,
    onView: setView,
    page,
    onPage: setPage,
    onMode: noop,
    modePending: NO_PENDING,
    modeError: undefined,
    selectedRoot: project?.projectRoot,
    onSelectProject: noop,
    selectedServer,
    onSelectServer: setSelectedServer,
    onSync: noop,
    onRetry: noop,
    json,
    onJson: setJson,
    draft: undefined,
    confirming: false,
    consent: false,
    saveState: undefined,
    saving: false,
    onDraft: noop,
    onDiscard: noop,
    onAskSave: noop,
    onCancelSave: noop,
    onConsent: noop,
    onConfirmSave: noop,
    onReRead: noop,
    narrow,
    t,
    hostT: props.hostT,
  })
}

/**
 * The tab body the entry hands to {@link registerSidebarTab}.
 *
 * The entry already bound both translate seats, so the adapter only forwards the
 * framework's own session and the fixture the mode was started with — the
 * product's own adapter (`LocalizedPanel` in `./index.ts`) does the same with the
 * real panel.
 * @param props - the body's props, seats included.
 * @returns the fixture panel.
 */
export function LocalizedDesignPanel(props: SidebarTabBodyProps & { variant?: DesignVariant }): ReactNode {
  const variant = props.variant ?? 'full'
  return h(DesignPanel, { variant, sessionId: props.sessionId, t: props.t, hostT: props.hostT })
}

/**
 * The settings popup's fixture content.
 *
 * Same chrome as the product's popup — the poll-interval row first, then the
 * per-project blocks — with the stand's fixtures behind it. The interval row is
 * the shared {@link RefreshRow}, so the stand cannot drift from the product on
 * the control the port moved here.
 * @param props - the popup's props, seats included, plus the fixture variant.
 * @returns the fixture popup.
 */
export function LocalizedDesignPopup(props: SidebarSettingsProps & { variant?: DesignVariant }): ReactNode {
  const variant = props.variant ?? 'full'
  return h(DesignPopup, {
    variant,
    refreshMs: props.refreshMs,
    onRefreshMs: props.onRefreshMs,
    onClose: props.onClose,
    t: props.t,
    hostT: props.hostT,
  })
}


/**
 * The frame-wide toast stack, repeating its three fixture banners.
 *
 * The product's stack reads a status channel; here the store is filled directly
 * from {@link DESIGN_TOASTS} and refilled on a timer, because a banner lives
 * three seconds and a design surface has to still be on screen when someone
 * looks at it.
 * @param services - the injected `slots` service, and the locale seat.
 */
export function registerDesignToasts(services: ToastsServices): void {
  const store = createToastStore()
  services.slots.inject(TOASTS_SLOT, () => {
    const entry = services.slots.register(
      { name: TOASTS_SLOT, id: TOASTS_ID, order: TOASTS_ORDER },
      () => h(ToastStack, { store, locale: services.locale }),
    )
    let index = 0
    const push = (): void => {
      const draft = DESIGN_TOASTS[index % DESIGN_TOASTS.length]
      index += 1
      if (draft !== undefined) store.push(draft)
    }
    push()
    const timer = setInterval(push, DESIGN_TOAST_ROTATE_MS)
    return () => {
      clearInterval(timer)
      entry()
    }
  })
}

/**
 * Register the fixture surfaces on the browser half.
 *
 * Mirrors `apply`'s own wiring exactly — the tab behind the right sidebar's
 * settings page behind `slots` + `locale`, the toasts behind `slots` alone — so
 * the design mode is a drop-in replacement for the real one and a composition
 * missing a service behaves the same way in both.
 * @param ctx - client root context.
 * @param variant - the picture to draw; read from the flag when omitted.
 */
export function registerDesignSurfaces(
  ctx: Context,
  variant: DesignVariant = designVariantOf(browserStorage()) ?? 'full',
): void {
  const locale = localeServiceOf(ctx)
  const t = tabTranslate(locale)

  // The same four seats the product registers, from the fixtures: the stand has
  // to draw the surface the port produced — a right-sidebar tab, one actions-menu
  // row and the popup in the frame-wide floating layer — or it would be comparing
  // the product against a surface that no longer exists.
  ctx.inject(['slots', 'sidebarRightTabs'], (scope) => {
    registerSidebarTab(scope as unknown as SidebarTabServices, {
      locale,
      // The stand reads and writes the same browser-local interval the product
      // does, so the row a designer presses there behaves exactly like the row
      // the product shows.
      refresh: createRefreshStore(),
      body: (props) =>
        h(LocalizedDesignPanel, { ...props, variant }),
      settings: (props) =>
        h(LocalizedDesignPopup, { ...props, variant }),
      copy: {
        title: () => t('designTitle', { variant }),
        description: () => t('designDesc', { variant }),
      },
    })
  })

  ctx.inject(['slots', 'locale'], (scope) => {
    const services = scope as unknown as SettingsSlotServices
    // The same one call with all three tables as the product entry. No
    // `addLanguage` of its own: `apply()` returns early in design mode, so
    // the entry — the only place that names Russian to the shell — never runs
    // in this mode. The registration alone is still valid: its `ru` keys are
    // simply unused, and anything unresolved falls back to English.
    services.effect(
      () => services.locale.register(NS, { zh, en, ru }),
      'dsh-project-mcp: design settings dictionary',
    )
    services.effect(
      // The host-code namespace, beside the UI one as in the product entry.
      () => services.locale.register(NS_HOST, { zh: hostZh, en: hostEn, ru: hostRu }),
      'dsh-project-mcp: design host dictionary',
    )
    registerSettingsTab(services, (props: SettingsTabProps) =>
      h(DesignSettingsTab, { variant, t: props.t, hostT: props.hostT }),
    )
  })

  ctx.inject(['slots', 'locale'], (scope) => {
    registerDesignToasts(scope as unknown as ToastsServices)
  })
}
