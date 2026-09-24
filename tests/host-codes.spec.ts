/**
 * Host-code coverage (F-48, Task 6): every wire code the host half can emit
 * exists in all three `projectMcp.host` tables.
 *
 * The scan is a grep, not an import: it reads the four host emission sources
 * as text and keeps every string literal that matches the wire-code grammar —
 * dotted and channel-prefixed, plus `unmounting`, the one non-dotted code
 * that shipped before the grammar settled. Three emission shapes are covered
 * by that one rule:
 *
 * - the `code:` field of an emission object, **including** the `CodedText`
 *   constructions of runtime.ts (the unmount reasons travel as
 *   `{ text, code }` — their `code:` field is the emission);
 * - the companion fields `detailCode:` / `blockedCode:` / `messageCode:` /
 *   `noteCode:`;
 * - the positional arguments of parse.ts's `fail(…)` and write.ts's
 *   `new WriteDocError(…)` — `parse.entry.*` and `write.doc.*` never appear
 *   in a `code:` field at all, so a field-only grep would silently miss them.
 *
 * The five `SaveErrorCode`s (`'failed'`, `'not-found'`, `'blocked'`,
 * `'conflict'`, `'invalid'`) are a different axis — the HTTP status mapping —
 * and are not message codes; the grammar's channel prefixes exclude them.
 *
 * The stay-English sites are deliberately outside this scan: route-local
 * protocol errors of src/ui.ts (they fire on API contract violations by our
 * own client — developer bugs, not user situations), the host logger lines
 * (`project-mcp: …` in DSH's own log, not the UI), and the model-facing files
 * (src/activation.ts, src/guidance.ts, src/bridge.ts — text a model reads,
 * not a person). `scripts/audit.mjs` mirrors this check for the Node side.
 *
 * @module tests/host-codes
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { en, ru, zh } from '../src/client/locales/host.ts'

/** The host sources that emit coded messages. */
const HOST_SOURCES = ['src/runtime.ts', 'src/parse.ts', 'src/write.ts', 'src/notifications.ts']

/**
 * The wire-code grammar: dotted, channel-prefixed — plus `unmounting`, the
 * one non-dotted code (shipped; codes are never renamed).
 */
const CODE_GRAMMAR = /^'((?:write|parse|mount|unmount|idle|conflict|present|save)\.[A-Za-z][\w.]*|unmounting)'$/u

/**
 * Every wire code emitted by the host sources, with the files that emit it.
 * A code literal inside a comment would match too — and failing loudly on it
 * is the safe direction, so comments are not stripped.
 */
function emittedCodes(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>()
  for (const file of HOST_SOURCES) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    for (const match of source.matchAll(/'[^'\n]*'/gu)) {
      if (!CODE_GRAMMAR.test(match[0])) continue
      const code = match[0].slice(1, -1)
      const files = found.get(code) ?? new Set<string>()
      files.add(file)
      found.set(code, files)
    }
  }
  return found
}

const emitted = emittedCodes()

describe('host-code coverage', () => {
  it('the scan is not vacuous: it finds the codes, in every emission shape', () => {
    // 73 codes at HEAD; a broken regex must not let the suite pass empty.
    expect(emitted.size).toBeGreaterThanOrEqual(70)
    const representatives: Array<[string, string]> = [
      ['unmount.reason.unloading', 'a CodedText { text, code } construction'],
      ['unmounting', 'the one non-dotted code'],
      ['parse.entry.noCommand', "a positional fail(…) argument"],
      ['write.doc.invalidJson', 'a positional WriteDocError argument'],
      ['write.blocked.notConfigured', 'a blockedCode: companion'],
      ['save.noPolicyStore', 'a messageCode: companion'],
      ['idle.disabled', 'a detailCode: companion'],
      ['present.ownerNote', 'a noteCode: companion'],
    ]
    for (const [code, shape] of representatives) {
      expect(emitted.has(code), `the scan must see ${code} (${shape})`).toBe(true)
    }
  })

  it.each(['en', 'zh', 'ru'] as const)('every emitted code exists in projectMcp.host.%s', (lang) => {
    const table = { en, zh, ru }[lang]
    for (const [code, files] of emitted) {
      expect(
        Object.hasOwn(table, code),
        `code '${code}' (emitted by ${[...files].join(', ')}) is missing from projectMcp.host.${lang} — ` +
          `add it to the ${lang} table in src/client/locales/host.ts`,
      ).toBe(true)
    }
  })
})
