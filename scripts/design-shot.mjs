#!/usr/bin/env node
/**
 * Screenshot the plugin's real surfaces, out of a live DSH profile.
 *
 * The mockup in `docs/design/mockups/harness.html` is the approved picture; this script is
 * how the actual product is put next to it: boot a profile whose plugin is a
 * `link:` to this checkout, drive chromium over CDP, open the sidebar tab and
 * capture it. `docs/design/mockups/harness.html` shows the mockup; this shows what the
 * plugin draws today.
 *
 * Usage:
 *   node scripts/design-shot.mjs --probe                  # what is on the page
 *   node scripts/design-shot.mjs [--profile test-web] [--out shot.png]
 *                                [--tab "MCP"] [--settle 1200] [--keep]
 *
 * `--probe` prints the tab strip and the panels it finds, which is what to
 * adjust `--tab` or `--clip` against when the shell's markup moves.
 *
 * Exit codes: 0 captured, 1 the page never mounted, 2 setup problem.
 *
 * @module scripts/design-shot
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { armChildReaper, reapOrphanedServers } from './dsh-reaper.mjs'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const PROFILE = argument('--profile', 'test-web')
const OUT = argument('--out', join(tmpdir(), 'design-shot.png'))
const TAB_TEXT = argument('--tab', 'MCP')
const SETTLE_MS = Number(argument('--settle', '1500'))
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
  if (value === undefined || value.startsWith('--')) fail(`design-shot: ${name} needs a value`, 2)
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
  fail('design-shot: no chromium found (install playwright or chrome)', 2)
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
  const child = spawn(DSH_BIN, ['--profile', PROFILE, '--no-open', '--port', '0'], {
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

/** Connect to the page target of a chromium started with a debugging port. */
async function connect(chrome, url) {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-shot-chrome-'))
  const child = spawn(
    chrome.path,
    [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--disable-background-networking',
      '--remote-debugging-port=0',
      '--window-size=1000,820',
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
          shell:
            document.querySelector('[aria-label*="right sidebar" i]') !== null ||
            document.body.innerText.includes('Workspaces'),
        })`,
      )
      .catch(() => undefined)
    if (state !== undefined) {
      const parsed = JSON.parse(state)
      if (parsed.children > 0 && parsed.boot === null && parsed.shell === true) return parsed
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error('the page never mounted')
}

/** What the shell has on it: the tab strip and anything of ours. */
async function probe(page) {
  return JSON.parse(
    await page.value(`JSON.stringify((() => {
      const text = (node) => (node.innerText ?? '').replace(/\\s+/g, ' ').trim().slice(0, 60)
      const rect = (node) => { const r = node.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] }
      const tabs = [...document.querySelectorAll('[role="tab"], [data-tab], nav button, [class*="tab"]')]
        .filter((node) => text(node) !== '')
        .slice(0, 24)
        .map((node) => ({ tag: node.tagName.toLowerCase(), id: node.id || null, cls: String(node.className).slice(0, 60), text: text(node), rect: rect(node) }))
      const ours = [...document.querySelectorAll('[id*="project-mcp"], [class*="project-mcp"], [data-dsh-tab], [class*="sidebar"]')]
        .slice(0, 16)
        .map((node) => ({ tag: node.tagName.toLowerCase(), id: node.id || null, cls: String(node.className).slice(0, 60), text: text(node), rect: rect(node) }))
      return { tabs, ours, viewport: [innerWidth, innerHeight] }
    })())`),
  )
}

/** Click the tab whose text carries `needle`, then report what appeared. */
async function openTab(page, needle) {
  // The tab lives in the right sidebar's tab strip, and that pane is collapsed
  // by default: opening it is what makes the tab exist in the DOM at all.
  const sidebar = JSON.parse(
    await page.value(`JSON.stringify((() => {
    const vis = (node) => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const open = [...document.querySelectorAll('button,[role="button"]')]
      .filter(vis)
      .find((node) => /open right sidebar/i.test(node.getAttribute('aria-label') ?? ''))
    if (open === undefined) return { opened: false }
    open.click()
    return { opened: true, label: open.getAttribute('aria-label') }
  })())`),
  )
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
  const clicked = JSON.parse(
    await page.value(`JSON.stringify((() => {
    const text = (node) => (node.innerText ?? '').replace(/\\s+/g, ' ').trim()
    const needle = ${JSON.stringify(needle)}.toLowerCase()
    // The rail labels a tab, and the label is what a click must land on: the
    // deepest element whose own text is the needle, else the first control that
    // merely contains it. A plain div needs the pointer events the shell binds.
    const all = [...document.querySelectorAll('*')].filter((node) => text(node).toLowerCase() === needle)
    const controls = [...document.querySelectorAll('[role="tab"], [data-tab], button, [class*="tab"]')]
      .filter((node) => text(node).toLowerCase().includes(needle))
    const target = all[all.length - 1] ?? controls[0]
    if (target === undefined) return { clicked: false, seen: 0 }
    const box = target.getBoundingClientRect()
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...point, button: 0 }))
    }
    target.click()
    return { clicked: true, seen: all.length + controls.length, text: text(target).slice(0, 60), cls: String(target.className).slice(0, 60) }
  })())`),
  )
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
  const panel = JSON.parse(
    await page.value(`JSON.stringify((() => {
      const text = (node) => (node.innerText ?? '').replace(/\\s+/g, ' ').trim().slice(0, 80)
      const rect = (node) => { const r = node.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } }
      const nodes = [...document.querySelectorAll('div,section,aside')]
        .filter((node) => /this session|Sync|Servers|Tools|Logs|Проблемы/i.test(text(node)))
        .map((node) => ({ cls: String(node.className).slice(0, 70), text: text(node), rect: rect(node) }))
      const widest = nodes.sort((left, right) => (right.rect.width * right.rect.height) - (left.rect.width * left.rect.height))[0] ?? null
      return { clicked: ${JSON.stringify(clicked)}, panel: widest, candidates: nodes.length }
    })())`),
  )
  return { sidebar, ...panel }
}

/** Capture the viewport, or a clip when one is given. */
async function shot(page, out, clip) {
  const result = await page.send('Page.captureScreenshot', {
    format: 'png',
    ...(clip === undefined ? { captureBeyondViewport: true } : { clip: { ...clip, scale: 2 } }),
  })
  writeFileSync(out, Buffer.from(result.data, 'base64'))
  return out
}

async function main() {
  const spec = linkedSpec()
  if (spec === undefined) fail(`design-shot: the ${PROFILE} profile does not declare dsh-project-mcp`, 2)
  if (!spec.startsWith('link:')) {
    fail(`design-shot: ${PROFILE} pins ${spec}; a tarball cannot see the working tree — use link:<repo>`, 2)
  }
  const chrome = findChrome()
  const server = await startServer()
  let browser
  try {
    browser = await connect(chrome, server.url)
    await mounted(browser.page)
    if (PROBE) {
      console.log(JSON.stringify(await probe(browser.page), null, 2))
      if (!KEEP) {
        // A probe is cheap to repeat; leave the page open only when asked.
      }
      return
    }
    const opened = await openTab(browser.page, TAB_TEXT)
    console.log(JSON.stringify(opened, null, 2))
    // The whole viewport is the honest picture: the panel only reads as the user
    // sees it next to the rail it lives in. `--clip` narrows it once that is
    // understood.
    const clip = process.argv.includes('--clip') && opened.panel !== null ? opened.panel.rect : undefined
    const out = await shot(browser.page, OUT, clip)
    console.log(`design-shot: ${out}${clip === undefined ? ' (viewport)' : ` (clip ${clip.width}x${clip.height})`}`)
  } finally {
    browser?.stop()
    await stopServer(server)
    reapOrphanedServers(PROFILE)
  }
}

await main()
