/**
 * The hook half of the tab's translate seat: a language switch repaints the tab.
 *
 * React is mocked at the module boundary (the same technique the client-bundle
 * spec uses) so the hook's own binding and subscription run without a renderer
 * and without a DOM. What is checked is the wiring a user would notice: the tab
 * starts in the shell's language, follows a switch, and leaves no listener
 * behind when the tab goes away.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { uiTranslate } from '../src/client/locales/ui.ts'
import { RU, localeService } from './helpers/locale.ts'

/** Mutable stand-ins for the two hooks the seat uses, driven per test. */
const hooks = {
  state: undefined as unknown,
  effect: undefined as (() => unknown) | undefined,
}

vi.mock('react', () => ({
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
  useCallback: (callback: unknown) => callback,
  useState: <T,>(initial: T | (() => T)): [T, (next: T) => void] => {
    if (hooks.state === undefined) hooks.state = typeof initial === 'function' ? (initial as () => T)() : initial
    return [
      hooks.state as T,
      (next: T) => {
        hooks.state = next
      },
    ]
  },
  useEffect: (callback: () => unknown) => {
    hooks.effect = callback
  },
}))

const { useTabTranslate } = await import('../src/client/tab-locale.ts')

beforeEach(() => {
  hooks.state = undefined
  hooks.effect = undefined
})

describe('useTabTranslate', () => {
  it('starts from the language the locale service is in', () => {
    const { service } = localeService({ ru: RU }, 'ru')

    expect(useTabTranslate(service)('tab')).toBe('MCP проектов')
  })

  it('re-binds the seat when the locale service notifies', () => {
    const { service, setActive, listeners } = localeService({ ru: RU }, 'en')
    const first = useTabTranslate(service)

    expect(first('tab')).toBe('Project MCP')
    expect(hooks.effect).toBeDefined()
    hooks.effect?.()
    expect(listeners()).toBe(1)

    setActive('ru')
    expect(useTabTranslate(service)('tab')).toBe('MCP проектов')
  })

  it('leaves no listener behind when the tab goes away', () => {
    const { service, listeners } = localeService({ ru: RU })

    useTabTranslate(service)
    const cleanup = hooks.effect?.()

    expect(listeners()).toBe(1)
    expect(typeof cleanup).toBe('function')
    ;(cleanup as () => void)()
    expect(listeners()).toBe(0)
  })

  it('subscribes to nothing when there is no locale service', () => {
    const seat = useTabTranslate(undefined)

    expect(seat('tab')).toBe('Project MCP')
    expect(hooks.effect?.()).toBeUndefined()
  })
})

describe('uiTranslate', () => {
  it('serves English, not the key, when a translation is missing', () => {
    // A shell whose locale dictionary knows only one key of the namespace.
    const { service } = localeService({ ru: { tab: 'MCP проектов' } }, 'ru')
    const t = uiTranslate(service)
    expect(t('tab')).toBe('MCP проектов')
    expect(t('close')).toBe('Close')          // English from the merged table
    expect(t('noSuchKeyAnywhere')).toBe('noSuchKeyAnywhere') // last resort, and only this
  })

  it('serves a settings-only key from the merged table, not the key', () => {
    // `project` exists in the settings half only: a fallback against the
    // panel's table alone would still show the key, the merged one does not.
    const { service } = localeService({ ru: { tab: 'MCP проектов' } }, 'ru')
    const t = uiTranslate(service)

    expect(t('project')).toBe('Project')
  })

  it('answers English for every key when there is no locale service', () => {
    const t = uiTranslate(undefined)

    expect(t('tab')).toBe('Project MCP')
    expect(t('project')).toBe('Project')
  })
})
