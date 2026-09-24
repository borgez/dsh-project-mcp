/**
 * A fake of the slice of the client locale service the plugin binds to.
 *
 * The DSH `LocaleRuntime` keeps one dictionary per namespace and language,
 * binds a namespace to a translate function that follows the active language,
 * lets a plugin add a language the shell does not ship (`addLanguage`), and
 * notifies its subscribers when the language changes. This mirror is what the
 * no-DOM checks of `tests/tab-locale.spec.ts`, `tests/tab-translate.spec.ts`
 * and `tests/client-entry.spec.ts` bind against; English is served from the
 * panel's own table, exactly as the shell's own lookup chain ends in it.
 *
 * Every `register` and `addLanguage` call is recorded, so a spec can assert
 * not only what the seat answers but what the entry named to the shell.
 *
 * @module tests/helpers/locale
 */

import { NS } from '../../src/client/settings.ts'
import type { SlotLocale } from '../../src/client/settings.ts'
import { en } from '../../src/client/view.ts'
import type { TabLocale } from '../../src/client/tab-locale.ts'

/** The other language's table, as a language pack would ship it. */
export const RU: Record<string, string> = {
  tab: 'MCP проектов',
  toolsPinned: 'закреплено',
  toolsHidden: 'скрыто',
}

/** A language the service was asked to add, as the shell would hear it. */
export interface RecordedLanguage {
  id: string
  label: string
  fallback: string
}

/** One `register` call: the namespace and the per-language tables it carried. */
export interface RecordedRegistration {
  namespace: string
  tables: Record<string, Record<string, string>>
}

/**
 * A locale service holding one table per language, like the shell's.
 * @param tables - the plugin's tables by language id (`{ ru: RU }`); English
 *   is served from the panel's own table when no `en` table is passed.
 * @param active - language the service starts in.
 * @returns the service, a way to switch its language, its listener count, and
 *   the `addLanguage` / `register` calls it heard.
 */
export function localeService(
  tables: Record<string, Record<string, string>> = {},
  active = 'en',
): {
  service: TabLocale & SlotLocale
  setActive(id: string): void
  listeners(): number
  languages: RecordedLanguage[]
  registrations: RecordedRegistration[]
} {
  const state = { active, listeners: new Set<() => void>() }
  const english = en as Record<string, string>
  const languages: RecordedLanguage[] = []
  const registrations: RecordedRegistration[] = []
  const service: TabLocale & SlotLocale = {
    bind: (namespace) =>
      (key, params) => {
        const template =
          namespace !== NS ? key : (tables[state.active]?.[key] ?? english[key] ?? key)
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/g, (match, name: string) =>
          name in params ? String(params[name]) : match,
        )
      },
    subscribe: (listener) => {
      state.listeners.add(listener)
      return () => {
        state.listeners.delete(listener)
      }
    },
    register: (namespace, registered) => {
      registrations.push({ namespace, tables: registered })
      return () => undefined
    },
    addLanguage: (input) => {
      languages.push(input)
      return () => undefined
    },
  }
  return {
    service,
    setActive: (id) => {
      state.active = id
      for (const listener of state.listeners) listener()
    },
    listeners: () => state.listeners.size,
    languages,
    registrations,
  }
}
