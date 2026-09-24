/**
 * The approved design artifacts must be regenerated and committed together with
 * whatever they are built from.
 *
 * The gallery under `docs/design/parity/` is not hand-written: it is
 * `scripts/design-gallery.mjs` over the mock (`docs/design/mockups/harness.html`)
 * and a live profile. Editing the mock without rebuilding the tracked half leaves
 * a file that claims to show the design and does not — the kind of drift this spec
 * turns into a failing build, with the command to fix it in the message.
 *
 * The pictures themselves are never compared byte-for-byte: a live capture
 * differs with the browser and the profile, so what is checked here is what can
 * be checked deterministically — every crop's source still carries the section it
 * claims, the gallery's index and its files agree with each other, and the
 * expected side is really the mock's own crops.
 *
 * Only the `expected/` half is tracked: it is the mock's own crops. The `actual/`
 * half is a snapshot of a live profile — generated, git-ignored and absent on a
 * fresh clone — so this spec asks that whatever is on disk is named by the index,
 * not that the machine has run the gallery.
 *
 * @module tests/design-artifacts
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const DESIGN = join(REPO, 'docs', 'design')
const PARITY = join(DESIGN, 'parity')
const README = join(PARITY, 'README.md')
/** The gallery's own table, shared with `scripts/design-gallery.mjs`. */
const SECTIONS_FILE = join(REPO, 'scripts', 'design-sections.json')
/** The one mock: all surfaces, one self-contained page. */
const MOCK = join(DESIGN, 'mockups', 'harness.html')

/** One crop of the mock, as the gallery table declares it. */
interface GallerySection {
  readonly out: string
  readonly file: string
  readonly heading: string
  readonly what: string
  /** Deep link the page is opened with, so a crop can show a hidden state. */
  readonly hash?: string
}

/** The gallery's crop table. */
function sections(): GallerySection[] {
  return JSON.parse(readFileSync(SECTIONS_FILE, 'utf8')) as GallerySection[]
}

/** Every path the gallery README names, with `{a,b}` shorthand expanded. */
function namedIn(readme: string): Set<string> {
  const found = new Set<string>()
  // A glob (`expected/*.png`) is prose in the how-to section, not a file name.
  for (const match of readme.matchAll(/(expected|actual)\/([A-Za-z0-9._{},-]+\.png)/gu)) {
    const half = match[1]
    const tail = match[2]
    if (half === undefined || tail === undefined) continue
    const braces = /\{([^}]+)\}/u.exec(tail)
    const options = braces?.[1]
    if (braces === null || options === undefined) {
      found.add(`${half}/${tail}`)
      continue
    }
    for (const option of options.split(',')) found.add(`${half}/${tail.replace(braces[0], option)}`)
  }
  return found
}

describe('generated design artifacts', () => {
  it('crops every gallery surface from the mock that still carries its section', () => {
    expect(existsSync(MOCK), 'docs/design/mockups/harness.html is missing: the stand has no picture').toBe(true)
    for (const section of sections()) {
      const source = join(DESIGN, section.file)
      expect(existsSync(source), `${section.file} is missing: the gallery crop «${section.out}» has no source`).toBe(true)
      const html = readFileSync(source, 'utf8')
      expect(
        html.includes(section.heading),
        `${section.file} no longer holds the heading «${section.heading}»: fix scripts/design-sections.json and re-run the gallery`,
      ).toBe(true)
      // A state a crop relies on must be reachable by the deep link it declares,
      // and that link must be one the page's own script answers.
      for (const token of (section.hash ?? '').split(',').map((each) => each.trim()).filter(Boolean)) {
        if (token.startsWith('#')) continue
        if (token === 'dark' || token === 'light' || token === 'tab' || token === 'settings') continue
        expect(
          html.includes(`'${token}'`),
          `${section.file} does not answer the deep-link token «${token}» used by «${section.out}»`,
        ).toBe(true)
      }
    }
  })

  it('keeps the gallery index and the gallery files in step', () => {
    expect(existsSync(README), 'docs/design/parity/README.md is missing: the gallery has no index').toBe(true)
    const named = namedIn(readFileSync(README, 'utf8'))

    const expectedOnDisk = new Set(readdirSync(join(PARITY, 'expected')).filter((name) => name.endsWith('.png')))
    for (const name of expectedOnDisk) {
      expect(named.has(`expected/${name}`), `expected/${name} is not listed in docs/design/parity/README.md`).toBe(true)
    }
    for (const section of sections()) {
      expect(
        expectedOnDisk.has(section.out),
        `expected/${section.out} is missing: run \`node scripts/design-gallery.mjs --only expected\` and commit docs/design/parity`,
      ).toBe(true)
    }

    // The actual half is generated and untracked, so an absent directory is a
    // clone that never ran the gallery — not a drifted index. What is on disk
    // still has to be named, and the approved half still has to exist.
    const actualDir = join(PARITY, 'actual')
    const actualOnDisk = existsSync(actualDir) ? readdirSync(actualDir).filter((name) => name.endsWith('.png')) : []
    for (const name of actualOnDisk) {
      expect(named.has(`actual/${name}`), `actual/${name} is not listed in docs/design/parity/README.md`).toBe(true)
    }

    for (const path of named) {
      if (!path.startsWith('expected/')) continue
      expect(
        existsSync(join(PARITY, path)),
        `docs/design/parity/README.md names ${path}, which does not exist: re-run the gallery or fix the index`,
      ).toBe(true)
    }
  })
})
