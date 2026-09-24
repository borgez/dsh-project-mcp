#!/usr/bin/env node
/**
 * Design parity: the live sidebar panel against the repository's own frozen
 * contract.
 *
 * The gate no longer compares the product against a picture. The design stand
 * (`docs/design/mockups/harness.html`) is a **proposal**: it is allowed to run
 * ahead of the product in copy and in block scheme, so a line-for-line diff
 * against it would fail on purpose rather than on a defect. What the gate holds
 * instead is the contract the repository pins for itself —
 * `docs/design/contracts/surfaces.md` (what each surface looks like today) and
 * `docs/design/contracts/single-surface.md` (the tab's one surface, F-26) — read
 * as `getComputedStyle` values off the live panel, in the live shell's own theme.
 *
 * How it measures. One chromium target, driven over the raw CDP WebSocket the
 * shot script already uses (no new dependency, the playwright cache's own
 * headless shell). It boots the profile's `dsh web`, installs the fixture below,
 * opens the right sidebar, presses the plugin's tab and reads `getComputedStyle`
 * of the elements the panel draws. Since F-26 the tab is one surface
 * (`docs/design/contracts/single-surface.md`): the capture is anchored on the
 * panel's own scrolling body, and the rows for the folded blocks are read by
 * pressing their disclosure heads and a tool row, closed and opened.
 *
 * Where an expected value comes from. Anything the token layer owns is read from
 * the live theme at run time: the gate freezes *which* `--dsw-alias-*` token a
 * drawn thing must use and compares the resolved colour against it, so a theme
 * switch, a shell upgrade or a re-pointed token is caught without a stored
 * constant. Geometry and type the contract states as literals (`8px`, `50%`,
 * `12px`, `2px 0`, `gap 6px`, `7px 9px`, `9px 10px`, `2px`) are frozen literals.
 * Relations the contract states between two live elements (`.dim` smaller than
 * `.muted`, the tool row reading like a server row, both disclosure labels in
 * one tone, the pane wider than the stand's band) are checked as relations on
 * the one page, never as a shared pixel value neither page can have.
 *
 * Why a fixture. A profile started only for this measurement has no **live
 * agent** until a session runs a turn, and the host publishes a project only for
 * a live agent — so the panel would draw its empty state and there would be
 * nothing for the contract rows to read. The fixture hands the panel a payload
 * of the host's own shape (the same `{ ok, value }` envelope, the same
 * `McpSnapshot`) so every state the contract names is on screen at once: all
 * four status tokens, the quiet rows, a failure with its detail, a ring with
 * events, and a status channel that raises a toast. The panel is still the
 * product — same bundle, same theme, same DOM — only the host is replaced, and
 * the script says so in the profile line it prints.
 *
 * Outcomes per row:
 *
 *   PASS      the live value equals the frozen contract — a literal, the
 *             resolved value of a named `--dsw-alias-*` token, or a relation
 *             between two live elements;
 *   ACCEPTED  a **documented exception** the repository decided on and named.
 *             None is declared today, so the tally prints `0 ACCEPTED`; the
 *             vocabulary stays for the day one is;
 *   SKIP      a row this run could not observe (it stays out of the tally and
 *             names its reason — a skip is not a pass);
 *   FAIL      everything else.
 *
 * Usage:
 *   node scripts/design-parity.mjs [--profile test-web] [--dump] [--watch]
 *                                  [--shot out.png] [--json out.json]
 *                                  [--settle 1500] [--keep]
 *
 * `--dump` prints the raw live capture and no verdict, which is what to reach
 * for when the shell's markup moves or a value needs re-measuring.
 * `--watch` prints the panel's own reading once a second, which is what to
 * reach for when the fixture is in place but the tab keeps drawing nothing.
 * `--shot` writes the panel itself at 2x — the picture the verdict is about.
 *
 * Exit codes: 0 every row PASS or ACCEPTED, 1 some row FAILed, 2 setup problem.
 *
 * @module scripts/design-parity
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
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
const SETTLE_MS = Number(argument('--settle', '1500'))
const DUMP = process.argv.includes('--dump')
const WATCH = process.argv.includes('--watch')
const KEEP = process.argv.includes('--keep')
const JSON_OUT = argument('--json', undefined)
const SHOT = argument('--shot', undefined)

/**
 * The width the design stand draws the tab at and the width the harness forces
 * the live panel to, so the narrow-shell claim is measured rather than assumed.
 */
const NARROW_WIDTH = 330

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE)
const DSH_BIN = process.env.DSH_BIN ?? which('dsh')

/**
 * The token names the contract freezes.
 *
 * The gate never stores a colour: it names the alias token a drawn thing must
 * resolve to, reads that token's value **off the live page** (see
 * {@link HELPERS}'s `tokenColor`) and compares the two in the one theme the run
 * is in. A token re-pointed in the shell's alias layer therefore fails here
 * instead of quietly changing the interface.
 */
const TOKEN = {
  success: '--dsw-alias-state-success-primary',
  warn: '--dsw-alias-state-warn-primary',
  error: '--dsw-alias-state-error-primary',
  tertiary: '--dsw-alias-label-tertiary',
  secondary: '--dsw-alias-label-secondary',
  layer3: '--dsw-alias-bg-layer-3',
  applied: '--dsw-alias-interactive-bg-active',
}

/* -------------------------------------------------------------------------- */
/* CLI and process plumbing                                                    */
/* -------------------------------------------------------------------------- */

/** Read `--name value` out of argv. */
function argument(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) fail(`design-parity: ${name} needs a value`, 2)
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
  fail('design-parity: no chromium found (install playwright or chrome)', 2)
}

/** The install spec the profile declares for this plugin. */
function linkedSpec() {
  const manifest = join(PROFILE_DIR, 'package.json')
  if (!existsSync(manifest)) return undefined
  const deps = JSON.parse(readFileSync(manifest, 'utf8')).dependencies ?? {}
  return deps['dsh-project-mcp']
}

/** The bundle half the browser actually loads, with the identity of its build. */
function bundleInfo() {
  const client = join(REPO, 'lib', 'client.js')
  if (!existsSync(client)) return { path: client, missing: true }
  const text = readFileSync(client)
  return {
    path: client,
    bytes: text.byteLength,
    builtAt: statSync(client).mtime.toISOString(),
    sha256: createHash('sha256').update(text).digest('hex').slice(0, 12),
  }
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

/* -------------------------------------------------------------------------- */
/* CDP                                                                         */
/* -------------------------------------------------------------------------- */

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

  /** Evaluate and parse a JSON string the page built. */
  async json(expression) {
    const value = await this.value(expression)
    return typeof value === 'string' ? JSON.parse(value) : value
  }

  /** Navigate and wait for the document to settle. */
  async navigate(url) {
    await this.send('Page.navigate', { url })
    await sleep(600)
  }
}

/** Connect to the page target of a chromium started with a debugging port. */
async function connect(chrome, url) {
  const profile = mkdtempSync(join(tmpdir(), 'dsh-parity-chrome-'))
  const child = spawn(
    chrome.path,
    [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--disable-background-networking',
      '--remote-debugging-port=0',
      '--window-size=1000,900',
      ...(chrome.shell ? [] : ['--headless=new']),
      '--allow-file-access-from-files',
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
    await sleep(250)
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

/* -------------------------------------------------------------------------- */
/* Page-side helpers, injected into every probe                                */
/* -------------------------------------------------------------------------- */

/**
 * The page-side vocabulary every probe shares.
 *
 * `sample` is the whole comparison: the computed values the frozen contract
 * states and the product is held to. `rect` is here because two rows can carry
 * the same size and tone and still be laid out differently — the log message is
 * checked by *where* it sits, not only by its `flex-basis`. `tokenColor` is how
 * a `--dsw-alias-*` name becomes a value: the alias layer is a chain of `var()`
 * references, so the name is resolved by the browser on a probe element and read
 * back in the same `rgb()`/`rgba()` serialization `getComputedStyle` gives the
 * element under test.
 */
const HELPERS = `
function sample(el) {
  if (!el) return null
  const s = getComputedStyle(el)
  const r = el.getBoundingClientRect()
  return {
    text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 48),
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    fontWeight: s.fontWeight,
    color: s.color,
    backgroundColor: s.backgroundColor,
    borderStyle: s.borderStyle,
    borderWidth: s.borderTopWidth,
    borderColor: s.borderTopColor,
    borderRadius: s.borderTopLeftRadius,
    borderLeftWidth: s.borderLeftWidth,
    borderLeftColor: s.borderLeftColor,
    padding: s.padding,
    paddingTop: s.paddingTop,
    paddingBottom: s.paddingBottom,
    paddingLeft: s.paddingLeft,
    gap: s.gap,
    opacity: s.opacity,
    width: s.width,
    height: s.height,
    flexBasis: s.flexBasis,
    flexGrow: s.flexGrow,
    display: s.display,
    lineHeight: s.lineHeight,
    letterSpacing: s.letterSpacing,
    textTransform: s.textTransform,
    marginTop: s.marginTop,
    marginLeft: s.marginLeft,
    top: Math.round(r.top),
    left: Math.round(r.left),
    rect: { width: Math.round(r.width), height: Math.round(r.height) },
  }
}
function textOf(el) { return (el.textContent || '').replace(/\\s+/g, ' ').trim() }
function isDot(el) {
  const r = el.getBoundingClientRect()
  if (r.width < 5 || r.width > 11 || Math.abs(r.width - r.height) > 1) return false
  return getComputedStyle(el).borderRadius.startsWith('50%')
}
function all(root, selector) { return [...root.querySelectorAll(selector)] }
function tokenColor(name) {
  const probe = document.createElement('span')
  probe.style.display = 'none'
  probe.style.backgroundColor = 'var(' + name + ')'
  document.body.appendChild(probe)
  const value = getComputedStyle(probe).backgroundColor
  probe.remove()
  return value
}
function deepestWith(root, predicate) {
  const hits = all(root, '*').filter(predicate)
  return hits.length === 0 ? null : hits[hits.length - 1]
}
`

/** Injected as a top-level function: the plugin's tab panel, or null. */
const FIND_PANEL = `
function findPanel() {
  // F-26 removed the segment track, and the old text tells ("Servers" and
  // "Logs" were the segments) left with it. What every state of the tab draws is
  // its top bar: the project name, the chip and the \`Sync\` button that stands
  // there whether or not a project was read. Sized to the pane, smallest box
  // wins.
  const sized = [...document.querySelectorAll('div,section,aside')].filter(function (el) {
    const r = el.getBoundingClientRect()
    if (r.width < 280 || r.width > 700 || r.height < 200) return false
    return [...el.querySelectorAll('button')].some(function (button) { return textOf(button) === 'Sync' })
  })
  // The contract's own anchor is a body the panel owns *directly*: the header is
  // the sibling before it in \`panel.children\`. A shell wrapper around the tab can
  // carry the same rectangle, so the panel is the box whose own child scrolls.
  const owning = sized.filter(function (el) {
    return [...el.children].some(function (child) {
      return getComputedStyle(child).overflowY === 'auto'
    })
  })
  const pool = owning.length > 0 ? owning : sized
  pool.sort(function (left, right) {
    const a = left.getBoundingClientRect()
    const b = right.getBoundingClientRect()
    return a.width * a.height - b.width * b.height
  })
  return pool[0] || null
}
`

/**
 * The picture the panel draws from.
 *
 * A self-booted `dsh web` has no **live agent** until a session actually runs a
 * turn, and the plugin publishes a project only for a live agent — so a profile
 * started just to take this measurement draws the empty state, and the contract
 * rows would have nothing to read. The harness therefore hands the panel a
 * payload of the host's own shape before the bundle loads: the real components,
 * the real theme and the real CSSOM, with every state the contract names on
 * screen at once (all four status tokens, the quiet rows, a failure with its
 * detail, and events in the ring). The panel is the product; only the host is
 * replaced, and the replacement is the same `{ ok, value }` envelope the route
 * returns.
 *
 * Every answer names *the shell's own* session — the tab reads its own session's
 * project, and the harness cannot see that id from outside, so the fixture takes
 * it from the record the shell itself writes (`dsh.sessions.current`) at the
 * moment it answers.
 */
const FIXTURE_SCRIPT = `(function () {
  var PROJECT = '/example/service'
  var DOC = PROJECT + '/.dsh/mcp.json'
  // Another session of the same project, just so the ring holds more events than
  // this tab's session does: the logs disclosure's badge counts this session's
  // own share, and a badge that counted the project's ring instead would print a
  // different number (FIXTURE_EVENTS vs FIXTURE_RING_EVENTS).
  var OTHER_SESSION = 'session-00000000-0000-4000-8000-000000000000'
  function rows() {
    return [
      { name: 'tglider', status: 'active', projectRoot: PROJECT, source: DOC, transport: 'streamable-http' },
      { name: 'grafana-local', status: 'active', projectRoot: PROJECT, source: DOC, transport: 'streamable-http' },
      {
        name: 'gateway', status: 'error', projectRoot: PROJECT, source: DOC, transport: 'stdio',
        detail: 'no tool appeared within 60.2s; endpoint stdio docker; declared in ' + DOC,
      },
      { name: 'playwright', status: 'connecting', projectRoot: PROJECT, source: DOC, transport: 'stdio' },
      {
        name: 'context7', status: 'conflict', projectRoot: PROJECT, source: DOC, transport: 'streamable-http',
        detail: 'the name is taken by a live profile-level instance',
      },
      {
        name: 'rider', status: 'idle', projectRoot: PROJECT, source: DOC, transport: 'stdio',
        detail: 'not mounted yet — this session has not started a turn (lazy mounting is on)',
      },
      { name: 'legacy-gh', status: 'disabled', projectRoot: PROJECT, source: DOC, transport: 'stdio' },
    ]
  }
  function events() {
    var SESSION = currentSession()
    return [
      { at: 1789000000000, level: 'info', projectRoot: PROJECT, sessionId: SESSION, server: 'tglider',
        message: 'mounting for session ' + SESSION + ' (trigger: turn)' },
      { at: 1789000001000, level: 'up', projectRoot: PROJECT, sessionId: SESSION, server: 'tglider',
        message: 'is up — tools visible to session ' + SESSION + ' after 812ms' },
      { at: 1789000002000, level: 'warn', projectRoot: PROJECT, sessionId: SESSION, server: 'grafana-local',
        message: 'unmounting — the session went idle (it ran for 8m 03s)' },
      { at: 1789000003000, level: 'error', projectRoot: PROJECT, sessionId: SESSION, server: 'gateway',
        message: 'no tool appeared in 4m 27s',
        detail: 'endpoint: stdio docker · declared in ' + DOC },
      // The other session's share of the ring: older, and never this tab's.
      { at: 1788999998000, level: 'info', projectRoot: PROJECT, sessionId: OTHER_SESSION, server: 'tglider',
        message: 'mounting for session ' + OTHER_SESSION + ' (trigger: turn)' },
      { at: 1788999997000, level: 'up', projectRoot: PROJECT, sessionId: OTHER_SESSION, server: 'tglider',
        message: 'is up — tools visible to session ' + OTHER_SESSION + ' after 640ms' },
    ]
  }
  // F-26 put the tools on the tab's one surface, so the fixture has to publish
  // the session's own offer: without it the panel draws "Nothing to hide yet"
  // and there is no tool row to fold open into its full mcp__ name.
  function tools() {
    return {
      sessionId: currentSession(),
      baseline: ['mcp__tglider__workspace', 'mcp__tglider__catalog'],
      activated: [{ name: 'mcp__grafana-local__query', via: 'session', at: 1789000004000, step: 3 }],
      context: [{ name: 'mcp__context7__docs', via: 'context' }],
      deferred: ['mcp__rider__open', 'mcp__playwright__navigate'],
      mounted: 5,
      surfaceChars: 12800,
      visibleChars: 4200,
      deferredChars: 8600,
      budgetChars: 20000,
      deferring: true,
    }
  }
  function picture(withStatus) {
    var SESSION = currentSession()
    var events_ = events()
    var sessionEvents_ = events_.filter(function (event) {
      return event.sessionId === SESSION
    })
    var rows_ = rows().map(function (row) {
      return withStatus !== undefined && row.name === withStatus.name
        ? Object.assign({}, row, { status: withStatus.status })
        : row
    })
    // The project is the merge of its sessions, and after F-24 the panel draws
    // the sessions section only where a session's own reading disagrees with
    // that merge — a lone session holding the same rows as the project shows no
    // section at all. The fixture therefore keeps one honest disagreement (the
    // ring above says this session went idle, so it reads the server the project
    // still reports as active as idle) and the ladder below still has a session
    // to unfold.
    var sessionRows_ = rows_.map(function (row) {
      return row.name === 'grafana-local' ? Object.assign({}, row, { status: 'idle' }) : row
    })
    return {
      ready: true,
      // The deployment's own document list, as the host publishes it: the panel
      // numbers a row's priority by its place here (F-45).
      sources: { local: ['.dsh/mcp.json'], global: [] },
      watchedFiles: [DOC],
      projects: [{
        projectRoot: PROJECT,
        files: [{ path: DOC, scope: 'project' }],
        // One pin by hand plus one name the counters offered: the block has to
        // show both tiers, and only the second one carries the pin action (F-29).
        policy: { mode: 'disclosure', pins: ['mcp__tglider__workspace'] },
        sessionIds: [currentSession()],
        rows: rows_,
        issues: [],
        logs: events_,
        // The ring's own count, and this session's share of it: the two numbers
        // differ on purpose (FIXTURE_EVENTS / FIXTURE_RING_EVENTS), so a
        // badge reading the wrong one is visible.
        logCount: events_.length,
        sessions: [{
          id: SESSION,
          current: true,
          rows: sessionRows_,
          issues: [],
          logCount: sessionEvents_.length,
          tools: tools(),
        }],
      }],
    }
  }
  // A response the panel can read, answered from the object itself rather than
  // through JSON: the includes() override above would not survive a serialized
  // round trip, and the tab's own id would then match nothing.
  function envelope(value) {
    var body = JSON.stringify({ ok: true, value: value })
    return {
      ok: true,
      status: 200,
      headers: { get: function () { return 'application/json' } },
      json: function () { return Promise.resolve({ ok: true, value: value }) },
      text: function () { return Promise.resolve(body) },
    }
  }
  // The shell's own record of which session is open: the tab reads *its* own
  // session's project, so the fixture has to name the same one. The harness
  // cannot see the shell's session id from outside, and the shell writes it
  // here before the panel asks for anything.
  function currentSession() {
    try {
      var stored = JSON.parse(window.localStorage.getItem('dsh.sessions.current') || '{}')
      if (stored && typeof stored.sessionId === 'string' && stored.sessionId !== '') return stored.sessionId
    } catch (error) {}
    return ''
  }
  try {
    // The tab's own remembered state, pinned: the Logs tab otherwise opens on
    // this checkout's last filters, and a filter that hides the fixture's events
    // would leave the log rows with nothing to read. F-26 removed the tab's mode,
    // so there is no remembered mode to pin any more.
    window.localStorage.setItem('dsh-project-mcp:servers:logsScope', 'all')
    window.localStorage.setItem('dsh-project-mcp:servers:logsLevel', 'all')
  } catch (error) {}
  var realFetch = window.fetch.bind(window)
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || ''
    if (url.indexOf('/project-mcp/snapshot') !== -1) return Promise.resolve(envelope(picture()))
    if (url.indexOf('/project-mcp/') !== -1) {
      return Promise.resolve(envelope({ events: events(), total: events().length, more: false }))
    }
    return realFetch(input, init)
  }
  // The status channel, as the toast stack reads it: a baseline, then a real
  // lifecycle flip every few seconds so a banner is on screen while the harness
  // looks for one.
  function ParitySource() {
    var self = this
    var listeners = {}
    var revision = 0
    var up = false
    var timer
    this.addEventListener = function (type, listener) {
      ;(listeners[type] = listeners[type] || []).push(listener)
    }
    this.close = function () { clearInterval(timer) }
    var emit = function (type, payload) {
      var event = { data: JSON.stringify(payload) }
      var group = listeners[type] || []
      for (var index = 0; index < group.length; index++) group[index](event)
    }
    timer = setInterval(function () {
      revision += 1
      up = !up
      var value = picture({ name: 'playwright', status: up ? 'active' : 'connecting' })
      emit(revision === 1 ? 'hello' : 'change', { revision: revision, snapshot: value })
    }, 2000)
  }
  window.EventSource = ParitySource
})()`

/**
 * How many events this session left in the ring, and how many the ring holds in
 * total (`FIXTURE_SCRIPT`'s `events()`: four of the six are this session's).
 *
 * The two numbers are kept apart on purpose. The logs disclosure's own badge
 * counts this session's share, and if the fixture published one number for both
 * — the way it used to — a badge that counted the whole ring would still read as
 * a pass. They move together with the fixture.
 */
const FIXTURE_EVENTS = 4
const FIXTURE_RING_EVENTS = 6

/**
 * The logs disclosure's own filter chips, by the labels the dictionary gives them
 * (`logsThisSession` / `logsAllSessions` / `logsAllLevels` / `logsErrorsOnly`).
 *
 * They are the only `[aria-pressed]` controls the panel may keep after F-26, so
 * the row that counts presses reads this list rather than a number.
 */
const FILTER_LABELS = ['this session', 'all sessions', 'all levels', 'errors']

/**
 * The tier words of the tools block's own filter (F-43), by the labels the
 * dictionary gives the counters (`toolsPinned` / `toolsByCounters` /
 * `toolsDisclosed` / `toolsHidden`).
 *
 * The chip's own text is `{count} {label}`, so the row matches on the suffix:
 * the number in front of the word is the host's count and moves with the
 * fixture. These chips are the second — and last — legitimate home of a press
 * in the panel, so the row that counts presses names them instead of a number.
 */
const TIER_LABELS = ['pinned', 'by the counters', 'disclosed', 'hidden']

/**
 * The one label of the server-level pin (F-44), from the dictionary's
 * `toolsPinAll`.
 *
 * The press sits on a server's own line inside the `hidden` tier, so it is only
 * in the DOM with that tier open — the row that reads it takes the snapshot with
 * the disclosure bodies open, like the press count does.
 */
const SERVER_PRESS_LABEL = 'Pin all'

/**
 * The other direction of the same two presses (F-44), from `toolsUnpinAll`.
 *
 * The hidden tier's server line says it when its group is already pinned whole;
 * the pinned tier's server lines say it always, because every name under them is
 * pinned by definition.
 */
const SERVER_UNPRESS_LABEL = 'Unpin all'

/**
 * Install the fixture before the bundle runs, then reload into it.
 * @param page - the live page.
 */
async function installFixture(page) {
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: FIXTURE_SCRIPT })
  await page.send('Page.reload')
  await sleep(1_500)
  await mounted(page)
}

/**
 * Is the panel bound to a project yet?
 *
 * A restored session becomes live a moment after the client opens it, and the
 * panel draws the "no project" copy until it does. The project's own name is the
 * tell: it is the one header span in mono type (`STYLE.name`), while the
 * no-project copy is `.muted`, i.e. the shell's prose face.
 *
 * F-26 removed the segment track, so the header is no longer reached through it.
 * The contract's own anchor is the body — the panel's first descendant whose
 * computed `overflow-y` is `auto` — and the header is its sibling in
 * `panel.children` immediately before it.
 */
const READY_PROBE = `JSON.stringify((function () {
  ${HELPERS}
  ${FIND_PANEL}
  const panel = findPanel()
  if (!panel) return { ready: false, why: 'the tab panel is not on the page' }
  const body = all(panel, '*').find(function (el) {
    return getComputedStyle(el).overflowY === 'auto'
  }) || null
  const siblings = [...panel.children]
  const header = body === null ? null : siblings[siblings.indexOf(body) - 1] || null
  const name = header ? header.children[0] : null
  if (!name) return { ready: false, why: 'the header has no name span' }
  return {
    ready: getComputedStyle(name).fontFamily.indexOf('mono') !== -1,
    why: textOf(name).slice(0, 40),
  }
})())`

/**
 * What the page actually looks like when the tab never read the fixture.
 *
 * The failure this exists for reads "no project", which the panel also draws
 * while it is still waiting for its first answer — so the diagnosis prints the
 * panel's own text, whether the fixture replaced `fetch`, and what the route
 * answers from inside the page.
 */
const DIAGNOSE_PROBE = `(async function () {
  ${HELPERS}
  ${FIND_PANEL}
  const panel = findPanel()
  let snapshot = 'the route was not called'
  try {
    const response = await fetch('/project-mcp/snapshot')
    snapshot = (await response.text()).slice(0, 240)
  } catch (error) {
    snapshot = String(error)
  }
  return {
    panel: panel === null ? null : textOf(panel).slice(0, 200),
    fetchReplaced: window.fetch.toString().indexOf('project-mcp/snapshot') !== -1,
    stored: localStorage.getItem('dsh.sessions.current'),
    snapshot: snapshot,
  }
})()`

/**
 * Unfold the sessions section and one session inside it.
 *
 * Rungs 24 and 36 of the ladder exist only while those two are open, and the
 * ladder is checked on every rung the surface has — a folded panel
 * would only ever show rung 12.
 * @param page - the live page.
 * @returns what was unfolded, for the report.
 */
async function openLadder(page) {
  const section = await page.value(`(function () {
    ${HELPERS}
    const node = [...document.querySelectorAll('button')].find(function (button) {
      return /sessions$/.test(textOf(button))
    })
    if (!node) return 'no sessions section'
    node.click()
    return textOf(node)
  })()`)
  await sleep(700)
  const session = await page.value(`(function () {
    ${HELPERS}
    const node = [...document.querySelectorAll('button')].find(function (button) {
      return textOf(button).indexOf('\\u25b8 ') === 0
    })
    if (!node) return 'no folded session'
    node.click()
    return textOf(node)
  })()`)
  await sleep(700)
  return { section, session }
}

/** Wait for the tab to read a project, then say which one. */
async function waitForProject(page, budgetMs = 30_000) {
  const deadline = Date.now() + budgetMs
  let last = { ready: false, why: "nothing read yet" }
  while (Date.now() < deadline) {
    last = await page.json(READY_PROBE).catch(() => last)
    if (last.ready === true) return { ok: true, project: last.why }
    await sleep(1_000)
  }
  return { ok: false, project: last.why }
}

/* -------------------------------------------------------------------------- */
/* Live capture                                                                */
/* -------------------------------------------------------------------------- */

/** Wait until the application mounted and the shell's own chrome is up. */
async function mounted(page, budgetMs = 60_000) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const state = await page
      .json(
        `JSON.stringify({
          children: document.getElementById('root')?.children.length ?? -1,
          boot: document.querySelector('[data-dsh-boot]')?.innerText?.slice(0, 200) ?? null,
          shell:
            document.querySelector('[aria-label*="right sidebar" i]') !== null ||
            document.body.innerText.includes('Workspaces'),
        })`,
      )
      .catch(() => undefined)
    if (state !== undefined && state.children > 0 && state.boot === null && state.shell === true) return state
    await sleep(400)
  }
  throw new Error('the page never mounted')
}

/**
 * Open the right sidebar and press the plugin's tab.
 *
 * The tab is not in the DOM at all until the pane is open, and the sidebar's
 * own class names are hashed per build — so the rail button is found by its
 * `aria-label` and the tab by its text, exactly as the shot script does.
 */
async function openTab(page, needle) {
  const opened = await page.json(
    `JSON.stringify((function () {
      const vis = function (node) { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
      const open = [...document.querySelectorAll('button,[role="button"]')]
        .filter(vis)
        .find(function (node) { return /open right sidebar/i.test(node.getAttribute('aria-label') || '') })
      if (!open) return { opened: false }
      open.click()
      return { opened: true, label: open.getAttribute('aria-label') }
    })())`,
  )
  await sleep(SETTLE_MS)
  const clicked = await page.json(
    `JSON.stringify((function () {
      ${HELPERS}
      const needle = ${JSON.stringify(needle.toLowerCase())}
      const hits = [...document.querySelectorAll('*')].filter(function (node) {
        return textOf(node).toLowerCase() === needle
      })
      const target = hits[hits.length - 1]
      if (!target) return { clicked: false }
      const box = target.getBoundingClientRect()
      const point = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        target.dispatchEvent(new MouseEvent(type, Object.assign({ bubbles: true, cancelable: true, button: 0 }, point)))
      }
      target.click()
      return { clicked: true, text: textOf(target).slice(0, 60) }
    })())`,
  )
  await sleep(SETTLE_MS)
  if (clicked.clicked !== true) throw new Error(`design-parity: the "${needle}" tab was not on the page`)
  return { opened, clicked }
}

/**
 * Press the first tool row of the tools block.
 *
 * F-26 made every tool row a `button[aria-expanded]`, so folding one open no
 * longer needs a mode press. The block is found from the counter chips
 * (`N pinned`, `N by the counters`, `N hidden` — one chip per non-zero part,
 * F-37; before F-37 the same numbers were one `counterParts` sentence) rather
 * than from a tool name, so the row does not have to be recognised by a name the
 * panel may shorten: the nearest ancestor of the chip that holds a row button is
 * the tools block, and its first row button is a tool row.
 * @param page - the live page.
 * @returns the row's own text, for the report.
 */
async function pressToolRow(page) {
  return page.value(`(function () {
    ${HELPERS}
    ${FIND_PANEL}
    const panel = findPanel()
    if (!panel) return 'the tab panel is not on the page'
    const body = [...panel.querySelectorAll('*')].find(function (el) {
      return getComputedStyle(el).overflowY === 'auto'
    }) || null
    if (!body) return 'the tab has no scrolling body'
    const counters = [...body.querySelectorAll('*')].find(function (el) {
      return el.children.length === 0 && /\\d+ pinned/.test(textOf(el))
    })
    if (!counters) return 'the tools counters are not on the page'
    let block = counters
    while (block !== null && block !== body && block.querySelector('button[aria-expanded]') === null) {
      block = block.parentElement
    }
    const row = block === null || block === body ? null : block.querySelector('button[aria-expanded]')
    if (!row) return 'no tool row under the counters'
    row.click()
    return textOf(row).slice(0, 60)
  })()`)
}

/**
 * Open the errors and the logs disclosure — the contract's last two blocks.
 *
 * Both are folded by default (contract), and the log rows and the error's body
 * only exist while they are open. The block order is fixed (servers, sessions,
 * tools, errors, logs), so the last two of the surface's own disclosures are
 * exactly those two — the same rule the capture probe classifies by.
 * @param page - the live page.
 * @returns what was pressed, for the report.
 */
/**
 * Fold the tools block's own `hidden` tier in or out.
 *
 * The tier is folded by default and the per-server press of F-44 lives in its
 * body, so the row that reads that press needs it open. The tail capture opens
 * the two tail disclosures only, so this is a step of its own — and it is undone
 * right after, because the narrow-shell reading below measures the surface the
 * user has when no tier is unfolded.
 * @param page - the live page.
 * @param open - the state to reach.
 * @returns the head's label, or `null` when the tier is not on screen.
 */
async function foldHiddenTier(page, open) {
  return page.value(`(function () {
    ${HELPERS}
    ${FIND_PANEL}
    const panel = findPanel()
    if (!panel) return null
    // The tier's own head, found by its word: it is the only button[aria-expanded]
    // in the panel whose label says 'hidden' (the counter chip that says the same
    // word is a span, and the tool rows print names).
    const head = all(panel, 'button[aria-expanded]').find(function (el) {
      return /hidden/i.test(textOf(el))
    })
    if (!head) return null
    if (head.getAttribute('aria-expanded') !== String(${JSON.stringify(open)})) head.click()
    return textOf(head).slice(0, 40)
  })()`)
}

async function openTailBlocks(page) {
  return page.value(`(function () {
    ${HELPERS}
    ${FIND_PANEL}
    const panel = findPanel()
    if (!panel) return 'the tab panel is not on the page'
    const body = [...panel.querySelectorAll('*')].find(function (el) {
      return getComputedStyle(el).overflowY === 'auto'
    }) || null
    if (!body) return 'the tab has no scrolling body'
    const depth = function (el) {
      let steps = 0
      for (let node = el; node !== null && node !== body; node = node.parentElement) steps += 1
      return steps
    }
    const holders = [...body.querySelectorAll('div')].filter(function (el) {
      // Same rule as the capture probe: a disclosure holds one head button, a
      // block of tool rows holds many.
      return [...el.children].filter(function (child) {
        return child.tagName === 'BUTTON' && child.hasAttribute('aria-expanded')
      }).length === 1
    })
    const shallow = holders.length === 0 ? null : Math.min(...holders.map(depth))
    const blocks = shallow === null ? [] : holders.filter(function (el) { return depth(el) === shallow })
    const sessions = blocks.find(function (el) {
      const head = el.querySelector(':scope > button[aria-expanded]')
      return head !== null && /sessions/i.test(textOf(head))
    })
    // The counters vocabulary is the tools block, not a disclosure: drop it, so
    // the tail really is the errors and the logs block (same rule as the capture
    // probe).
    const tail = blocks.filter(function (el) {
      return el !== sessions && !/pinned|disclosed|hidden/i.test(textOf(el))
    }).slice(-2)
    const pressed = []
    for (let index = 0; index < tail.length; index += 1) {
      const head = tail[index].querySelector(':scope > button[aria-expanded]')
      if (head !== null && head.getAttribute('aria-expanded') !== 'true') {
        head.click()
        pressed.push(textOf(head).slice(0, 40))
      }
    }
    return pressed.join(' · ') || 'nothing to press'
  })()`)
}

/**
 * The tab's one surface, as the panel draws it right now.
 *
 * F-26 removed the `Servers / Tools / Problems / Logs` segment bar, and the
 * anchor this probe used to reach the surface went with it: there is no
 * `[aria-pressed]` left to stand on. The contract's own anchors
 * (`docs/design/contracts/single-surface.md`, "Anchors for the parity gate") are the surface
 * itself:
 *
 *   - `body` — the panel's scrolling container (`STYLE.body`): the first
 *     descendant whose computed `overflow-y` is `auto`;
 *   - `header` — its sibling in `panel.children` immediately before it;
 *   - a disclosure — a `div` with a `button[aria-expanded]` child; a tool row is
 *     such a button itself, and the row's body is the block that prints the full
 *     `mcp__<server>__<tool>` name.
 */
const LIVE_SURFACE_PROBE = `JSON.stringify((function () {
  ${HELPERS}
  ${FIND_PANEL}
  const panel = findPanel()
  if (!panel) return { found: false }
  const body = all(panel, '*').find(function (el) {
    return getComputedStyle(el).overflowY === 'auto'
  }) || null
  const siblings = [...panel.children]
  const header = body === null ? null : siblings[siblings.indexOf(body) - 1] || null
  const spans = body ? all(body, 'span') : []
  const rowDivs = body
    ? all(body, 'div').filter(function (el) { return [...el.children].some(isDot) })
    : []
  const rows = rowDivs.map(function (row) {
    const dot = [...row.children].find(isDot) || null
    const chips = [...row.children].filter(function (child) {
      const s = getComputedStyle(child)
      return s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.fontFamily.indexOf('mono') !== -1
    })
    return {
      text: textOf(row).slice(0, 80),
      dot: sample(dot),
      name: sample(row.children[1] || null),
      status: sample([...row.children].find(function (child) {
        return ['active','connecting','idle','disabled','conflict','error'].indexOf(textOf(child)) !== -1
      }) || null),
      chips: chips.map(sample),
      padding: row ? getComputedStyle(row).padding : null,
      gap: row ? getComputedStyle(row).gap : null,
      // The block-order row reads this: the first server row's own top line.
      top: Math.round(row.getBoundingClientRect().top),
    }
  })
  const chipOf = function (label) {
    return sample(spans.find(function (span) { return textOf(span) === label }) || null)
  }
  const transportSpans = spans.filter(function (span) {
    return ['http', 'stdio', 'sse', 'streamable-http'].indexOf(textOf(span)) !== -1
  })
  const quietChips = spans.filter(function (span) {
    return ['idle', 'disabled'].indexOf(textOf(span)) !== -1
  })
  /**
   * The indentation ladder, as the panel actually nests today.
   *
   * Only the rungs that carry a level are collected — STYLE.indent sets a
   * multiple of INDENT — so the chips and buttons own few pixels do not read as
   * a rung. A folded session shows fewer rungs than an open one: that is the
   * state, not a broken ladder, and the row below says which rungs were visible.
   */
  const indentValues = [...new Set(all(body, '*').map(function (el) {
    const value = getComputedStyle(el).paddingLeft
    const pixels = parseFloat(value)
    return Number.isFinite(pixels) && pixels >= 12 ? value : null
  }).filter(function (value) { return value !== null }))].sort(function (a, b) {
    return parseFloat(a) - parseFloat(b)
  })
  /**
   * The disclosures: the contract's div with a button[aria-expanded] child.
   *
   * Only the shallowest such divs are the surface's own blocks (sessions,
   * errors, logs) — a tool group's wrapper and the session rows sit deeper. The
   * block order is fixed by the contract (servers, sessions, tools, errors,
   * logs), so of the blocks that are not the sessions one, the last two are the
   * errors and the logs disclosure.
   */
  const depth = function (el) {
    let steps = 0
    for (let node = el; node !== null && node !== body; node = node.parentElement) steps += 1
    return steps
  }
  const directHeads = function (el) {
    return [...el.children].filter(function (child) {
      return child.tagName === 'BUTTON' && child.hasAttribute('aria-expanded')
    })
  }
  const holders = body ? all(body, 'div').filter(function (el) {
    // A disclosure holds exactly one head button; a block of tool rows holds as
    // many rows as it lists, so the count of direct heads tells them apart even
    // when the panel wraps the whole surface in one more div.
    return directHeads(el).length === 1
  }) : []
  const shallow = holders.length === 0 ? null : Math.min(...holders.map(depth))
  const blocks = shallow === null ? [] : holders.filter(function (el) { return depth(el) === shallow })
  const readBlock = function (el) {
    const head = el.querySelector(':scope > button[aria-expanded]')
    const rest = [...el.children].filter(function (child) { return child !== head })
    const box = rest[0] || null
    return {
      text: textOf(el).slice(0, 60),
      headText: textOf(head).slice(0, 60),
      head: sample(head),
      expanded: head !== null && head.getAttribute('aria-expanded') === 'true',
      body: sample(box),
      bodyVisible: box !== null && box.getBoundingClientRect().height > 0,
      top: Math.round(el.getBoundingClientRect().top),
    }
  }
  const disclosures = blocks.map(readBlock)
  // A tool group's wrapper can sit at the same depth as the surface's blocks;
  // its text is the counters vocabulary, so it is dropped before the labels are
  // read rather than being mistaken for a disclosure.
  const candidates = disclosures.filter(function (entry) {
    return !/pinned|disclosed|hidden/i.test(entry.text)
  })
  // The two tail disclosures are told apart by their own word-labels, never by
  // their position. Position deciding which is which would make a swap of the
  // two blocks invisible: the upper block would simply be renamed "errors" and
  // the order row would still pass. The labels come from the dictionary
  // (errorsSection / logsSection), so they are read as words, not as one exact
  // string.
  const labelOf = function (entry) {
    if (/logs/i.test(String(entry.headText))) return 'logs'
    if (/problems|issues|errors/i.test(String(entry.headText))) return 'errors'
    return null
  }
  const logsEntry = candidates.find(function (entry) { return labelOf(entry) === 'logs' }) || null
  const errorsEntry = candidates.find(function (entry) { return labelOf(entry) === 'errors' }) || null
  const unlabeled = candidates.filter(function (entry) {
    return entry !== logsEntry && entry !== errorsEntry
  })
  // A dictionary that stopped carrying the label still leaves a disclosure to
  // measure, so the fallback is positional — and the order row says which route
  // was taken.
  const errorsBlock = errorsEntry !== null
    ? errorsEntry
    : (unlabeled.length >= 2 ? unlabeled[unlabeled.length - 2] : null)
  const logsBlock = logsEntry !== null
    ? logsEntry
    : (unlabeled.length >= 1 ? unlabeled[unlabeled.length - 1] : null)
  // The sessions section (F-24) is not a disclosure block of its own: its head
  // button sits one level down, inside the line that holds the count and the
  // summary. The block order still wants its top, so it is read from the head's
  // own word — the one button[aria-expanded] whose text is the section label. The
  // label is read off the head, not off the whole block: an open logs body
  // carries its own "all sessions" filter, and that word must not make the logs
  // block pass for the sessions one.
  const sessionsHead = body ? all(body, 'button[aria-expanded]').find(function (el) {
    return /sessions/i.test(textOf(el))
  }) || null : null
  const sessionsBlock = sessionsHead === null ? null : readBlock(sessionsHead.parentElement)
  /**
   * One tool row, folded or not.
   *
   * The counter chips (N pinned, N disclosed, N hidden — one chip per non-zero
   * part, from counterParts) sit above the rows, and the nearest ancestor that
   * holds a row button is the tools block; its first button[aria-expanded] is a
   * tool row. The row's open body is the only place the full public name appears
   * outside a row button (the row prints the same name in its own header), so
   * the body is read from the mcp__ leaf that no row button holds, and the inset
   * belongs to the block around that leaf, not to the leaf itself.
   */
  const counters = body ? all(body, '*').find(function (el) {
    return el.children.length === 0 && /\\d+ pinned/.test(textOf(el))
  }) || null : null
  let toolsBlock = counters
  while (toolsBlock !== null && toolsBlock !== body && toolsBlock.querySelector('button[aria-expanded]') === null) {
    toolsBlock = toolsBlock.parentElement
  }
  if (toolsBlock === body) toolsBlock = null
  const toolRow = toolsBlock === null ? null : toolsBlock.querySelector('button[aria-expanded]')
  const fullName = body ? all(body, '*').find(function (el) {
    return el.children.length === 0 &&
      textOf(el).indexOf('mcp__') === 0 &&
      el.closest('button[aria-expanded]') === null
  }) || null : null
  const detail = fullName === null ? null : (function () {
    let node = fullName
    while (node.parentElement !== null && node.parentElement !== body &&
      (toolRow === null || node.parentElement.contains(toolRow) === false)) {
      node = node.parentElement
    }
    return node
  })()
  const tool = toolRow === null ? null : {
    text: textOf(toolRow).slice(0, 80),
    line: sample(toolRow),
    name: sample(toolRow.children[1] || null),
    expanded: toolRow.getAttribute('aria-expanded') === 'true',
    detail: sample(detail),
    detailName: sample(fullName),
    detailVisible: detail !== null && detail.getBoundingClientRect().height > 0,
    full: fullName !== null && /^mcp__[^_]+__/.test(textOf(fullName)),
  }
  // Both directions of one write: the Unpin a user's own pin carries, and the Pin
  // the counter-offered rows carry (F-29). Both are plain buttons — the row itself
  // is the button that carries aria-expanded.
  const pinButtons = toolsBlock === null ? [] : all(toolsBlock, 'button').filter(function (button) {
    return button.getAttribute('aria-expanded') === null
  }).map(function (button) { return textOf(button) })
  const pins = { pin: pinButtons.indexOf('Pin') !== -1, unpin: pinButtons.indexOf('Unpin') !== -1 }
  const summary = header === null ? null : sample([...header.querySelectorAll('span')].filter(function (el) {
    return el.children.length === 0 && textOf(el) !== ''
  }).pop() || null)
  const logTimes = spans.filter(function (span) { return /^[0-9]{2}:[0-9]{2}:[0-9]{2}$/.test(textOf(span)) })
  const logRows = logTimes.map(function (time) {
    const row = time.parentElement
    const message = [...row.children].find(function (child) {
      return getComputedStyle(child).flexBasis === '100%'
    }) || row.children[row.children.length - 1]
    const detail = row.nextElementSibling && getComputedStyle(row.nextElementSibling).borderLeftWidth !== '0px'
      ? row.nextElementSibling
      : null
    return {
      time: sample(time),
      level: sample(row.children[1] || null),
      name: sample([...row.children].find(function (child) {
        return getComputedStyle(child).fontFamily.indexOf('mono') !== -1 &&
          getComputedStyle(child).color !== getComputedStyle(time).color &&
          child !== time
      }) || null),
      message: sample(message),
      messageBelow: message ? Math.round(message.getBoundingClientRect().top - time.getBoundingClientRect().top) : null,
      detail: sample(detail),
      text: textOf(row).slice(0, 80),
    }
  })
  const rootStyle = getComputedStyle(panel)
  return {
    found: true,
    theme: document.body.hasAttribute('data-ds-dark-theme'),
    // The alias tokens the contract freezes, resolved in this page's own theme.
    tokens: {
      success: tokenColor(${JSON.stringify(TOKEN.success)}),
      warn: tokenColor(${JSON.stringify(TOKEN.warn)}),
      error: tokenColor(${JSON.stringify(TOKEN.error)}),
      tertiary: tokenColor(${JSON.stringify(TOKEN.tertiary)}),
      secondary: tokenColor(${JSON.stringify(TOKEN.secondary)}),
      layer3: tokenColor(${JSON.stringify(TOKEN.layer3)}),
      applied: tokenColor(${JSON.stringify(TOKEN.applied)}),
    },
    panel: {
      rect: (function () {
        const r = panel.getBoundingClientRect()
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
      })(),
      fontSize: rootStyle.fontSize,
      color: rootStyle.color,
    },
    header: header ? {
      padding: getComputedStyle(header).padding,
      gap: getComputedStyle(header).gap,
      project: sample(header.children[0] || null),
      chip: chipOf('this session'),
      sync: sample([...header.querySelectorAll('button')].find(function (b) { return textOf(b) === 'Sync' }) || null),
    } : null,
    // The panel's own scrolling container, as an anchor rather than as the
    // predicate that found it: it has to be a direct child of the panel, the
    // header has to be the sibling immediately before it, and it carries the
    // .body inset the contract states. A shell wrapper can have the same
    // rectangle and the
    // same overflow, so the parenthood is what proves which box this is.
    body: body ? {
      direct: body.parentElement === panel,
      afterHeader: header !== null && body.previousElementSibling === header,
      padding: getComputedStyle(body).padding,
      overflowY: getComputedStyle(body).overflowY,
    } : null,
    // Every pressed control the panel has, split by the two places a press is
    // still legitimate: the logs filter chips inside their disclosure (F-10),
    // and the tools block's own tier chips (F-43). A press inside a folded body
    // is not in the DOM at all, so the rows read this off the snapshot with the
    // bodies open.
    pressed: (function () {
      const pressed = all(panel, '[aria-pressed]')
      const logs = pressed.filter(function (el) {
        return blocks.some(function (block) { return block.contains(el) })
      })
      const tiers = pressed.filter(function (el) {
        return toolsBlock !== null && toolsBlock.contains(el)
      })
      return {
        outside: pressed.length - logs.length - tiers.length,
        total: pressed.length,
        labels: logs.map(function (el) { return textOf(el).slice(0, 40) }),
        tiers: tiers.map(function (el) { return textOf(el).slice(0, 40) }),
      }
    })(),
    // The server-level press (F-44): the one button whose label is the whole
    // action, read together with the server line it stands on. It exists only
    // while the hidden tier is open, which is why it rides this same object.
    serverPress: (function () {
      const of = function (label) {
        const press = all(panel, 'button').find(function (el) {
          return textOf(el) === label
        })
        if (!press) return null
        const line = press.parentElement
        const box = sample(press)
        return {
          text: textOf(press),
          line: line === null ? '' : textOf(line).slice(0, 60),
          expanded: press.getAttribute('aria-expanded'),
          width: box.width,
          height: box.height,
        }
      }
      return { pin: of(${JSON.stringify(SERVER_PRESS_LABEL)}), unpin: of(${JSON.stringify(SERVER_UNPRESS_LABEL)}) }
    })(),
    // The tools block's filter field (F-43): the one input the panel owns. The
    // panel is the same bundle and the same DOM as the product's, so the field
    // being here at all — with its own label, placeholder and plate — is the
    // reading. sample() carries no tag and no attributes, so they are read here.
    toolFilter: (function () {
      const field = toolsBlock === null ? null : toolsBlock.querySelector('input')
      if (field === null) return { inputs: 0 }
      const box = sample(field)
      return {
        tag: field.tagName,
        type: field.getAttribute('type'),
        placeholder: field.getAttribute('placeholder'),
        label: field.getAttribute('aria-label'),
        inputs: toolsBlock.querySelectorAll('input').length,
        width: box.width,
        height: box.height,
        padding: box.padding,
        borderRadius: box.borderRadius,
      }
    })(),
    // The first tier chip of the same block (F-43): the counter chip turned into
    // a control. Its plate is the reading chip's own, and the row below is what
    // proves it — the font reset a button needs is a shorthand, and written
    // after the plate it would silently hand this chip the shell's sans face at
    // the shell's size while its twin above the list stayed mono.
    tierChip: (function () {
      const chip = toolsBlock === null ? null : toolsBlock.querySelector('[aria-pressed]')
      if (chip === null) return null
      const box = sample(chip)
      return {
        text: box.text,
        fontFamily: box.fontFamily,
        fontSize: box.fontSize,
        bodyFontSize: body === null ? null : getComputedStyle(body).fontSize,
        borderRadius: box.borderRadius,
        borderStyle: box.borderStyle,
        padding: box.padding,
        backgroundColor: box.backgroundColor,
      }
    })(),
    summary: summary,
    rows: rows,
    transports: transportSpans.map(sample),
    quietChips: quietChips.map(sample),
    indentValues: indentValues,
    rowPadding: rowDivs.length > 0 ? getComputedStyle(rowDivs[0]).padding : null,
    rowGap: rowDivs.length > 0 ? getComputedStyle(rowDivs[0]).gap : null,
    disclosures: disclosures,
    sessions: sessionsBlock,
    errors: errorsBlock,
    logs: logsBlock,
    // Which of the two was found by its own label rather than by position.
    errorsLabeled: errorsEntry !== null,
    logsLabeled: logsEntry !== null,
    tool: tool,
    pins: pins,
    order: {
      row: rows.length > 0 ? rows[0].top : null,
      sessions: sessionsBlock === null ? null : sessionsBlock.top,
      tools: tool === null ? null : tool.line.top,
      errors: errorsBlock === null ? null : errorsBlock.top,
      logs: logsBlock === null ? null : logsBlock.top,
    },
    logRows: logRows,
    logFilters: [...panel.querySelectorAll('button')].filter(function (button) {
      return ${JSON.stringify(FILTER_LABELS)}.indexOf(textOf(button)) !== -1
    }).map(function (button) {
      return Object.assign(sample(button), { pressed: button.getAttribute('aria-pressed') })
    }),
    sessionsToggle: sample(deepestWith(panel, function (el) {
      const t = textOf(el)
      return (t === 'sessions' || t === '\\u25b8 sessions' || t === '\\u25be sessions') && el.children.length === 0
    })),
    muted: (function () {
      const node = deepestWith(panel, function (el) {
        return /^[0-9]+ (active|idle|error|connecting|conflict)/.test(textOf(el)) && el.children.length === 0
      })
      return sample(node)
    })(),
  }
})())`

/** The toast banner, when one is on screen. The stack is a frame-wide layer. */
const TOAST_PROBE = `JSON.stringify((function () {
  ${HELPERS}
  const banners = all(document.body, 'div').filter(function (el) {
    const s = getComputedStyle(el)
    return s.borderRadius === '14px' && s.backgroundColor !== 'rgba(0, 0, 0, 0)'
  })
  if (banners.length === 0) return { found: false }
  const stack = banners[0].parentElement
  return {
    found: true,
    stack: sample(stack),
    banner: sample(banners[0]),
    dot: sample([...banners[0].children].find(isDot) || null),
    text: textOf(banners[0]).slice(0, 80),
  }
})())`

/** Force the panel to a known width, so the narrow-shell claim is measured. */
const WIDTH_PROBE = `JSON.stringify((function () {
  ${HELPERS}
  ${FIND_PANEL}
  const panel = findPanel()
  if (!panel) return { found: false }
  const before = panel.style.width
  panel.style.width = ${NARROW_WIDTH} + 'px'
  panel.style.maxWidth = ${NARROW_WIDTH} + 'px'
  void panel.offsetWidth
  // F-26: the same anchor the capture probe uses — the contract's scrolling
  // container, not the panel's last child (the old mode bar's sibling).
  const body = all(panel, '*').find(function (el) {
    return getComputedStyle(el).overflowY === 'auto'
  }) || panel
  const overflow = all(panel, '*').filter(function (el) {
    return el.scrollWidth - el.clientWidth > 2
  }).map(function (el) {
    return { text: textOf(el).slice(0, 40), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }
  })
  const rows = all(panel, 'div').filter(function (el) { return [...el.children].some(isDot) })
  const indentValues = [...new Set(all(body, '*').map(function (el) {
    const value = getComputedStyle(el).paddingLeft
    const pixels = parseFloat(value)
    return Number.isFinite(pixels) && pixels >= 12 ? value : null
  }).filter(function (value) { return value !== null }))]
  const result = {
    found: true,
    width: Math.round(panel.getBoundingClientRect().width),
    overflow: overflow,
    rowCount: rows.length,
    indentValues: indentValues,
  }
  panel.style.width = before
  panel.style.maxWidth = ''
  return result
})())`

/* -------------------------------------------------------------------------- */
/* Comparison                                                                  */
/* -------------------------------------------------------------------------- */

const results = []

/** The contract every row points at when it does not name a more precise one. */
const CONTRACT_DOC = 'docs/design/contracts/surfaces.md'

/**
 * A row whose expected value is a frozen literal from the contract.
 *
 * The literal is the point: geometry and type the contract states as numbers are
 * compared as strings, so a shell that re-spaces the panel fails here instead of
 * drifting quietly.
 */
function expectRule({ surface, title, live, expected, property, authority, normalize }) {
  const normalizeValue = normalize ?? String
  const liveValue = live === null || live === undefined ? null : normalizeValue(live[property])
  const pass = liveValue !== null && liveValue === normalizeValue(expected)
  results.push({
    surface,
    title,
    status: pass ? 'PASS' : 'FAIL',
    property,
    live: liveValue,
    expected: normalizeValue(expected),
    authority: authority ?? CONTRACT_DOC,
    detail: pass ? undefined : `live ${liveValue} ≠ contract ${normalizeValue(expected)}`,
  })
}

/**
 * A row whose expected value is the live theme's own value for a named token.
 *
 * The token *name* is frozen here and the *value* is read off the page under
 * test (see {@link HELPERS}'s `tokenColor`), so the check survives a theme switch
 * and still catches a component that stopped using the token the contract names.
 * A theme that never resolved the token fails the row and says so rather than
 * comparing against an empty string.
 */
function expectToken({ surface, title, live, tokens, token, property, authority }) {
  const liveValue = live === null || live === undefined ? null : String(live[property])
  const expected = tokens?.[token] ?? null
  const resolved = expected !== null && expected !== '' && expected !== 'rgba(0, 0, 0, 0)'
  const pass = liveValue !== null && resolved && liveValue === expected
  results.push({
    surface,
    title,
    status: pass ? 'PASS' : 'FAIL',
    property,
    live: String(liveValue),
    expected: String(expected),
    authority: authority ?? CONTRACT_DOC,
    detail: pass
      ? undefined
      : resolved
        ? `live ${String(liveValue)} ≠ ${TOKEN[token]} ${String(expected)}`
        : `${TOKEN[token]} did not resolve in this theme (read ${String(expected)})`,
  })
}

/**
 * A row this run could not observe.
 *
 * The harness provokes real lifecycle events, but it cannot promise a *failure*
 * — the profile's project may declare only servers that come up. A row that
 * never saw its data says so instead of passing quietly, and stays out of the
 * pass/fail tally the way `scripts/audit.mjs` keeps its own skips.
 */
function skipped({ surface, title, expected, live, authority, note }) {
  results.push({
    surface,
    title,
    status: 'SKIP',
    property: 'not observed',
    live: String(live),
    expected: String(expected),
    authority,
    detail: note,
  })
}

/** One contract the repository pins for itself. */
function contract({ surface, title, holds, expected, live, authority, note }) {
  results.push({
    surface,
    title,
    status: holds ? 'PASS' : 'FAIL',
    property: 'contract',
    live: String(live),
    expected: String(expected),
    authority,
    detail: holds ? note : `live ${String(live)} ≠ contract ${String(expected)}`,
  })
}

/** Compare two pixel lengths the way a browser would, within half a pixel. */
function samePixels(left, right) {
  const a = parseFloat(String(left))
  const b = parseFloat(String(right))
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  return Math.abs(a - b) < 0.51
}

/** A pixel length that must equal a frozen literal, within half a pixel. */
function expectPixels({ surface, title, live, expected, property, authority }) {
  const liveValue = live?.[property] ?? null
  const pass = liveValue !== null && samePixels(liveValue, expected)
  results.push({
    surface,
    title,
    status: pass ? 'PASS' : 'FAIL',
    property,
    live: String(liveValue),
    expected: String(expected),
    authority: authority ?? CONTRACT_DOC,
    detail: pass ? undefined : `live ${String(liveValue)} ≠ contract ${String(expected)}`,
  })
}

/** A live typeface that must carry a frozen substring. */
function expectContains({ surface, title, live, property, needle, authority }) {
  const liveValue = String(live?.[property] ?? '')
  const pass = liveValue.includes(needle)
  results.push({
    surface,
    title,
    status: pass ? 'PASS' : 'FAIL',
    property,
    live: liveValue,
    expected: `«${needle}»`,
    authority: authority ?? CONTRACT_DOC,
    detail: pass ? undefined : `the live value has to carry «${needle}»`,
  })
}

/**
 * The *relation* between two elements of the one live panel.
 *
 * The panel inherits the shell's own type scale, so "the same size as a row" or
 * "the same tone as a server row" is checked as exactly that relation on the one
 * page instead of a pixel value no picture can share.
 */
function relation({ surface, title, liveA, liveB, property, authority }) {
  const pass = liveA != null && liveB != null && String(liveA[property]) === String(liveB[property])
  results.push({
    surface,
    title,
    status: pass ? 'PASS' : 'FAIL',
    property,
    live: `${String(liveA?.[property])} vs ${String(liveB?.[property])}`,
    expected: 'one value on both elements',
    authority: authority ?? CONTRACT_DOC,
    detail: pass ? undefined : 'these two elements have to read alike; the panel draws them differently',
  })
}

/* -------------------------------------------------------------------------- */
/* The check table                                                             */
/* -------------------------------------------------------------------------- */

const SURFACE_A = 'A · the sidebar tab'
const SURFACE_D = 'D · the logs disclosure'
const SURFACE_T = 'T · toasts (the frame layer)'

/**
 * Build the verdict from the live capture.
 * @param live - the live panel capture: the one surface in its default state
 *   (both disclosures folded), the tool row's own open and closed readings, the
 *   tail disclosures unfolded for the log rows, and the values of the alias
 *   tokens the contract freezes, resolved in the theme this run is in.
 * @param toast - the toast banner, when one was on screen during the run.
 * @param narrow - the same panel forced to the contract's own 330px.
 * @returns the number of FAILing rows.
 */
function verdict(live, toast, narrow) {
  const firstRow = live.rows[0] ?? null
  const tokens = live.tokens ?? {}

  /* ── the status dot and the palette it draws from ──────────────────────── */
  expectPixels({
    surface: SURFACE_A,
    title: 'the status dot — an 8px circle',
    live: firstRow?.dot,
    expected: '8px',
    property: 'width',
    authority: `${CONTRACT_DOC} §9 — "the 8 px dot is a circle"`,
  })
  expectPixels({
    surface: SURFACE_A,
    title: 'the status dot — 50% radius',
    live: firstRow?.dot,
    expected: '50%',
    property: 'borderRadius',
    authority: `${CONTRACT_DOC} §9 — "the 8 px dot is a circle"`,
  })

  // Every drawn status names the alias token it must resolve to. The token's
  // *value* is read off the live theme (see {@link TOKEN}), never stored here.
  const palette = {
    active: 'success',
    connecting: 'warn',
    conflict: 'warn',
    error: 'error',
    idle: 'tertiary',
    disabled: 'tertiary',
  }
  const drawn = new Map()
  for (const row of live.rows) {
    const status = row.status?.text
    if (status !== undefined && !drawn.has(status)) drawn.set(status, row)
  }
  const checked = []
  for (const [status, row] of drawn) {
    const token = palette[status]
    if (token === undefined || row.dot === null) continue
    checked.push(status)
    expectToken({
      surface: SURFACE_A,
      title: `the «${status}» status dot — colour from the state token`,
      live: row.dot,
      tokens,
      token,
      property: 'backgroundColor',
      authority: `${CONTRACT_DOC} §9 — "four distinguishable state tones"`,
    })
  }
  contract({
    surface: SURFACE_A,
    title: 'both pin directions drawn: `Pin` on the counters-offered, `Unpin` on the user’s pin',
    holds: live.pins?.pin === true && live.pins?.unpin === true,
    expected: 'Pin and Unpin in the tools block',
    live: JSON.stringify(live.pins ?? null),
    authority: `${CONTRACT_DOC} §1 — "Pin and Unpin are one and the same project-policy write in two directions"`,
  })
  contract({
    surface: SURFACE_A,
    title: 'every drawn status is verified against the contract',
    holds: checked.length > 0 && checked.length === drawn.size,
    expected: 'every drawn status',
    live: checked.length > 0 ? checked.join(', ') : 'none drawn',
    authority: 'scripts/design-parity.mjs — a drawn status without a state token is unverified',
    note: `verified: ${checked.join(', ')}`,
  })
  const fourNames = ['success', 'warn', 'error', 'tertiary'].map((name) => tokens[name])
  contract({
    surface: SURFACE_A,
    title: 'the four state tokens are distinguishable',
    holds: new Set(fourNames).size === 4 && fourNames.every((value) => typeof value === 'string' && value !== ''),
    expected: `${TOKEN.success} · ${TOKEN.warn} · ${TOKEN.error} · ${TOKEN.tertiary}`,
    live: fourNames.join(' · '),
    authority: `${CONTRACT_DOC} §9 — "four distinguishable state tones"`,
    note: 'the palette the panel has to be able to draw',
  })

  /* ── chips, tones, the heading ─────────────────────────────────────────── */

  // One plate, four chips: the contract's layer fill, no frame, radius 4px
  // (`surfaces.md` §9, "chips"). Mono is checked where the contract has it — the
  // `this session` chip, the transport chip and the level chip are values and
  // read in the panel's mono face; the Logs toolbar chips are controls and keep
  // the interface font, so their mono-ness is not asserted and their plate is.
  const CHIP_AUTHORITY = `${CONTRACT_DOC} §9 — "chips: the bg-layer-3 layer plate in mono, no border"`
  const plate = (surface, chip, title) => {
    expectToken({
      surface,
      title: `${title} — layer fill`,
      live: chip,
      tokens,
      token: 'layer3',
      property: 'backgroundColor',
      authority: CHIP_AUTHORITY,
    })
    expectRule({
      surface,
      title: `${title} — 4px radius`,
      live: chip,
      expected: '4px',
      property: 'borderRadius',
      authority: CHIP_AUTHORITY,
    })
    expectRule({
      surface,
      title: `${title} — no border`,
      live: chip,
      expected: 'none',
      property: 'borderStyle',
      authority: CHIP_AUTHORITY,
    })
  }
  plate(SURFACE_A, live.header?.chip ?? null, 'the `this session` chip')
  plate(SURFACE_A, live.transports[0] ?? null, 'the transport chip (`http` / `stdio`)')
  expectContains({
    surface: SURFACE_A,
    title: 'the `this session` chip — monospaced',
    live: live.header?.chip ?? null,
    property: 'fontFamily',
    needle: 'mono',
    authority: CHIP_AUTHORITY,
  })
  expectContains({
    surface: SURFACE_A,
    title: 'the transport chip (`http` / `stdio`) — monospaced',
    live: live.transports[0] ?? null,
    property: 'fontFamily',
    needle: 'mono',
    authority: CHIP_AUTHORITY,
  })
  expectToken({
    surface: SURFACE_A,
    title: 'the `idle` chip — the waiting dot in the tertiary tone',
    live: live.quietChips[0] ?? null,
    tokens,
    token: 'tertiary',
    property: 'color',
    authority: `${CONTRACT_DOC} §9 — "the idle tone tertiary"`,
  })
  expectToken({
    surface: SURFACE_A,
    title: 'the `.muted` tone — a secondary label',
    live: live.muted,
    tokens,
    token: 'secondary',
    property: 'color',
    authority: `${CONTRACT_DOC} §9 — ".muted secondary"`,
  })
  expectToken({
    surface: SURFACE_A,
    title: 'the `.dim` tone — the header right edge’s tertiary label',
    live: live.summary,
    tokens,
    token: 'tertiary',
    property: 'color',
    authority: `${CONTRACT_DOC} §9 — ".dim tertiary"`,
  })
  contract({
    surface: SURFACE_A,
    title: '`.dim` is smaller than `.muted`',
    holds: parseFloat(String(live.summary?.fontSize)) < parseFloat(String(live.muted?.fontSize)),
    expected: '`.dim` is smaller than `.muted`',
    live: `${String(live.summary?.fontSize)} vs ${String(live.muted?.fontSize)}`,
    authority: `${CONTRACT_DOC} §9 — ".dim … (and smaller)"`,
  })
  relation({
    surface: SURFACE_A,
    title: 'the project name — a row’s size, not a heading’s',
    liveA: live.header?.project ?? null,
    liveB: firstRow?.name ?? null,
    property: 'fontSize',
    authority: `${CONTRACT_DOC} §6 — "the ratio is compared, not pixels"`,
  })
  expectContains({
    surface: SURFACE_A,
    title: 'the project name reads monospaced',
    live: live.header?.project ?? null,
    property: 'fontFamily',
    needle: 'mono',
    authority: `${CONTRACT_DOC} §9 — "the project name mono"`,
  })

  /* ── one surface: no mode switch, and the blocks it left behind ────────── */
  const pressedLive = live.pressedOpened ?? null
  const pressedLabels = [...(pressedLive?.labels ?? [])].sort()
  const filterLabels = [...FILTER_LABELS].sort()
  const tierPresses = pressedLive?.tiers ?? []
  contract({
    surface: SURFACE_A,
    title: 'no modes: a press stands only on filter chips, and only there is it non-empty',
    holds:
      pressedLive !== null &&
      pressedLive.outside === 0 &&
      pressedLabels.length === filterLabels.length &&
      pressedLabels.every((label, index) => label === filterLabels[index]) &&
      // The tools block's own presses are its tier chips and nothing else: each
      // is `{count} {label}` of the counters vocabulary, so a segment that came
      // back — or any other control growing an `aria-pressed` — fails here.
      tierPresses.every((label) =>
        TIER_LABELS.some((word) => label.indexOf(` ${word}`) === label.length - ` ${word}`.length),
      ),
    expected: `0 outside the disclosures and outside the tier chips · in the logs exactly the filter chips (${FILTER_LABELS.join(
      ' · ',
    )}) · in the tools only the tier chips (${TIER_LABELS.join(' · ')})`,
    live: pressedLive === null
      ? 'no snapshot with open bodies'
      : `${pressedLive.outside} outside the disclosures · in the logs: ${pressedLive.labels.join(' · ') || 'nothing'} · in the tools: ${tierPresses.join(' · ') || 'nothing'}`,
    authority:
      'docs/design/contracts/single-surface.md — "`[aria-pressed]` in the panel sits only on filter chips" + docs/design/contracts/surfaces.md §1.5 (F-43)',
    note: 'read on the snapshot with the disclosure bodies open, so a press inside one is in the DOM; the segment track left with the mode it switched, while the logs filter chips and the tools tier chips keep theirs',
  })
  contract({
    surface: SURFACE_A,
    title: 'the tools filter has a query field, and it is a panel field, not a form one',
    holds:
      live.toolFilter !== null &&
      live.toolFilter !== undefined &&
      live.toolFilter.tag === 'INPUT' &&
      live.toolFilter.type === 'search' &&
      typeof live.toolFilter.label === 'string' &&
      live.toolFilter.label.length > 0 &&
      live.toolFilter.inputs === 1,
    expected:
      'the tools block’s only `input`, `type=search`, with its own `aria-label` — a panel field, not a form one',
    live:
      live.toolFilter === null || live.toolFilter === undefined
        ? 'no field in the tools block'
        : `${live.toolFilter.tag ?? '—'} · type ${live.toolFilter.type ?? '—'} · label ${live.toolFilter.label ? 'present' : 'absent'} · ${live.toolFilter.inputs ?? 0} fields in the block · ${live.toolFilter.width ?? '?'}px · placeholder «${live.toolFilter.placeholder ?? ''}»`,
    authority:
      'docs/design/contracts/surfaces.md §1.5 — the tools filter panel (F-43): the query field, `Clear` and the caption',
    note: 'the block is found by its counters phrase, so the field is read out of the tools block rather than off the panel: a field anywhere else would not be this filter',
  })
  const tierChip = live.tierChip ?? null
  contract({
    surface: SURFACE_A,
    title: 'the tools filter’s tier chip — the same plate as a reading chip',
    holds:
      tierChip !== null &&
      /mono/.test(String(tierChip.fontFamily)) &&
      tierChip.bodyFontSize !== null &&
      Number.parseFloat(String(tierChip.fontSize)) < Number.parseFloat(String(tierChip.bodyFontSize)) &&
      tierChip.borderRadius === '4px' &&
      tierChip.borderStyle === 'none' &&
      tierChip.padding === '0px 5px',
    expected: 'mono · smaller than the panel body · 4 px radius · no border · `0 5px` padding',
    live: tierChip === null
      ? 'no tier chip in the tools block'
      : `«${tierChip.text}» · ${tierChip.fontFamily} · ${tierChip.fontSize} with the body at ${tierChip.bodyFontSize} · radius ${tierChip.borderRadius} · ${tierChip.borderStyle} · ${tierChip.padding}`,
    authority:
      'docs/design/contracts/surfaces.md §1.5 — "the tier chip’s plate is the reading chip’s plate" (F-43)',
    note: 'the tier chips are the counter chips as controls; a `font: inherit` written after the plate resets the mono face and the size to the shell\u2019s, which this row is the only reading of',
  })
  const serverPress = live.serverPressOpened?.pin ?? null
  contract({
    surface: SURFACE_A,
    title: 'a server group of the hidden tier has one action for the whole server',
    holds:
      serverPress !== null &&
      serverPress.expanded === null &&
      serverPress.line.indexOf('\u00b7') !== -1,
    expected: `a «${SERVER_PRESS_LABEL}» button on the «{server} · {count}» row, not itself a disclosure`,
    live: serverPress === null
      ? 'no press on a server row'
      : `«${serverPress.text}» on the row «${serverPress.line}» · aria-expanded ${serverPress.expanded ?? 'none'} · ${serverPress.width ?? '?'}×${serverPress.height ?? '?'}`,
    authority:
      'docs/design/contracts/surfaces.md §1.5 — the `hidden` tier’s server row carries the whole server’s pin (F-44)',
    note: 'read on the snapshot with the disclosure bodies open: the tier is folded by default, so the press is not in the DOM otherwise. The action is the expansion into names — there is no server rule in the policy (`docs/design/contracts/policy.md`)',
  })
  const serverUnpress = live.serverPressOpened?.unpin ?? null
  contract({
    surface: SURFACE_A,
    title: 'the pinned list has the same action in the opposite direction',
    holds:
      serverUnpress !== null &&
      serverUnpress.expanded === null &&
      serverUnpress.line.indexOf('\u00b7') !== -1,
    expected: `an «${SERVER_UNPRESS_LABEL}» button on the «{server} · {count}» row inside the pinned tier`,
    live: serverUnpress === null
      ? 'no press on a pinned server row'
      : `«${serverUnpress.text}» on the row «${serverUnpress.line}» · aria-expanded ${serverUnpress.expanded ?? 'none'}`,
    authority:
      'docs/design/contracts/surfaces.md §1.5 — the pinned list reads by server and carries `Unpin all` (F-44)',
    note: 'the pinned tier always has a group per server, so this press needs no unfolded disclosure — it is read on the same snapshot as the hidden tier, which is unfolded for the row above',
  })
  contract({
    surface: SURFACE_A,
    title: 'the tab body — a direct child of the panel, `9px 10px` padding',
    holds:
      live.body !== null &&
      live.body.direct === true &&
      live.body.afterHeader === true &&
      live.body.overflowY === 'auto' &&
      live.body.padding === '9px 10px',
    expected: 'body ∈ panel.children, header = the previous sibling, padding 9px 10px',
    live: live.body === null
      ? 'no body'
      : `${live.body.direct ? 'direct child' : 'nested deeper'} · ${
          live.body.afterHeader ? 'the header before it' : 'no header before it'
        } · overflow-y ${live.body.overflowY} · padding ${live.body.padding}`,
    authority:
      'docs/design/contracts/single-surface.md — `body`/`header` in `panel.children` + docs/design/contracts/surfaces.md §1.2 — "`flex:1; min-height:0; overflow:auto; padding:9px 10px`"',
    note: 'the anchor the segment track used to be; the parenthood is what proves the box is the panel’s own body and not a shell wrapper with the same rectangle',
  })
  contract({
    surface: SURFACE_A,
    title: 'the header — the body’s previous sibling, with `Sync` and the right-edge phrase',
    holds: live.header !== null && live.header.sync !== null && live.summary !== null,
    expected: 'Sync and the right-edge phrase above the body',
    live: live.header === null
      ? 'no header above the body'
      : `${live.header.sync === null ? 'no Sync' : 'Sync'} · «${live.summary?.text ?? 'no phrase'}»`,
    authority: 'docs/design/contracts/single-surface.md — "`header` — `body`\'s sibling in `panel.children` before it"',
  })
  contract({
    surface: SURFACE_A,
    title: 'the errors are not visible until the disclosure is opened',
    holds: live.errors !== null && live.errors.expanded === false && live.errors.bodyVisible === false,
    expected: 'the `errors` disclosure exists, its body not visible',
    live: live.errors === null
      ? 'no disclosure'
      : `«${live.errors.headText}» · aria-expanded ${live.errors.expanded} · body ${
          live.errors.bodyVisible ? 'visible' : 'hidden'
        }`,
    authority: 'docs/design/contracts/single-surface.md — the `errors` disclosure, "Collapsed by default"',
    note: '"no disclosure at all when there are no problems" is held by the DOM spec: the fixture has problems',
  })
  const logsHead = String(live.logs?.headText ?? '')
  contract({
    surface: SURFACE_A,
    title: 'the logs are not visible, and the head counts this session’s events, not the ring’s',
    holds:
      live.logs !== null &&
      live.logs.expanded === false &&
      live.logs.bodyVisible === false &&
      new RegExp(`(^|\\D)${FIXTURE_EVENTS}(\\D|$)`).test(logsHead) &&
      !new RegExp(`(^|\\D)${FIXTURE_RING_EVENTS}(\\D|$)`).test(logsHead),
    expected: `the disclosure folded, «${FIXTURE_EVENTS}» of this session (the ring holds ${FIXTURE_RING_EVENTS})`,
    live: live.logs === null
      ? 'no disclosure'
      : `«${logsHead}» · aria-expanded ${live.logs.expanded} · body ${
          live.logs.bodyVisible ? 'visible' : 'hidden'
        }`,
    authority: 'docs/design/contracts/single-surface.md — "The header: a label word + the number of this session\'s events in the ring"',
  })
  contract({
    surface: SURFACE_A,
    title: 'a click opens the tail disclosures: errors and logs',
    holds:
      live.errorsOpened?.expanded === true &&
      live.errorsOpened?.bodyVisible === true &&
      live.logsOpened?.expanded === true &&
      live.logsOpened?.bodyVisible === true,
    expected: 'the error and log bodies are visible',
    live: `${live.blockPress ?? '?'} · errors ${
      live.errorsOpened?.bodyVisible === true ? 'visible' : 'hidden'
    } · logs ${live.logsOpened?.bodyVisible === true ? 'visible' : 'hidden'}`,
    authority: 'docs/design/contracts/single-surface.md — the disclosure bodies: the `IssueView` and `LogsView` content',
  })
  const order = live.order ?? {}
  const orderKeys = ['row', 'sessions', 'tools', 'errors', 'logs']
  const tops = orderKeys
    .map((key) => order[key])
    .filter((top) => typeof top === 'number')
  contract({
    surface: SURFACE_A,
    title: 'the block order: servers, sessions, tools, errors, logs',
    holds:
      // Both tail blocks have to be known by their own label, or position would
      // be deciding which is which and a swap of the two could not fail.
      live.errorsLabeled === true &&
      live.logsLabeled === true &&
      tops.length >= 4 &&
      tops.every((top, index) => index === 0 || tops[index - 1] < top),
    expected: 'errors and logs recognized by their label and in this order; the rest — top to bottom',
    live: `errors «${live.errors?.headText ?? '—'}» ${live.errorsLabeled === true ? 'by label' : 'by position'} · ` +
      `logs «${live.logs?.headText ?? '—'}» ${live.logsLabeled === true ? 'by label' : 'by position'} · ` +
      orderKeys.map((key) => `${key} ${order[key] ?? '—'}`).join(' · '),
    authority: 'docs/design/contracts/single-surface.md — "The order in the tab\'s body (top to bottom)"',
    note: 'the two tail blocks are told apart by their labels, so swapping them fails here; the sessions block is drawn only while a session deviates, and the fixture keeps one deviation',
  })

  /* ── one tool row, folded open ─────────────────────────────────────────── */
  relation({
    surface: SURFACE_A,
    title: 'a tool row — the same tone as a server row',
    liveA: live.toolOpen?.name ?? null,
    liveB: firstRow?.name ?? null,
    property: 'color',
    authority: `${CONTRACT_DOC} §9 — "the colour and weight of a server row"`,
  })
  relation({
    surface: SURFACE_A,
    title: 'a tool row — the same weight as a server row',
    liveA: live.toolOpen?.name ?? null,
    liveB: firstRow?.name ?? null,
    property: 'fontWeight',
    authority: `${CONTRACT_DOC} §9 — "the colour and weight of a server row"`,
  })
  expectContains({
    surface: SURFACE_A,
    title: 'the tool name in the row — monospaced',
    live: live.toolOpen?.name,
    property: 'fontFamily',
    needle: 'mono',
    authority: `${CONTRACT_DOC} §9 — "the name mono"`,
  })
  expectPixels({
    surface: SURFACE_A,
    title: 'a tool’s disclosure — a one-rung indent',
    live: live.toolOpen?.detail,
    expected: '12px',
    property: 'paddingLeft',
    authority: `${CONTRACT_DOC} §9 — "the disclosure’s 12 px indent"`,
  })
  expectContains({
    surface: SURFACE_A,
    title: 'the full name in the disclosure — monospaced',
    live: live.toolOpen?.detailName,
    property: 'fontFamily',
    needle: 'mono',
    authority: `${CONTRACT_DOC} §1.5 — "with the full name (mono)"`,
  })
  contract({
    surface: SURFACE_A,
    title: 'a tool’s disclosure prints the full `mcp__<server>__<tool>`',
    holds: live.toolOpen?.expanded === true && live.toolOpen?.detailVisible === true && live.toolOpen?.full === true,
    expected: 'mcp__<server>__<tool> visible',
    live: live.toolOpen === null
      ? 'no tool row'
      : `${live.toolOpen.detailName?.text ?? '?'} · ${live.toolOpen.expanded ? 'open' : 'folded'}`,
    authority: 'docs/design/contracts/single-surface.md — "the full public name in mono: `mcp__<server>__<tool>`"',
    note: 'the row is pressed through the counters sentence, not through a tool name the panel may shorten',
  })
  contract({
    surface: SURFACE_A,
    title: 'a tool row is folded by default, and a second click closes it',
    holds: live.tool?.expanded === false && live.toolOpen?.expanded === true && live.toolClosed?.expanded === false,
    expected: 'closed → open → closed',
    live: `${live.tool?.expanded ?? '?'} → ${live.toolOpen?.expanded ?? '?'} → ${live.toolClosed?.expanded ?? '?'}`,
    authority: 'docs/design/contracts/single-surface.md — "a second click closes the disclosure"',
  })
  expectToken({
    surface: SURFACE_A,
    title: 'the errors disclosure’s label — the tertiary tone',
    live: live.errors?.head,
    tokens,
    token: 'tertiary',
    property: 'color',
    authority:
      `${CONTRACT_DOC} §9 — "the disclosure labels in one tertiary tone" (the label is the control’s word, not its state)`,
  })
  expectToken({
    surface: SURFACE_A,
    title: 'the logs disclosure’s label — the tertiary tone',
    live: live.logs?.head,
    tokens,
    token: 'tertiary',
    property: 'color',
    authority: `${CONTRACT_DOC} §9 — "the disclosure labels in one tertiary tone"`,
  })
  relation({
    surface: SURFACE_A,
    title: 'both disclosure labels read in one tone',
    liveA: live.errors?.head ?? null,
    liveB: live.logs?.head ?? null,
    property: 'color',
    authority: `${CONTRACT_DOC} §9 — "the disclosure labels in one tertiary tone"`,
  })

  /* ── density, the ladder, the narrow shell ─────────────────────────────── */
  const rowLeft = live.rowPadding === null ? null : String(live.rowPadding).split(' ')[1]
  const rungs = [rowLeft === '0px' ? 0 : null, ...live.indentValues.map((value) => parseFloat(value))]
    .filter((rung) => rung !== null)
  contract({
    surface: SURFACE_A,
    title: 'the 0 / 12 / 24 / 36 indent ladder',
    holds:
      [0, 12, 24, 36].every((rung) => rungs.includes(rung)) &&
      live.indentValues.every((value) => parseFloat(value) % 12 === 0),
    expected: '0, 12, 24, 36 — every rung on INDENT',
    live: rungs.length === 0 ? 'no rungs' : rungs.join(', '),
    authority: `${CONTRACT_DOC} §9 — "the 0/12/24/36 ladder"`,
    note: `${live.ladder?.section ?? '?'} · ${live.ladder?.session ?? '?'}`,
  })
  contract({
    surface: SURFACE_A,
    title: `the panel works at the stand’s narrow width (${NARROW_WIDTH}px)`,
    holds: narrow?.found === true && narrow.overflow.length === 0 && narrow.width <= NARROW_WIDTH + 1,
    expected: 'no horizontal overflow',
    live: narrow?.found === true ? `${narrow.width}px, overflow ${narrow.overflow.length}` : 'not measured',
    authority: `${CONTRACT_DOC} §9 — "separately at 330 px with no horizontal overflow"`,
    note: `${narrow?.width ?? '?'}px — the width the panel probe assigns itself`,
  })
  contract({
    surface: SURFACE_A,
    title: 'the live panel is wider than the narrow band, hence a separate narrow measurement',
    // The bounds `findPanel()` refuses are not the claim here: the claim is that
    // the shell's own pane is wider than the band the narrow probe forces, which
    // is exactly why the 330px row above has to set the width instead of reading it.
    holds:
      typeof live.panel?.rect?.width === 'number' &&
      live.panel.rect.width > NARROW_WIDTH + 20,
    expected: `the panel wider than ${NARROW_WIDTH + 20}px`,
    live: `${live.panel?.rect?.width ?? '?'}px panel`,
    authority: `${CONTRACT_DOC} §9 — "the panel works at the shell’s native width and separately at 330 px"`,
    note: 'a pane that ever narrowed to the stand’s band would make the forced 330px reading meaningless',
  })
  contract({
    surface: SURFACE_A,
    title: 'the server row density — `2px 0` and `gap 6px`',
    holds:
      live.rowPadding !== null &&
      samePixels(String(live.rowPadding).split(' ')[0], '2px') &&
      samePixels(String(live.rowPadding).split(' ')[1], '0') &&
      samePixels(live.rowGap, '6px'),
    expected: '2px 0 · gap 6px',
    live: live.rowPadding === null ? 'no rows' : `${live.rowPadding} · gap ${live.rowGap}`,
    authority: `${CONTRACT_DOC} §9 — "the row density 2px 0 and gap 6px"`,
  })
  contract({
    surface: SURFACE_A,
    title: 'the bar’s row padding — `7px 9px`',
    holds: (() => {
      const parts = String(live.header?.padding).split(' ')
      return samePixels(parts[0], '7px') && samePixels(parts[1], '9px')
    })(),
    expected: '7px 9px',
    live: String(live.header?.padding),
    authority: `${CONTRACT_DOC} §9 — "the bar padding 7px 9px"`,
  })

  /* ── surface D, the logs disclosure ────────────────────────────────────── */
  const logRow = live.logRows[0] ?? null
  contract({
    surface: SURFACE_D,
    title: 'the ring holds an event — there is a row to check',
    holds: logRow !== null,
    expected: '≥ 1 event',
    live: `${live.logRows.length} rows`,
    authority: `scripts/design-parity.mjs — the fixture puts ${FIXTURE_RING_EVENTS} events in the ring (${FIXTURE_EVENTS} of them this session's)`,
    note: 'F-26 moved the ring under the logs disclosure, and the harness unfolds it before this capture',
  })
  expectContains({
    surface: SURFACE_D,
    title: 'the event time — monospaced',
    live: logRow?.time ?? null,
    property: 'fontFamily',
    needle: 'mono',
    authority: `${CONTRACT_DOC} §9 — "the time mono and tertiary"`,
  })
  expectToken({
    surface: SURFACE_D,
    title: 'the event time — the tertiary tone',
    live: logRow?.time ?? null,
    tokens,
    token: 'tertiary',
    property: 'color',
    authority: `${CONTRACT_DOC} §9 — "the time mono and tertiary"`,
  })
  expectRule({
    surface: SURFACE_D,
    title: 'the message — its own full-width line',
    live: logRow?.message ?? null,
    expected: '100%',
    property: 'flexBasis',
    authority: `${CONTRACT_DOC} §1.7 — "the message full-width (flex:1 1 100%)"`,
  })
  contract({
    surface: SURFACE_D,
    title: 'the message sits below the row’s head',
    holds: typeof logRow?.messageBelow === 'number' && logRow.messageBelow > 0,
    expected: '> 0px below the time',
    live: logRow?.messageBelow === undefined || logRow?.messageBelow === null ? 'no row' : `${logRow.messageBelow}px`,
    authority: `${CONTRACT_DOC} §9 — "the message on its own line below the time"`,
  })
  if (logRow !== null && logRow.detail !== null) {
    expectPixels({
      surface: SURFACE_D,
      title: 'the error detail — a ruler on the left',
      live: logRow.detail,
      expected: '2px',
      property: 'borderLeftWidth',
      authority: `${CONTRACT_DOC} §9 — "the detail with a 2 px ruler"`,
    })
  } else {
    skipped({
      surface: SURFACE_D,
      title: 'the error detail — a ruler on the left',
      expected: '2px',
      live: logRow === null ? 'no event row' : 'no failure in the ring',
      authority: `${CONTRACT_DOC} §9 — "the detail with a 2 px ruler"`,
      note: 'the ring held no failure: a detail line renders under an `error` event only',
    })
  }
  plate(SURFACE_D, logRow?.level ?? null, 'the level chip (`info` / `up` / `warn` / `error`)')
  expectContains({
    surface: SURFACE_D,
    title: 'the level chip (`info` / `up` / `warn` / `error`) — monospaced',
    live: logRow?.level ?? null,
    property: 'fontFamily',
    needle: 'mono',
    authority: CHIP_AUTHORITY,
  })
  // The chips are controls, so their plate is checked on the applied state too:
  // the applied pair reads through the fill, not the layer.
  const filterOff = (live.logFilters ?? []).find((chip) => chip.pressed === 'false') ?? null
  const filterOn = (live.logFilters ?? []).find((chip) => chip.pressed === 'true') ?? null
  plate(SURFACE_D, filterOff, 'the filter chip (not applied)')
  expectRule({
    surface: SURFACE_D,
    title: 'the applied filter chip — 4px radius',
    live: filterOn,
    expected: '4px',
    property: 'borderRadius',
    authority: `${CONTRACT_DOC} §9 — "the applied filter reads by its fill"`,
  })
  expectRule({
    surface: SURFACE_D,
    title: 'the applied filter chip — no border',
    live: filterOn,
    expected: 'none',
    property: 'borderStyle',
    authority: `${CONTRACT_DOC} §9 — "the applied filter reads by its fill"`,
  })
  expectToken({
    surface: SURFACE_D,
    title: 'the applied filter chip reads by its fill',
    live: filterOn,
    tokens,
    token: 'applied',
    property: 'backgroundColor',
    authority: `${CONTRACT_DOC} §9 — "the applied filter reads by its fill"`,
  })
  contract({
    surface: SURFACE_D,
    title: 'exactly one chip is applied in each filter pair',
    holds: ['this session', 'all sessions'].filter((label) => (live.logFilters ?? []).find((chip) => chip.text === label)?.pressed === 'true').length === 1 &&
      ['all levels', 'errors'].filter((label) => (live.logFilters ?? []).find((chip) => chip.text === label)?.pressed === 'true').length === 1,
    expected: 'one of the two in a pair',
    live: (live.logFilters ?? []).map((chip) => `${chip.text}:${chip.pressed}`).join(' · '),
    authority: `${CONTRACT_DOC} §9 — "one applied chip in each filter pair"`,
  })

  /* ── the frame-wide toast ──────────────────────────────────────────────── */
  contract({
    surface: SURFACE_T,
    title: 'the toast rose and landed in the frame layer',
    holds: toast?.found === true && toast.stack !== null,
    expected: 'the banner in `shell.overlay`',
    live: toast?.found === true ? `«${toast.text}»` : 'not caught',
    authority: `${CONTRACT_DOC} §4 — "Surface T — toasts": the frame-layer shell.overlay slot`,
    note: 'the banner is the shell’s floating layer, drawn outside the panel; caught from the transition the harness provoked with `Sync`',
  })
  if (toast?.found === true) {
    expectRule({
      surface: SURFACE_T,
      title: 'the toast banner — the shell radius',
      live: toast.banner,
      expected: '14px',
      property: 'borderRadius',
      authority: 'src/client/toasts.ts — the stock DSH Toast geometry',
    })
    expectRule({
      surface: SURFACE_T,
      title: 'the toast banner — the shell padding',
      live: toast.banner,
      expected: '12px 16px',
      property: 'padding',
      authority: 'src/client/toasts.ts — the stock DSH Toast geometry',
    })
    contract({
      surface: SURFACE_T,
      title: 'the toast banner — a contrast-layer background and inverse text',
      holds:
        toast.banner.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
        toast.banner.color !== toast.banner.backgroundColor,
      expected: 'an opaque background + readable text',
      live: `${toast.banner.backgroundColor} · ${toast.banner.color}`,
      authority: 'src/client/toasts.ts — `--dsw-alias-button-contrast-fill` / `-label-primary-inverted`',
    })
  }
}

/* -------------------------------------------------------------------------- */
/* Report                                                                      */
/* -------------------------------------------------------------------------- */

/** How wide the widest cell of a column is. */
function columnWidth(rows, key) {
  return rows.reduce((width, row) => Math.max(width, String(row[key] ?? '').length), 0)
}

function report() {
  const order = { FAIL: 0, SKIP: 1, ACCEPTED: 2, PASS: 3 }
  const sorted = [...results].sort((left, right) => order[left.status] - order[right.status])
  const w = {
    status: columnWidth(sorted, "status"),
    surface: columnWidth(sorted, "surface"),
    title: columnWidth(sorted, "title"),
  }
  const indent = " ".repeat(w.status + 2 + w.surface + 2)
  console.log("")
  for (const row of sorted) {
    console.log(`${row.status.padEnd(w.status)}  ${row.surface.padEnd(w.surface)}  ${row.title}`)
    if (row.status !== "PASS") console.log(`${indent}${row.authority}`)
    if (row.detail !== undefined) console.log(`${indent}${row.status === "FAIL" ? "FAIL: " : ""}${row.detail}`)
    if (row.status !== "FAIL" && row.live !== null && row.expected !== null) {
      console.log(`${indent}live ${row.live}   ·   contract ${row.expected}`)
    }
  }
  const by = (status) => sorted.filter((row) => row.status === status)
  const failed = by("FAIL")
  const acceptedRows = by("ACCEPTED")
  const skippedRows = by("SKIP")
  console.log("")
  console.log(
    `design-parity: ${by("PASS").length} PASS · ${acceptedRows.length} ACCEPTED (documented exceptions) · ` +
      `${skippedRows.length} SKIP (not observed) · ${failed.length} FAIL`,
  )
  if (acceptedRows.length > 0) {
    console.log("accepted exceptions:")
    for (const row of acceptedRows) console.log(`  · ${row.title} — ${row.authority}`)
  }
  if (skippedRows.length > 0) {
    console.log("skipped (not passing):")
    for (const row of skippedRows) console.log(`  · ${row.title} — ${row.detail ?? ""}`)
  }
  return failed.length
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  const spec = linkedSpec()
  if (spec === undefined) fail(`design-parity: the ${PROFILE} profile does not declare dsh-project-mcp`, 2)
  if (!spec.startsWith('link:')) {
    fail(`design-parity: ${PROFILE} pins ${spec}; a tarball cannot see the working tree — use link:<repo>`, 2)
  }
  const bundle = bundleInfo()
  if (bundle.missing === true) fail('design-parity: lib/client.js is missing — run `pnpm build` first', 2)

  console.log(`design-parity: profile ${PROFILE} (${spec})`)
  console.log(`design-parity: profile manifest ${join(PROFILE_DIR, 'package.json')}`)
  console.log(`design-parity: bundle ${bundle.path} sha256 ${bundle.sha256} (${bundle.bytes} bytes, built ${bundle.builtAt})`)

  const chrome = findChrome()
  const server = await startServer()
  let app
  try {
    app = await connect(chrome, server.url)
    await mounted(app.page)
    // The panel draws the fixture (see {@link FIXTURE_SCRIPT}): the real
    // components and theme, every state the contract names, no dependency on
    // the machine having a live agent.
    await installFixture(app.page)
    await openTab(app.page, 'Project MCP')
    const ready = await waitForProject(app.page)
    if (ready.ok !== true) {
      const diagnosis = await app.page.value(DIAGNOSE_PROBE).catch((error) => String(error))
      console.error(JSON.stringify(diagnosis, null, 2))
      fail(`design-parity: the tab never read the fixture's project (${ready.project})`, 2)
    }
    console.log(`design-parity: project ${ready.project} (fixture payload, every state on screen)`)

    if (WATCH) {
      for (let attempt = 0; attempt < 30; attempt++) {
        await sleep(700)
        const surface = await app.page.json(LIVE_SURFACE_PROBE)
        const state = await app.page.json(READY_PROBE)
        console.log(
          `watch ${attempt}: ready=${String(state.ready)} why=${state.why} rows=${surface.rows?.length ?? 0} ` +
            `disclosures=${surface.disclosures?.length ?? 0} logRows=${surface.logRows?.length ?? 0} ` +
            `summary=${String(surface.summary?.text)}`,
        )
      }
      return 0
    }

    // The tab has one surface (F-26): every block is on screen at once, and the
    // sessions section is unfolded because its rungs are part of the ladder.
    // Both tail disclosures and the tool rows stay in their default state for
    // the first capture — that is what the "folded by default" rows read.
    const ladder = await openLadder(app.page)
    const surface = await app.page.json(LIVE_SURFACE_PROBE)
    if (SHOT !== undefined) {
      // A little air on both sides: the pane body's own box starts where its
      // rows' inset begins, so a tight clip shaves the first character.
      const box = surface.panel?.rect
      const shot = await app.page.send('Page.captureScreenshot', {
        format: 'png',
        ...(box === undefined
          ? {}
          : { clip: { x: box.x - 12, y: box.y, width: box.width + 24, height: box.height, scale: 2 } }),
      })
      writeFileSync(SHOT, Buffer.from(shot.data, 'base64'))
      console.log(`design-parity: ${SHOT} (${box?.width ?? '?'}x${box?.height ?? '?'} at 2x)`)
    }

    // A tool row is a disclosure of its own: press it, read the full `mcp__` name
    // its body prints, then press it again — the contract's "a second click
    // closes the disclosure". The row is found through the tools counters
    // sentence, never through a tool name the panel may shorten.
    const toolPress = await pressToolRow(app.page)
    await sleep(SETTLE_MS)
    const toolOpen = await app.page.json(LIVE_SURFACE_PROBE)
    await pressToolRow(app.page)
    await sleep(400)
    const toolClosed = await app.page.json(LIVE_SURFACE_PROBE)

    // The errors and the logs disclosure are the contract's last two blocks, and
    // both open folded (`LogsView` reads its own filters once its body mounts).
    // Opening them puts the ring's rows and the failure's body on screen; the
    // fixture's status channel is raising a banner while that settles, and that
    // banner is the toast the last checks read.
    const blockPress = await openTailBlocks(app.page)
    // The server press of F-44 sits in the tools block's folded `hidden` tier:
    // unfold it for the tail reading, fold it back before the width probe.
    await foldHiddenTier(app.page, true)
    await sleep(SETTLE_MS)
    let toast = { found: false }
    let tail = { found: false, logRows: [] }
    for (let attempt = 0; attempt < 40; attempt++) {
      await sleep(400)
      const seen = await app.page.json(TOAST_PROBE)
      if (seen.found === true) toast = seen
      tail = await app.page.json(LIVE_SURFACE_PROBE)
      if ((tail.logRows?.length ?? 0) > 0 && toast.found === true) break
    }

    await foldHiddenTier(app.page, false)

    // The narrow shell is measured with the tool's own detail open: the detail
    // is the widest thing the new surface adds, so that is the state the pane
    // has to survive.
    await pressToolRow(app.page)
    await sleep(SETTLE_MS)
    const narrow = await app.page.json(WIDTH_PROBE)
    await pressToolRow(app.page)
    await sleep(400)

    const live = {
      ...surface,
      ladder,
      toolOpen: toolOpen.tool,
      toolClosed: toolClosed.tool,
      toolPress,
      blockPress,
      errorsOpened: tail.errors,
      logsOpened: tail.logs,
      // The pressed-control rows read the snapshot with the disclosure bodies
      // open: a press inside a folded body is not in the DOM to be counted.
      pressedOpened: tail.pressed,
      serverPressOpened: tail.serverPress,
      logRows: tail.logRows,
      logFilters: tail.logFilters,
    }

    if (DUMP) {
      if (JSON_OUT !== undefined) writeFileSync(JSON_OUT, JSON.stringify({ live, narrow, toast }, null, 2))
      console.log(JSON.stringify({ live, narrow, toast }, null, 2))
      return 0
    }
    if (live.found !== true) fail('design-parity: the plugin’s tab panel is not on the page', 1)

    verdict(live, toast, narrow)
    if (JSON_OUT !== undefined) writeFileSync(JSON_OUT, JSON.stringify({ live, narrow, toast, results }, null, 2))
    return report()
  } finally {
    app?.stop()
    await stopServer(server)
    // A server left alive would keep the shared session store held, which is the
    // failure this gate's own profile boot must not cause.
    reapOrphanedServers(PROFILE)
  }
}

process.exitCode = await main()
