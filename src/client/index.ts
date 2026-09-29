/**
 * `dsh-project-mcp`, browser half: a DSH right-sidebar tab that shows which MCP
 * servers each project declares and what is currently mounted for its sessions,
 * its own settings popup in the tab chip's actions menu, a page in DSH's native
 * Settings listing every project with a live session, and a frame-wide toast
 * stack for the servers that come up, fail or are released.
 *
 * The tab is a type of DSH's own right sidebar (`./sidebar-tab.ts`, which mirrors
 * the shipped contract structurally), and the popup is an entry of the frame-wide
 * floating layer. The other three seats are the browser-shell slots
 * `settings.section`, `plugins.bundle.config` and `shell.overlay`. Every seat
 * exists in the browser half only. The host half publishes the same data over
 * `/project-mcp/*` (see `src/ui.ts`), so this module never imports host code at
 * runtime.
 *
 * @module dsh-project-mcp/client
 */

import { createElement } from 'react'
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { PACKAGE_NAME } from '../shared.ts'
import { designModeEnabled, registerDesignSurfaces } from './design.ts'
import { en, ru, zh } from './locales/ui.ts'
import { NS_HOST, en as hostEn, ru as hostRu, zh as hostZh } from './locales/host.ts'
import { registerPluginConfigCard } from './plugin-config.ts'
import type { PluginConfigSlotServices } from './plugin-config.ts'
import { NS, registerSettingsTab } from './settings.ts'
import type { SettingsSlotServices } from './settings.ts'
import { localeServiceOf } from './tab-locale.ts'
import { registerSidebarTab } from './sidebar-tab.ts'
import type { SidebarSettingsProps, SidebarTabBodyProps, SidebarTabServices } from './sidebar-tab.ts'
import { registerToasts } from './toasts.ts'
import type { ToastsServices } from './toasts.ts'
import { ProjectMcpPanel, ProjectMcpSettings, createRefreshStore } from './view.ts'

/** Plugin name: matches the package name and the host half. */
export const name = PACKAGE_NAME

/**
 * Register the surfaces, each behind the services it actually needs.
 *
 * No module-level dependency is declared, because every one of them is optional:
 * a module-level `inject` would leave this entry **pending** for good in a
 * composition without the right sidebar, and DSH's web boot audit refuses to
 * start while an entry is pending. `ctx.inject(name, …)` waits for the same
 * services without gating the entry, so a composition without the sidebar keeps
 * the native Settings page, the config card and the toast stack.
 *
 * A service this fiber did not declare must never be read as a property: Cordis
 * throws `cannot get property "…" without inject`, and that throw fails the
 * entry, which takes the whole web client boot down. Optional reads go through
 * {@link Context.get}.
 */
export const inject: string[] = []

/**
 * Register the browser half's surfaces. Every registration returns a disposer and
 * Cordis runs them on fiber disposal, which is what keeps HMR and plugin
 * disabling free of "already registered" failures.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  // The design-only render mode: when the flag names a picture, the four
  // surfaces below are registered from fixtures instead (`./design.ts`). It is a
  // replacement, never an addition — two registrations of one tab type id would
  // fight over the same sidebar cell. The flag is a browser-local preference, so
  // the product and the fixture mode are one bundle apart, not one build apart.
  if (designModeEnabled()) {
    registerDesignSurfaces(ctx)
    return
  }

  // The plugin's own translate seat: the slots below are registered without a
  // locale namespace of their own, because the plugin registers its dictionaries
  // itself and wants the tab to repaint on a language switch either way. The
  // shell's locale service is read with `ctx.get` — this fiber does not declare
  // it — and without one the seat falls back to the merged English table
  // composed in ./locales/ui.ts.
  const locale = localeServiceOf(ctx)

  // The panel's poll interval, shared by the tab it paces and the popup that
  // changes it. One store for both, because the two are not in one tree.
  const refresh = createRefreshStore()

  // The sidebar tab, its chip's settings row and the settings popup itself:
  // `./sidebar-tab.ts` holds the structural contract of DSH's own right sidebar
  // and registers all four seats behind the services they need. `ctx.inject`
  // parks this callback until the slot registry and the tab registry exist, so a
  // composition without a right sidebar still boots everything below.
  ctx.inject(['slots', 'sidebarRightTabs'], (scope) => {
    registerSidebarTab(scope as unknown as SidebarTabServices, {
      locale,
      refresh,
      body: LocalizedPanel,
      settings: LocalizedSettings,
    })
  })

  // The native Settings page. `ctx.inject` runs this callback only once both
  // services exist and unloads it when either goes away: a composition without
  // the web settings shell keeps the sidebar tab above and the toast stack
  // below, it just has no page to add.
  ctx.inject(['slots', 'locale'], (scope) => {
    const services = scope as unknown as SettingsSlotServices
    // The shell ships only `zh` and `en`: Russian is added at runtime, and the
    // add must precede the dictionary registration that uses it. `addLanguage`
    // is read optionally — a shell whose locale service predates the method
    // must still boot, with `ru` keys simply falling back to English.
    services.effect(
      () => services.locale.addLanguage?.({ id: 'ru', label: 'Русский', fallback: 'en' }),
      'dsh-project-mcp: ru language',
    )
    services.effect(
      // One namespace for the whole plugin, one call carrying all three
      // languages: the runtime throws when the same (namespace, locale) pair is
      // registered twice, so three calls are not an option. The tables are the
      // complete ones from ./locales/ui.ts — `en` is the merge of the panel's
      // and the settings page's halves, composed there.
      () => services.locale.register(NS, { zh, en, ru }),
      'dsh-project-mcp: settings dictionaries',
    )
    services.effect(
      // The second namespace, beside the first: the host's coded messages
      // (F-48). Same one-call shape — a duplicate (namespace, locale) pair
      // throws, so the three languages ride a single registration.
      () => services.locale.register(NS_HOST, { zh: hostZh, en: hostEn, ru: hostRu }),
      'dsh-project-mcp: host dictionaries',
    )
    registerSettingsTab(services)
  })

  // The plugin's own configuration card on the Plugins page (F-54), in an
  // inject of its own: `configForms` is optional (DSH before the service's
  // introduction, or a composition without it), and the settings tab above must
  // not depend on it. `locale` rides along because the card declares the
  // plugin's namespace — the dictionaries themselves stay registered by the
  // settings block, whose inject list is a subset of this one's.
  ctx.inject(['slots', 'locale', 'configForms'], (scope) => {
    const services = scope as unknown as PluginConfigSlotServices
    const forms = services.configForms
    // A service that predates `get`/`whileServed` leaves the card absent
    // rather than failing the entry — the same rule the whole file follows.
    if (typeof forms?.get !== 'function' || typeof forms.whileServed !== 'function') return
    registerPluginConfigCard(services)
  })

  // The frame-wide toast stack, in its own inject: a composition without the
  // sidebar still floats banners, and one without the slot registry keeps every
  // other surface. The locale service rides along so a language switch repaints
  // the banners on screen; `shell.overlay` is declared by the layout frame, so
  // `registerToasts` waits for it through `slots.inject` and simply has nothing
  // to register in a shell without a frame.
  ctx.inject(['slots', 'locale'], (scope) => {
    registerToasts(scope as unknown as ToastsServices)
  })
}

/**
 * The sidebar panel.
 *
 * `./sidebar-tab.ts` already bound the two translate seats — the UI namespace and
 * the host-message one — before calling this, so the adapter has nothing left to
 * do but name the component and let React render it as an element rather than as
 * a bare call.
 * @param props - the body's props, seats included.
 * @returns the panel element.
 */
export function LocalizedPanel(props: SidebarTabBodyProps): ReactNode {
  return createElement(ProjectMcpPanel, {
    visible: props.visible,
    sessionId: props.sessionId,
    refreshMs: props.refreshMs,
    t: props.t,
    hostT: props.hostT,
  })
}

/**
 * The settings popup's content, with the same two seats.
 *
 * The popup is an entry of the frame-wide floating layer, so its chrome has to
 * repaint on a language switch exactly like the tab's: the seats are bound per
 * render by `./sidebar-tab.ts`, and this adapter only names the component.
 * @param props - the popup's props, seats included.
 * @returns the settings panel element.
 */
export function LocalizedSettings(props: SidebarSettingsProps): ReactNode {
  return createElement(ProjectMcpSettings, {
    refreshMs: props.refreshMs,
    onRefreshMs: props.onRefreshMs,
    onClose: props.onClose,
    t: props.t,
    hostT: props.hostT,
  })
}
