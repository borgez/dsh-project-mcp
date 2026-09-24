/**
 * `dsh-project-mcp`, browser half: a DSH sidebar tab that shows which MCP
 * servers each project declares and what is currently mounted for its sessions,
 * its own settings panel in the side card settings popup, a page in DSH's
 * native Settings listing every project with a live session, and a frame-wide
 * toast stack for the servers that come up, fail or are released.
 *
 * Registered through the `dsh-better-sidebar` service and two browser-shell
 * seats — the `settings.section` slot and the `shell.overlay` floating layer.
 * Both seats exist in the browser half only. The
 * host half publishes the same data over `/project-mcp/*` (see `src/ui.ts`), so
 * this module never imports host code at runtime.
 *
 * @module dsh-project-mcp/client
 */

import { createElement, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { BetterSidebarService, TabDescriptor } from 'dsh-better-sidebar'
import type { Context } from '@deepseek-ai/cordis'
import { PACKAGE_NAME, TAB_ID } from '../shared.ts'
import { designModeEnabled, registerDesignSurfaces } from './design.ts'
import { en, ru, zh } from './locales/ui.ts'
import { NS_HOST, en as hostEn, ru as hostRu, zh as hostZh, hostTranslate } from './locales/host.ts'
import { NS, registerSettingsTab } from './settings.ts'
import type { SettingsSlotServices } from './settings.ts'
import { localeServiceOf, tabTranslate, useTabTranslate } from './tab-locale.ts'
import type { TabLocale } from './tab-locale.ts'
import { registerToasts } from './toasts.ts'
import type { ToastsServices } from './toasts.ts'
import {
  ProjectMcpPanel,
  ProjectMcpSettings,
  REFRESH_KEY,
  pluginSettingsOf,
  refreshMsOf,
} from './view.ts'

/** Plugin name: matches the package name and the host half. */
export const name = PACKAGE_NAME

/**
 * Register the three surfaces, each behind the service it actually needs.
 *
 * No module-level dependency is declared, because the sidebar is optional: a
 * module-level `inject` would leave this entry **pending** for good in a
 * composition without `dsh-better-sidebar`, and DSH's web boot audit refuses to
 * start while an entry is pending. `ctx.inject(name, …)` waits for the same
 * service without gating the entry, so a composition without the sidebar keeps
 * the native Settings page and the toast stack.
 *
 * A service this fiber did not declare must never be read as a property: Cordis
 * throws `cannot get property "…" without inject`, and that throw fails the
 * entry, which takes the whole web client boot down. Optional reads go through
 * {@link Context.get}.
 */
export const inject: string[] = []

/**
 * Register the browser half's surfaces. `registerTab` returns a disposer and
 * Cordis runs it on fiber disposal, which is what keeps HMR and plugin disabling
 * free of "already registered" failures.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  // The design-only render mode: when the flag names a picture, the three
  // surfaces below are registered from fixtures instead (`./design.ts`). It is a
  // replacement, never an addition — two registrations of one tab id would fight
  // over the same sidebar cell. The flag is a browser-local preference, so the
  // product and the fixture mode are one bundle apart, not one build apart.
  if (designModeEnabled()) {
    registerDesignSurfaces(ctx)
    return
  }

  // The tab is the one surface rendered outside the slot framework, so it is
  // also the one that has to bind its own translate seat: the shell's locale
  // service, read with `ctx.get` because this fiber does not declare it, with
  // the plugin's dictionary registered below. Without a locale service the seat
  // falls back to the merged English table composed in ./locales/ui.ts.
  const locale = localeServiceOf(ctx)
  const t = tabTranslate(locale)

  // The sidebar tab. `ctx.inject` parks this callback until the service exists
  // and re-runs it when the service is replaced, so a composition without the
  // sidebar simply has no tab while everything below still registers.
  ctx.inject(['betterSidebar'], (scope) => {
    const betterSidebar = (scope as unknown as { betterSidebar: BetterSidebarService }).betterSidebar
    scope.effect(() =>
      betterSidebar.registerTab({
        id: TAB_ID,
        title: () => t('tab'),
        description: () => t('tabDescription'),
        order: 55,
        single: true,
        settings: {
          pluginToggles: [
            {
              key: REFRESH_KEY,
              // Live copy, the closure shape: the sidebar's `SidebarSettingToggle`
              // declares `title`/`desc` as `string | (() => string)` ("i18n
              // friendly", service.ts), exactly like the descriptor's own title
              // above, so the row re-reads the seat on every render and no
              // re-registration is needed. (The alternative — strings resolved
              // at registration plus a re-register on locale change — would
              // leave the row frozen until then.)
              title: () => t('refreshTitle'),
              desc: () => t('refreshDesc'),
              type: 'number',
              min: 1_000,
              max: 60_000,
              unit: 'ms',
            },
          ],
          render: (props: Parameters<NonNullable<NonNullable<TabDescriptor['settings']>['render']>>[0]) =>
            createElement(LocalizedSettings, {
              pluginSettings: props.pluginSettings,
              updatePluginSetting: props.updatePluginSetting,
              onClose: props.close,
              locale,
            }),
        },
        // `LocalizedPanel` re-binds the seat when the shell's language changes:
        // the descriptor's own title is read again by the sidebar on every render,
        // and the panel below it subscribes to the same service.
        component: (props: Parameters<TabDescriptor['component']>[0]) =>
          createElement(LocalizedPanel, {
            locale,
            visible: props.visible,
            sessionId: props.scope.sessionId,
            refreshMs: refreshMsOf(pluginSettingsOf(betterSidebar.getSnapshot())),
          }),
      }),
    )
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
 * The sidebar panel with its translate seat.
 *
 * `useTabTranslate` binds the plugin's namespace to the shell's locale service
 * and subscribes to the locale snapshot, so a language switch repaints the tab —
 * the one thing the settings page gets from the slot framework for free.
 * @param props - the panel's props plus the locale service, when there is one.
 * @returns the panel element with its translator.
 */
export function LocalizedPanel(props: {
  locale: TabLocale | undefined
  visible: boolean
  sessionId: string | undefined
  refreshMs: number
}): ReactNode {
  const t = useTabTranslate(props.locale)
  // The host namespace beside the UI one: the Logs tab renders the host's
  // coded events (F-48), and the seat follows the active language the same way
  // `t` does — the repaint rides on `t`'s re-bind.
  const hostT = hostTranslate(props.locale)
  return createElement(ProjectMcpPanel, {
    visible: props.visible,
    sessionId: props.sessionId,
    refreshMs: props.refreshMs,
    t,
    hostT,
  })
}

/**
 * The side card settings popup with the same translate seat.
 *
 * The popup is rendered by the sidebar service too, so it needs the seat for the
 * same reason the tab does: `ProjectMcpSettings` carries no hook of its own, and
 * a language switch should repaint its chrome rather than wait for the next
 * poll.
 * @param props - the popup's props plus the locale service, when there is one.
 * @returns the popup element with its translator.
 */
export function LocalizedSettings(props: {
  locale: TabLocale | undefined
  pluginSettings: Record<string, unknown>
  updatePluginSetting: (key: string, value: unknown) => void
  onClose?: (() => void) | undefined
}): ReactNode {
  const t = useTabTranslate(props.locale)
  // The host namespace beside the UI one: the popup renders the host's coded
  // payload fields (F-48), and the bound seat follows the active language the
  // same way `t` does — the repaint still rides on `t`'s re-bind.
  const hostT = hostTranslate(props.locale)
  return createElement(ProjectMcpSettings, {
    pluginSettings: props.pluginSettings,
    updatePluginSetting: props.updatePluginSetting,
    onClose: props.onClose,
    t,
    hostT,
  })
}
