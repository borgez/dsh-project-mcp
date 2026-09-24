#!/usr/bin/env node
/**
 * E2E: boot this plugin for real, in a browser, before packing anything.
 *
 * The failure this guards against is a **client** one: DSH's web shell refuses
 * to start when any client entry of the boot roster fails to activate
 * (`web boot: N entries did not activate`, thrown by `assertEntriesActive` in
 * the harness), and that only happens inside a browser — `vitest` and
 * `node scripts/audit.mjs` cannot see it. So the check is: boot a profile that
 * links this checkout, open the page in headless chromium, and read the boot
 * page and the console until the application has mounted.
 *
 * The profile is expected to declare the plugin as `link:<repo>` (DSH's
 * `link:` install spec). With a link, a rebuild of `lib/` is picked up by the
 * next boot: no `pnpm pack`, no reinstall, no version bump.
 *
 * Usage:
 *   node scripts/e2e-boot.mjs [--profile test] [--plugin dsh-project-mcp]
 *                             [--budget 60000] [--install] [--url <url>]
 *
 * Exit codes: 0 pass, 1 boot failure, 2 setup problem (no chrome, no link).
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { armChildReaper, reapOrphanedServers } from './dsh-reaper.mjs'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const PLUGIN = argument('--plugin', 'dsh-project-mcp')
const PROFILE = argument('--profile', 'test')
const BUDGET_MS = Number(argument('--budget', '60000'))
const ATTACH_URL = argument('--url', undefined)
const INSTALL = process.argv.includes('--install')
const DUMP_CONSOLE = process.argv.includes('--dump-console')

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE)
const DSH_BIN = process.env.DSH_BIN ?? which('dsh')

/** Read `--name value` out of argv. */
function argument(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) fail(`e2e: ${name} needs a value`, 2)
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

/** Newest matching path, or undefined. */
function newest(candidates) {
  const existing = candidates.filter((path) => existsSync(path))
  if (existing.length < 2) return existing[0]
  return existing.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}

/**
 * Find a chromium able to expose CDP.
 * @returns the binary and whether it is `chrome-headless-shell` (already headless).
 */
function findChrome() {
  if (process.env.DSH_E2E_CHROME !== undefined) {
    return { path: process.env.DSH_E2E_CHROME, shell: true }
  }
  const root = join(homedir(), 'Library', 'Caches', 'ms-playwright')
  if (existsSync(root)) {
    const shells = readdirSync(root)
      .filter((entry) => entry.startsWith('chromium_headless_shell-'))
      .map((entry) => join(root, entry, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'))
    const shell = newest(shells)
    if (shell !== undefined) return { path: shell, shell: true }
    const browsers = readdirSync(root)
      .filter((entry) => entry.startsWith('chromium-'))
      .map((entry) => join(root, entry, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'))
    const browser = newest(browsers)
    if (browser !== undefined) return { path: browser, shell: false }
  }
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  if (existsSync(chrome)) return { path: chrome, shell: false }
  const onPath = which('chromium') ?? which('google-chrome')
  if (onPath !== undefined) return { path: onPath, shell: false }
  fail(
    'e2e: no chromium found. Set DSH_E2E_CHROME to a chromium binary, or install the\n'
      + '     playwright headless shell under ~/Library/Caches/ms-playwright.',
    2,
  )
}

/**
 * Check that the profile links this checkout, not a packed snapshot.
 * @returns the dependency spec found, or undefined.
 */
function linkedSpec() {
  const manifest = join(PROFILE_DIR, 'package.json')
  if (!existsSync(manifest)) return undefined
  const deps = JSON.parse(readFileSync(manifest, 'utf8')).dependencies ?? {}
  return deps[PLUGIN]
}

/** Summarize the built client bundle the boot will read. */
function builtBundle() {
  const bundle = join(REPO, 'lib', 'client.js')
  const manifest = join(REPO, 'package.json')
  const version = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).version : '?'
  if (!existsSync(bundle)) return { version, built: 'MISSING — build before running e2e' }
  return { version, built: statSync(bundle).mtime.toLocaleString('sv-SE').slice(0, 19) }
}

/** Start `dsh` for the profile and resolve the authenticated page URL. */
async function startServer() {
  // Launcher flags come first: the first token the launcher does not recognize
  // starts the app's own arguments, so `web --profile test` would silently boot
  // the `web` profile instead.
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

/** Collapse the shell's one-line-wrapped bundle URL and cap a console message. */
function compact(text) {
  return text
    .replace(/\?\?[^\s()]*/gu, '??<bundles>')
    .replace(/\s+/gu, ' ')
    .slice(0, 600)
}

/** One CDP session over the browser's page target, tracking console output. */
class Page {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.console = []
    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (entry !== undefined) entry(message)
        return
      }
      if (message.method === 'Runtime.consoleAPICalled') {
        const text = (message.params.args ?? [])
          .map((arg) => arg.value ?? arg.description ?? arg.type)
          .join(' ')
        this.console.push(`${message.params.type}: ${compact(text)}`)
      } else if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails
        this.console.push(`exception: ${compact(details.exception?.description ?? details.text)}`)
      } else if (message.method === 'Log.entryAdded') {
        const entry = message.params.entry
        if (entry.level === 'error' || entry.level === 'warning') {
          this.console.push(`${entry.level}: ${compact(entry.text)}`)
        }
      }
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

  /** Snapshot the boot page and the mount point. */
  async snapshot() {
    const result = await this.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        boot: document.querySelector('[data-dsh-boot]') !== null,
        rootChildren: document.getElementById('root')?.children.length ?? -1,
        bootText: document.querySelector('[data-dsh-boot]')?.innerText ?? '',
      })`,
      returnByValue: true,
    })
    return JSON.parse(result.result.value)
  }
}

/** Connect to the page target of a chromium started with --remote-debugging-port=0. */
async function connect(chrome, url) {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-e2e-chrome-'))
  const child = spawn(chrome.path, [
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--disable-background-networking',
    '--remote-debugging-port=0',
    ...(chrome.shell ? [] : ['--headless=new']),
    '--user-data-dir=' + profile,
    url,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stderr.setEncoding('utf8')
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('chromium never printed a DevTools endpoint'))
    }, 30_000)
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
    await new Promise((resolve) => {
      setTimeout(resolve, 250)
    })
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
  await page.send('Log.enable')
  return {
    page,
    stop: () => {
      socket.close()
      child.kill('SIGKILL')
      try {
        rmSync(profile, { recursive: true, force: true })
      } catch {
        // Chromium may still be writing its profile; a leftover temp dir is harmless.
      }
    },
  }
}

/**
 * Open the page and wait until the application mounts, the boot page reports a
 * failure, or the budget runs out.
 */
async function observe(chrome, url) {
  const session = await connect(chrome, url)
  const deadline = Date.now() + BUDGET_MS
  let snapshot = { boot: true, rootChildren: -1, bootText: '' }
  try {
    while (Date.now() < deadline) {
      snapshot = await session.page.snapshot()
      if (/did not activate|Failed to load plugins/u.test(snapshot.bootText)) {
        return { ok: false, snapshot, console: session.page.console }
      }
      if (!snapshot.boot && snapshot.rootChildren > 0) {
        return { ok: true, snapshot, console: session.page.console }
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 500)
      })
    }
    return { ok: false, snapshot, console: session.page.console, timedOut: true }
  } finally {
    session.stop()
  }
}

const link = linkedSpec()
const bundle = builtBundle()
console.log(`e2e boot: profile=${PROFILE}  plugin=${PLUGIN}@${bundle.version}`)
console.log(`  repo:     ${REPO}`)
console.log(`  profile:  ${PROFILE_DIR}`)
console.log(`  link:     ${link ?? '(not declared)'}`)
console.log(`  bundle:   lib/client.js built ${bundle.built}`)

if (link === undefined || !link.startsWith('link:')) {
  const command = `${DSH_BIN ?? 'dsh'} plugin --profile ${PROFILE} add link:${REPO}`
  if (!INSTALL) {
    fail(
      `e2e: ${PROFILE} does not declare ${PLUGIN} as a link: dependency (found ${JSON.stringify(link ?? null)}).\n`
        + `     Install it once with:\n       ${command}\n`
        + '     or re-run this script with --install.',
      2,
    )
  }
  console.log(`  installing (${command})`)
  const added = spawnSync(DSH_BIN, ['plugin', '--profile', PROFILE, 'add', `link:${REPO}`], {
    cwd: REPO,
    env: { ...process.env, DSH_HOME },
    stdio: 'inherit',
  })
  if (added.status !== 0) fail(`e2e: plugin install failed (code ${String(added.status)})`, 2)
}

const chrome = findChrome()
console.log(`  headless: ${chrome.path}`)

let server
let exitCode = 1
try {
  let url = ATTACH_URL
  if (url === undefined) {
    server = await startServer()
    url = server.url
  }
  console.log(`  server:   ${url}`)
  const result = await observe(chrome, url)
  if (DUMP_CONSOLE) {
    console.log(`  console:  ${String(result.console.length)} message(s)`)
    for (const line of result.console) console.log(`    ${line}`)
  }
  if (result.ok) {
    console.log('  page:     #root mounted, no boot page left, no console errors')
    console.log(`\nPASS: every client entry activated (${PLUGIN} linked, ${bundle.version}).`)
    exitCode = 0
  } else {
    console.error('\nFAIL: the web client did not finish booting.')
    if (result.snapshot.bootText.length > 0) {
      console.error(`  boot page:\n    ${result.snapshot.bootText.split('\n').join('\n    ')}`)
    } else {
      console.error(`  boot page: absent; #root has ${String(result.snapshot.rootChildren)} children`)
    }
    if (result.timedOut === true) console.error(`  timed out after ${String(BUDGET_MS)}ms`)
    if (result.console.length > 0) {
      console.error(`  console (last ${String(Math.min(result.console.length, 12))}):`)
      for (const line of result.console.slice(-12)) console.error(`    ${line}`)
    }
    exitCode = 1
  }
} catch (error) {
  console.error(`\nFAIL: ${error instanceof Error ? error.message : String(error)}`)
  exitCode = 1
} finally {
  await stopServer(server)
  // A server this run could not stop — and one an earlier interrupted run left —
  // is swept here: a live `dsh` keeps the profile's sessions held.
  reapOrphanedServers(PROFILE)
}
process.exit(exitCode)
