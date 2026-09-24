/**
 * The sidebar tab's translate seat: the tab follows the shell's language.
 *
 * The tab is the one surface of this plugin the slot framework does not
 * compose, so it is the one that has to bind its own `t`. The checks drive the
 * binding with a fake locale service — the same shape the DSH `LocaleRuntime`
 * publishes on the client context (one dictionary per namespace, `bind`, and a
 * change notification) — and assert the keys the panel renders with. No DOM.
 */

import { describe, expect, it } from 'vitest'
import { uiFallback } from '../src/client/locales/ui.ts'
import { NS } from '../src/client/settings.ts'
import { localeServiceOf, tabTranslate } from '../src/client/tab-locale.ts'
import type { TabLocale } from '../src/client/tab-locale.ts'
import { RU, localeService } from './helpers/locale.ts'

describe('the locale service the tab binds to', () => {
  /** A context double whose service lookup is `get`, the way Cordis serves it. */
  const ctxOf = (services: Record<string, unknown>) => ({
    get: (name: string) => services[name],
  })

  it('reads the locale service through `ctx.get`', () => {
    const { service } = localeService({ ru: RU })

    expect(localeServiceOf(ctxOf({ locale: service }))).toBe(service)
  })

  it('never touches a service property, which Cordis throws on', () => {
    const { service } = localeService({ ru: RU })
    const ctx = {
      get: (name: string) => (name === 'locale' ? service : undefined),
      get locale(): never {
        throw new Error('cannot get property "locale" without inject')
      },
    }

    expect(localeServiceOf(ctx)).toBe(service)
  })

  it('refuses anything that is not a locale service', () => {
    expect(localeServiceOf(undefined)).toBeUndefined()
    expect(localeServiceOf(null)).toBeUndefined()
    expect(localeServiceOf({})).toBeUndefined()
    expect(localeServiceOf({ get: () => undefined })).toBeUndefined()
    expect(localeServiceOf(ctxOf({ locale: {} }))).toBeUndefined()
    // A `bind` that is not a function is not a seat worth calling.
    expect(localeServiceOf(ctxOf({ locale: { bind: 'nope' } }))).toBeUndefined()
  })
})

describe('the tab translator', () => {
  it('renders the dictionary of the language the service is in', () => {
    const { service, setActive } = localeService({ ru: RU })
    const t = tabTranslate(service)

    expect(t('tab')).toBe('Project MCP')
    setActive('ru')
    expect(t('tab')).toBe('MCP проектов')
    // Its own namespace binds its own table: the panel's copy is in it.
    expect(t('toolsPinned')).toBe('закреплено')
    setActive('en')
    expect(t('toolsPinned')).toBe('pinned')
  })

  it('expands `{name}` params through the bound seat', () => {
    const { service } = localeService({ ru: RU })

    expect(tabTranslate(service)('toolsStep', { step: '4' })).toBe('step 4')
    expect(tabTranslate(service)('toolsDemo')).toBe('demo')
  })

  it('answers the panel’s English when there is no locale service at all', () => {
    const t = tabTranslate(undefined)

    expect(t('tab')).toBe('Project MCP')
    expect(t).toBe(uiFallback)
  })

  it('keeps the panel readable for a key the shell has no translation for', () => {
    const { service } = localeService({ ru: { tab: 'MCP проектов' } }, 'ru')

    // Registered namespace, but that one key is missing: the panel's own table
    // is the last resort rather than the raw key on screen.
    expect(tabTranslate(service)('toolsHidden')).toBe('hidden')
  })

  it('survives a service that refuses the namespace', () => {
    const hostile: TabLocale = {
      bind: () => {
        throw new Error('namespace not registered')
      },
    }

    expect(tabTranslate(hostile)('tab')).toBe('Project MCP')
  })

  it('registers under the same namespace as the settings page', () => {
    let asked = ''
    const t = tabTranslate({
      bind: (namespace) => {
        asked = namespace
        return (key) => key
      },
    })

    t('tab')
    expect(asked).toBe(NS)
    expect(NS).toBe('settings.projectMcp')
  })
})
