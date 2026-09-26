/**
 * Background-loading contract: mounting a project's MCP servers must never sit
 * on the load path of the plugin and must never hold the event loop.
 *
 * Three properties are pinned here:
 * 1. `apply()` returns with the lifecycle attached, but having read no config
 *    and mounted no server — discovery and mounting are deferred to a macrotask.
 * 2. The first reconciliation pass runs by itself, in the background.
 * 3. Connecting servers (which can take seconds) leaves the loop free: timers
 *    keep firing and independent servers connect concurrently.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { SERVICE_NAME, apply } from '../src/index.ts'
import type { ProjectMcpService } from '../src/index.ts'
import { chainSchemas, fakeScopes } from './helpers/scopes.ts'
import type { FakeScopes } from './helpers/scopes.ts'
import {
  ProjectMcpRuntime,
  type AgentEventLike,
  type AgentLike,
  type AgentScopeLike,
  type RuntimeConfig,
} from '../src/runtime.ts'

const created: string[] = []
const MISSING_CREDENTIALS = '/definitely/missing/.credentials.yaml'

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'project-mcp-bg-'))
  created.push(dir)
  return dir
}

/** Project with a `.dsh/mcp.json`, plus a nested session directory. */
function makeProject(servers: Record<string, unknown>): { root: string; session: string } {
  const root = tmp()
  mkdirSync(join(root, '.dsh'), { recursive: true })
  mkdirSync(join(root, 'src', 'nested'), { recursive: true })
  writeFileSync(join(root, '.dsh', 'mcp.json'), JSON.stringify({ mcpServers: servers }))
  return { root, session: join(root, 'src', 'nested') }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Poll until `probe` holds, so the tests never depend on a fixed delay. */
async function waitFor(probe: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!probe() && Date.now() < deadline) await sleep(5)
}

/**
 * Agent-scoped context double. A mount resolves its fiber after `connectMs`,
 * which stands in for a real MCP handshake; `inFlight`/`maxInFlight` make the
 * overlap of concurrent connects observable.
 */
class FakeAgentCtx {
  readonly names = new Set<string>()
  readonly mounts: { name: string; disposed: boolean }[] = []
  inFlight = 0
  maxInFlight = 0

  constructor(readonly connectMs = 0) {}

  plugin(_plugin: unknown, config: { serverName: string }): unknown {
    const record = { name: config.serverName, disposed: false }
    this.mounts.push(record)
    const names = this.names
    const owner = this
    return {
      await: async () => {
        owner.inFlight += 1
        owner.maxInFlight = Math.max(owner.maxInFlight, owner.inFlight)
        if (owner.connectMs > 0) await sleep(owner.connectMs)
        owner.inFlight -= 1
        names.add(`mcp__${config.serverName}__tool`)
      },
      dispose: async () => {
        record.disposed = true
        for (const name of [...names]) {
          if (name.startsWith(`mcp__${config.serverName}__`)) names.delete(name)
        }
      },
    }
  }

  schemas(): { name: string }[] {
    return [...this.names].map((name) => ({ name }))
  }

  /** Scope disposal: drop every tool this context registered. */
  disposeAll(): void {
    for (const mount of this.mounts) mount.disposed = true
    this.names.clear()
  }
}

class FakeScope implements AgentScopeLike {
  private readonly handlers = new Map<string, ScopeHandler[]>()

  constructor(private readonly agents_: AgentLike[]) {}

  get agents() {
    return { list: () => [...this.agents_] }
  }

  on(name: string, handler: ScopeHandler): () => void {
    const list = this.handlers.get(name) ?? []
    list.push(handler)
    this.handlers.set(name, list)
    return () => undefined
  }

  effect(): () => void {
    return () => undefined
  }
}

type ScopeHandler = (event: AgentEventLike, next: () => Promise<unknown>) => unknown

/**
 * Scope doubles whose *project* scope carries the fake connect timing: the
 * shared instance is where a server's connect delay lives now.
 */
function scopesFor(connectMs = 0): FakeScopes<FakeAgentCtx> {
  return fakeScopes<FakeAgentCtx>(
    () => new FakeAgentCtx(connectMs),
    (key) => (key as AgentLike).ctx as unknown as FakeAgentCtx,
    (ctx) => ctx.disposeAll(),
  )
}

/** Host stub: `tools.schemas(agent)` resolves that agent's scope chain. */
function fakeHost(scopes: FakeScopes<FakeAgentCtx>) {
  const counters = { schemas: 0 }
  const host = {
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    tools: {
      schemas: (agent: AgentLike) => {
        counters.schemas += 1
        return chainSchemas(scopes.chainOf(agent), (ctx) => ctx.schemas())
      },
    },
    get: () => undefined,
  }
  return { host: host as unknown as Context, counters }
}

function config(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
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
    localPrefix: '',
    watch: false,
    debounceMs: 0,
    rescanIntervalMs: 1_000,
    credentialsFile: MISSING_CREDENTIALS,
    ...overrides,
  }
}

function fakeAgent(
  id: string,
  cwd: string,
  ctx: FakeAgentCtx = new FakeAgentCtx(),
): { agent: AgentLike; ctx: FakeAgentCtx } {
  return {
    ctx,
    agent: { id, session: { header: { cwd } }, ctx: ctx as unknown as Context },
  }
}

function runtimeFor(
  host: Context,
  scopes: FakeScopes<FakeAgentCtx>,
  overrides: Partial<RuntimeConfig> = {},
): ProjectMcpRuntime {
  return new ProjectMcpRuntime(host, config(overrides), {
    plugin: { name: 'fake-mcp', inject: ['tools'], apply: () => undefined },
    createScope: scopes.createScope,
  })
}

/**
 * Minimal host for `apply()`: `inject` runs its callback as soon as the
 * dependency is present (as Cordis does) and captures the published service.
 */
function applyHost(agent: AgentLike) {
  const provided = new Map<string, unknown>()
  const warnings: string[] = []
  let effectRegistered = false
  const ctx = {
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (message: string) => warnings.push(message),
    },
    tools: { schemas: () => [] },
    get: () => undefined,
    inject: (_deps: string[], callback: (scope: unknown) => void): void => {
      callback({
        agents: { list: () => [agent] },
        on: () => undefined,
        effect: () => undefined,
        provide: (name: string, value: unknown) => provided.set(name, value),
      })
    },
    effect: () => {
      effectRegistered = true
    },
    // The plugin subscribes to the loader's volatile-update event at boot.
    on: () => undefined,
  }
  return { ctx: ctx as unknown as Context, provided, warnings, effectRegistered: () => effectRegistered }
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('background loading', () => {
  it('apply() returns before any config is read or any server mounted', async () => {
    // A disabled entry keeps the test hermetic: the pass reads the document but
    // never spawns an MCP server, so the only thing under test is the timing.
    const project = makeProject({ ghost: { command: 'npx', enabled: false } })
    const { agent } = fakeAgent('session-1', project.session)
    const { ctx, provided, warnings, effectRegistered } = applyHost(agent)

    await apply(ctx, { watch: false, debounceMs: 0, credentialsFile: MISSING_CREDENTIALS })

    const service = provided.get(SERVICE_NAME) as ProjectMcpService
    expect(service).toBeDefined()
    expect(effectRegistered()).toBe(true)
    // The load tick attached the lifecycle (ready) but discovered nothing:
    // project-root walk, document reads, mounts and catalog scans are all
    // deferred to a macrotask, so plugin loading cannot be blocked by them.
    expect(service.snapshot()).toEqual({
      ready: true,
      projects: [],
      sources: { local: ['.dsh/mcp.json'], global: [] },
      watchedFiles: [],
    })
    expect(warnings).toEqual([])
  })

  it('runs the first pass by itself, in the background', async () => {
    const project = makeProject({ ghost: { command: 'npx', enabled: false } })
    const { agent } = fakeAgent('session-1', project.session)
    const { ctx, provided } = applyHost(agent)

    await apply(ctx, { watch: false, debounceMs: 0, credentialsFile: MISSING_CREDENTIALS })
    const service = provided.get(SERVICE_NAME) as ProjectMcpService
    expect(service.snapshot().projects).toEqual([])

    // No explicit sync call anywhere: the debounced pass fires on its own.
    await waitFor(() => service.snapshot().projects.length > 0)

    const rows = service.snapshot().projects[0]?.rows ?? []
    expect(rows.map((row) => [row.name, row.status])).toEqual([['ghost', 'disabled']])
  })

  it('keeps the event loop free while a server connects', async () => {
    const project = makeProject({ slow: { command: 'npx' } })
    const scopes = scopesFor(60)
    const { host } = fakeHost(scopes)
    const runtime = runtimeFor(host, scopes, { watch: false, debounceMs: 0 })
    const { agent } = fakeAgent('session-1', project.session)
    runtime.attach(new FakeScope([agent]))

    let ticks = 0
    const ticker = setInterval(() => {
      ticks += 1
    }, 5)
    const pass = runtime.syncNow()
    // Nothing ran on the caller's tick: `syncNow` only enqueues the pass.
    expect(ticks).toBe(0)
    await pass

    // The pass returns while the server is still connecting — registration is
    // all it does now — so the whole 60 ms connect runs with the loop free,
    // which is what the ticker measures.
    expect(runtime.snapshot().projects[0]?.rows[0]?.status).toBe('connecting')
    await waitFor(() => runtime.snapshot().projects[0]?.rows[0]?.status === 'active')
    clearInterval(ticker)

    // A blocked loop would have starved the ticker and left `ticks` at 0.
    expect(ticks).toBeGreaterThan(3)
    await runtime.disposeAll()
  })

  it('connects independent servers concurrently, not one after another', async () => {
    const project = makeProject({
      alpha: { command: 'npx', args: ['-y', 'alpha'] },
      beta: { command: 'npx', args: ['-y', 'beta'] },
      gamma: { command: 'npx', args: ['-y', 'gamma'] },
    })
    const scopes = scopesFor(40)
    const { host, counters } = fakeHost(scopes)
    const runtime = runtimeFor(host, scopes, { watch: false, debounceMs: 0 })
    const { agent } = fakeAgent('session-1', project.session)
    runtime.attach(new FakeScope([agent]))

    const started = Date.now()
    await runtime.syncNow()
    const elapsed = Date.now() - started

    const ctx = scopes.forProject(project.root)
    expect(ctx?.mounts).toHaveLength(3)
    // Three 40 ms connects overlapped; strictly sequential work is >= 120 ms.
    expect(ctx?.maxInFlight).toBe(3)
    expect(elapsed).toBeLessThan(120)
    expect(counters.schemas).toBeGreaterThan(0)
    await runtime.disposeAll()
  })

  it('returns from attach() without waiting for the first pass', async () => {
    const project = makeProject({ slow: { command: 'npx' } })
    const scopes = scopesFor(60)
    const { host } = fakeHost(scopes)
    const runtime = runtimeFor(host, scopes, { watch: false, debounceMs: 300 })
    const { agent } = fakeAgent('session-1', project.session)

    const started = Date.now()
    runtime.attach(new FakeScope([agent]))
    const attachMs = Date.now() - started

    // Attaching is bookkeeping only: no read, no mount, no wait.
    expect(attachMs).toBeLessThan(20)
    expect(scopes.projects).toEqual([])
    expect(runtime.snapshot().projects).toEqual([])

    await waitFor(() => (scopes.forProject(project.root)?.mounts.length ?? 0) === 1)
    expect(scopes.forProject(project.root)?.mounts.map((mount) => mount.name)).toEqual(['slow'])
    await runtime.disposeAll()
  })

  it('queues the pass behind syncSoon() without waiting for it', async () => {
    const project = makeProject({ slow: { command: 'npx' } })
    const scopes = scopesFor(30)
    const { host } = fakeHost(scopes)
    const runtime = runtimeFor(host, scopes, { watch: false, debounceMs: 0 })
    const { agent } = fakeAgent('session-1', project.session)
    runtime.attach(new FakeScope([agent]))

    runtime.syncSoon()

    // The operator call only enqueues: the answer is the picture as it is now.
    expect(scopes.forProject(project.root)).toBeUndefined()

    // Awaiting the next pass also awaits the queued one, so the mount is
    // registered; the connect that follows is not part of the pass.
    await runtime.syncNow()
    await waitFor(() => runtime.snapshot().projects[0]?.rows[0]?.status === 'active')
    await runtime.disposeAll()
  })

  it('mounts only the project an operator pass names', async () => {
    const mine = makeProject({ alpha: { command: 'npx' } })
    const other = makeProject({ beta: { command: 'npx' } })
    const scopes = scopesFor()
    const { host } = fakeHost(scopes)
    // `lazy` is on and neither session has turned: only the operator request can
    // start a server, so what is mounted is exactly what the request named.
    const runtime = runtimeFor(host, scopes, { watch: false, debounceMs: 0, lazy: true })
    runtime.attach(
      new FakeScope([
        fakeAgent('session-1', mine.session).agent,
        fakeAgent('session-2', other.session).agent,
      ]),
    )

    await runtime.syncNow(mine.root)

    expect(scopes.forProject(mine.root)?.mounts.map((mount) => mount.name)).toEqual(['alpha'])
    expect(scopes.forProject(other.root)).toBeUndefined()
    const rows = runtime
      .snapshot()
      .projects.map((project) => [project.projectRoot, project.rows[0]?.status])
    expect(rows).toEqual([
      [mine.root, 'active'],
      [other.root, 'idle'],
    ])
    await runtime.disposeAll()
  })
})
