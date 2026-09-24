#!/usr/bin/env node
/**
 * Refresh the design-parity gallery under `docs/design/parity/`.
 *
 * Two halves, and they must be regenerated together or the pair lies:
 *
 * - **expected/** — the approved mockups, cropped to one section each, straight
 *   out of `docs/design/mockups/*.html`. No profile, no build: the files are opened from
 *   disk, so a mockup edit shows up here on the next run.
 * - **actual/** — the plugin as it draws today, out of a live profile that links
 *   this checkout. Delegated to the two capture scripts (`design-shot.mjs` for
 *   the sidebar tab, `design-shot-settings.mjs` for the settings page), which
 *   each own their own navigation and theme handling.
 *
 * Usage:
 *   node scripts/design-gallery.mjs [--only expected|actual] [--profile test-web]
 *
 * The pictures are chunky (2x PNG); they live in the repo so a review can point
 * at "this is what it should be, this is what it is" without a live session.
 *
 * @module scripts/design-gallery
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const DESIGN = join(REPO, 'docs', 'design')
const OUT = join(DESIGN, 'parity')
const EXPECTED = join(OUT, 'expected')
const ACTUAL = join(OUT, 'actual')
const PROFILE = argument('--profile', 'test-web')
const ONLY = argument('--only', undefined)

/**
 * One crop of one mockup: the section that answers a surface of the product.
 *
 * The table lives in `scripts/design-sections.json` because the artifact gate in
 * `tests/design-artifacts.spec.ts` checks it too, and a TypeScript file cannot
 * import this module without a declaration. `heading` is matched against the
 * section's own `<h2>` text — that is how the mockups delimit a section — and
 * `selector` narrows the crop to the surface itself, leaving the prose that
 * explains it out of the picture.
 */
const SECTIONS = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'design-sections.json'), 'utf8'))


/** Read `--name value` out of argv. */
function argument(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    console.error(`design-gallery: ${name} needs a value`)
    process.exit(2)
  }
  return value
}

/** Find a chromium able to expose CDP: the playwright cache, then the PATH. */
function findChrome() {
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright')
  if (existsSync(cache)) {
    for (const entry of readdirSync(cache).sort()) {
      const shell = join(cache, entry, 'chrome-headless-shell-mac-arm64/chrome-headless-shell')
      if (existsSync(shell)) return shell
    }
  }
  const found = spawnSync('/usr/bin/which', ['chromium'], { encoding: 'utf8' })
  if (found.status === 0) return found.stdout.trim()
  console.error('design-gallery: no chromium found')
  process.exit(2)
}

/** One CDP page, over the debugging port a headless shell prints on stderr. */
async function withPage(url, run) {
  const chrome = findChrome()
  const profile = mkdtempSync(join(tmpdir(), 'dsh-gallery-'))
  const child = spawn(
    chrome,
    ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=0', '--user-data-dir=' + profile, url],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  child.stderr.setEncoding('utf8')
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('chromium never printed a DevTools endpoint')), 30_000)
    let buffer = ''
    child.stderr.on('data', (chunk) => {
      buffer += chunk
      const match = /DevTools listening on (ws:\/\/\S+)/u.exec(buffer)
      if (match?.[1] === undefined) return
      clearTimeout(timer)
      resolve(match[1])
    })
    child.once('error', reject)
  })
  const port = new URL(endpoint).port
  let target
  for (let attempt = 0; attempt < 60 && target === undefined; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl !== undefined)
    } catch {
      /* the port answers a moment later */
    }
  }
  if (target === undefined) throw new Error('chromium exposed no page target')
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let nextId = 1
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    entry(message)
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)))
      socket.send(JSON.stringify({ id, method, params }))
    })
  const value = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.exception?.description)
    return result.result.value
  }
  await send('Runtime.enable')
  await send('Page.enable')
  try {
    await run({ send, value })
  } finally {
    socket.close()
    child.kill('SIGKILL')
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      /* chromium may still be writing it */
    }
  }
}

/**
 * The rectangle of one mockup section: from its own heading to the next one.
 *
 * The width comes from the widest thing in that band plus the page's own
 * padding, so a section that holds a 900px page mock is cropped to 900px and one
 * that holds a 330px tab is cropped to 330px.
 */
function sectionProbe(heading, selector) {
  return `JSON.stringify((() => {
    const want = ${JSON.stringify(heading)}
    const heads = [...document.querySelectorAll('h2')]
    const index = heads.findIndex((node) => (node.innerText ?? '').includes(want))
    if (index === -1) return null
    const head = heads[index]
    const next = heads[index + 1]
    const top = head.getBoundingClientRect().top
    const bottom = next === undefined ? document.body.scrollHeight : next.getBoundingClientRect().top
    // The surface itself, when the section names one: a section also carries the
    // prose that explains it, and that prose is not what the product is compared
    // against.
    const named = ${JSON.stringify(selector ?? null)}
    if (named !== null) {
      const node = [...document.querySelectorAll(named)].find((each) => {
        const rect = each.getBoundingClientRect()
        return rect.height > 0 && rect.top >= top - 1 && rect.top <= bottom
      })
      if (node !== undefined) {
        const rect = node.getBoundingClientRect()
        // The screenshot clip is in page coordinates, the probe measures the
        // viewport, and a live mock scrolls itself to the section its deep link
        // names — so the scroll offset belongs in the rectangle.
        return {
          x: Math.max(0, rect.left - 8) + window.scrollX,
          y: Math.max(0, rect.top - 8) + window.scrollY,
          width: rect.width + 16,
          height: rect.height + 16,
        }
      }
    }
    let left = Infinity
    let right = 0
    for (const node of document.querySelectorAll('body *')) {
      const rect = node.getBoundingClientRect()
      if (rect.height === 0 || rect.width === 0) continue
      if (rect.top < top - 1 || rect.top > bottom) continue
      left = Math.min(left, rect.left)
      right = Math.max(right, rect.right)
    }
    if (left === Infinity) return null
    return {
      x: Math.max(0, left - 16) + window.scrollX,
      y: Math.max(0, top - 8) + window.scrollY,
      width: Math.min(document.body.scrollWidth, right - left + 32),
      height: bottom - top - 8,
    }
  })())`
}

/**
 * Capture every expected crop out of the mock itself.
 *
 * One mock, several states: a section may carry a `hash`, and the page is opened
 * with it so a crop can show a disclosure or a settings view that the file keeps
 * closed by default (`#dark,tab,logs`, `#dark,settings,tools`). Rows that share
 * one file **and** one hash share a page load.
 */
async function expected() {
  mkdirSync(EXPECTED, { recursive: true })
  const byState = new Map()
  for (const section of SECTIONS) {
    const state = `${section.file}${section.hash ?? ''}`
    const list = byState.get(state) ?? []
    list.push(section)
    byState.set(state, list)
  }
  for (const sections of byState.values()) {
    const file = sections[0].file
    const hash = sections[0].hash ?? ''
    const path = join(DESIGN, file)
    await withPage(`file://${path}${hash}`, async ({ send, value }) => {
      // The mock is a live document: its own script sets the theme and applies
      // the deep link, so a crop taken before `load` shows the default state and
      // silently lies about the section it names.
      await value(`new Promise((resolve) => {
        if (document.readyState === 'complete') resolve(true)
        else window.addEventListener('load', () => resolve(true), { once: true })
      })`)
      for (const section of sections) {
        // The mockups open dark; the light palette is a mockup of its own, so the
        // crop is pinned to dark — the same theme the whole page uses.
        const rect = JSON.parse((await value(sectionProbe(section.heading, section.selector))) ?? 'null')
        if (rect === null) {
          console.error(`design-gallery: no section «${section.heading}» in ${file}`)
          continue
        }
        const shot = await send('Page.captureScreenshot', {
          format: 'png',
          // A mockup is taller than the window: without this the area under the
          // fold comes back black, which is exactly the picture that lies.
          captureBeyondViewport: true,
          clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 2 },
        })
        writeFileSync(join(EXPECTED, section.out), Buffer.from(shot.data, 'base64'))
        console.log(`expected/${section.out} ← ${file} §«${section.heading}» (${Math.round(rect.width)}×${Math.round(rect.height)})`)
      }
    })
  }
}

/** Ask the two capture scripts for the live half. */
async function actual() {
  mkdirSync(ACTUAL, { recursive: true })
  const tab = join(REPO, 'scripts', 'design-shot.mjs')
  if (existsSync(tab)) {
    const result = spawnSync(process.execPath, [tab, '--profile', PROFILE, '--tab', 'Project MCP', '--clip', '--out', join(ACTUAL, 'tab-light.png')], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 300_000,
    })
    const tail = (result.stdout ?? '').trim().split('\n').slice(-1)[0]
    console.log(result.status === 0 ? `actual/tab-light.png ← design-shot.mjs (${tail})` : `design-gallery: design-shot.mjs failed (${tail})`)
  } else {
    console.log('design-gallery: scripts/design-shot.mjs is absent — the tab half is skipped')
  }
  const settings = join(REPO, 'scripts', 'design-shot-settings.mjs')
  if (existsSync(settings)) {
    const result = spawnSync(process.execPath, [settings, '--profile', PROFILE, '--out-dir', ACTUAL], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 300_000,
    })
    const tail = (result.stdout ?? '').trim().split('\n').slice(-1)[0]
    console.log(result.status === 0 ? `actual/settings-*.png ← design-shot-settings.mjs (${tail})` : `design-gallery: design-shot-settings.mjs failed (${tail})`)
  } else {
    console.log('design-gallery: scripts/design-shot-settings.mjs is absent — the settings half is skipped')
  }
}

// Imported (a test reads {@link SECTIONS} to check the index), the module only
// declares its table; run as a script, it captures. Nothing below runs on import.
export { ACTUAL, EXPECTED, OUT }

const RAN_DIRECTLY =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (RAN_DIRECTLY) {
  mkdirSync(OUT, { recursive: true })
  if (ONLY !== 'actual') await expected()
  if (ONLY !== 'expected') await actual()
  console.log(`design-gallery: ${OUT}`)
}
