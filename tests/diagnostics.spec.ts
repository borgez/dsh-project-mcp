/**
 * Connect watchdog: a declared server that never produces a tool must surface a
 * detailed, actionable error instead of sitting in `connecting` forever — and
 * the plugin must never compensate for it by respawning the server on every
 * pass (that is what turns one broken entry into a process storm).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ProjectMcpRuntime,
  type AgentEventLike,
  type AgentLike,
  type AgentScopeLike,
  type RuntimeConfig,
} from '../src/runtime.ts'
import { chainSchemas, fakeScopes } from './helpers/scopes.ts'
import type { FakeScopes } from './helpers/scopes.ts'

const created: string[] = []

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'project-mcp-diag-'))
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

/**
 * Poll until `probe` holds. A mount's activation settles behind the pass that
 * registered it, so a test reads the row it left behind rather than the row the
 * pass returned with.
 */
async function waitFor(probe: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!probe() && Date.now() < deadline) await sleep(5)
}

/**
 * Agent-scoped context double that mimics `mcp-client`'s startup contract:
 * activation settles on the *first* attempt either way, the supervisor keeps
 * reconnecting in the background, and only a healthy server registers a tool.
 */
class SupervisedCtx {
  readonly names = new Set<string>()
  readonly mounts: { name: string; disposed: boolean }[] = []
  /** `false` models a server that exits on startup and is being retried. */
  healthy = true
  /** Set to reject activation, as `failOnStartupError: true` does. */
  activationError: string | undefined
  /** `true` models a mount that never settles: the connect window is the only bound. */
  stalled = false
  /**
   * When set, activation waits on this promise instead of settling by itself,
   * so a test can hold a fiber open across a pass and release it afterwards.
   */
  gate: Promise<void> | undefined

  constructor(healthy = true) {
    this.healthy = healthy
  }

  plugin(_plugin: unknown, config: { serverName: string }): unknown {
    const record = { name: config.serverName, disposed: false }
    this.mounts.push(record)
    const owner = this
    return {
      await: async () => {
        await sleep(1)
        if (owner.gate !== undefined) await owner.gate
        if (owner.activationError !== undefined) throw new Error(owner.activationError)
        if (owner.stalled) await new Promise<never>(() => undefined)
        if (owner.healthy) owner.raise(config.serverName)
      },
      dispose: async () => {
        record.disposed = true
        for (const name of [...owner.names]) {
          if (name.startsWith(`mcp__${config.serverName}__`)) owner.names.delete(name)
        }
      },
    }
  }

  /** The background reconnect finally succeeds. */
  raise(serverName: string): void {
    this.names.add(`mcp__${serverName}__tool`)
  }

  schemas(): { name: string }[] {
    return [...this.names].map((name) => ({ name }))
  }

  disposeAll(): void {
    for (const mount of this.mounts) mount.disposed = true
    this.names.clear()
  }
}

class FakeScope implements AgentScopeLike {
  constructor(private readonly agents_: AgentLike[]) {}

  get agents() {
    return { list: () => [...this.agents_] }
  }

  on(
    _name: string,
    _handler: (event: AgentEventLike, next: () => Promise<unknown>) => unknown,
  ): () => void {
    return () => undefined
  }

  effect(): () => void {
    return () => undefined
  }
}

function fakeHost(scopes: FakeScopes<SupervisedCtx>) {
  const host = {
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    tools: {
      schemas: (agent: AgentLike) => chainSchemas(scopes.chainOf(agent), (ctx) => ctx.schemas()),
    },
    get: () => undefined,
  }
  return host as unknown as Context
}

/**
 * Scope doubles whose project scope carries the fake server's behaviour: the
 * mount, its health and its later recovery all live in the shared instance.
 */
function scopesFor(
  behaviour: {
    healthy?: boolean
    activationError?: string
    stalled?: boolean
    gate?: Promise<void>
  } = {},
): FakeScopes<SupervisedCtx> {
  return fakeScopes<SupervisedCtx>(
    () => {
      const ctx = new SupervisedCtx(behaviour.healthy ?? true)
      ctx.activationError = behaviour.activationError
      ctx.stalled = behaviour.stalled ?? false
      ctx.gate = behaviour.gate
      return ctx
    },
    (key) => (key as AgentLike).ctx as unknown as SupervisedCtx,
    (ctx) => ctx.disposeAll(),
  )
}

/** The project's shared context double, minted with its first mount. */
function projectCtx(scopes: FakeScopes<SupervisedCtx>, projectRoot: string): SupervisedCtx {
  const ctx = scopes.forProject(projectRoot)
  if (ctx === undefined) throw new Error(`no project scope was minted for ${projectRoot}`)
  return ctx
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
    credentialsFile: '/definitely/missing/.credentials.yaml',
    ...overrides,
  }
}

function runtimeFor(
  scopes: FakeScopes<SupervisedCtx>,
  overrides: Partial<RuntimeConfig> = {},
): ProjectMcpRuntime {
  return new ProjectMcpRuntime(fakeHost(scopes), config(overrides), {
    plugin: { name: 'fake-mcp', inject: ['tools'], apply: () => undefined },
    createScope: scopes.createScope,
  })
}

function fakeAgent(id: string, cwd: string, ctx: SupervisedCtx): AgentLike {
  return { id, session: { header: { cwd } }, ctx: ctx as unknown as Context }
}

function rowOf(runtime: ProjectMcpRuntime, index = 0) {
  return runtime.snapshot().projects[index]?.rows[0]
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('connect watchdog', () => {
  it('reports a mount that never connects and leaves it running', async () => {
    const project = makeProject({ audit: { command: 'node', args: ['server.mjs'] } })
    const scopes = scopesFor({ healthy: false })
    const runtime = runtimeFor(scopes, { connectTimeoutMs: 40 })
    const agent = fakeAgent('session-1', project.session, new SupervisedCtx())
    runtime.attach(new FakeScope([agent]))

    await runtime.syncNow()
    expect(rowOf(runtime)?.status).toBe('connecting')
    expect(rowOf(runtime)?.detail).toBeUndefined()

    await sleep(60)
    await runtime.syncNow()

    const row = rowOf(runtime)
    expect(row?.status).toBe('error')
    // Three facts, nothing else: the row already carries the status, the
    // transport chip and a `Retry` button, and the server's own reason is on its
    // stderr, in the DSH log.
    expect(row?.detail?.split('\n')).toEqual([
      expect.stringContaining('audit: no tool appeared in'),
      'endpoint: stdio node',
      `declared in: ${join(project.root, '.dsh', 'mcp.json')}`,
    ])
    expect(row?.detail).not.toContain('projectMcp.retry()')
    expect(row?.detail).not.toContain('hint:')

    const issue = runtime
      .snapshot()
      .projects[0]?.issues.find((entry) => entry.server === 'audit')
    expect(issue?.level).toBe('error')
    expect(issue?.message).toBe(row?.detail)

    // Read-only watchdog: the slow server is not killed, and mcp-client may
    // still connect in the background.
    expect(projectCtx(scopes, project.root).mounts).toHaveLength(1)
    expect(projectCtx(scopes, project.root).mounts[0]?.disposed).toBe(false)
    await runtime.disposeAll()
  })

  it('gives an HTTP stall the same three facts, with no stdio advice', async () => {
    const project = makeProject({ wiki: { url: 'https://mcp.example.net/mcp' } })
    const scopes = scopesFor({ healthy: false })
    const runtime = runtimeFor(scopes, { connectTimeoutMs: 40 })
    const agent = fakeAgent('session-1', project.session, new SupervisedCtx())
    runtime.attach(new FakeScope([agent]))

    await runtime.syncNow()
    await sleep(60)
    await runtime.syncNow()

    const detail = rowOf(runtime)?.detail ?? ''
    expect(detail.split('\n')).toEqual([
      expect.stringContaining('wiki: no tool appeared in'),
      'endpoint: streamable-http https://mcp.example.net/mcp',
      `declared in: ${join(project.root, '.dsh', 'mcp.json')}`,
    ])
    // No child process, so there is no stderr to read and no startup profile to
    // validate: neither the stdio advice nor the `docker` example may appear
    // here, and nothing is repeated that the row already shows.
    expect(detail).not.toContain('stderr')
    expect(detail).not.toContain('docker')
    expect(detail).not.toContain('projectMcp.retry()')
    await runtime.disposeAll()
  })

  it('clears the stall once the background retry connects', async () => {
    const project = makeProject({ audit: { command: 'node' } })
    const scopes = scopesFor({ healthy: false })
    const runtime = runtimeFor(scopes, { connectTimeoutMs: 40 })
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session, new SupervisedCtx())]))

    await runtime.syncNow()
    await sleep(60)
    await runtime.syncNow()
    expect(rowOf(runtime)?.status).toBe('error')

    projectCtx(scopes, project.root).raise('audit')
    await runtime.syncNow()

    const row = rowOf(runtime)
    expect(row?.status).toBe('active')
    expect(row?.detail).toBeUndefined()
    expect(runtime.snapshot().projects[0]?.issues).toEqual([])
    await runtime.disposeAll()
  })

  it('never respawns a stalled server on later passes', async () => {
    const project = makeProject({ audit: { command: 'node' } })
    const scopes = scopesFor({ healthy: false })
    const runtime = runtimeFor(scopes, { connectTimeoutMs: 20 })
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session, new SupervisedCtx())]))

    await runtime.syncNow()
    await sleep(40)
    for (let pass = 0; pass < 5; pass += 1) await runtime.syncNow()

    expect(projectCtx(scopes, project.root).mounts).toHaveLength(1)
    expect(projectCtx(scopes, project.root).mounts[0]?.disposed).toBe(false)
    expect(rowOf(runtime)?.status).toBe('error')
    await runtime.disposeAll()
  })

  it('keeps a mount as `connecting` when the watchdog is disabled', async () => {
    const project = makeProject({ audit: { command: 'node' } })
    const scopes = scopesFor({ healthy: false })
    const runtime = runtimeFor(scopes, { connectTimeoutMs: 0 })
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session, new SupervisedCtx())]))

    await runtime.syncNow()
    await sleep(60)
    await runtime.syncNow()

    expect(rowOf(runtime)?.status).toBe('connecting')
    expect(rowOf(runtime)?.detail).toBeUndefined()
    expect(runtime.snapshot().projects[0]?.issues).toEqual([])
    await runtime.disposeAll()
  })

  it('reports a hard activation failure with the underlying cause', async () => {
    const project = makeProject({ gateway: { command: 'docker', args: ['mcp', 'gateway', 'run'] } })
    const scopes = scopesFor({ activationError: 'profile "Default Profile" failed validation' })
    const runtime = runtimeFor(scopes, { connectTimeoutMs: 60_000 })
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session, new SupervisedCtx())]))

    await runtime.syncNow()

    // The pass returned with the mount recorded; the fiber's failure is what
    // the watcher behind it writes.
    await waitFor(() => rowOf(runtime)?.status === 'error')

    const row = rowOf(runtime)
    expect(row?.status).toBe('error')
    expect(row?.detail).toContain('mount failed')
    expect(row?.detail).toContain('profile "Default Profile" failed validation')
    expect(row?.detail).toContain('stdio docker')
    expect(row?.detail).toContain(join(project.root, '.dsh', 'mcp.json'))

    // The failure is published as an issue by the pass after it, not by the one
    // that registered the mount — and a dead fiber is never retried implicitly.
    await runtime.syncNow()
    expect(
      runtime.snapshot().projects[0]?.issues.some((entry) => entry.level === 'error'),
    ).toBe(true)
    expect(projectCtx(scopes, project.root).mounts).toHaveLength(1)
    await runtime.disposeAll()
  })

  it('does not hold the pass for a server that never answers', async () => {
    const project = makeProject({ audit: { command: 'node' } })
    const scopes = scopesFor({ stalled: true })
    // A connect window a pass used to spend waiting: an awaited activation would
    // hold this call for a full minute, and the turn behind it with it.
    const runtime = runtimeFor(scopes, { connectTimeoutMs: 60_000 })
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session, new SupervisedCtx())]))

    const started = Date.now()
    await expect(runtime.syncNow()).resolves.toBeUndefined()
    const elapsed = Date.now() - started

    // Registered, not connected: the row is `connecting` with no detail, and the
    // pass came back without the fiber.
    expect(elapsed).toBeLessThan(1_000)
    expect(projectCtx(scopes, project.root).mounts).toHaveLength(1)
    expect(rowOf(runtime)?.status).toBe('connecting')
    expect(rowOf(runtime)?.detail).toBeUndefined()

    await runtime.disposeAll()
  })

  it('reports a failure that lands after the pass returned, without rejecting it', async () => {
    const project = makeProject({ audit: { command: 'node' } })
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const scopes = scopesFor({ activationError: 'the gateway closed the transport', gate })
    const runtime = runtimeFor(scopes, { connectTimeoutMs: 60_000 })
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session, new SupervisedCtx())]))

    // The pass is over while the fiber is still open — an awaited activation
    // would have sat in the 60 s window — so the failure cannot have been
    // reported by it, and nothing about the pass waits to see one.
    const started = Date.now()
    await expect(runtime.syncNow()).resolves.toBeUndefined()
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(projectCtx(scopes, project.root).mounts).toHaveLength(1)
    expect(rowOf(runtime)?.status).toBe('connecting')

    // The server then fails. The watcher behind the pass is what writes the
    // row — the same `error` status and the same detail an awaited activation
    // wrote — and a rejection there would be an unhandled one.
    release()
    await waitFor(() => rowOf(runtime)?.status === 'error')

    const detail = rowOf(runtime)?.detail
    expect(detail).toContain('mount failed')
    expect(detail).toContain('the gateway closed the transport')

    // The failed fiber stays registered — a later pass reports it, it does not
    // mount it again — and the pass is never the one that rejects.
    await runtime.syncNow()
    expect(projectCtx(scopes, project.root).mounts).toHaveLength(1)
    expect(rowOf(runtime)?.status).toBe('error')

    await sleep(20)
    await runtime.disposeAll()
  })

  it('re-mounts a failed server on retry()', async () => {
    const project = makeProject({ gateway: { command: 'docker' } })
    const scopes = scopesFor({ activationError: 'boom' })
    const runtime = runtimeFor(scopes, { connectTimeoutMs: 60_000 })
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session, new SupervisedCtx())]))

    await runtime.syncNow()
    await waitFor(() => rowOf(runtime)?.status === 'error')

    // The operator fixes the server outside the plugin.
    const holder = projectCtx(scopes, project.root)
    holder.activationError = undefined
    // `retry()` answers as soon as the failed mount is dropped: the pass that
    // mounts it again is background work, so it is awaited through the same
    // entry point the panel's status channel reads the result from.
    await runtime.retry()
    await runtime.syncNow()

    expect(holder.mounts).toHaveLength(2)
    expect(holder.mounts[0]?.disposed).toBe(true)
    // That pass registered the re-mount; the pass after its handshake is what
    // turns the row active.
    await waitFor(() => holder.names.size === 1)
    await runtime.syncNow()
    expect(rowOf(runtime)?.status).toBe('active')
    await runtime.disposeAll()
  })

  it('answers retry() once the failed mounts are dropped, not once the pass is done', async () => {
    const project = makeProject({ gateway: { command: 'docker' } })
    const scopes = scopesFor({ activationError: 'boom' })
    const runtime = runtimeFor(scopes, { connectTimeoutMs: 60_000 })
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session, new SupervisedCtx())]))

    await runtime.syncNow()
    await waitFor(() => rowOf(runtime)?.status === 'error')

    // Fixed outside the plugin — but the re-mount never settles. A `retry()`
    // that waited for the pass (as it used to, and as `POST retry` did) would
    // never return here; the row must simply stop being an error.
    const holder = projectCtx(scopes, project.root)
    holder.activationError = undefined
    holder.stalled = true
    const started = Date.now()
    await runtime.retry()
    const elapsed = Date.now() - started

    // `retry()` answered after the drop and did not sit in the connect window
    // waiting for the re-mount; the row left `error` as soon as the pass behind
    // the drop registered the new one.
    expect(elapsed).toBeLessThan(1_000)
    await waitFor(() => rowOf(runtime)?.status === 'connecting')
    expect(rowOf(runtime)?.status).not.toBe('error')
    await runtime.disposeAll()
  })

  it('never leaks arguments or a URL query string into the detail', async () => {
    const stdio = makeProject({
      figma: { command: 'npx', args: ['--figma-api-key=figd_SUPERSECRET'] },
    })
    const http = makeProject({ remote: { url: 'http://127.0.0.1:1/mcp?token=SUPERSECRET' } })
    const scopes = scopesFor({ healthy: false })
    const runtime = runtimeFor(scopes, { connectTimeoutMs: 20 })
    runtime.attach(
      new FakeScope([
        fakeAgent('session-a', stdio.session, new SupervisedCtx(false)),
        fakeAgent('session-b', http.session, new SupervisedCtx(false)),
      ]),
    )

    await runtime.syncNow()
    await sleep(40)
    await runtime.syncNow()

    const details = runtime
      .snapshot()
      .projects.flatMap((project) => project.rows.map((row) => row.detail ?? ''))
      .join(' ')
    expect(details).toContain('stdio npx')
    expect(details).toContain('http://127.0.0.1:1/mcp')
    expect(details).not.toContain('SUPERSECRET')
    expect(details).not.toContain('figma-api-key')
    expect(details).not.toContain('token=')
    await runtime.disposeAll()
  })
})
