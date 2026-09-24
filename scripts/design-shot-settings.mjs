#!/usr/bin/env node
/**
 * Screenshot the plugin's own page inside DSH's native Settings.
 *
 * `scripts/design-shot.mjs` captures the sidebar tab. This is the other surface
 * the mockup describes: the `settings.section` page, which the shell renders
 * inside a dialog, not in the viewport. It is also the surface with two pages of
 * its own (`Servers` and `Tools`), so one capture is not the whole picture.
 *
 * The mockup in `docs/design/mockups/harness.html` is the approved picture; this script is
 * how the actual product is put next to it: boot a profile whose plugin is a
 * `link:` to this checkout, drive chromium over CDP, open Settings → Project MCP
 * (the left rail of the dialog), then capture `Servers` and `Tools` in the
 * shell's light and dark themes.
 *
 * Usage:
 *   node scripts/design-shot-settings.mjs --probe        # what is on the page
 *   node scripts/design-shot-settings.mjs [--profile test-web] [--out-dir <dir>]
 *                                        [--settle 1200] [--keep] [--port 0]
 *
 * Output (default under the system temp directory):
 *   settings-servers-light.png · settings-servers-dark.png
 *   settings-tools-light.png   · settings-tools-dark.png
 *   settings-<page>-<theme>.txt  — that page's aria snapshot, so a reader can
 *                                 check the copy without opening the PNG.
 *
 * `--probe` prints the dialog's own structure first, which is what to adjust the
 * click targets against when the shell's markup moves.
 *
 * Exit codes: 0 captured, 1 the page never mounted or Settings never opened,
 * 2 setup problem.
 *
 * @module scripts/design-shot-settings
 */

import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { armChildReaper, reapOrphanedServers } from './dsh-reaper.mjs'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const PROFILE = argument('--profile', 'test-web')
const OUT_DIR = argument('--out-dir', tmpdir())
const SETTLE_MS = Number(argument('--settle', '1200'))
const PORT = argument('--port', '0')
const PROBE = process.argv.includes('--probe')
const KEEP = process.argv.includes('--keep')

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE)
const DSH_BIN = process.env.DSH_BIN ?? which('dsh')

/** Read `--name value` out of argv. */
function argument(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) fail(`design-shot-settings: ${name} needs a value`, 2)
  return value
}

/** Locate a command on PATH without a shell. */
function which(command) {
  const found = spawnSync('/usr/bin/which', [command], { encoding: 'utf8' })
  return found.status === 0 ? found.stdout.trim() : undefined
}

/** Report and exit. */
function fail(message, code = 1) {
  console.error(`\n${message}`)
  process.exit(code)
}

/** Newest of a list of candidate paths, by mtime. */
function newest(candidates) {
  return candidates
    .filter((path) => existsSync(path))
    .map((path) => ({ path, at: statSync(path).mtimeMs }))
    .sort((left, right) => right.at - left.at)[0]?.path
}

/** Find a chromium able to expose CDP: the playwright cache, then the PATH. */
function findChrome() {
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright')
  const candidates = []
  if (existsSync(cache)) {
    for (const entry of readdirSync(cache)) {
      for (const layout of [
        'chrome-headless-shell-mac-arm64/chrome-headless-shell',
        'chrome-headless-shell-mac-x64/chrome-headless-shell',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      ]) {
        candidates.push(join(cache, entry, layout))
      }
    }
  }
  const shell = newest(candidates)
  if (shell !== undefined) return { path: shell, shell: true }
  const chrome = which('google-chrome') ?? which('chromium') ?? which('chromium-browser')
  if (chrome !== undefined) return { path: chrome, shell: false }
  return fail('design-shot-settings: no chromium found (install playwright or chrome)', 2)
}

/** The install spec the profile declares for this plugin. */
function linkedSpec() {
  const manifest = join(PROFILE_DIR, 'package.json')
  if (!existsSync(manifest)) return undefined
  const deps = JSON.parse(readFileSync(manifest, 'utf8')).dependencies ?? {}
  return deps['dsh-project-mcp']
}

/** Start `dsh` for the profile and resolve the authenticated page URL. */
async function startServer() {
  reapOrphanedServers(PROFILE)
  const child = spawn(DSH_BIN, ['--profile', PROFILE, '--no-open', '--port', PORT], {
    cwd: REPO,
    env: { ...process.env, DSH_HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  armChildReaper(child)
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let output = ''
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`dsh web did not become ready in 120s:\n${output.slice(-4000)}`))
    }, 120_000)
    const scan = (chunk) => {
      output += chunk
      const match = /dsh web: (http:\/\/\S+)/u.exec(output)
      if (match?.[1] === undefined) return
      clearTimeout(timer)
      resolve(match[1])
    }
    child.stdout.on('data', scan)
    child.stderr.on('data', scan)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`dsh web exited before printing a URL (code ${String(code)}):\n${output.slice(-4000)}`))
    })
  })
  return { child, url, output: () => output }
}

/** Stop the server process group, escalating to SIGKILL when SIGTERM is ignored. */
async function stopServer(server) {
  if (server === undefined || server.child.exitCode !== null) return
  const pid = server.child.pid
  const exited = new Promise((resolve) => {
    server.child.once('exit', resolve)
  })
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    server.child.kill('SIGTERM')
  }
  const forced = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      server.child.kill('SIGKILL')
    }
  }, 10_000)
  forced.unref()
  await exited
  clearTimeout(forced)
}

/** One CDP session over the browser's page target. */
class Page {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.id === undefined) return
      const entry = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (entry !== undefined) entry(message)
    })
  }

  /** Send one CDP command and await its result. */
  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, (message) => {
        if (message.error !== undefined) reject(new Error(`${method}: ${message.error.message}`))
        else resolve(message.result)
      })
      this.socket.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (!this.pending.delete(id)) return
        reject(new Error(`${method}: timed out`))
      }, 30_000).unref()
    })
  }

  /** Evaluate an expression in the page and return its value. */
  async value(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails !== undefined) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed')
    }
    return result.result.value
  }
}

/** A pause, so the shell can finish a render before the next read. */
function settle(ms = SETTLE_MS) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Connect to the page target of a chromium started with a debugging port. */
async function connect(chrome, url) {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-settings-shot-chrome-'))
  const child = spawn(
    chrome.path,
    [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--disable-background-networking',
      '--remote-debugging-port=0',
      '--window-size=1440,1200',
      ...(chrome.shell ? [] : ['--headless=new']),
      '--user-data-dir=' + profile,
      url,
    ],
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
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`chromium exited early (code ${String(code)})\n${buffer.slice(-2000)}`))
    })
  })
  const port = new URL(endpoint).port
  let target
  for (let attempt = 0; attempt < 60 && target === undefined; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250))
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
  const page = new Page(socket)
  await page.send('Runtime.enable')
  await page.send('Page.enable')
  return {
    page,
    stop: () => {
      socket.close()
      child.kill('SIGKILL')
      if (!KEEP) {
        try {
          rmSync(profile, { recursive: true, force: true })
        } catch {
          /* chromium may still be writing it */
        }
      }
    },
  }
}

/** Wait until the application mounted and the shell's own chrome is up. */
async function mounted(page, budgetMs = 60_000) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const state = await page
      .value(
        `JSON.stringify({
          children: document.getElementById('root')?.children.length ?? -1,
          boot: document.querySelector('[data-dsh-boot]')?.innerText?.slice(0, 200) ?? null,
          shell: document.body.innerText.includes('Settings'),
        })`,
      )
      .catch(() => undefined)
    if (state !== undefined) {
      const parsed = JSON.parse(state)
      if (parsed.children > 0 && parsed.boot === null && parsed.shell === true) return parsed
    }
    await settle(400)
  }
  throw new Error('the page never mounted')
}

/** What the shell has on it: the rail, whatever is modal, and our own page. */
async function probe(page) {
  return JSON.parse(
    await page.value(`JSON.stringify((() => {
      const text = (node) => (node.innerText ?? '').replace(/\\s+/g, ' ').trim().slice(0, 70)
      const rect = (node) => { const r = node.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] }
      const controls = [...document.querySelectorAll('button, [role="button"], [role="tab"], select, input')]
        .filter((node) => text(node) !== '')
        .slice(0, 40)
        .map((node) => ({ tag: node.tagName.toLowerCase(), role: node.getAttribute('role'), text: text(node), rect: rect(node) }))
      const modal = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="dialog"], [class*="modal"]')]
        .map((node) => ({ tag: node.tagName.toLowerCase(), cls: String(node.className).slice(0, 70), text: text(node), rect: rect(node) }))
      return { controls, modal, viewport: [innerWidth, innerHeight], theme: document.documentElement.getAttribute('data-ds-dark-theme') ?? document.documentElement.className }
    })())`),
  )
}

/** Click a visible control whose own text is exactly `label`. */
async function clickByText(page, label) {
  return JSON.parse(
    await page.value(`JSON.stringify((() => {
      const text = (node) => (node.innerText ?? '').replace(/\\s+/g, ' ').trim()
      const visible = (node) => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
      const all = [...document.querySelectorAll('*')]
        .filter((node) => visible(node) && text(node) === ${JSON.stringify(label)})
      const target = all[all.length - 1]
      if (target === undefined) return { clicked: false, seen: 0 }
      const box = target.getBoundingClientRect()
      const point = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...point, button: 0 }))
      }
      target.click()
      return { clicked: true, cls: String(target.className).slice(0, 70), text: text(target) }
    })())`),
  )
}


/** Open the Settings dialog from the left rail. */
async function openSettings(page) {
  const rail = JSON.parse(
    await page.value(`JSON.stringify((() => {
      const text = (node) => (node.innerText ?? '').replace(/\\s+/g, ' ').trim()
      const visible = (node) => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
      const target = [...document.querySelectorAll('button, [role="button"], a, [class*="nav"] *')]
        .filter((node) => visible(node) && text(node).toLowerCase().endsWith('settings'))
        .pop()
      if (target === undefined) return { opened: false }
      const box = target.getBoundingClientRect()
      const point = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...point, button: 0 }))
      }
      target.click()
      return { opened: true, text: text(target), cls: String(target.className).slice(0, 70) }
    })())`),
  )
  if (rail.opened !== true) fail('design-shot-settings: the left rail has no Settings entry', 1)
  await settle()
  return rail
}

/** Whether the dialog is on the page, and what it currently says. */
async function dialogState(page) {
  return JSON.parse(
    await page.value(`JSON.stringify((() => {
      const text = (node) => (node.innerText ?? '').replace(/\\s+/g, ' ').trim()
      const nodes = [...document.querySelectorAll('*')]
        .filter((node) => node.children.length === 0 && text(node) !== '')
      const heading = [...nodes].find((node) => text(node) === 'Settings')
      const dialog = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="dialog"], [class*="modal"]')]
        .sort((left, right) => right.getBoundingClientRect().width - left.getBoundingClientRect().width)[0]
      return {
        open: heading !== undefined && dialog !== undefined,
        heading: heading === undefined ? null : [Math.round(heading.getBoundingClientRect().x), Math.round(heading.getBoundingClientRect().y)],
        entries: [...nodes].slice(0, 60).map((node) => text(node).slice(0, 50)),
        dialog: dialog === undefined ? null : (() => { const r = dialog.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] })(),
      }
    })())`),
  )
}

/** The plugin's page inside the dialog, once the Project MCP row was clicked. */
async function pageState(page) {
  return JSON.parse(
    await page.value(`JSON.stringify((() => {
      const body = document.body.innerText
      return {
        pluginPage: /Project MCP/.test(body),
        tools: /\\bTools\\b/.test(body),
        servers: /Servers/.test(body),
      }
    })())`),
  )
}

/** The whole readable text of the plugin's page, keyed for the before/after diff. */
async function ariaSnapshot(page) {
  return page.value(`(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="dialog"], [class*="modal"]')]
      .sort((left, right) => right.getBoundingClientRect().width - left.getBoundingClientRect().width)[0] ?? document.body
    return dialog.innerText
  })()`)
}

/**
 * Force the shell's theme, the way DSH's own boot does.
 *
 * `boot-theme.ts` toggles `data-ds-dark-theme` on `document.body`, and the
 * palette keys off `body[data-ds-dark-theme]` — setting it on `<html>` renders
 * a second light shot.
 * @param page - the driven page.
 * @param dark - `true` for the dark palette.
 * @returns the attribute as the page now carries it.
 */
async function setTheme(page, dark) {
  const applied = await page.value(`(() => {
    document.body.toggleAttribute('data-ds-dark-theme', ${dark ? 'true' : 'false'})
    return document.body.hasAttribute('data-ds-dark-theme')
  })()`)
  await settle(500)
  return applied
}


/**
 * The By-files view of the server page: the document cards the mockup draws.
 *
 * `Servers` answers with the table by default, so the other half of the page —
 * one card per declaring document, with the count in its head — needs its own
 * capture rather than a second shot of the same table.
 * @param page - the driven page.
 * @param out - file to write the PNG to.
 * @param clip - the dialog rect to capture.
 * @returns the path written, or undefined when the view switch was not found.
 */
async function shotFiles(page, out, clip) {
  // The capture starts on `Tools`, whose toolbar has no view switch, so this
  // walks back to the server page before asking for its by-files reading.
  await clickByText(page, 'Servers')
  await settle()
  const clicked = await clickByText(page, 'By files')
  if (clicked.clicked !== true) return undefined
  await settle()
  await shot(page, out, clip)
  const dump = out.replace(/\.png$/u, '.txt')
  writeFileSync(dump, `${await ariaSnapshot(page)}\n`)
  return out
}

/** Capture the full page, or a clip when one is given. */
async function shot(page, out, clip) {
  const result = await page.send('Page.captureScreenshot', {
    format: 'png',
    ...(clip === undefined ? { captureBeyondViewport: true, fromSurface: true } : { clip: { ...clip, scale: 2 } }),
  })
  writeFileSync(out, Buffer.from(result.data, 'base64'))
  return out
}

async function main() {
  const spec = linkedSpec()
  if (spec === undefined) fail(`design-shot-settings: the ${PROFILE} profile does not declare dsh-project-mcp`, 2)
  if (!spec.startsWith('link:')) {
    fail(`design-shot-settings: ${PROFILE} pins ${spec}; a tarball cannot see the working tree — use link:<repo>`, 2)
  }
  mkdirSync(OUT_DIR, { recursive: true })
  const chrome = findChrome()
  const server = await startServer()
  let browser
  try {
    browser = await connect(chrome, server.url)
    const { page } = browser
    await mounted(page)
    if (PROBE) {
      console.log(JSON.stringify(await probe(page), null, 2))
      return
    }
    const rail = await openSettings(page)
    console.log(`design-shot-settings: Settings ${JSON.stringify(rail)}`)
    const state = await dialogState(page)
    if (!state.open) fail(`design-shot-settings: the Settings dialog did not open\n${JSON.stringify(state, null, 2)}`, 1)
    const entry = await clickByText(page, 'Project MCP')
    console.log(`design-shot-settings: section ${JSON.stringify(entry)}`)
    await settle()
    const onPage = await pageState(page)
    if (onPage.pluginPage !== true) {
      fail(`design-shot-settings: the Project MCP section did not render\n${JSON.stringify(await dialogState(page), null, 2)}`, 1)
    }

    // The dialog's own rect is the honest frame: the surface is a modal, and its
    // width is what the copy has to fit.
    const rect = await page.value(`JSON.stringify((() => {
      const dialog = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="dialog"], [class*="modal"]')]
        .sort((left, right) => right.getBoundingClientRect().width - left.getBoundingClientRect().width)[0]
      const r = dialog.getBoundingClientRect()
      return { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) }
    })())`)
    const clip = JSON.parse(rect)

    const written = []
    for (const theme of ['light', 'dark']) {
      const dark = await setTheme(page, theme === 'dark')
      if (dark !== (theme === 'dark')) {
        fail(`design-shot-settings: the ${theme} palette did not apply (body data-ds-dark-theme is ${String(dark)})`, 1)
      }
      for (const target of [
        { key: 'servers', label: 'Servers' },
        { key: 'tools', label: 'Tools' },
      ]) {
        const clicked = await clickByText(page, target.label)
        await settle()
        const file = join(OUT_DIR, `settings-${target.key}-${theme}.png`)
        await shot(page, file, clip)
        const text = await ariaSnapshot(page)
        const dump = join(OUT_DIR, `settings-${target.key}-${theme}.txt`)
        writeFileSync(dump, `${text}\n`)
        written.push(file)
        console.log(
          `design-shot-settings: ${file} (${clip.width}x${clip.height}) — clicked ${target.label}: ${JSON.stringify(clicked)}`,
        )
      }
      // The server page's other reading: the same project, by document.
      const files = await shotFiles(page, join(OUT_DIR, `settings-files-${theme}.png`), clip)
      if (files !== undefined) {
        written.push(files)
        console.log(`design-shot-settings: ${files} (${clip.width}x${clip.height}) — clicked By files`)
      }
      await clickByText(page, 'Table')
      await settle()
    }
    console.log(`design-shot-settings: ${written.length} shots in ${OUT_DIR}`)
  } finally {
    browser?.stop()
    await stopServer(server)
    reapOrphanedServers(PROFILE)
  }
}

await main()
