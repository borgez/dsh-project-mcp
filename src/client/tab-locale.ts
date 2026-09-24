/**
 * The translate seat of the sidebar tab.
 *
 * The native Settings page registers through `settings.section` / `slots`,
 * which hands its component the framework's own `t` seat. The tab has neither:
 * it is created by the sidebar service, so its
 * panel used to render the module's English dictionary while the rest of the
 * shell followed the language preference.
 *
 * The tab's translator is built here, out of the one locale face the shell
 * publishes on the client context (`ctx.get('locale')` — the DSH `LocaleRuntime`
 * every dictionary registers into): the component binds the plugin's namespace
 * to it, subscribes to the locale snapshot, and repaints on a language switch.
 * The same namespace is registered from `./index.ts` with the merged
 * three-language dictionary, so a key the shell translates wins, and the
 * fallback inside {@link uiTranslate} is only the last resort for a composition
 * without a locale service — a test, or a browser half newer than the host.
 *
 * @module dsh-project-mcp/client/tab-locale
 */

import { useEffect, useState } from 'react'
import { uiTranslate } from './locales/ui.ts'
import type { Translate } from './view.ts'

/**
 * The slice of the client locale service the tab needs, mirrored structurally.
 *
 * The DSH client packages are provided by the web shell and are not dependencies
 * of this one, so the seat is bound by shape rather than by import — the same
 * reason the settings page mirrors its slot services. `subscribe` is optional:
 * a service that publishes no snapshot never notifies, and the tab then renders
 * whatever language it was opened in.
 */
export interface TabLocale {
  /** Bind one namespace to a translate function that follows the active locale. */
  bind(namespace: string): Translate
  /** Subscribe to locale changes (a language switch or a late registration). */
  subscribe?(listener: () => void): () => void
}

/**
 * The locale service out of the client context, when the composition has one.
 *
 * The read goes through `ctx.get`, never through a property: Cordis throws
 * `cannot get property "locale" without inject` for a service this fiber did not
 * declare, and that throw takes the whole web client boot down with it. A
 * composition without a locale service answers `undefined`, and the tab keeps
 * its own English table.
 * @param ctx - the client context `apply` was called with.
 * @returns the locale service, or undefined when there is none.
 */
export function localeServiceOf(ctx: unknown): TabLocale | undefined {
  if (ctx === null || typeof ctx !== 'object') return undefined
  const get = (ctx as { get?: unknown }).get
  if (typeof get !== 'function') return undefined
  const candidate = (get as (name: string) => unknown).call(ctx, 'locale')
  if (candidate === null || typeof candidate !== 'object') return undefined
  return typeof (candidate as Partial<TabLocale>).bind === 'function'
    ? (candidate as TabLocale)
    : undefined
}

/**
 * The tab's translator, bound to the shell's locale service.
 *
 * A thin delegate to {@link uiTranslate}, the one translator both seats share:
 * the bound namespace answers first, the merged English table answers a key
 * the active language lacks, and the raw key shows only when even English has
 * nothing for it.
 * @param locale - the locale service, when there is one.
 * @returns a translate function that always answers.
 */
export function tabTranslate(locale: TabLocale | undefined): Translate {
  return uiTranslate(locale)
}

/**
 * The tab's translator as a hook: bound once, re-bound when the language
 * changes.
 *
 * The tab component is the one surface of this plugin rendered outside the slot
 * framework, so it is the one place a repaint has to be asked for explicitly.
 * @param locale - the locale service, when there is one.
 * @returns the translate seat the panel renders through.
 */
export function useTabTranslate(locale: TabLocale | undefined): Translate {
  const [seat, setSeat] = useState<Translate>(() => tabTranslate(locale))
  useEffect(() => {
    setSeat(tabTranslate(locale))
    return locale?.subscribe?.(() => setSeat(tabTranslate(locale)))
  }, [locale])
  return seat
}
