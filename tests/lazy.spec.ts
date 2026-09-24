/**
 * Lazy mounting and idle release: a session that has not started a turn must
 * not run a single server, and a session that went quiet must give its servers
 * back — while the turn that needs them still gets them.
 *
 * The event contract these tests encode comes from the agent plane:
 * - `agent/status` is a plain notification (`{ agent, status }`), fire-and-forget;
 * - `agent/pre-step` is a waterfall hook (`(payload, next)`), awaited by the
 *   loop, and a listener that does not call `next()` vetoes the built-in step.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ProjectMcpRuntime,
  mountTrigger,
  type AgentEventLike,
  type AgentLike,
  type AgentScopeLike,
  type RuntimeConfig,
} from '../src/runtime.ts'
import { chainSchemas, fakeScopes } from './helpers/scopes.ts'
import type { FakeScopes } from './helpers/scopes.ts'

const created: string[] = []

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'project-mcp-lazy-'))
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

/** Poll until `probe` holds, so no test depends on a fixed delay. */
async function waitFor(probe: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!probe() && Date.now() < deadline) await sleep(5)
}

/**
 * Agent-scoped context double. `hang` models a connect that never settles,
 * `healthy: false` a server that comes up but never publishes a tool.
 */
class FakeAgentCtx {
  readonly names = new Set<string>()
  readonly mounts: { name: string; disposed: boolean }[] = []
  healthy = true
  hang = false

  constructor(readonly connectMs = 5) {}

  plugin(_plugin: unknown, config: { serverName: string }): unknown {
    const record = { name: config.serverName, disposed: false }
    this.mounts.push(record)
    const owner = this
    return {
      await: (): Promise<void> => {
        if (owner.hang) return new Promise<void>(() => undefined)
        return sleep(owner.connectMs).then(() => {
          if (owner.healthy) owner.names.add(`mcp__${config.serverName}__tool`)
        })
      },
      dispose: async () => {
        record.disposed = true
        for (const name of [...owner.names]) {
          if (name.startsWith(`mcp__${config.serverName}__`)) owner.names.delete(name)
        }
      },
    }
  }

  schemas(): { name: string }[] {
    return [...this.names].map((name) => ({ name }))
  }

  disposeAll(): void {
    for (const mount of this.mounts) mount.disposed = true
    this.names.clear()
  }
}

type ScopeHandler = (event: AgentEventLike, next: () => Promise<unknown>) => unknown

/** Scope double that can deliver events the way the agent plane does. */
class FakeScope implements AgentScopeLike {
  private readonly handlers = new Map<string, ScopeHandler[]>()

  /**
   * @param agents_ - the sessions the host registry lists.
   * @param namesOf - how many tools one session resolves, read at the
   * continuation so a step asserts on the catalog the model would see —
   * a project's shared tools included.
   */
  constructor(
    private readonly agents_: AgentLike[],
    private readonly namesOf: (agent: AgentLike) => number,
  ) {}

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

  /** Fire-and-forget notification, as `dispatch.emit` does. */
  emit(name: string, event: AgentEventLike): void {
    for (const handler of this.handlers.get(name) ?? []) void handler(event, async () => undefined)
  }

  /** Awaited waterfall call, as `dispatch.waterfall` does. */
  async dispatch(name: string, event: AgentEventLike, next: () => Promise<unknown>): Promise<void> {
    for (const handler of this.handlers.get(name) ?? []) await handler(event, next)
  }

  /** Await one step the way the agent loop does, returning the continuation's result. */
  async step(event: AgentEventLike): Promise<{ nextCalls: number; seenAtNext: number }> {
    const result = { nextCalls: 0, seenAtNext: 0 }
    await this.dispatch('agent/pre-step', event, async () => {
      result.nextCalls += 1
      result.seenAtNext = this.namesOf(event.agent)
    })
    return result
  }

  /** Drop one session from the registry, as the host does when it is gone. */
  remove(agentId: string): void {
    const index = this.agents_.findIndex((agent) => agent.id === agentId)
    if (index !== -1) this.agents_.splice(index, 1)
  }
}

/** Every `info` line the fake host received, in order. */
const infoLines: string[] = []

/**
 * The `mounting` lines among {@link infoLines} — exactly one per created
 * process. The lifecycle writes three kinds of line (mounting, up, unmounting),
 * so a count of processes has to name the phase it counts.
 */
function mountingLines(): string[] {
  return infoLines.filter((line) => line.includes(': mounting '))
}

/** The `unmounting` lines among {@link infoLines} — one per stopped process. */
function unmountingLines(): string[] {
  return infoLines.filter((line) => line.includes(': unmounting '))
}

/** Every tool name one session resolves through its chain. */
function sessionNames(scopes: FakeScopes<FakeAgentCtx>, agent: AgentLike): string[] {
  return chainSchemas(scopes.chainOf(agent), (ctx) => [...ctx.names].map((name) => ({ name }))).map(
    (schema) => schema.name,
  )
}

/**
 * How the fake project's servers come up — the knobs a mount test needs, now
 * that they live on the shared project scope rather than on a session's own.
 */
interface ProjectBehaviour {
  /** Milliseconds the fake server takes to settle its activation. */
  connectMs?: number
  /** `true` models a connect that never settles. */
  hang?: boolean
  /** `false` models a server that comes up but never publishes a tool. */
  healthy?: boolean
}

/**
 * The scope double a project's servers are mounted in, by project root. A test
 * asserts on the instance the runtime created here, and on the catalog a session
 * resolves from it (`sessionNames`), never on a session's own empty scope.
 */
function projectScope(scopes: FakeScopes<FakeAgentCtx>, projectRoot: string): FakeAgentCtx {
  const ctx = scopes.forProject(projectRoot)
  if (ctx === undefined) throw new Error(`no project scope was minted for ${projectRoot}`)
  return ctx
}

/** The shared instance's mounts, empty while the project has not mounted. */
function sharedMounts(
  scopes: FakeScopes<FakeAgentCtx>,
  projectRoot: string,
): { name: string; disposed: boolean }[] {
  return scopes.forProject(projectRoot)?.mounts ?? []
}

/** Whether every instance one project started has been disposed. */
function released(scopes: FakeScopes<FakeAgentCtx>, projectRoot: string): boolean {
  const mounts = sharedMounts(scopes, projectRoot)
  return mounts.length > 0 && mounts.every((mount) => mount.disposed)
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
    lazy: true,
    idleTimeoutMs: 0,
    activationWaitMs: 0,
    profileWins: true,
    localPrefix: '',
    watch: false,
    debounceMs: 0,
    rescanIntervalMs: 50,
    credentialsFile: '/definitely/missing/.credentials.yaml',
    ...overrides,
  }
}

/**
 * One runtime wired to the fakes: the scope doubles it mints (one per session,
 * one per project), and the exact catalog a session resolves through them.
 */
function runtimeFor(
  overrides: Partial<RuntimeConfig> = {},
  behaviour: ProjectBehaviour = {},
): {
  runtime: ProjectMcpRuntime
  scopes: FakeScopes<FakeAgentCtx>
  namesOf: (agent: AgentLike) => number
} {
  const scopes = fakeScopes<FakeAgentCtx>(
    () => {
      const ctx = new FakeAgentCtx(behaviour.connectMs ?? 5)
      ctx.hang = behaviour.hang ?? false
      ctx.healthy = behaviour.healthy ?? true
      return ctx
    },
    (key) => (key as AgentLike).ctx as unknown as FakeAgentCtx,
    (ctx) => ctx.disposeAll(),
  )
  const host = {
    logger: {
      debug: () => undefined,
      info: (message: string) => infoLines.push(message),
      warn: () => undefined,
    },
    // The registry resolves a session's chain: a shared project layer is exactly
    // what this plugin's mounted servers are visible through.
    tools: {
      schemas: (agent: AgentLike) => chainSchemas(scopes.chainOf(agent), (ctx) => ctx.schemas()),
    },
    get: () => undefined,
  }
  const runtime = new ProjectMcpRuntime(host as unknown as Context, config(overrides), {
    plugin: { name: 'fake-mcp', inject: ['tools'], apply: () => undefined },
    createScope: scopes.createScope,
  })
  return { runtime, scopes, namesOf: (agent) => sessionNames(scopes, agent).length }
}

function fakeAgent(id: string, cwd: string, ctx: FakeAgentCtx): AgentLike {
  return { id, session: { header: { cwd } }, ctx: ctx as unknown as Context }
}

/**
 * Agent double whose host-visible status the test can set on its own, so a
 * session can be quiet on the host while the events it emitted say otherwise.
 */
function statusAgent(
  id: string,
  cwd: string,
  ctx: FakeAgentCtx,
  status: 'idle' | 'running' | undefined = undefined,
): { agent: AgentLike; setStatus: (next: 'idle' | 'running' | undefined) => void } {
  let current = status
  const agent = {
    id,
    session: { header: { cwd } },
    ctx: ctx as unknown as Context,
    get status(): 'idle' | 'running' | undefined {
      return current
    },
  } as AgentLike
  return { agent, setStatus: (next) => { current = next } }
}

function rowsOf(runtime: ProjectMcpRuntime) {
  return runtime.snapshot().projects[0]?.rows ?? []
}

/** The rows of one exact project, so a two-project test never reads the wrong one. */
function rowsFor(runtime: ProjectMcpRuntime, projectRoot: string) {
  return runtime.snapshot().projects.find((project) => project.projectRoot === projectRoot)?.rows ?? []
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
  infoLines.splice(0)
})

describe('lazy mounting', () => {
  it('mounts nothing for a session that has not started a turn', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime, scopes, namesOf } = runtimeFor()
    const ctx = new FakeAgentCtx()
    const agent = fakeAgent('session-1', project.session, ctx)
    runtime.attach(new FakeScope([agent], namesOf))

    await sleep(30)

    expect(scopes.projects).toEqual([])
    const rows = rowsOf(runtime)
    expect(rows.map((row) => [row.name, row.status])).toEqual([['alpha', 'idle']])
    expect(rows[0]?.detail).toContain('not mounted yet')
    expect(runtime.snapshot().projects[0]?.sessionIds).toEqual(['session-1'])
    await runtime.disposeAll()
  })

  it('still reconciles when the rescan tick is shorter than the debounce', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    // A restarting debounce would be pushed back by every tick and starve the
    // pass forever; the queued pass must survive the ticks.
    const { runtime, scopes, namesOf } = runtimeFor({ debounceMs: 200, rescanIntervalMs: 20 })
    const ctx = new FakeAgentCtx()
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session, ctx)], namesOf))

    await waitFor(() => rowsOf(runtime).length > 0, 1_000)

    expect(rowsOf(runtime)[0]?.status).toBe('idle')
    await runtime.disposeAll()
  })

  it('mounts the project on the first turn', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime, scopes, namesOf } = runtimeFor()
    const ctx = new FakeAgentCtx()
    const agent = fakeAgent('session-1', project.session, ctx)
    const scope = new FakeScope([agent], namesOf)
    runtime.attach(scope)
    await sleep(20)

    scope.emit('agent/status', { agent, status: 'running' })
    // The turn's pass registers the instance and returns; the handshake settles
    // behind it, and the row turns active on the pass that follows — this scope
    // has no rescan timer of its own.
    await waitFor(() => sessionNames(scopes, agent).length === 1)
    await runtime.syncNow()

    expect(rowsOf(runtime).map((row) => [row.name, row.status])).toEqual([['alpha', 'active']])
    expect(rowsOf(runtime)[0]?.detail).toBeUndefined()
    // Further passes keep finding it up; nothing is mounted twice.
    await runtime.syncNow()
    await sleep(60)
    expect(sharedMounts(scopes, project.root)).toHaveLength(1)
    await runtime.disposeAll()
  })

  it('never attaches a session of a mounted project that has not turned', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime, scopes, namesOf } = runtimeFor()
    const working = fakeAgent('session-working', project.session, new FakeAgentCtx())
    const sideline = fakeAgent('session-sideline', project.session, new FakeAgentCtx())
    const scope = new FakeScope([working, sideline], namesOf)
    runtime.attach(scope)
    await sleep(20)

    scope.emit('agent/status', { agent: working, status: 'running' })
    await waitFor(() => sharedMounts(scopes, project.root).length === 1)

    // The neighbour is live, declares the same project, and asked for nothing:
    // it holds no part of the instance and sees none of its tools.
    expect(sessionNames(scopes, sideline)).toEqual([])
    expect(scopes.chainOf(sideline)).toEqual([sideline.ctx])

    // Losing the one real holder takes the instance down even so: a neighbour
    // that never turned must not keep it alive.
    await runtime.release('session-working')
    await waitFor(() => released(scopes, project.root))
    expect(scopes.projects).toHaveLength(1)
    await runtime.disposeAll()
  })

  it('mounts one instance for two sessions of one project that both turn', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime, scopes, namesOf } = runtimeFor({ activationWaitMs: 1_000 })
    const first = fakeAgent('session-1', project.session, new FakeAgentCtx())
    const second = fakeAgent('session-2', project.session, new FakeAgentCtx())
    const scope = new FakeScope([first, second], namesOf)
    runtime.attach(scope)
    await sleep(20)

    await scope.step({ agent: first })
    expect(sharedMounts(scopes, project.root)).toHaveLength(1)
    // The instance belongs to the project the moment it is registered, but its
    // handshake settles behind the pass: wait for the server, then take the
    // second turn — which is the one this test is about.
    await waitFor(() => namesOf(first) === 1)

    // The second session's first turn finds the project already mounted: one
    // process, one scope, one `mounting` line — and its model sees the tool.
    const step = await scope.step({ agent: second })
    expect(step).toEqual({ nextCalls: 1, seenAtNext: 1 })
    expect(scopes.projects).toHaveLength(1)
    expect(sharedMounts(scopes, project.root)).toHaveLength(1)
    expect(mountingLines()).toHaveLength(1)
    expect(mountingLines()[0]).toContain('shared')
    await runtime.disposeAll()
  })

  it('keeps the instance running for a session of the project that is still turning', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime, scopes, namesOf } = runtimeFor({ idleTimeoutMs: 60 })
    const busy = fakeAgent('session-busy', project.session, new FakeAgentCtx())
    const quiet = fakeAgent('session-quiet', project.session, new FakeAgentCtx())
    const scope = new FakeScope([busy, quiet], namesOf)
    runtime.attach(scope)

    // Both sessions hold the project's instance; the quiet one goes idle, and
    // the instance stays up for the session that is still working.
    scope.emit('agent/status', { agent: busy, status: 'running' })
    scope.emit('agent/status', { agent: quiet, status: 'running' })
    scope.emit('agent/status', { agent: quiet, status: 'idle' })
    await waitFor(() => sessionNames(scopes, quiet).length === 0)
    await waitFor(() => rowsFor(runtime, project.root)[0]?.status === 'active')

    expect(sharedMounts(scopes, project.root)[0]?.disposed).toBe(false)
    expect(sessionNames(scopes, busy)).toEqual(['mcp__alpha__tool'])
    await runtime.disposeAll()
  })

  it('an operator sync mounts even without a turn, after lazy already published the declaration', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime, scopes, namesOf } = runtimeFor()
    const ctx = new FakeAgentCtx()
    const agent = fakeAgent('session-1', project.session, ctx)
    runtime.attach(new FakeScope([agent], namesOf))

    // Let the lazy pass settle first: it stores the document digest, and the
    // operator pass must not mistake identical inputs for "nothing to do".
    await waitFor(() => rowsOf(runtime)[0]?.status === 'idle')
    await sleep(30)

    await runtime.syncNow()

    // The operator pass mounts without a turn, and — as every pass now does —
    // returns as soon as the mount is recorded. The handshake settles behind
    // it, and the pass that follows reads it.
    expect(sharedMounts(scopes, project.root)).toHaveLength(1)
    await waitFor(() => namesOf(agent) === 1)
    await runtime.syncNow()
    expect(rowsOf(runtime)[0]?.status).toBe('active')
    await runtime.disposeAll()
  })

  it('never holds a step for a server that has not connected', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime, scopes, namesOf } = runtimeFor(
      { activationWaitMs: 1_000, connectTimeoutMs: 60_000 },
      { hang: true },
    )
    const ctx = new FakeAgentCtx()
    const agent = fakeAgent('session-1', project.session, ctx)
    const scope = new FakeScope([agent], namesOf)
    runtime.attach(scope)
    await sleep(20)
    expect(scopes.projects).toEqual([])

    // The turn is not held for the server: the mount is registered, the
    // handshake keeps running behind the pass, and the continuation goes ahead
    // without the tool. A step that waited would sit in the 60 s connect window
    // (or at least the full `activationWaitMs`).
    const started = Date.now()
    const step = await scope.step({ agent })
    const elapsed = Date.now() - started

    expect(step).toEqual({ nextCalls: 1, seenAtNext: 0 })
    expect(elapsed).toBeLessThan(500)
    expect(sharedMounts(scopes, project.root)).toHaveLength(1)

    // The later pass is what publishes the outcome: nothing here awaits one.
    await runtime.disposeAll()
  })

  it('never holds a step longer than activationWaitMs', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime, scopes, namesOf } = runtimeFor({ activationWaitMs: 30, connectTimeoutMs: 5_000 }, { hang: true })
    const ctx = new FakeAgentCtx()
    const agent = fakeAgent('session-1', project.session, ctx)
    const scope = new FakeScope([agent], namesOf)
    runtime.attach(scope)
    await sleep(20)

    const started = Date.now()
    const step = await scope.step({ agent })
    const elapsed = Date.now() - started

    expect(step.nextCalls).toBe(1)
    expect(elapsed).toBeLessThan(1_500)
    await runtime.disposeAll()
  })

  it('never vetoes a step: an unknown session and a disposed runtime both continue', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime, scopes, namesOf } = runtimeFor({ activationWaitMs: 1_000 })
    const ctx = new FakeAgentCtx()
    const agent = fakeAgent('session-1', project.session, ctx)
    const scope = new FakeScope([agent], namesOf)
    runtime.attach(scope)

    const stranger = fakeAgent('session-unknown', project.session, new FakeAgentCtx())
    expect((await scope.step({ agent: stranger })).nextCalls).toBe(1)

    await runtime.disposeAll()
    expect((await scope.step({ agent })).nextCalls).toBe(1)
  })

  it('a fiber that never settles cannot hold a pass or teardown open', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime, scopes, namesOf } = runtimeFor({ connectTimeoutMs: 40 }, { hang: true })
    const ctx = new FakeAgentCtx()
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session, ctx)], namesOf))

    const started = Date.now()
    await runtime.syncNow()
    expect(Date.now() - started).toBeLessThan(1_000)

    const teardown = Date.now()
    await runtime.disposeAll()
    expect(Date.now() - teardown).toBeLessThan(1_000)
  })
})

describe('idle release', () => {
  it('releases an idle session and mounts it again on the next turn', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime, scopes, namesOf } = runtimeFor({ idleTimeoutMs: 60 })
    const ctx = new FakeAgentCtx()
    const agent = fakeAgent('session-1', project.session, ctx)
    const scope = new FakeScope([agent], namesOf)
    runtime.attach(scope)

    scope.emit('agent/status', { agent, status: 'running' })
    await waitFor(() => sharedMounts(scopes, project.root).length === 1)

    scope.emit('agent/status', { agent, status: 'idle' })
    await waitFor(() => released(scopes, project.root))

    expect(sessionNames(scopes, agent)).toEqual([])
    const rows = rowsOf(runtime)
    expect(rows.map((row) => [row.name, row.status])).toEqual([['alpha', 'idle']])
    expect(rows[0]?.detail).toContain('without activity')

    // The next turn mounts the project again — from a fresh shared scope, the
    // instance that went away with the release is not revived.
    scope.emit('agent/status', { agent, status: 'running' })
    await waitFor(() => rowsOf(runtime)[0]?.status === 'active')
    expect(scopes.projects).toHaveLength(2)
    expect(sharedMounts(scopes, project.root)).toHaveLength(1)
    expect(sharedMounts(scopes, project.root)[0]?.disposed).toBe(false)
    expect(rowsOf(runtime)[0]?.status).toBe('active')
    await runtime.disposeAll()
  })

  it('releases on request and mounts again on the next turn', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    // No idle sweep in this config: only the explicit request releases.
    const { runtime, scopes, namesOf } = runtimeFor({ idleTimeoutMs: 0 })
    const ctx = new FakeAgentCtx()
    const agent = fakeAgent('session-1', project.session, ctx)
    const scope = new FakeScope([agent], namesOf)
    runtime.attach(scope)

    scope.emit('agent/status', { agent, status: 'running' })
    // This config has no rescan timer, so the pass that reads the settled
    // handshake is an explicit one: the turn registered the mount and moved on.
    await waitFor(() => namesOf(agent) === 1)
    await runtime.syncNow()
    expect(rowsOf(runtime)[0]?.status).toBe('active')

    await runtime.release('session-1')
    await waitFor(() => released(scopes, project.root))
    expect(sessionNames(scopes, agent)).toEqual([])
    expect(rowsOf(runtime)[0]?.status).toBe('idle')
    expect(rowsOf(runtime)[0]?.detail).toContain('released on request')

    scope.emit('agent/status', { agent, status: 'running' })
    await waitFor(() => namesOf(agent) === 1)
    await runtime.syncNow()
    expect(rowsOf(runtime)[0]?.status).toBe('active')
    expect(scopes.projects).toHaveLength(2)
    expect(sharedMounts(scopes, project.root)).toHaveLength(1)
    await runtime.disposeAll()
  })

  it('never releases a session in the middle of a turn', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime, scopes, namesOf } = runtimeFor({ idleTimeoutMs: 60 })
    const ctx = new FakeAgentCtx()
    const agent = fakeAgent('session-1', project.session, ctx)
    const scope = new FakeScope([agent], namesOf)
    runtime.attach(scope)

    scope.emit('agent/status', { agent, status: 'running' })
    await waitFor(() => sharedMounts(scopes, project.root).length === 1)

    await sleep(140)
    expect(sharedMounts(scopes, project.root)).toHaveLength(1)
    expect(sharedMounts(scopes, project.root)[0]?.disposed).toBe(false)
    expect(rowsOf(runtime)[0]?.status).toBe('active')
    await runtime.disposeAll()
  })

  it('releases an eager session that never spoke', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime, scopes, namesOf } = runtimeFor({ lazy: false, idleTimeoutMs: 60 })
    const ctx = new FakeAgentCtx()
    const agent = fakeAgent('session-1', project.session, ctx)
    runtime.attach(new FakeScope([agent], namesOf))

    await waitFor(() => sharedMounts(scopes, project.root).length === 1)
    await waitFor(() => released(scopes, project.root))

    expect(sessionNames(scopes, agent)).toEqual([])
    expect(rowsOf(runtime)[0]?.status).toBe('idle')
    await runtime.disposeAll()
  })

  it('releases a session the registry no longer lists, without the idle timer', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    // The idle sweep is off: only the pass that notices the session is gone can
    // hand its mounts back.
    const { runtime, scopes, namesOf } = runtimeFor({ lazy: false, idleTimeoutMs: 0 })
    const ctx = new FakeAgentCtx()
    const agent = fakeAgent('session-1', project.session, ctx)
    const scope = new FakeScope([agent], namesOf)
    runtime.attach(scope)

    await waitFor(() => sharedMounts(scopes, project.root).length === 1)
    expect(sharedMounts(scopes, project.root)[0]?.disposed).toBe(false)

    scope.remove('session-1')
    await runtime.syncNow()
    await waitFor(() => sharedMounts(scopes, project.root)[0]?.disposed === true)

    expect(sharedMounts(scopes, project.root)[0]?.disposed).toBe(true)
    expect(projectScope(scopes, project.root).names.size).toBe(0)
    expect(runtime.snapshot().projects.map((project) => project.projectRoot)).not.toContain(project.root)
    await runtime.disposeAll()
  })

  it('releases a quiet session whose idle transition never reaches the plugin', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime, scopes, namesOf } = runtimeFor({ idleTimeoutMs: 60 })
    const ctx = new FakeAgentCtx()
    // The host reports the truth; the only event the plugin saw was `running`.
    const { agent, setStatus } = statusAgent('session-1', project.session, ctx, 'running')
    const scope = new FakeScope([agent], namesOf)
    runtime.attach(scope)

    scope.emit('agent/status', { agent, status: 'running' })
    await waitFor(() => sharedMounts(scopes, project.root).length === 1)

    setStatus('idle')
    await waitFor(() => released(scopes, project.root))

    expect(sessionNames(scopes, agent)).toEqual([])
    expect(rowsOf(runtime)[0]?.status).toBe('idle')
    await runtime.disposeAll()
  })
})

describe('mount observability', () => {
  it('logs one line per mount, naming the session, the project root and the trigger', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    // An idle sweep long enough to keep the mount, a tick short enough that
    // several rescan passes run while it is up.
    const { runtime, scopes, namesOf } = runtimeFor({ idleTimeoutMs: 5_000, rescanIntervalMs: 20 })
    const ctx = new FakeAgentCtx()
    const agent = fakeAgent('session-1', project.session, ctx)
    const scope = new FakeScope([agent], namesOf)
    runtime.attach(scope)

    await sleep(60)
    expect(infoLines).toEqual([])

    scope.emit('agent/status', { agent, status: 'running' })
    await waitFor(() => sharedMounts(scopes, project.root).length === 1)

    expect(mountingLines()).toHaveLength(1)
    const line = mountingLines()[0] ?? ''
    expect(line).toContain('alpha')
    expect(line).toContain('session-1')
    expect(line).toContain(project.root)
    expect(line).toContain('turn')
    // The line says the instance is shared, so an operator reading it knows a
    // second session of this project will not start another process.
    expect(line).toContain('shared')

    // Every later rescan pass re-derives the same mount: no second line.
    await sleep(100)
    expect(sharedMounts(scopes, project.root)).toHaveLength(1)
    expect(mountingLines()).toHaveLength(1)
    await runtime.disposeAll()
  })

  it('names an operator pass as the trigger', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime, scopes, namesOf } = runtimeFor()
    const ctx = new FakeAgentCtx()
    const agent = fakeAgent('session-1', project.session, ctx)
    runtime.attach(new FakeScope([agent], namesOf))
    await sleep(20)

    await runtime.syncNow()

    expect(mountingLines()).toHaveLength(1)
    expect(mountingLines()[0]).toContain('operator')
    await runtime.disposeAll()
  })

  it('logs the unmount of every instance it stops, with the reason', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime, namesOf } = runtimeFor()
    const agent = fakeAgent('session-1', project.session, new FakeAgentCtx())
    runtime.attach(new FakeScope([agent], namesOf))
    await sleep(20)
    await runtime.syncNow()
    expect(mountingLines()).toHaveLength(1)

    infoLines.splice(0)
    await runtime.release('session-1')

    const lines = unmountingLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('alpha')
    expect(lines[0]).toContain(project.root)
    // The reason is the part the log's order cannot tell: an edit, an idle
    // release and an operator release all unmount, and only some are followed by
    // a mount of the same server.
    expect(lines[0]).toContain('an operator released it')
    expect(lines[0]).toContain('it ran for')
    await runtime.disposeAll()
  })

  it('reports no presentation, and no step tag, before a session has mounted', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime, namesOf } = runtimeFor({ activationToolBudgetChars: 0 })
    const agent = fakeAgent('session-1', project.session, new FakeAgentCtx())
    const scope = new FakeScope([agent], namesOf)
    runtime.attach(scope)
    await sleep(20)

    // Nothing the plugin offers this session yet: "not mounted for this
    // session" is not the same statement as "offers nothing", so there is no
    // row to carry a step tag — and no step has run either.
    expect(runtime.snapshot().projects[0]?.sessions[0]?.tools).toBeUndefined()

    // A real turn starts the project and continues the step untouched, so the
    // mounted catalog becomes visible without a step ever being held up.
    await scope.step({ agent })
    await waitFor(() => namesOf(agent) === 1)
    expect(runtime.snapshot().projects[0]?.rows[0]?.status).toBe('active')
    await runtime.disposeAll()
  })
})

describe('mount isolation', () => {
  it('starts only the project of the session whose turn asks for it', async () => {
    const project1 = makeProject({ alpha: { command: 'npx' } })
    const project2 = makeProject({ beta: { command: 'npx' } })
    const { runtime, scopes, namesOf } = runtimeFor({ activationWaitMs: 1_000 })
    const ctx1 = new FakeAgentCtx()
    const ctx2 = new FakeAgentCtx()
    const agent1 = fakeAgent('session-1', project1.session, ctx1)
    const agent2 = fakeAgent('session-2', project2.session, ctx2)
    const scope = new FakeScope([agent1, agent2], namesOf)
    runtime.attach(scope)
    await sleep(20)
    expect(scopes.projects).toEqual([])

    // A real turn: the loop's pre-step hook, the path a first step goes through.
    await scope.step({ agent: agent1 })

    // Exactly one project scope exists, and only the asking session's project.
    expect(scopes.projects).toHaveLength(1)
    expect(sharedMounts(scopes, project1.root).map((mount) => mount.name)).toEqual(['alpha'])
    // The turn registered the mount; its handshake settles behind the pass.
    await waitFor(() => namesOf(agent1) === 1)
    expect(sessionNames(scopes, agent1)).toEqual(['mcp__alpha__tool'])
    // The other project is published, and nothing of its own runs.
    expect(scopes.forProject(project2.root)).toBeUndefined()
    expect(sessionNames(scopes, agent2)).toEqual([])
    expect(rowsFor(runtime, project2.root).map((row) => [row.name, row.status])).toEqual([['beta', 'idle']])

    // Its own turn still mounts it: the pass is scoped, lazy mounting is not off.
    scope.emit('agent/status', { agent: agent2, status: 'running' })
    await waitFor(() => namesOf(agent2) === 1)
    await runtime.syncNow()
    expect(rowsFor(runtime, project2.root).map((row) => [row.name, row.status])).toEqual([
      ['beta', 'active'],
    ])
    expect(sharedMounts(scopes, project2.root).map((mount) => mount.name)).toEqual(['beta'])
    expect(sessionNames(scopes, agent2)).toEqual(['mcp__beta__tool'])
    await runtime.disposeAll()
  })
})

describe('mountTrigger', () => {
  it('grants a mount only to the session that asks, and names why', () => {
    const idle = { lazy: true, activationPending: false, mounted: false, operatorRequested: false }
    expect(mountTrigger({ ...idle, activationPending: true })).toBe('turn')
    expect(mountTrigger({ ...idle, operatorRequested: true })).toBe('operator')
    expect(mountTrigger({ ...idle, mounted: true })).toBe('mounted')
    expect(mountTrigger({ ...idle, lazy: false })).toBe('eager')
    // A registered session that has asked for nothing starts nothing.
    expect(mountTrigger(idle)).toBeUndefined()
    // And the eager deployment still wins over an unasked session.
    expect(mountTrigger({ ...idle, lazy: false, activationPending: false })).toBe('eager')
  })
})
