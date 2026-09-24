#!/usr/bin/env node
/**
 * Resource audit for `dsh-project-mcp`: proves the plugin does not leak child
 * processes, file descriptors, watchers or memory, and that an idle project and
 * an unrelated file-churn storm cost (almost) no CPU.
 *
 * Run: pnpm build && node scripts/audit.mjs   (or: bun scripts/audit.mjs)
 *
 * The runtime under test is the real one, mounting the real
 * `@deepseek-ai/dsh-mcp-client` into a real `createScope` scope; only the host
 * (`logger`, `tools`, `loader`) is stubbed so the audit can observe it.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ProjectMcpRuntime } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, 'fixture-mcp-server.mjs')
const CATALOG = Number(process.env.AUDIT_TOOL_CATALOG ?? 400)
const results = []

function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/**
 * A gate that could not run. Skipping is not passing: the line says why, and it
 * stays out of the pass/fail tally so a standalone `pnpm audit` — which runs no
 * coverage pass and therefore has no artifact to read — cannot fail on it.
 */
function skip(name, detail) {
  console.log(`SKIP ${name} — ${detail}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fdCount() {
  try {
    return readdirSync('/dev/fd').length
  } catch {
    return -1
  }
}

function cpuMs() {
  const usage = process.cpuUsage()
  return (usage.user + usage.system) / 1000
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

async function waitFor(probe, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (probe()) return true
    await sleep(100)
  }
  return false
}

const createdDirs = []
function tmpRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'project-mcp-audit-'))
  createdDirs.push(dir)
  return dir
}

/** Project directory with a `.dsh/mcp.json` declaring the fixture server. */
function makeProject(pidPath) {
  const root = tmpRoot()
  mkdirSync(join(root, '.dsh'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(
    join(root, '.dsh', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        audit: {
          command: process.execPath,
          args: [fixture],
          ...(pidPath === undefined ? {} : { env: { AUDIT_PID_FILE: pidPath } }),
        },
      },
    }),
  )
  return root
}

/**
 * Host stub. `tools.schemas()` counts calls and returns a large synthetic
 * catalog, so catalog churn per pass is observable.
 */
function makeHost() {
  const calls = { schemas: 0, registered: new Map(), mounts: 0 }
  const debug = []
  const warnings = []
  const infos = []
  const mountCtx = new Context()
  mountCtx.provide('tools', {
    register: (definition) => {
      calls.registered.set(definition.name, definition)
      return () => calls.registered.delete(definition.name)
    },
    schemas: () => {
      calls.schemas += 1
      const synthetic = Array.from({ length: CATALOG }, (_, index) => ({ name: `mcp__fake${index}__tool` }))
      return synthetic.concat([...calls.registered.keys()].map((name) => ({ name })))
    },
    get: (name) => calls.registered.get(name),
  })
  const host = {
    logger: {
      debug: (message) => debug.push(String(message)),
      info: (message) => infos.push(String(message)),
      warn: (message) => warnings.push(String(message)),
    },
    tools: mountCtx.tools,
    get: () => undefined,
  }
  return {
    host,
    mountCtx,
    calls,
    debug,
    warnings,
    infos,
    // The scope context is wrapped so the plugin's own mount attempts can be
    // counted: `ctx.plugin` is context-bound, so it is called through the
    // receiver and the child fiber still belongs to the real context.
    makeScope: (_ctx, agent) => {
      const scope = createScope(mountCtx, agent)
      return {
        ctx: {
          plugin: (plugin, config) => {
            calls.mounts += 1
            return scope.ctx.plugin(plugin, config)
          },
        },
        dispose: () => scope.dispose(),
      }
    },
  }
}

/** Each simulated session owns its own context, as a real agent does. */
function agentCtx(env) {
  return env.mountCtx.extend({})
}

function makeAgentScope() {
  const handlers = new Map()
  const agents = []
  return {
    agents: { list: () => [...agents] },
    on(name, handler) {
      const list = handlers.get(name) ?? []
      list.push(handler)
      handlers.set(name, list)
      return () => undefined
    },
    effect() {
      return () => undefined
    },
    emit(name, payload) {
      for (const handler of handlers.get(name) ?? []) handler(payload)
    },
    /** Drive the pre-step hook the way the loop does: with its continuation. */
    async step(agent) {
      for (const handler of handlers.get('agent/pre-step') ?? []) {
        await handler({ agent }, async () => undefined)
      }
    },
    add(agent) {
      agents.push(agent)
    },
    remove(agent) {
      const index = agents.indexOf(agent)
      if (index >= 0) agents.splice(index, 1)
    },
  }
}

function runtimeFor(env, project, overrides = {}, options = {}) {
  const config = {
    localFiles: ['.dsh/mcp.json'],
    globalFiles: [],
    inputs: {},
    projectMarkers: ['.git', '.dsh', 'package.json'],
    fileMarkers: ['.sln', '.slnx', '.csproj'],
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
    connectTimeoutMs: 60_000,
    lazy: false,
    idleTimeoutMs: 0,
    activationWaitMs: 0,
    profileWins: true,
    watch: true,
    debounceMs: 300,
    rescanIntervalMs: 10_000,
    credentialsFile: join(project, 'missing-credentials.yaml'),
    ...overrides,
  }
  const runtime = new ProjectMcpRuntime(env.host, config, { createScope: env.makeScope })
  const counters = { passes: 0 }
  // Count passes at the pass itself: scheduled and watcher-driven passes do not
  // go through `syncNow`.
  const originalPass = runtime.runPass.bind(runtime)
  runtime.runPass = async (force) => {
    counters.passes += 1
    return originalPass(force)
  }
  const agent = { id: 'audit-session', session: { header: { cwd: join(project, 'src') } }, ctx: env.mountCtx }
  const scope = makeAgentScope()
  if (options.withAgent !== false) scope.add(agent)
  runtime.attach(scope)
  return { runtime, counters, scope, agent }
}

async function sectionChildLifecycle() {
  const root = tmpRoot()
  const pidPath = join(root, 'child.pid')
  const project = makeProject(pidPath)
  const env = makeHost()
  const { runtime } = runtimeFor(env, project)
  await runtime.syncNow()

  const mounted = await waitFor(() => env.calls.registered.has('mcp__audit__echo'))
  check('mount connects and registers its tools', mounted)

  const pid = Number(existsSync(pidPath) ? readFileSync(pidPath, 'utf8').trim() : '')
  check('mcp server child runs while mounted', Number.isInteger(pid) && pid > 0 && alive(pid), `pid ${pid}`)

  await runtime.disposeAll()
  const gone = await waitFor(() => !alive(pid), 5_000)
  check('dispose kills the mcp server child', gone, `pid ${pid}`)
  check('child removes its pid file on exit', !existsSync(pidPath))
  return { pid, childExited: gone }
}

/**
 * The "twenty project folders" case: sessions that never start a turn must run
 * no server at all, the one that does must mount only its own project, and a
 * session that goes quiet must give its servers back.
 */
async function sectionLazy() {
  const projects = []
  for (let index = 0; index < 10; index += 1) {
    const pidPath = join(tmpRoot(), `child-${index}.pid`)
    projects.push({ pidPath, root: makeProject(pidPath) })
  }
  const env = makeHost()
  const { runtime, scope, counters } = runtimeFor(
    env,
    projects[0].root,
    { lazy: true, idleTimeoutMs: 400, rescanIntervalMs: 150, watch: false },
    { withAgent: false },
  )
  // A second, idle session of the first project, registered *before* the session
  // that will turn: a first-wins merge would then report that mounted project as
  // idle, and the per-session breakdown has to say which session holds the mount.
  const idleAgent = {
    id: 'lazy-idle',
    session: { header: { cwd: join(projects[0].root, 'src') } },
    ctx: agentCtx(env),
  }
  scope.add(idleAgent)
  scope.emit('agent/created', { agent: idleAgent })
  const agents = projects.map((project, index) => {
    const agent = {
      id: `lazy-${index}`,
      session: { header: { cwd: join(project.root, 'src') } },
      ctx: agentCtx(env),
    }
    scope.add(agent)
    scope.emit('agent/created', { agent })
    return agent
  })
  const children = () => projects.filter((project) => existsSync(project.pidPath)).length
  const mountedNow = () =>
    runtime.snapshot().projects.filter((project) => project.rows[0]?.status === 'active')

  const cpuBefore = cpuMs()
  const passesBefore = counters.passes
  await sleep(400)
  const lazyReport = {
    projects: projects.length,
    children: children(),
    passes: counters.passes - passesBefore,
    published: runtime.snapshot().projects.length,
    idleRows: runtime.snapshot().projects.filter((project) => project.rows[0]?.status === 'idle').length,
    cpuMs: Number((cpuMs() - cpuBefore).toFixed(2)),
  }
  check('lazy: no server runs before a turn', lazyReport.children === 0, `${lazyReport.children} children`)
  check('lazy: every project is still published', lazyReport.published === projects.length, `${lazyReport.published} projects`)
  check('lazy: declarations show as idle', lazyReport.idleRows === projects.length, `${lazyReport.idleRows} idle rows`)
  check('lazy: waiting costs no CPU', lazyReport.cpuMs < 200, `${lazyReport.cpuMs} ms over 400 ms`)

  scope.emit('agent/status', { agent: agents[0], status: 'running' })
  const mounted = await waitFor(() => mountedNow().length === 1, 10_000)
  const mountedChildren = children()
  check('lazy: the session that starts a turn mounts its project', mounted, `${mountedChildren} children`)
  check('lazy: no other project is mounted', mountedChildren === 1 && mountedNow().length === 1, `${mountedNow().length} mounted`)

  // The hook a real first step goes through. Awaiting it used to run one
  // pass-wide forced pass, which mounted every registered session's project: one
  // session working started servers for all ten. It must mount exactly this one.
  const attemptsBefore = env.calls.mounts
  await scope.step(agents[5])
  // The pass registers the mount and returns; the child writes its pid file when
  // it comes up. Both are read at the moment the second project is mounted, not
  // after a fixed wait: this harness also sweeps idle sessions, so a longer wait
  // can read after the sweep has already taken the server back down.
  const stepped = await waitFor(() => mountedNow().length === 2 && children() === 2, 10_000)
  const attempts = env.calls.mounts - attemptsBefore
  check(
    'lazy: one session’s step mounts its project and no other',
    stepped && attempts === 1,
    `${attempts} mount attempts, ${children()} children after one step`,
  )

  const firstProject = runtime.snapshot().projects.find((project) => project.projectRoot === projects[0].root)
  const sessions = firstProject?.sessions.map((session) => [session.id, session.rows[0]?.status]) ?? []
  check(
    'snapshot: a project merges by the most actionable status, not by session order',
    firstProject?.rows[0]?.status === 'active',
    firstProject?.rows[0]?.status ?? 'no row',
  )
  check(
    'snapshot: the breakdown says which session holds the mount',
    sessions.length === 2 &&
      sessions[0]?.[0] === 'lazy-idle' &&
      sessions[0]?.[1] === 'idle' &&
      sessions[1]?.[0] === 'lazy-0' &&
      sessions[1]?.[1] === 'active',
    JSON.stringify(sessions),
  )

  scope.emit('agent/status', { agent: agents[0], status: 'idle' })
  const released = await waitFor(() => children() === 0, 10_000)
  check('idle: a quiet session releases its servers', released, `${children()} children left`)
  check(
    'idle: its rows stay visible as idle',
    runtime.snapshot().projects.some((project) => project.rows[0]?.status === 'idle'),
  )

  await runtime.disposeAll()
  check('lazy: teardown leaves no child behind', children() === 0)
  return { ...lazyReport, mountedChildren, afterRelease: children(), sessions }
}

/**
 * Two sessions of one project must share one instance — one child process — for
 * as long as either of them holds it, while a session of another project runs
 * nothing until its own turn asks. The instance goes down with the project's
 * *last* holder, never with the first one.
 */
async function sectionSharedMount() {
  const sharedPidPath = join(tmpRoot(), 'shared.pid')
  const otherPidPath = join(tmpRoot(), 'other.pid')
  const projectRoot = makeProject(sharedPidPath)
  const otherRoot = makeProject(otherPidPath)
  const env = makeHost()
  const { runtime, scope } = runtimeFor(
    env,
    projectRoot,
    { lazy: true, watch: false, rescanIntervalMs: 150 },
    { withAgent: false },
  )

  const childPid = (pidPath) =>
    existsSync(pidPath) ? Number(readFileSync(pidPath, 'utf8').trim()) : undefined
  const sessions = ['shared-1', 'shared-2'].map((id) => ({
    id,
    session: { header: { cwd: join(projectRoot, 'src') } },
    ctx: agentCtx(env),
  }))
  const neighbour = {
    id: 'other-1',
    session: { header: { cwd: join(otherRoot, 'src') } },
    ctx: agentCtx(env),
  }
  for (const agent of [...sessions, neighbour]) {
    scope.add(agent)
    scope.emit('agent/created', { agent })
  }
  const sessionStatus = (projectRoot, id) =>
    runtime
      .snapshot()
      .projects.find((entry) => entry.projectRoot === projectRoot)
      ?.sessions.find((entry) => entry.id === id)?.rows[0]?.status

  const attemptsBefore = env.calls.mounts
  scope.emit('agent/status', { agent: sessions[0], status: 'running' })
  await scope.step(sessions[0])
  const mounted = await waitFor(() => childPid(sharedPidPath) !== undefined, 15_000)
  const firstPid = childPid(sharedPidPath)
  const attemptsAfterFirst = env.calls.mounts - attemptsBefore

  // The second session's own turn: it must resolve the running instance, not
  // start another one, and the operator must not see a second creation line.
  scope.emit('agent/status', { agent: sessions[1], status: 'running' })
  await scope.step(sessions[1])
  await waitFor(() => sessionStatus(projectRoot, 'shared-2') === 'active', 10_000)
  await sleep(400)
  const attemptsAfterSecond = env.calls.mounts - attemptsBefore
  const sharedLines = env.infos.filter(
    (line) => line.includes(': mounting ') && line.includes('shared'),
  )

  check(
    'shared: two sessions of one project start one child process',
    mounted && attemptsAfterSecond === 1 && childPid(sharedPidPath) === firstPid,
    `${attemptsAfterSecond} mount attempt(s), pid ${firstPid}`,
  )
  check(
    'shared: both sessions see the project tool',
    sessionStatus(projectRoot, 'shared-1') === 'active' &&
      sessionStatus(projectRoot, 'shared-2') === 'active',
    `shared-1 ${sessionStatus(projectRoot, 'shared-1')}, shared-2 ${sessionStatus(projectRoot, 'shared-2')}`,
  )
  check(
    'shared: one creation line, naming the session that asked for it',
    sharedLines.length === 1 && sharedLines[0].includes('shared-1') && sharedLines[0].includes('turn'),
    `${sharedLines.length} line(s)`,
  )
  check(
    'shared: another project’s session runs nothing',
    !existsSync(otherPidPath) &&
      sessionStatus(otherRoot, 'other-1') === 'idle' &&
      attemptsAfterSecond === attemptsAfterFirst,
    `other child ${existsSync(otherPidPath) ? 'spawned' : 'absent'}`,
  )

  // Releasing one holder keeps the instance for the other; releasing the last
  // holder takes it down exactly as a per-session mount used to.
  await runtime.release('shared-1')
  await sleep(400)
  const keptForOther = Number.isInteger(firstPid) && alive(firstPid)
  check('shared: releasing one session keeps the instance for the other', keptForOther)

  await runtime.release('shared-2')
  const gone = await waitFor(() => !alive(firstPid), 5_000)
  check('shared: releasing the last holder takes the child down', gone, `pid ${firstPid}`)
  check('shared: the child removed its pid file', !existsSync(sharedPidPath))

  await runtime.disposeAll()
  return {
    sessions: sessions.length,
    mountAttempts: attemptsAfterSecond,
    creationLines: sharedLines.length,
    pid: firstPid,
    keptForOther,
    childExited: gone,
  }
}

async function sectionIdle() {
  const project = makeProject()
  const env = makeHost()
  const { runtime, counters } = runtimeFor(env, project)
  await runtime.syncNow()
  await sleep(500)

  counters.passes = 0
  const before = { cpu: cpuMs(), schemas: env.calls.schemas }
  await sleep(4_000)
  const report = {
    seconds: 4,
    passes: counters.passes,
    schemasCalls: env.calls.schemas - before.schemas,
    cpuMs: Number((cpuMs() - before.cpu).toFixed(2)),
  }
  check('idle: negligible CPU', report.cpuMs < 120, `${report.cpuMs} ms over ${report.seconds}s`)
  await runtime.disposeAll()
  return report
}

async function sectionChurn() {
  const project = makeProject()
  const env = makeHost()
  const { runtime, counters } = runtimeFor(env, project)
  await runtime.syncNow()
  await sleep(500)

  // Unrelated churn a real project produces constantly: install cache, build
  // output, git metadata. None of it declares an MCP server.
  const noise = [join(project, 'node_modules', 'pkg'), join(project, 'dist'), join(project, '.git')]
  for (const dir of noise) mkdirSync(dir, { recursive: true })

  counters.passes = 0
  const before = { cpu: cpuMs(), schemas: env.calls.schemas, debug: env.debug.length }
  for (let index = 0; index < 600; index += 1) {
    writeFileSync(join(noise[index % noise.length], `f${index}.txt`), String(index))
  }
  await sleep(1_500)
  const report = {
    files: 600,
    watchSchedules: env.debug.filter((line) => line.includes('(watch)')).length,
    passes: counters.passes,
    schemasCalls: env.calls.schemas - before.schemas,
    cpuMs: Number((cpuMs() - before.cpu).toFixed(2)),
  }
  check('churn: low CPU', report.cpuMs < 400, `${report.cpuMs} ms for ${report.files} unrelated writes`)
  check('churn: bounded rescan count', report.passes <= 10, `${report.passes} passes`)
  check('churn: no catalog scan per file', report.schemasCalls <= 10, `${report.schemasCalls} schemas() calls`)
  await runtime.disposeAll()
  return report
}

async function sectionAgentChurn() {
  const root = tmpRoot()
  const pidPath = join(root, 'child.pid')
  const project = makeProject(pidPath)
  const env = makeHost()
  const { runtime, scope } = runtimeFor(env, project, { watch: false }, { withAgent: false })

  const cycles = 10
  const seen = new Set()
  const heapBefore = process.memoryUsage().heapUsed
  const fdBefore = fdCount()
  for (let index = 0; index < cycles; index += 1) {
    const agent = { id: `session-${index}`, session: { header: { cwd: join(project, 'src') } }, ctx: agentCtx(env) }
    scope.add(agent)
    scope.emit('agent/created', { agent })
    await waitFor(() => env.calls.registered.has('mcp__audit__echo') && existsSync(pidPath))
    const pid = Number(existsSync(pidPath) ? readFileSync(pidPath, 'utf8').trim() : '')
    if (Number.isInteger(pid)) seen.add(pid)
    scope.emit('agent/disposed', { agent })
    scope.remove(agent)
    await runtime.syncNow()
    await waitFor(() => !existsSync(pidPath), 5_000)
  }
  await sleep(700)

  const leaked = [...seen].filter((pid) => alive(pid))
  const report = {
    cycles,
    childrenSpawned: seen.size,
    childrenStillAlive: leaked.length,
    heapGrowthMb: Number(((process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024).toFixed(2)),
    fdBefore,
    fdAfter: fdCount(),
    projectsAfter: runtime.snapshot().projects.length,
  }
  check('agent churn: every spawned child exited', leaked.length === 0, `${seen.size} spawned, ${leaked.length} alive`)
  check('agent churn: no fd growth', fdBefore < 0 || report.fdAfter - fdBefore <= 4, `${fdBefore} -> ${report.fdAfter}`)
  check('agent churn: bounded heap growth', report.heapGrowthMb < 8, `${report.heapGrowthMb} MB / ${cycles} cycles`)
  check('agent churn: no state left behind', report.projectsAfter === 0)
  await runtime.disposeAll()
  return report
}

async function sectionBrokenServer() {
  const project = tmpRoot()
  mkdirSync(join(project, '.dsh'), { recursive: true })
  mkdirSync(join(project, 'src'), { recursive: true })
  const marker = join(project, 'starts.log')
  // A server that starts and dies at once: the loudest real failure mode, and
  // the one a project-scoped mount must report instead of retrying forever.
  writeFileSync(
    join(project, '.dsh', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        broken: {
          command: process.execPath,
          args: [
            '-e',
            `require('node:fs').appendFileSync(${JSON.stringify(marker)},'x'); process.exit(1)`,
          ],
        },
      },
    }),
  )
  const env = makeHost()
  const { runtime } = runtimeFor(env, project, { connectTimeoutMs: 300, rescanIntervalMs: 1_000 })
  const fdBefore = fdCount()

  await runtime.syncNow()
  const reported = await waitFor(() => runtime.snapshot().projects[0]?.rows[0]?.status === 'error')
  const mountsAfterMount = env.calls.mounts

  // Further passes must not mount anything again: the plugin reports the
  // failure, it does not respawn the server on every rescan.
  for (let pass = 0; pass < 10; pass += 1) await runtime.syncNow()
  const mountsAfterPasses = env.calls.mounts

  const row = runtime.snapshot().projects[0]?.rows[0]
  const issue = runtime.snapshot().projects[0]?.issues.find((item) => item.level === 'error')
  const starts = () => (existsSync(marker) ? readFileSync(marker, 'utf8').length : 0)
  const startsBeforeRetry = starts()

  // `retry()` answers once the failed mount is dropped: the pass that mounts it
  // again is background work, so the audit awaits it like the panel's status
  // channel does before reading the mount count.
  await runtime.retry()
  await runtime.syncNow()
  const mountsAfterRetry = env.calls.mounts
  await sleep(400)

  const report = {
    status: row?.status,
    mounts: { afterMount: mountsAfterMount, afterPasses: mountsAfterPasses, afterRetry: mountsAfterRetry },
    childStarts: { beforeRetry: startsBeforeRetry, afterRetry: starts() },
    fdDelta: fdCount() - fdBefore,
    detail: row?.detail,
  }
  check('broken server: reported within the connect window', reported && row?.status === 'error', `${mountsAfterMount} mount attempt(s)`)
  check(
    'broken server: detail names the command and the declaring document',
    typeof row?.detail === 'string' &&
      row.detail.includes('no tool appeared') &&
      row.detail.includes('stdio ') &&
      row.detail.includes('.dsh/mcp.json'),
  )
  check('broken server: published as an error issue', issue !== undefined && issue.level === 'error')
  check(
    'broken server: ten passes mount nothing again',
    mountsAfterPasses === mountsAfterMount,
    `${mountsAfterMount} -> ${mountsAfterPasses}`,
  )
  check(
    'broken server: retry() mounts once more',
    mountsAfterRetry === mountsAfterPasses + 1,
    `${mountsAfterPasses} -> ${mountsAfterRetry}`,
  )
  check('broken server: no descriptor growth', report.fdDelta <= 4, `${report.fdDelta} fds`)
  await runtime.disposeAll()
  return report
}

/**
 * Event-loop lag sampler: a 1 ms timer whose lateness is the time the loop was
 * unavailable. Used to prove that loading and connecting MCP servers never
 * blocks the main thread.
 */
function lagMonitor() {
  const state = { maxMs: 0, samples: 0 }
  let last = process.hrtime.bigint()
  const timer = setInterval(() => {
    const now = process.hrtime.bigint()
    const deltaMs = Number(now - last) / 1e6
    last = now
    state.maxMs = Math.max(state.maxMs, deltaMs - 1)
    state.samples += 1
  }, 1)
  return { state, stop: () => clearInterval(timer) }
}

async function sectionStartup() {
  const root = tmpRoot()
  const pidPath = join(root, 'child.pid')
  const project = makeProject(pidPath)
  const env = makeHost()

  const attachStarted = Date.now()
  const { runtime } = runtimeFor(env, project, { debounceMs: 300 })
  const attachMs = Date.now() - attachStarted
  const spawnedOnAttach = existsSync(pidPath)
  const discoveredOnAttach = runtime.snapshot().projects.length

  // Sample the loop across the real mount: project walk, document read, spawn
  // and the MCP handshake all happen inside this window.
  const monitor = lagMonitor()
  const mountStarted = Date.now()
  await runtime.syncNow()
  const mountMs = Date.now() - mountStarted
  // The pass registers the mount and returns; the spawn and the MCP handshake
  // that follow are what the loop must stay free for, so the monitor keeps
  // sampling until the server is actually serving.
  const reached = await waitFor(
    () => runtime.snapshot().projects[0]?.rows[0]?.status === 'active',
    10_000,
  )
  monitor.stop()

  const report = {
    attachMs,
    mountMs,
    loopMaxLagMs: Number(monitor.state.maxMs.toFixed(2)),
    loopSamples: monitor.state.samples,
    spawnedOnAttach,
    discoveredOnAttach,
    status: runtime.snapshot().projects[0]?.rows[0]?.status,
  }
  check('attach: returns without spawning or discovering', attachMs < 50 && !spawnedOnAttach && discoveredOnAttach === 0, `${attachMs} ms`)
  check('mount: loop stays free while connecting', report.loopMaxLagMs < 50, `${report.loopMaxLagMs} ms max lag`)
  check('mount: server reaches active', reached && report.status === 'active', `${report.status} after a ${report.mountMs} ms pass`)
  await runtime.disposeAll()
  return report
}

/**
 * The browser half ships into DSH's Lazy-CJS module table: the web client
 * evaluates several plugin bundles concatenated into one **classic script** and
 * calls `factory(require)` at materialization. A statement-level `import`/
 * `export` is therefore a syntax error that aborts the whole combo, and a
 * `require` the table cannot answer throws on the spot. Both failure modes are
 * silent until a real browser loads the page, so they are checked here.
 */
async function sectionClientBundle() {
  const bundle = join(here, '..', 'lib', 'client.js')
  if (!existsSync(bundle)) {
    check('client bundle exists', false, 'run `pnpm build` first')
    return { missing: true }
  }
  const source = readFileSync(bundle, 'utf8')
  const preamble = ['// Generated by scripts/wrap-client.mjs', 'window.__ModuleLoader__.load({']
  const shell = preamble.every((line, index) => source.split('\n')[index]?.startsWith(line) === true)
  const esm = /^\s*(?:import|export)\s/m.test(source)
  const id = /id:\s*"([^"]+)"/.exec(source)?.[1]
  const requests = [...new Set([...source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]))]
  // The shell's frozen module table (`PLATFORM_MODULES` in the DSH checkout):
  // these exact specifiers are what `factory(require)` can answer.
  const BASELINE = new Set([
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-dockkit',
  ])
  const unresolved = requests.filter((specifier) => !BASELINE.has(specifier))
  const returnsExports = /return module\.exports;/.test(source)

  const report = { bytes: source.length, shell, esm, id, requests, unresolved, returnsExports }
  check('client bundle is wrapped in the ModuleLoader shell', shell && returnsExports)
  check('client bundle has no ESM statements', !esm)
  check('client bundle registers under the package name', id === 'dsh-project-mcp', String(id))
  check(
    'client bundle only requests baseline modules',
    unresolved.length === 0,
    requests.join(', ') || 'none',
  )
  return report
}

async function sectionDispose() {
  const project = makeProject()
  const env = makeHost()
  const { runtime, counters } = runtimeFor(env, project, { rescanIntervalMs: 1_000 })
  await runtime.syncNow()
  await runtime.syncNow()

  const watchedBefore = runtime.snapshot().watchedFiles.length
  check('watcher registered for the project', watchedBefore === 1, `${watchedBefore} watched roots`)

  const fdBefore = fdCount()
  await runtime.disposeAll()
  await sleep(300)
  const fdAfter = fdCount()

  // Behavioural proof that nothing keeps running after teardown: disturb the
  // former watch target and wait past a rescan tick. A leaked watcher or
  // interval would schedule work; the counters must not move.
  counters.passes = 0
  const cpuBefore = cpuMs()
  writeFileSync(
    join(project, '.dsh', 'mcp.json'),
    JSON.stringify({ mcpServers: { late: { command: 'npx', args: ['-y', 'late'] } } }),
  )
  await sleep(2_500)

  const report = {
    watchedAfter: runtime.snapshot().watchedFiles.length,
    fdBefore,
    fdAfter,
    passesAfterDispose: counters.passes,
    cpuAfterDisposeMs: Number((cpuMs() - cpuBefore).toFixed(2)),
  }
  check('dispose closes every watcher', report.watchedAfter === 0)
  check('dispose releases handles', fdAfter <= fdBefore, `${fdBefore} -> ${fdAfter} fds`)
  check('dispose stops the rescan timer', report.passesAfterDispose === 0, `${report.passesAfterDispose} passes`)
  check('dispose leaves no watcher firing', report.cpuAfterDisposeMs < 20, `${report.cpuAfterDisposeMs} ms`)
  return report
}

/**
 * The two client files the suite's **global** thresholds cannot police (F-20).
 *
 * A global 80 leaves room for one surface to sit far below it while the total
 * still passes, and that is exactly what happened to these two: the sidebar
 * panel's hooks and the settings page's DOM were at ~63% while the suite was
 * green. `coverage/coverage-summary.json` is the only artifact that names a
 * file, so the gate is read from there. `coverage.thresholds.perFile` is
 * deliberately *not* switched on: it would apply to every file, including
 * `src/client/index.ts`, which is a registration surface no test drives
 * end-to-end.
 */
const PER_FILE_COVERAGE = ['src/client/view.ts', 'src/client/settings.ts']
const PER_FILE_METRICS = ['statements', 'branches', 'functions', 'lines']

/**
 * Enforce ≥80% on all four metrics for {@link PER_FILE_COVERAGE}, by reading the
 * summary the coverage reporter writes.
 *
 * `pnpm audit` is also a command of its own, run without a coverage pass; with
 * no artifact there is nothing to read, so the gate says so and skips rather
 * than failing. The same goes for a summary that does not mention the file at
 * all (a coverage pass over a subset of the suite), which is reported as its own
 * skip so a partial artifact can never read as proof of the threshold.
 */
function sectionPerFileCoverage() {
  const summaryPath = join(here, '..', 'coverage', 'coverage-summary.json')
  if (!existsSync(summaryPath)) {
    skip(
      'per-file coverage ≥ 80',
      'coverage/coverage-summary.json is absent — run `pnpm coverage` (or `pnpm check`) to gate src/client/view.ts and src/client/settings.ts',
    )
    return { skipped: 'no coverage-summary.json' }
  }
  let summary
  try {
    summary = JSON.parse(readFileSync(summaryPath, 'utf8'))
  } catch (error) {
    skip('per-file coverage ≥ 80', `coverage/coverage-summary.json is unreadable (${error.message})`)
    return { skipped: 'unreadable coverage-summary.json' }
  }
  const report = {}
  for (const relative of PER_FILE_COVERAGE) {
    // Keys are absolute paths of the machine that ran the pass, so the file is
    // matched by its own suffix rather than compared literally.
    const entry = Object.entries(summary).find(
      ([key]) => key !== 'total' && key.replaceAll('\\', '/').endsWith(relative),
    )
    if (entry === undefined) {
      skip(
        `per-file coverage ≥ 80: ${relative}`,
        'no entry in coverage-summary.json — this coverage pass did not include the file',
      )
      report[relative] = { skipped: true }
      continue
    }
    const readings = PER_FILE_METRICS.map((metric) => [metric, entry[1]?.[metric]?.pct])
    const detail = readings.map(([metric, pct]) => `${metric} ${pct}`).join(' · ')
    const below = readings.filter(([, pct]) => typeof pct !== 'number' || pct < 80)
    check(`per-file coverage ≥ 80: ${relative}`, below.length === 0, detail)
    report[relative] = Object.fromEntries(readings)
  }
  return report
}

/**
 * The boot scripts must arm the reaper (F-25).
 *
 * A script that boots a real `dsh` and only stops it in a `finally` leaves the
 * server alive when it is interrupted, and that orphan holds the session store a
 * person's own `dsh web` shares — the failure is "session/writer-held" in the
 * GUI, far from the gate that caused it. Read as source text: the wiring is what
 * is enforced, because running all four scripts here would boot four servers.
 * @returns one entry per boot script, with what was found.
 */
function sectionBootReaper() {
  const scripts = ['e2e-boot.mjs', 'design-parity.mjs', 'design-shot.mjs', 'design-shot-settings.mjs']
  const report = {}
  for (const name of scripts) {
    const source = readFileSync(join(here, name), 'utf8')
    const armed = source.includes("from './dsh-reaper.mjs'") && source.includes('armChildReaper(child)')
    const sweeps = (source.match(/reapOrphanedServers\(PROFILE\)/gu) ?? []).length
    const ok = armed && sweeps >= 2
    const detail = armed
      ? sweeps >= 2
        ? `armed · ${String(sweeps)} sweeps`
        : `armed but only ${String(sweeps)} sweep(s) — a run must sweep before and after`
      : 'does not arm scripts/dsh-reaper.mjs'
    check(`boot script reaps its dsh: ${name}`, ok, detail)
    report[name] = { armed, sweeps }
  }
  return report
}

/**
 * Client copy gates (F-46/F-47): the plugin card's own translations must exist,
 * parse, carry a title and a description, and travel in the tarball; and product
 * copy must come from a dictionary rather than from a module literal.
 *
 * They live in this audit because DSH's `verify-client-ui-i18n` discovers
 * workspace packages only — this plugin is a third party to it — and because
 * `pnpm check`'s pipeline is a literal `&&` chain that would never run a script
 * nobody named.
 *
 * @returns the section's report literal: the card meta per language and the
 *   copy scan's offender count.
 */
function sectionI18n() {
  const report = {}
  const root = join(here, '..')

  // 1. The card's translations: present, parseable, titled, described, shipped.
  const files = ['en', 'zh', 'ru']
  const parsed = {}
  for (const id of files) {
    const path = join(root, 'locale', `${id}.json`)
    let meta
    try {
      meta = JSON.parse(readFileSync(path, 'utf8'))?.meta
    } catch {
      meta = undefined
    }
    parsed[id] = { title: meta?.title, description: meta?.description }
  }
  const labelled = files.every((id) =>
    [parsed[id].title, parsed[id].description].every(
      (value) => typeof value === 'string' && value.trim() !== '',
    ),
  )
  check('i18n: plugin card translations exist and carry a title and a description', labelled,
    files.map((id) => `${id}:${parsed[id].title ?? 'missing'}`).join(' · '))
  const shipped = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).files ?? []).includes('locale')
  check('i18n: package.json ships the locale directory', shipped, shipped ? 'files.locale' : 'files[] has no locale entry')

  // 2. Product copy belongs to a dictionary. Bounded: an explicit module list,
  // an allowlist with a one-line reason per entry, and a heuristic that only
  // fires on sentences — deliberately not a port of the shell's AST gate, which
  // discovers workspace packages only.
  const COPY_MODULES = [
    'view.ts', 'settings.ts', 'settings-tools.ts', 'toasts.ts', 'index.ts', 'design.ts',
    'policy.ts', 'usage-view.ts', 'tab-locale.ts',
  ]
  const ALLOWED = [
    // Protocol and format constants, wire tokens, element and event names.
    /^['"`][\w.:/#-]+['"`]$/u,
    // Layout and transition values (`opacity ${…}ms ease`, '#fff', 'var(…)').
    /^['"`](?:#|var\(|flex|grid|absolute|relative|none|auto|cubic-bezier|opacity)/u,
    // A digit-led literal is a layout value only when it is value-shaped end
    // to end: every token is a number with an optional CSS unit, a CSS keyword,
    // or a function call ('-2px 0 6px 99px', '1px solid var(--…, rgba(…))').
    // A digit-led sentence ('3 servers failed to mount') is copy, not a value,
    // and must stay an offender.
    /^['"`]-?[\d.]+[a-z%]*(?:[\s,]+(?:-?[\d.]+[a-z%]*|solid|dashed|dotted|double|inset|outset|auto|none|transparent|currentColor|ease(?:-in|-out|-in-out)?|linear|infinite|alternate|forwards|backwards|both|#[0-9a-fA-F]{3,8}|var\([^()]*(?:\([^()]*\)[^()]*)*\)|rgba?\([^()]*\)|cubic-bezier\([^()]*\)))*['"`]$/u,
    // Locale ids and the namespace itself.
    /^['"`](?:en|zh|ru|settings\.projectMcp|projectMcp\.[\w.]+)['"`]$/u,
    // Cordis effect labels — log and diagnostic ids, never rendered.
    /^['"`]dsh-project-mcp: /u,
    // Fetch-failure fallback (view.ts, settings.ts, policy.ts): a technical
    // error string interpolated into the translated `hostMessage` template;
    // host-prose localization is F-48's own plan.
    /request failed \(/u,
    // A marker matched against the host's issue text — protocol, not copy.
    /more than one document/u,
    // The JSON pane's parse reason: one token of the same field-name vocabulary
    // as its siblings ('transport', 'args', …), interpolated into the
    // translated `jsonInvalid` template.
    /^'not an object'$/u,
  ]
  const looksLikeCopy = (literal) => /\w+ \w+/u.test(literal)
  const offenders = []
  for (const name of COPY_MODULES) {
    const source = readFileSync(join(root, 'src', 'client', name), 'utf8')
    // The `en`/`EN` object literal is the dictionary itself — the runtime's
    // English fallback, which the plan deliberately keeps in these modules —
    // so the table's body is exempt; everything around it is scanned.
    let tableDepth = 0
    for (const [index, line] of source.split('\n').entries()) {
      if (tableDepth === 0 && /^export const (?:en|EN)\b[^=]*=\s*\{/u.test(line)) {
        tableDepth = (line.match(/\{/gu) ?? []).length - (line.match(/\}/gu) ?? []).length
        continue
      }
      if (tableDepth > 0) {
        tableDepth += (line.match(/\{/gu) ?? []).length - (line.match(/\}/gu) ?? []).length
        continue
      }
      // Prose in comments is not copy: line comments, doc-block interiors, and
      // one-line doc blocks.
      const trimmed = line.trimStart()
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/**')) continue
      for (const match of line.matchAll(/(['"`])((?:(?!\1).){8,})\1/gu)) {
        const literal = match[2]
        if (ALLOWED.some((pattern) => pattern.test(match[0]))) continue
        if (!looksLikeCopy(literal)) continue
        if (/^[A-Z_]+$/u.test(literal)) continue                                            // SCREAMING_CASE ids
        offenders.push(`${name}:${String(index + 1)} ${literal.slice(0, 48)}`)
      }
    }
  }
  check('i18n: client copy comes from the dictionary', offenders.length === 0,
    offenders.length === 0 ? `${String(COPY_MODULES.length)} modules scanned` : `${String(offenders.length)} literal(s): ${offenders.slice(0, 5).join(' | ')}`)
  report.copyOffenders = offenders.length

  // 3. Host-code coverage (F-48): every wire code the host half can emit
  //    exists in all three `projectMcp.host` tables — the Node-side mirror of
  //    tests/host-codes.spec.ts, same rule. The scan keeps every string
  //    literal matching the wire-code grammar (dotted, channel-prefixed, plus
  //    'unmounting' — the one non-dotted code, shipped before the grammar
  //    settled), which covers all three emission shapes: the `code:` field of
  //    an emission object (including runtime.ts's CodedText `{ text, code }`
  //    constructions), the companion fields (`detailCode:` / `blockedCode:` /
  //    `messageCode:` / `noteCode:`), and the positional arguments of
  //    parse.ts's `fail(…)` and write.ts's `new WriteDocError(…)` — the
  //    `parse.entry.*` and `write.doc.*` codes appear in no `code:` field, so
  //    a field-only grep would silently miss them. The five SaveErrorCodes
  //    ('failed', 'not-found', 'blocked', 'conflict', 'invalid') are the HTTP
  //    status axis, not message codes, and the channel prefixes exclude them.
  //
  //    The stay-English allowlist — sites whose prose is deliberately never
  //    coded, named by pattern with the reason:
  const STAY_ENGLISH = [
    ['src/ui.ts route-local protocol errors',
      'they fire on API contract violations by our own client — developer bugs, not user situations'],
    ['host logger lines (`project-mcp: …`)',
      "DSH's own log, not the UI — operator-facing diagnostics stay English"],
    ['model-facing files (src/activation.ts, src/guidance.ts, src/bridge.ts)',
      'text a model reads, not a person'],
  ]
  const HOST_SOURCES = ['src/runtime.ts', 'src/parse.ts', 'src/write.ts', 'src/notifications.ts']
  const CODE_GRAMMAR = /^'((?:write|parse|mount|unmount|idle|conflict|present|save)\.[A-Za-z][\w.]*|unmounting)'$/u
  const emitted = new Map()
  for (const file of HOST_SOURCES) {
    const source = readFileSync(join(root, file), 'utf8')
    for (const match of source.matchAll(/'[^'\n]*'/gu)) {
      if (!CODE_GRAMMAR.test(match[0])) continue
      const code = match[0].slice(1, -1)
      const files = emitted.get(code) ?? new Set()
      files.add(file)
      emitted.set(code, files)
    }
  }
  // The tables of src/client/locales/host.ts read as source (the audit cannot
  // import TS): each `export const <lang>: Record<HostCode, string> = {` block
  // runs to its closing `}` at column 0, keys at two-space indent.
  const hostLocale = readFileSync(join(root, 'src', 'client', 'locales', 'host.ts'), 'utf8')
  const tables = {}
  for (const lang of ['en', 'zh', 'ru']) {
    const anchor = hostLocale.match(new RegExp(`^export const ${lang}: Record<HostCode, string> = \\{$`, 'mu'))
    const keys = new Set()
    if (anchor !== null) {
      const body = hostLocale.slice(anchor.index + anchor[0].length)
      for (const line of body.split('\n')) {
        if (line === '}') break
        const key = /^  '([\w.]+)':/u.exec(line)
        if (key !== null) keys.add(key[1])
      }
    }
    tables[lang] = keys
  }
  const missing = []
  for (const [code, files] of emitted) {
    for (const lang of ['en', 'zh', 'ru']) {
      if (!tables[lang].has(code)) {
        missing.push(
          `code '${code}' (emitted by ${[...files].join(', ')}) is missing from projectMcp.host.${lang} — ` +
            `add it to the ${lang} table in src/client/locales/host.ts`,
        )
      }
    }
  }
  check('i18n: every emitted host code exists in all three projectMcp.host tables',
    emitted.size >= 70 && missing.length === 0,
    missing.length === 0
      ? `${String(emitted.size)} codes across ${String(HOST_SOURCES.length)} host sources; stay-English allowlist: ${STAY_ENGLISH.length} patterns`
      : `${String(missing.length)} missing: ${missing.slice(0, 5).join(' | ')}`)
  report.hostCodes = { emitted: emitted.size, missing, stayEnglish: STAY_ENGLISH.map(([pattern]) => pattern) }

  report.card = parsed
  return report
}

const report = {
  runtime: typeof Bun === 'undefined' ? 'node' : 'bun',
  version: process.versions.node ?? process.versions.bun,
  toolCatalog: CATALOG,
  childLifecycle: await sectionChildLifecycle(),
  startup: await sectionStartup(),
  brokenServer: await sectionBrokenServer(),
  lazy: await sectionLazy(),
  sharedMount: await sectionSharedMount(),
  idle: await sectionIdle(),
  churn: await sectionChurn(),
  agentChurn: await sectionAgentChurn(),
  dispose: await sectionDispose(),
  clientBundle: await sectionClientBundle(),
  perFileCoverage: sectionPerFileCoverage(),
  bootReaper: sectionBootReaper(),
  i18n: sectionI18n(),
}

for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true })

console.log(JSON.stringify(report, null, 2))
const failed = results.filter((item) => !item.ok)
console.log(failed.length === 0 ? `AUDIT OK (${results.length} checks)` : `AUDIT FAILED (${failed.length}/${results.length})`)
process.exit(failed.length === 0 ? 0 : 1)
