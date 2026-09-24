/**
 * Durable per-project MCP usage counters: the pure attribution and counting
 * model, the debounced atomic document, the `tools/result` subscription, and
 * the snapshot field the UI reads.
 *
 * The registry contract under test is deliberately narrow: a counter moves only
 * for a tool of a server this plugin mounted for the calling agent's project,
 * and every filesystem failure stays off the tool-call path.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  type RuntimeOptions,
} from '../src/runtime.ts'
import { USAGE_VERSION, UsageStore, matchServer, observeToolResults, recordUsage } from '../src/usage.ts'
import { chainSchemas, fakeScopes } from './helpers/scopes.ts'
import type { FakeScopes } from './helpers/scopes.ts'
import type {
  ToolResultEventLike,
  ToolResultLike,
  UsageEvent,
  UsageState,
} from '../src/usage.ts'

const created: string[] = []
const AT = Date.UTC(2024, 4, 6, 7, 8, 9)

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'project-mcp-usage-'))
  created.push(dir)
  return dir
}

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    projectRoot: '/repo',
    serverName: 'alpha',
    tool: 'run',
    isError: false,
    at: AT,
    sessionId: 'session-one',
    ...overrides,
  }
}

function silentLogger(): { warn: (message: string) => void; warned: string[] } {
  const warned: string[] = []
  return { warned, warn: (message: string) => warned.push(message) }
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('usage model', () => {
  it('counts calls, errors and per-tool hits, and stamps only a success', () => {
    const first = recordUsage({}, event())
    expect(first['/repo']?.['alpha']).toEqual({
      calls: 1,
      errors: 0,
      tools: { run: 1 },
      lastUsedAt: new Date(AT).toISOString(),
      sessions: {
        'session-one': {
          calls: 1,
          errors: 0,
          tools: { run: 1 },
          lastUsedAt: new Date(AT).toISOString(),
        },
      },
    })

    // A failure increments both counters and keeps the previous success stamp.
    const failed = recordUsage(first, event({ tool: 'fail', isError: true, at: AT + 60_000 }))
    expect(failed['/repo']?.['alpha']).toEqual({
      calls: 2,
      errors: 1,
      tools: { run: 1, fail: 1 },
      lastUsedAt: new Date(AT).toISOString(),
      sessions: {
        'session-one': {
          calls: 2,
          errors: 1,
          tools: { run: 1, fail: 1 },
          lastUsedAt: new Date(AT).toISOString(),
        },
      },
    })

    // The input state is never mutated.
    expect(first['/repo']?.['alpha']?.calls).toBe(1)
    expect(first['/repo']?.['alpha']?.tools).toEqual({ run: 1 })
  })

  it('keeps projects and servers in separate buckets', () => {
    let state: UsageState = {}
    state = recordUsage(state, event())
    state = recordUsage(state, event())
    state = recordUsage(state, event({ projectRoot: '/other' }))
    state = recordUsage(state, event({ serverName: 'beta' }))

    expect(Object.keys(state).sort()).toEqual(['/other', '/repo'])
    expect(state['/repo']?.['alpha']?.calls).toBe(2)
    expect(state['/repo']?.['beta']?.calls).toBe(1)
    expect(state['/other']?.['alpha']?.calls).toBe(1)
    expect(state['/other']?.['alpha']?.tools).toEqual({ run: 1 })
  })

  it('counts each session of a project apart, and the project as their sum', () => {
    let state: UsageState = {}
    state = recordUsage(state, event({ sessionId: 'session-one' }))
    state = recordUsage(state, event({ sessionId: 'session-two', tool: 'other' }))
    state = recordUsage(state, event({ sessionId: 'session-two', tool: 'other' }))

    const alpha = state['/repo']?.['alpha']
    // The project total is what the disclosure decisions read.
    expect(alpha?.calls).toBe(3)
    expect(alpha?.tools).toEqual({ run: 1, other: 2 })
    // The split is what a session-scoped panel reads, and it does not merge.
    expect(alpha?.sessions?.['session-one']).toEqual({
      calls: 1,
      errors: 0,
      tools: { run: 1 },
      lastUsedAt: new Date(AT).toISOString(),
    })
    expect(alpha?.sessions?.['session-two']?.calls).toBe(2)
    expect(alpha?.sessions?.['session-two']?.tools).toEqual({ other: 2 })
  })

  it('moves one session’s stamp without touching the other’s', () => {
    let state: UsageState = {}
    state = recordUsage(state, event({ sessionId: 'session-one' }))
    state = recordUsage(state, event({ sessionId: 'session-two', at: AT + 3_600_000 }))
    state = recordUsage(
      state,
      event({ sessionId: 'session-one', tool: 'fail', isError: true, at: AT + 7_200_000 }),
    )

    const sessions = state['/repo']?.['alpha']?.sessions
    // A failure keeps the previous success stamp — per session, not per project.
    expect(sessions?.['session-one']?.lastUsedAt).toBe(new Date(AT).toISOString())
    expect(sessions?.['session-two']?.lastUsedAt).toBe(new Date(AT + 3_600_000).toISOString())
    expect(sessions?.['session-one']?.errors).toBe(1)
  })

  it('attributes only mounted servers, preferring the longest name', () => {
    const mounted = new Set(['alpha', 'alpha_tools'])
    expect(matchServer('mcp__alpha_tools__run', mounted)).toBe('alpha_tools')
    expect(matchServer('mcp__alpha__run', mounted)).toBe('alpha')
    // A profile-level server is not among the project's mounts.
    expect(matchServer('mcp__profile__run', mounted)).toBeUndefined()
    // A sibling prefix is not a match: `alpha` + `_tools` is another server.
    expect(matchServer('mcp__alpha2__run', mounted)).toBeUndefined()

    const underscored = new Set(['a', 'a_'])
    expect(matchServer('mcp__a___x', underscored)).toBe('a_')
  })

  it('still attributes a registry name truncated to the function-name budget', () => {
    // `publicToolName` keeps the `mcp__<serverName>__` prefix and appends a
    // 12-hex-char hash, so the mounted server stays identifiable.
    const truncated = `mcp__alpha__${'x'.repeat(40)}_0123456789ab`
    const mounted = new Set(['alpha', 'beta'])
    expect(matchServer(truncated, mounted)).toBe('alpha')
    // The hash suffix is not a raw tool name; it is still a stable per-tool key.
    const counted = recordUsage({}, {
      projectRoot: '/repo',
      serverName: 'alpha',
      tool: truncated.slice('mcp__alpha__'.length),
      isError: false,
      at: AT,
      sessionId: 'session-one',
    })
    expect(counted['/repo']?.['alpha']?.tools).toEqual({ [`${'x'.repeat(40)}_0123456789ab`]: 1 })
  })
})

describe('usage document', () => {
  it('stays in memory until flushed, then survives a round-trip', () => {
    const file = join(tmp(), 'nested', 'usage.json')
    const store = new UsageStore({ file, flushMs: 60_000 })
    store.record(event())
    expect(existsSync(file)).toBe(false)

    store.flush()
    expect(existsSync(file)).toBe(true)
    const document: unknown = JSON.parse(readFileSync(file, 'utf8'))
    expect(document).toMatchObject({ version: USAGE_VERSION })
    store.dispose()

    const reloaded = new UsageStore({ file, flushMs: 60_000 })
    expect(reloaded.forProject('/repo')).toEqual(store.forProject('/repo'))
    expect(reloaded.forProject('/missing')).toBeUndefined()
    reloaded.dispose()
  })

  it('starts clean on a missing, unreadable, foreign or older-version document', () => {
    const missing = silentLogger()
    const absent = new UsageStore({ file: join(tmp(), 'absent.json'), logger: missing, flushMs: 60_000 })
    expect(absent.forProject('/repo')).toBeUndefined()
    expect(missing.warned).toEqual([])

    const corruptDir = tmp()
    const corrupt = silentLogger()
    const corruptFile = join(corruptDir, 'usage.json')
    writeFileSync(corruptFile, '{not json')
    const broken = new UsageStore({ file: corruptFile, logger: corrupt, flushMs: 60_000 })
    expect(broken.forProject('/repo')).toBeUndefined()
    expect(corrupt.warned.some((message) => message.includes('starting clean'))).toBe(true)

    const olderDir = tmp()
    const older = silentLogger()
    const olderFile = join(olderDir, 'usage.json')
    writeFileSync(olderFile, JSON.stringify({ version: 0, projects: { '/repo': { alpha: {} } } }))
    const migrated = new UsageStore({ file: olderFile, logger: older, flushMs: 60_000 })
    expect(migrated.forProject('/repo')).toBeUndefined()
    expect(older.warned).toHaveLength(1)

    const foreignDir = tmp()
    const foreign = silentLogger()
    const foreignFile = join(foreignDir, 'usage.json')
    writeFileSync(
      foreignFile,
      JSON.stringify({
        version: USAGE_VERSION,
        projects: {
          '/repo': {
            alpha: { calls: 2, errors: 1, tools: { run: 2, bad: 'x' }, lastUsedAt: AT },
            malformed: { calls: 'many' },
          },
          nope: 7,
        },
      }),
    )
    const sanitized = new UsageStore({ file: foreignFile, logger: foreign, flushMs: 60_000 })
    expect(sanitized.forProject('/repo')).toEqual({
      alpha: { calls: 2, errors: 1, tools: { run: 2 } },
    })
    expect(foreign.warned).toEqual([])
  })

  it('never throws when the document cannot be written', () => {
    const dir = tmp()
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a directory')
    const logger = silentLogger()
    const store = new UsageStore({ file: join(blocker, 'usage.json'), logger, flushMs: 60_000 })

    store.record(event())
    expect(() => store.flush()).not.toThrow()
    expect(logger.warned.some((message) => message.includes('writing usage counters'))).toBe(true)
    // A failed write is not fatal for later writes either.
    expect(() => store.dispose()).not.toThrow()
  })
})

describe('tools/result subscription', () => {
  function harness(): {
    events: UsageEvent[]
    emit: (exec: ToolResultEventLike, result: ToolResultLike) => void
    subscribed: () => boolean
    dispose: () => void
  } {
    const events: UsageEvent[] = []
    let listener: ((exec: ToolResultEventLike, result: ToolResultLike) => undefined) | undefined
    const dispose = observeToolResults({
      on: (name, handler) => {
        expect(name).toBe('tools/result')
        listener = handler
        return () => {
          listener = undefined
        }
      },
      mountsFor: (agentId) =>
        agentId === 'session-1'
          ? { projectRoot: '/repo', servers: new Set(['alpha', 'alpha_tools']) }
          : undefined,
      store: { record: (recorded) => void events.push(recorded) },
      now: () => AT,
    })
    return {
      events,
      emit: (exec, result) => listener?.(exec, result),
      subscribed: () => listener !== undefined,
      dispose,
    }
  }

  it('counts a mounted server call exactly once, per event', () => {
    const observer = harness()
    observer.emit({ name: 'mcp__alpha__run', agent: { id: 'session-1' } }, { isError: false })
    // A programmatic sub-dispatch is one call of its own; the enclosing
    // `run_code` is not an MCP tool and is not counted on top of it.
    observer.emit({ name: 'run_code', agent: { id: 'session-1' } }, { isError: false })
    observer.emit({ name: 'mcp__alpha_tools__search', agent: { id: 'session-1' } }, { isError: true })

    expect(observer.events).toEqual([
      { projectRoot: '/repo', serverName: 'alpha', tool: 'run', isError: false, at: AT, sessionId: 'session-1' },
      { projectRoot: '/repo', serverName: 'alpha_tools', tool: 'search', isError: true, at: AT, sessionId: 'session-1' },
    ])
  })

  it('ignores profile-level names, unknown agents and host-level calls', () => {
    const observer = harness()
    observer.emit({ name: 'mcp__profile__run', agent: { id: 'session-1' } }, { isError: false })
    observer.emit({ name: 'mcp__alpha__run', agent: { id: 'session-elsewhere' } }, { isError: false })
    observer.emit({ name: 'mcp__alpha__run' }, { isError: false })

    expect(observer.events).toEqual([])
  })

  it('unsubscribes when its disposer runs', () => {
    const observer = harness()
    expect(observer.subscribed()).toBe(true)
    observer.dispose()
    expect(observer.subscribed()).toBe(false)
  })
})

/** Project with a `.dsh/mcp.json`, plus a nested session directory. */
function makeProject(servers: Record<string, unknown>): { root: string; session: string } {
  const root = tmp()
  mkdirSync(join(root, '.dsh'), { recursive: true })
  mkdirSync(join(root, 'src', 'nested'), { recursive: true })
  writeFileSync(join(root, '.dsh', 'mcp.json'), JSON.stringify({ mcpServers: servers }))
  return { root, session: join(root, 'src', 'nested') }
}

/** Stands in for an agent-scoped Cordis context: mounts fake mcp-client fibers. */
class FakeAgentCtx {
  readonly names = new Set<string>()
  readonly mounts: { name: string; disposed: boolean }[] = []

  plugin(_plugin: unknown, config: { serverName: string }): unknown {
    const record = { name: config.serverName, disposed: false }
    this.mounts.push(record)
    const names = this.names
    return {
      await: async () => {
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

  async disposeAll(): Promise<void> {
    for (const mount of this.mounts) mount.disposed = true
    this.names.clear()
  }

  schemas(): { name: string }[] {
    return [...this.names].map((name) => ({ name }))
  }
}

type ScopeHandler = (event: AgentEventLike, next: () => Promise<unknown>) => unknown

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

  effect(fn: () => unknown): () => void {
    void fn()
    return () => undefined
  }
}

/**
 * Scope doubles: one per session, one for the project its servers are shared
 * in. The usage publisher only reads `mountsFor`, but the mount itself has to
 * succeed for that answer to mean anything.
 */
function scopesFor(): FakeScopes<FakeAgentCtx> {
  return fakeScopes<FakeAgentCtx>(
    () => new FakeAgentCtx(),
    (key) => (key as AgentLike).ctx as unknown as FakeAgentCtx,
    (ctx) => ctx.disposeAll(),
  )
}

function fakeHost(scopes: FakeScopes<FakeAgentCtx>): Context {
  const host = {
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    tools: {
      schemas: (agent: AgentLike) => chainSchemas(scopes.chainOf(agent), (ctx) => ctx.schemas()),
    },
    get: () => undefined,
  }
  return host as unknown as Context
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
  scopes: FakeScopes<FakeAgentCtx>,
  options: RuntimeOptions,
): ProjectMcpRuntime {
  return new ProjectMcpRuntime(fakeHost(scopes), config(), {
    plugin: { name: 'fake-mcp', inject: ['tools'], apply: () => undefined },
    createScope: scopes.createScope,
    ...options,
  })
}

function fakeAgent(id: string, cwd: string): AgentLike {
  const ctx = new FakeAgentCtx()
  return {
    id,
    session: { header: { cwd } },
    ctx: ctx as unknown as Context,
  }
}

describe('runtime usage publishing', () => {
  it('resolves an agent to its project and mounted servers, and publishes the counters', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const other = makeProject({ beta: { command: 'npx' } })
    const store = new UsageStore({ file: join(tmp(), 'usage.json'), flushMs: 60_000 })
    const scopes = scopesFor()
    const runtime = runtimeFor(scopes, { usage: store })
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session), fakeAgent('session-2', other.session)]))

    await runtime.syncNow()

    expect(runtime.mountsFor('session-1')).toEqual({
      projectRoot: project.root,
      servers: new Set(['alpha']),
    })
    expect(runtime.mountsFor('session-2')?.projectRoot).toBe(other.root)
    expect(runtime.mountsFor('nobody')).toBeUndefined()

    // No counter yet: the field is absent, not an empty object.
    const before = runtime.snapshot().projects.find((entry) => entry.projectRoot === project.root)
    expect(before?.usage).toBeUndefined()

    store.record(event({ projectRoot: project.root }))

    const after = runtime.snapshot().projects.find((entry) => entry.projectRoot === project.root)
    expect(after?.usage).toEqual({
      alpha: {
        calls: 1,
        errors: 0,
        tools: { run: 1 },
        lastUsedAt: new Date(AT).toISOString(),
        // The split rides along in the published snapshot: this is what a panel
        // scoped to one session reads (F-34).
        sessions: {
          'session-one': {
            calls: 1,
            errors: 0,
            tools: { run: 1 },
            lastUsedAt: new Date(AT).toISOString(),
          },
        },
      },
    })
    // The project with no counted calls still omits the field.
    const untouched = runtime.snapshot().projects.find((entry) => entry.projectRoot === other.root)
    expect(untouched?.usage).toBeUndefined()

    store.dispose()
  })

  it('has no counters to publish when the runtime is built without a store', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const scopes = scopesFor()
    const runtime = runtimeFor(scopes, {})
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session)]))

    await runtime.syncNow()

    expect(runtime.snapshot().projects[0]?.usage).toBeUndefined()
    // The mount really happened in the project's shared scope.
    expect(scopes.forProject(project.root)?.mounts.map((mount) => mount.name)).toEqual(['alpha'])
  })
})
