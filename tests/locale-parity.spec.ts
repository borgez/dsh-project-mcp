/**
 * The plugin's own dictionaries must stay in step: one key set per namespace,
 * three languages. A key that exists in English and nowhere else is a raw key
 * on screen for a Russian or Chinese user, which is the failure this spec
 * exists to make impossible. It covers both namespaces: the UI copy of
 * `settings.projectMcp` and the host's wire codes of `projectMcp.host` (F-48).
 *
 * The shipped tables are keyed by `UiKey`, which is what makes a missing key a
 * compile error; this spec reads them generically and so walks them by string.
 * That widening happens in {@link byString} and never on the exported tables —
 * declaring *them* string-indexable is exactly what would put the compiler gate
 * back to sleep.
 *
 * @module tests/locale-parity
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { en, ru, zh } from '../src/client/locales/ui.ts'
import { en as hostEn, ru as hostRu, zh as hostZh } from '../src/client/locales/host.ts'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))

const languages = { en, ru, zh } as const

/** The wire-code namespace's three tables (F-48): keyed by `HostCode`. */
const hostLanguages = { en: hostEn, ru: hostRu, zh: hostZh } as const

/** One language's table, read by string key: the generic view this spec needs. */
const byString = (table: Record<string, string>): Record<string, string> => table

describe('client dictionaries', () => {
  it('carry the same key set in every language', () => {
    const reference = Object.keys(en).sort()
    expect(reference.length).toBeGreaterThan(200)
    for (const [id, table] of Object.entries(languages)) {
      expect(Object.keys(table).sort(), `${id} does not match English`).toEqual(reference)
    }
  })

  it('have no empty value in any language', () => {
    for (const [id, table] of Object.entries(languages)) {
      const dictionary = byString(table)
      const empty = Object.keys(en).filter((key) => dictionary[key]?.trim() === '')
      expect(empty, `${id} has empty values: ${empty.join(', ')}`).toEqual([])
    }
  })

  it('keep every interpolation placeholder the English value declares', () => {
    const names = (value: string) => [...value.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]).sort()
    for (const [id, table] of Object.entries(languages)) {
      if (id === 'en') continue
      for (const [key, value] of Object.entries(byString(table))) {
        expect(names(value), `${id}.${key} dropped a placeholder`).toEqual(names(byString(en)[key] ?? ''))
      }
    }
  })

  it('reports the values still identical to English, for the reviewer', () => {
    // Not a gate: some identities are legitimate (`CWD`, `URL`, `✕`, `…`, `On`).
    // This is the list a reviewer reads to find a dictionary that was scaffolded
    // and never translated — the plugin ships it as a log line, not as a failure.
    const identical = Object.keys(en).filter((key) => {
      const source = byString(en)[key]
      return byString(ru)[key] === source && byString(zh)[key] === source
    })
    console.log(`locale-parity: ${String(identical.length)} of ${String(Object.keys(en).length)} values identical to English`)
    if (identical.length > 0) console.log(`locale-parity: first 20 — ${identical.slice(0, 20).join(', ')}`)
  })

  it('every key the client asks for exists in the dictionaries', () => {
    const files = readdirSync(join(REPO, 'src', 'client')).filter((name) => name.endsWith('.ts'))
    const asked = new Map<string, string>()
    for (const name of files) {
      const source = readFileSync(join(REPO, 'src', 'client', name), 'utf8')
      for (const [index, line] of source.split('\n').entries()) {
        if (line.trimStart().startsWith('*')) continue        // prose in doc blocks is not a call
        for (const match of line.matchAll(/\b(?:t|translate)\(\s*'([A-Za-z]\w*)'/gu)) {
          const key = match[1]
          if (key === undefined) continue                     // the group is in the pattern, so this cannot happen
          asked.set(key, `${name}:${String(index + 1)}`)
        }
      }
    }
    const missing = [...asked]
      .filter(([key]) => !(key in en))
      .map(([key, where]) => `${key} (at ${where})`)
    expect(missing, `keys asked for but absent from the dictionaries: ${missing.join(', ')}`).toEqual([])
  })
})

/**
 * The same gate for the second namespace, `projectMcp.host`: its keys are the
 * wire contract (dotted, stable, never renamed), so a language that lacks a
 * code is not a rewording gap but a broken contract — the resolver's last
 * step keeps it off the screen as English, but the tables are what the
 * compiler and this spec keep complete.
 */
describe('host dictionaries', () => {
  it('carry the same key set in every language', () => {
    const reference = Object.keys(byString(hostEn)).sort()
    expect(reference.length).toBeGreaterThan(0)
    for (const [id, table] of Object.entries(hostLanguages)) {
      expect(Object.keys(byString(table)).sort(), `${id} does not match English`).toEqual(reference)
    }
  })

  it('have no empty value in any language', () => {
    for (const [id, table] of Object.entries(hostLanguages)) {
      const empty = Object.entries(byString(table))
        .filter(([, value]) => value.trim() === '')
        .map(([key]) => key)
      expect(empty, `${id} has empty values: ${empty.join(', ')}`).toEqual([])
    }
  })

  it('keep every interpolation placeholder the English value declares', () => {
    const names = (value: string) => [...value.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]).sort()
    for (const [id, table] of Object.entries(hostLanguages)) {
      if (id === 'en') continue
      for (const [key, value] of Object.entries(byString(table))) {
        expect(names(value), `${id}.${key} dropped a placeholder`).toEqual(names(byString(hostEn)[key] ?? ''))
      }
    }
  })
})
