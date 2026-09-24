/**
 * Session activation: the pure baseline/activation/prune model, the assembly
 * merge, the `mcp_search_tools` definition, and the agent-scope wiring the
 * runtime installs.
 *
 * The contract under test is deliberately narrow. A tool is only ever offered
 * when its schema is visible to the calling session — this plugin's own mounts
 * plus the profile plane and any F-19 forwarders — the merge trims the whole
 * visible MCP surface down to the budget and re-inserts the wanted schemas, and
 * every failure of this plugin's own work stays off the model-request path.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_ACTIVATION_MIN_CALLS,
  DEFAULT_ACTIVATION_SEEDED,
  DEFAULT_SEARCH_LIMIT,
  SEARCH_TOOL_NAME,
  activate,
  advanceAutoOffer,
  autoOffers,
  createActivationState,
  createAutoOfferState,
  createSearchTool,
  installActivation,
  noteUse,
  onCompaction,
  presentedNames,
  pruneIdle,
  seedFromUsage,
  surfaceChars,
  toolsFor,
  withActiveTools,
} from '../src/activation.ts'
import type {
  ActivationContextLike,
  ActivationState,
  ActivationWiringOptions,
  AssembleListener,
  AssemblyLike,
  ListenerLike,
  SessionEventLike,
  SessionToolInput,
  ToolDefinitionLike,
  ToolSchemaLike,
} from '../src/activation.ts'
import { PolicyStore } from '../src/policy.ts'
import {
  ProjectMcpRuntime,
  type AgentEventLike,
  type AgentLike,
  type AgentScopeLike,
  type RuntimeConfig,
  type RuntimeOptions,
} from '../src/runtime.ts'
import { DEFAULT_TOOL_POLICY } from '../src/types.ts'
import type { SessionTools, ToolMode, ToolPolicy } from '../src/types.ts'
import { UsageStore } from '../src/usage.ts'
import { chainSchemas, fakeScopes } from './helpers/scopes.ts'
import type { FakeScopes } from './helpers/scopes.ts'

const created: string[] = []
const AT = Date.UTC(2024, 4, 6, 7, 8, 9)

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'project-mcp-activation-'))
  created.push(dir)
  return dir
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** One schema with a description derived from the name, as the registry publishes it. */
function tool(name: string, description = `tool ${name}`): ToolSchemaLike {
  return { name, description, parameters: {} }
}

/**
 * Public names of the project's MCP tools in one assembly, without this
 * plugin's own discovery tool: every deferred assembly offers that one on
 * purpose, and these assertions are about the project's servers.
 */
function names(tools: readonly ToolSchemaLike[]): string[] {
  return tools.map((schema) => schema.name).filter((name) => name !== SEARCH_TOOL_NAME)
}

/** The canonical value shape `mcp_search_tools` returns. */
interface SearchValue {
  query: string
  matches: { name: string; description: string }[]
  activated: string[]
  message: string
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('baseline seeding', () => {
  it('seeds the most-called tools of every server, reconstructing the public name', () => {
    const usage = {
      alpha: { calls: 20, errors: 0, tools: { hot: 9, warm: 5, cold: 1 } },
      beta: { calls: 3, errors: 0, tools: { rare: 3 } },
    }

    expect([...seedFromUsage(usage, { count: 8, minCalls: 5 })].sort()).toEqual([
      'mcp__alpha__hot',
      'mcp__alpha__warm',
    ])
    // The cap keeps the highest counters, not the first names encountered.
    expect([...seedFromUsage(usage, { count: 1, minCalls: 1 })]).toEqual(['mcp__alpha__hot'])
    expect([...seedFromUsage(usage, { count: 8, minCalls: 0 })].sort()).toEqual([
      'mcp__alpha__cold',
      'mcp__alpha__hot',
      'mcp__alpha__warm',
      'mcp__beta__rare',
    ])
  })

  it('seeds nothing without counters, with an empty cap, or below the minimum', () => {
    const usage = { alpha: { calls: 1, errors: 0, tools: { run: 1 } } }

    expect(seedFromUsage(undefined, { count: 8, minCalls: 1 }).size).toBe(0)
    expect(seedFromUsage({}, { count: 8, minCalls: 1 }).size).toBe(0)
    expect(seedFromUsage(usage, { count: 0, minCalls: 1 }).size).toBe(0)
    expect(seedFromUsage(usage, { count: 8, minCalls: 2 }).size).toBe(0)
  })

  it('breaks equal counts by name so one usage document always seeds the same set', () => {
    const usage = { alpha: { calls: 2, errors: 0, tools: { b: 1, a: 1 } } }
    expect([...seedFromUsage(usage, { count: 1, minCalls: 1 })]).toEqual(['mcp__alpha__a'])
  })
})

describe('session activation state', () => {
  it('activates idempotently and refreshes the stamp of an active name', () => {
    let state = createActivationState()
    state = activate(state, ['mcp__a__x', 'mcp__a__x'], 10)
    expect([...state.active]).toEqual([['mcp__a__x', 10]])

    // Re-activating with the same instant is a no-op; a new instant moves the
    // stamp without duplicating the entry.
    const same = activate(state, ['mcp__a__x'], 10)
    expect(same).toBe(state)
    state = activate(state, ['mcp__a__x'], 20)
    expect([...state.active]).toEqual([['mcp__a__x', 20]])
  })

  it('never tracks a baseline name as session-activated', () => {
    const state = createActivationState(['mcp__a__hot'])
    const next = activate(state, ['mcp__a__hot', 'mcp__a__new'], 5)

    expect([...next.active]).toEqual([['mcp__a__new', 5]])
    expect([...presentedNames(next)].sort()).toEqual(['mcp__a__hot', 'mcp__a__new'])
  })

  it('refreshes only a name the session actually activated', () => {
    const state = activate(createActivationState(['mcp__a__hot']), ['mcp__a__warm'], 5)

    expect(noteUse(state, 'mcp__a__warm', 30).active.get('mcp__a__warm')).toBe(30)
    // A baseline tool and an unknown tool are not activated by being called.
    expect(noteUse(state, 'mcp__a__hot', 30)).toBe(state)
    expect(noteUse(state, 'mcp__a__stranger', 30)).toBe(state)
    expect(noteUse(state, 'mcp__a__warm', 5)).toBe(state)
  })

  it('prunes exactly the stale session tools and keeps the fresh ones', () => {
    let state = activate(createActivationState(), ['mcp__a__stale'], 0)
    state = activate(state, ['mcp__a__fresh'], 100)

    const pruned = pruneIdle(state, 160, 100)
    expect([...pruned.active]).toEqual([['mcp__a__fresh', 100]])
    // Nothing stale and a disabled window both leave the state untouched.
    expect(pruneIdle(state, 150, 200)).toBe(state)
    expect(pruneIdle(state, 10_000, 0)).toBe(state)
    // The boundary itself counts as idle.
    expect([...pruneIdle(state, 100, 100).active]).toEqual([['mcp__a__fresh', 100]])
  })

  it('clears session activations on compaction but keeps the counter baseline', () => {
    const state = activate(createActivationState(['mcp__a__hot']), ['mcp__a__warm'], 5)

    const compacted = onCompaction(state)
    expect(compacted.active.size).toBe(0)
    expect([...compacted.baseline]).toEqual(['mcp__a__hot'])
    expect(onCompaction(compacted)).toBe(compacted)
  })
})

describe('assembly merge', () => {
  it('appends only the missing active tools, at their sorted position, keeping every original entry', () => {
    const base = [tool('mcp__a__b'), tool('mcp__a__d')]
    const available = [tool('mcp__a__a'), tool('mcp__a__b'), tool('mcp__a__c'), tool('mcp__a__d')]

    const merged = withActiveTools(base, available, new Set(['mcp__a__a', 'mcp__a__c', 'mcp__a__b']))

    expect(names(merged)).toEqual(['mcp__a__a', 'mcp__a__b', 'mcp__a__c', 'mcp__a__d'])
    // The entries the base already had are the very same objects, where they were.
    expect(merged[1]).toBe(base[0])
    expect(merged[3]).toBe(base[1])
    // The base list is never mutated.
    expect(names(base)).toEqual(['mcp__a__b', 'mcp__a__d'])
  })

  it('is a no-op when nothing is active, nothing is available, or the name is stale', () => {
    const base = [tool('mcp__a__b')]
    const available = [tool('mcp__a__a'), tool('mcp__a__b')]

    expect(names(withActiveTools(base, available, new Set()))).toEqual(['mcp__a__b'])
    expect(names(withActiveTools(base, [], new Set(['mcp__a__a'])))).toEqual(['mcp__a__b'])
    expect(withActiveTools(base, [], new Set(['mcp__a__a']))[0]).toBe(base[0])
    // An active baseline name whose server is no longer mounted is skipped, and a
    // name the base already carries is never appended twice.
    expect(names(withActiveTools(base, available, new Set(['mcp__a__gone'])))).toEqual(['mcp__a__b'])
    expect(names(withActiveTools(base, available, new Set(['mcp__a__b'])))).toEqual(['mcp__a__b'])
  })

  it('is total: the same inputs always produce an equal list', () => {
    const base = [tool('mcp__a__b')]
    const available = [tool('mcp__a__a')]
    const active = new Set(['mcp__a__a'])

    const first = withActiveTools(base, available, active)
    const second = withActiveTools(base, available, active)
    expect(names(first)).toEqual(names(second))
    expect(first).not.toBe(second)
  })
})

describe('mcp_search_tools definition', () => {
  function searchFor(catalog: readonly ToolSchemaLike[], activated: string[]): ToolDefinitionLike {
    return createSearchTool({
      available: () => catalog,
      activate: (matched) => void activated.push(...matched),
    })
  }

  it('finds by name and description, activates the matches, and answers honestly on no match', async () => {
    const activated: string[] = []
    const definition = searchFor(
      [
        tool('mcp__alpha__run', 'Run the alpha task'),
        tool('mcp__alpha__fetch', 'Fetch a URL'),
        tool('mcp__beta__deploy', 'Deploy the beta service'),
      ],
      activated,
    )

    const byName = (await definition.execute({ query: 'fetch' }, undefined)) as SearchValue
    expect(names(byName.matches.map((match) => tool(match.name)))).toEqual(['mcp__alpha__fetch'])
    expect(byName.activated).toEqual(['mcp__alpha__fetch'])

    const byDescription = (await definition.execute({ query: 'deploy' }, undefined)) as SearchValue
    expect(byDescription.activated).toEqual(['mcp__beta__deploy'])
    expect(activated).toEqual(['mcp__alpha__fetch', 'mcp__beta__deploy'])

    const nothing = (await definition.execute({ query: 'kubernetes' }, undefined)) as SearchValue
    expect(nothing.matches).toEqual([])
    expect(nothing.activated).toEqual([])
    expect(nothing.message).toContain('no MCP tool')
  })

  it('caps the matches it activates and rejects an empty query', async () => {
    const catalog = [tool('mcp__a__one'), tool('mcp__a__two'), tool('mcp__a__three')]
    const activated: string[] = []
    const definition = searchFor(catalog, activated)

    const capped = (await definition.execute({ query: 'mcp__a__', limit: 2 }, undefined)) as SearchValue
    expect(capped.activated).toEqual(['mcp__a__one', 'mcp__a__three'])
    // An unusable limit falls back to the default rather than activating nothing.
    const fallback = (await definition.execute(
      { query: 'mcp__a__', limit: 0 },
      undefined,
    )) as SearchValue
    expect(fallback.activated).toHaveLength(3)
    expect(DEFAULT_SEARCH_LIMIT).toBe(8)

    await expect(definition.execute({}, undefined)).rejects.toThrow('non-empty string')
    await expect(definition.execute({ query: '   ' }, undefined)).rejects.toThrow('non-empty string')
  })

  it('declares a small schema and renders a text block', () => {
    const definition = searchFor([], [])
    expect(definition.name).toBe(SEARCH_TOOL_NAME)
    expect(Object.keys(definition.parameters)).toEqual([
      'type',
      'properties',
      'required',
      'additionalProperties',
    ])
    expect(definition.description).toContain('next model step')

    const blocks = definition.output.render({ query: 'x' }, { query: 'x', matches: [] })
    expect(blocks).toEqual([{ type: 'text', text: expect.stringContaining('"query": "x"') }])
  })
})

/**
 * Agent-scoped context double: mounts a fake server like the runtime does, and
 * dispatches `system-prompt/assemble` the way cordis' waterfall does — the first
 * listener is outermost, every `next()` runs the following one, and the built-in
 * assembly is deliberately empty ("a presentation plugin filtered everything
 * away").
 */
class FakeAgentCtx {
  readonly mounts: { name: string; disposed: boolean }[] = []
  readonly registered = new Map<string, ToolDefinitionLike>()
  /** Tools visible in this scope but not mounted by this plugin (profile-level). */
  readonly extraSchemas = new Set<string>()
  lastInner: AssemblyLike | undefined
  /** Tools the inner listeners leave in the assembly; default is none (the fake "presentation plugin filtered everything away"). */
  innerTools: ToolSchemaLike[] = []
  private readonly mcpNames = new Set<string>()
  private readonly listeners = new Map<string, ListenerLike[]>()

  plugin(_plugin: unknown, config: { serverName: string }): unknown {
    const record = { name: config.serverName, disposed: false }
    this.mounts.push(record)
    const owner = this
    const names = [`mcp__${config.serverName}__tool`]
    return {
      await: async (): Promise<void> => {
        for (const name of names) owner.mcpNames.add(name)
      },
      dispose: async (): Promise<void> => {
        record.disposed = true
        for (const name of [...owner.mcpNames]) {
          if (name.startsWith(`mcp__${config.serverName}__`)) owner.mcpNames.delete(name)
        }
      },
    }
  }

  schemas(): ToolSchemaLike[] {
    return [...this.mcpNames, ...this.extraSchemas, ...this.registered.keys()].map((name) =>
      tool(name),
    )
  }

  on(name: string, listener: ListenerLike, options?: { prepend?: boolean }): () => void {
    const list = this.listeners.get(name) ?? []
    if (options?.prepend === true) list.unshift(listener)
    else list.push(listener)
    this.listeners.set(name, list)
    return () => {
      const index = list.indexOf(listener)
      if (index >= 0) list.splice(index, 1)
    }
  }

  get tools(): { register: (definition: ToolDefinitionLike) => () => void } {
    return {
      register: (definition) => {
        this.registered.set(definition.name, definition)
        return () => {
          this.registered.delete(definition.name)
        }
      },
    }
  }

  listening(name: string): number {
    return this.listeners.get(name)?.length ?? 0
  }

  async assemble(): Promise<AssemblyLike> {
    const inner: AssemblyLike = { tools: [...this.innerTools] }
    this.lastInner = inner
    const records = [...(this.listeners.get('system-prompt/assemble') ?? [])]
    let index = 0
    const call = async (): Promise<AssemblyLike> => {
      const listener = records[index]
      index += 1
      if (listener === undefined) return inner
      return (listener as unknown as AssembleListener)(inner, { scope: this }, call)
    }
    return call()
  }

  emitSessionEvent(event: SessionEventLike): void {
    for (const listener of [...(this.listeners.get('session/event') ?? [])]) {
      ;(listener as unknown as (session: unknown, event: SessionEventLike) => void)({}, event)
    }
  }

  disposeAll(): void {
    for (const mount of this.mounts) mount.disposed = true
    this.mcpNames.clear()
    // Listeners and the search-tool registration are deliberately NOT cleared
    // here. A host that publishes a plain `tools` stub owns neither, so the
    // runtime has to release them explicitly for them to disappear.
  }
}

type ScopeHandler = (event: AgentEventLike, next: () => Promise<unknown>) => unknown

/** Scope double that can deliver the agent-plane notifications the runtime listens to. */
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

  emit(name: string, event: AgentEventLike): void {
    for (const handler of this.handlers.get(name) ?? []) void handler(event, async () => undefined)
  }
}

/** Project with a `.dsh/mcp.json`, plus a nested session directory. */
function makeProject(servers: Record<string, unknown>): { root: string; session: string } {
  const root = tmp()
  mkdirSync(join(root, '.dsh'), { recursive: true })
  mkdirSync(join(root, 'src', 'nested'), { recursive: true })
  writeFileSync(join(root, '.dsh', 'mcp.json'), JSON.stringify({ mcpServers: servers }))
  return { root, session: join(root, 'src', 'nested') }
}

/**
 * Scope doubles: one per session, one for the project its servers are shared
 * in. `tools.schemas(agent)` resolves the session's chain, so a shared project
 * layer is exactly what makes its mounts available to this session.
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
    lazy: true,
    idleTimeoutMs: 0,
    activationWaitMs: 0,
    profileWins: true,
    localPrefix: '',
    watch: false,
    debounceMs: 0,
    rescanIntervalMs: 50,
    credentialsFile: '/definitely/missing/.credentials.yaml',
    activationEnabled: true,
    // Presentation is what these tests exercise; the fixtures are far below any
    // realistic deferral budget, so the gate stays off unless a test asks for it.
    activationToolBudgetChars: 0,
    ...overrides,
  }
}

function runtimeForConfig(
  runtimeConfig: RuntimeConfig,
  options: RuntimeOptions = {},
): ProjectMcpRuntime {
  const scopes = scopesFor()
  return new ProjectMcpRuntime(fakeHost(scopes), runtimeConfig, {
    plugin: { name: 'fake-mcp', inject: ['tools'], apply: () => undefined },
    createScope: scopes.createScope,
    ...options,
  })
}

function runtimeFor(
  overrides: Partial<RuntimeConfig> = {},
  options: RuntimeOptions = {},
): ProjectMcpRuntime {
  return runtimeForConfig(config(overrides), options)
}

function fakeAgent(id: string, cwd: string, ctx: FakeAgentCtx): AgentLike {
  return { id, session: { header: { cwd } }, ctx: ctx as unknown as Context }
}

/** The registered search tool, or a failed assertion instead of a non-null claim. */
function searchToolOf(ctx: FakeAgentCtx): ToolDefinitionLike {
  const definition = ctx.registered.get(SEARCH_TOOL_NAME)
  if (definition === undefined) throw new Error(`${SEARCH_TOOL_NAME} was not registered`)
  return definition
}

describe('step stamps and the request split', () => {
  /** Baseline for one row: two mounted tools, one of them offered. */
  function rowInput(overrides: Partial<SessionToolInput> = {}): SessionToolInput {
    return {
      sessionId: 'session-1',
      mounted: [tool('mcp__alpha__one'), tool('mcp__alpha__two')],
      activation: createActivationState(),
      auto: undefined,
      activationEnabled: true,
      budgetChars: 0,
      ...overrides,
    }
  }

  it('stamps the session tier with the step its offer happened on', () => {
    const mounted = [tool('mcp__alpha__one')]
    const activation = activate(createActivationState(), ['mcp__alpha__one'], AT)
    const row = toolsFor(
      rowInput({
        mounted,
        activation,
        // Recorded during step two, read much later: the record keeps its own
        // step instead of being restamped with the step the row is read on.
        steps: new Map([['mcp__alpha__one', 2]]),
        step: 5,
      }),
    )

    expect(row?.activated).toEqual([
      { name: 'mcp__alpha__one', via: 'session', at: AT, step: 2 },
    ])
    expect(row?.deferred).toEqual([])
  })

  it('stamps the context tier with the step the row is read on', () => {
    let auto = createAutoOfferState()
    auto = advanceAutoOffer(
      auto,
      { userText: 'alpha work', recentCalls: [] },
      [tool('mcp__alpha__one', 'alpha work tool')],
      { limit: 1, minScore: 0 },
    )
    expect(autoOffers(auto)).toEqual(['mcp__alpha__one'])

    const row = toolsFor(
      rowInput({
        mounted: [tool('mcp__alpha__one', 'alpha work tool')],
        auto,
        step: 7,
      }),
    )
    expect(row?.context).toEqual([{ name: 'mcp__alpha__one', via: 'context', step: 7 }])
    expect(row?.activated).toEqual([])
  })

  it('carries no step tag at all when the caller counts none', () => {
    const activation = activate(createActivationState(), ['mcp__alpha__one'], AT)
    const row = toolsFor(rowInput({ activation }))
    const [offered] = row?.activated ?? []
    expect(offered?.name).toBe('mcp__alpha__one')
    expect(offered).not.toHaveProperty('step')
    // A record without a step of its own carries none either: the number is
    // never invented from the step the row happens to be read on.
    const partial = toolsFor(rowInput({ activation, steps: new Map(), step: 4 }))
    expect(partial?.activated?.[0]).not.toHaveProperty('step')
  })

  it('splits the mounted surface into the offered and deferred characters', () => {
    const mounted = [tool('mcp__alpha__one', 'first'), tool('mcp__alpha__two', 'second')]
    const row = toolsFor(
      rowInput({ mounted, activation: createActivationState(['mcp__alpha__one']) }),
    )

    // One rule measures both halves, so they add up to the whole surface: what
    // hiding saved is exactly `surfaceChars - visibleChars`.
    expect(row?.visibleChars).toBe(surfaceChars([mounted[0] as ToolSchemaLike]))
    expect(row?.deferredChars).toBe(surfaceChars([mounted[1] as ToolSchemaLike]))
    expect((row?.visibleChars ?? 0) + (row?.deferredChars ?? 0)).toBe(row?.surfaceChars)
  })

  it('carries zero deferred characters when the surface fits the budget', () => {
    const mounted = [tool('mcp__alpha__one', 'first')]
    const row = toolsFor(rowInput({ mounted, budgetChars: surfaceChars(mounted) }))

    expect(row?.deferring).toBe(false)
    expect(row?.deferredChars).toBe(0)
    expect(row?.visibleChars).toBe(row?.surfaceChars)
  })

  it('shows a pin to a visible cross-plane name in the baseline and never defers it', () => {
    // The runtime passes the whole visible surface as `mounted`, so a pin to a
    // profile-plane name is part of this row exactly like a project-plane pin.
    const mounted = [tool('mcp__alpha__one'), tool('mcp__beta__run')]
    const row = toolsFor(
      rowInput({
        mounted,
        policy: { mode: 'disclosure', pins: ['mcp__beta__run'] },
      }),
    )

    expect(row?.baseline).toEqual(['mcp__beta__run'])
    expect(row?.deferred).toEqual(['mcp__alpha__one'])
    expect(row?.deferring).toBe(true)
  })
})

describe('agent-scope wiring', () => {
  function wiring(
    ctx: FakeAgentCtx,
    getState: () => ActivationState,
    setState: (next: ActivationState) => void,
    available: () => readonly ToolSchemaLike[],
    overrides: Partial<ActivationWiringOptions> = {},
  ): () => void {
    return installActivation({
      ctx: ctx as unknown as ActivationContextLike,
      state: getState,
      setState,
      available,
      // The deferral gate is off here: these tests are about presentation, and
      // their fixtures sit far below any realistic project budget.
      toolBudgetChars: 0,
      ...overrides,
    })
  }

  it('registers the search tool once and the assemble listener prepended, and disposes with the scope', () => {
    const ctx = new FakeAgentCtx()
    const state = createActivationState()
    const dispose = wiring(ctx, () => state, () => undefined, () => [])

    expect(ctx.registered.has(SEARCH_TOOL_NAME)).toBe(true)
    expect(ctx.listening('system-prompt/assemble')).toBe(1)
    expect(ctx.listening('session/event')).toBe(1)

    dispose()
    expect(ctx.registered.size).toBe(0)
    expect(ctx.listening('system-prompt/assemble')).toBe(0)
    expect(ctx.listening('session/event')).toBe(0)
  })

  it('appends the active tools to the assembly the inner listeners produced', async () => {
    const ctx = new FakeAgentCtx()
    const available = [tool('mcp__a__one'), tool('mcp__a__two')]
    let state = createActivationState(['mcp__a__one'])
    wiring(ctx, () => state, (next) => void (state = next), () => available)

    // Only the baseline name is active: the merge returns the continuation's
    // own value (a new assembly object carrying the added schema).
    const withBaseline = await ctx.assemble()
    expect(names(withBaseline.tools)).toEqual(['mcp__a__one'])
    expect(withBaseline).not.toBe(ctx.lastInner)

    // Nothing active still offers the discovery tool: without it the session
    // could not ask for a tool it cannot see. The continuation's value comes
    // back untouched only once it already carries that tool.
    state = createActivationState()
    expect(names((await ctx.assemble()).tools)).toEqual([])
  })

  it('returns the continuation value unchanged when this plugin’s own work fails', async () => {
    const ctx = new FakeAgentCtx()
    let state = createActivationState(['mcp__a__one'])
    const errors: unknown[] = []
    wiring(
      ctx,
      () => state,
      (next) => void (state = next),
      () => {
        throw new Error('probe failed')
      },
      { onError: (error) => void errors.push(error) },
    )

    const assembled = await ctx.assemble()
    expect(assembled).toBe(ctx.lastInner)
    expect(assembled.tools).toEqual([])
    expect(errors).toHaveLength(1)
  })

  it('clears session activations on compaction and keeps the baseline', () => {
    const ctx = new FakeAgentCtx()
    let state = activate(createActivationState(['mcp__a__hot']), ['mcp__a__warm'], AT)
    wiring(ctx, () => state, (next) => void (state = next), () => [])

    ctx.emitSessionEvent({ type: 'turn/end' })
    expect([...state.active]).toEqual([['mcp__a__warm', AT]])

    ctx.emitSessionEvent({ type: 'compaction/end' })
    expect(state.active.size).toBe(0)
    expect([...state.baseline]).toEqual(['mcp__a__hot'])
  })

  it('offers a pinned name that no counter seeded', async () => {
    const ctx = new FakeAgentCtx()
    const available = [tool('mcp__a__one'), tool('mcp__a__two')]
    const policy: ToolPolicy = { mode: 'disclosure', pins: ['mcp__a__two'] }
    wiring(ctx, () => createActivationState(), () => undefined, () => available, {
      policy: () => policy,
    })

    // The gate defers (budget `0`), yet the pin is added to the assembly from
    // the first step on — with no counter and no activation behind it.
    expect(names((await ctx.assemble()).tools)).toEqual(['mcp__a__two'])
  })

  it('adds nothing to the assembly in direct and off modes', async () => {
    const ctx = new FakeAgentCtx()
    const available = [tool('mcp__a__one')]
    let policy: ToolPolicy = { mode: 'direct', pins: ['mcp__a__one'] }
    wiring(ctx, () => createActivationState(['mcp__a__one']), () => undefined, () => available, {
      policy: () => policy,
    })

    // The same baseline name, the same pinned name: with the presentation off
    // the listener hands back the inner listeners' own value untouched, so the
    // request carries exactly what the rest of the harness produced.
    const direct = await ctx.assemble()
    expect(direct).toBe(ctx.lastInner)
    expect(direct.tools).toEqual([])
    // Registration cannot be cancelled (a DSH limitation), but the tool is not
    // advertised in either mode, so nothing can reach a deferred layer.
    expect(ctx.registered.has(SEARCH_TOOL_NAME)).toBe(true)

    policy = { mode: 'off', pins: ['mcp__a__one'] }
    expect(await ctx.assemble()).toBe(ctx.lastInner)
  })

  it('drops the project plane from the assembly in off mode, and leaves the profile plane alone', async () => {
    const ctx = new FakeAgentCtx()
    const project = tool('mcp__a__one')
    const profile = tool('mcp__beta__run')
    let policy: ToolPolicy = { mode: 'off', pins: ['mcp__a__one'] }
    wiring(ctx, () => createActivationState(['mcp__a__one']), () => undefined, () => [project], {
      visible: () => [project, profile],
      policy: () => policy,
    })

    // Another presentation owner left the whole catalogue in the assembly. `off`
    // says the project's tools are not offered, so they leave it — the pin does
    // not cancel the mode, and a profile plane is none of this mode's business.
    ctx.innerTools = [project, profile]
    expect(names((await ctx.assemble()).tools)).toEqual(['mcp__beta__run'])

    // `direct` is the opposite promise and filters nothing.
    policy = { mode: 'direct', pins: [] }
    expect(await ctx.assemble()).toBe(ctx.lastInner)
  })

  it('searches and re-inserts a visible profile-plane tool, and refuses a name the session never sees', async () => {
    const ctx = new FakeAgentCtx()
    const project = tool('mcp__alpha__one', 'first project tool')
    const profile = tool('mcp__beta__run', 'beta runner')
    let state = createActivationState()
    wiring(ctx, () => state, (next) => void (state = next), () => [project], {
      visible: () => [project, profile],
      policy: () => ({ mode: 'disclosure', pins: [] }),
    })

    // Nothing active: the deferred tier holds the whole visible surface, so only
    // the discovery tool is carried (and `names` hides it).
    expect(names((await ctx.assemble()).tools)).toEqual([])

    const search = searchToolOf(ctx)
    const found = (await search.execute({ query: 'beta' }, undefined)) as SearchValue
    expect(found.activated).toEqual(['mcp__beta__run'])
    // The activated profile-plane name is re-inserted from the visible surface.
    expect(names((await ctx.assemble()).tools)).toEqual(['mcp__beta__run'])

    // A name the session never sees is still refused, whatever its `mcp__` shape.
    const foreign = (await search.execute({ query: 'gamma' }, undefined)) as SearchValue
    expect(foreign.matches).toEqual([])
    expect(foreign.activated).toEqual([])
  })

  it('budgets the merged project+profile surface and trims only the over-budget MCP tools', async () => {
    const project = tool('mcp__alpha__one', 'first project tool')
    const profile = tool('mcp__beta__run', 'beta runner')
    const whole = [project, profile]
    const mergedChars = surfaceChars(whole)

    // Inside the budget: the listener hands the inner assembly back by identity.
    const fits = new FakeAgentCtx()
    fits.innerTools = [profile]
    wiring(fits, () => createActivationState(), () => undefined, () => [project], {
      visible: () => whole,
      toolBudgetChars: mergedChars, // the merged surface fits exactly
    })
    expect(await fits.assemble()).toBe(fits.lastInner)

    // One character over: the profile tool is dropped, the non-MCP tool survives,
    // and the discovery tool is still offered.
    const over = new FakeAgentCtx()
    over.innerTools = [profile, tool('core_read')]
    wiring(over, () => createActivationState(), () => undefined, () => [project], {
      visible: () => whole,
      toolBudgetChars: mergedChars - 1,
    })
    const trimmed = await over.assemble()
    expect(trimmed.tools.map((schema) => schema.name).sort()).toEqual([
      'core_read',
      SEARCH_TOOL_NAME,
    ])
  })

  it('keeps a cross-plane pin offered through a compaction that clears the session', async () => {
    const ctx = new FakeAgentCtx()
    const project = tool('mcp__alpha__one', 'first project tool')
    const profile = tool('mcp__beta__run', 'beta runner')
    const policy: ToolPolicy = { mode: 'disclosure', pins: ['mcp__beta__run'] }
    let state = activate(createActivationState(), ['mcp__alpha__one'], AT)
    wiring(ctx, () => state, (next) => void (state = next), () => [project], {
      visible: () => [project, profile],
      policy: () => policy,
    })

    // Activated project tool + pinned profile name both offered.
    expect(names((await ctx.assemble()).tools)).toEqual(['mcp__alpha__one', 'mcp__beta__run'])

    // A compaction drops the session's activation; the pin is project state, so
    // it is offered on the step after it all the same.
    ctx.emitSessionEvent({ type: 'compaction/end' })
    expect(state.active.size).toBe(0)
    expect(names((await ctx.assemble()).tools)).toEqual(['mcp__beta__run'])
  })

  it('drops a foreign name from the assembly in every mode while the profile plane survives', async () => {
    const project = tool('mcp__a__one', 'first project tool')
    const profile = tool('mcp__beta__run', 'beta runner')
    const foreignTool = tool('mcp__gamma__run', 'another project\u2019s tool')
    const whole = [project, profile, foreignTool]

    // A leaked inner assembly carries another project's tool. `direct` filters
    // nothing and `off` drops only the project plane, so containment is the only
    // thing that removes the foreign name there; `disclosure` under the budget
    // hands the assembly back whole, so containment is the only thing that
    // removes it there too. The session's own profile-plane name survives every
    // mode.
    const assembled = async (mode: ToolMode): Promise<string[]> => {
      const ctx = new FakeAgentCtx()
      ctx.innerTools = [...whole]
      wiring(ctx, () => createActivationState(), () => undefined, () => [project], {
        visible: () => whole,
        foreign: () => new Set([foreignTool.name]),
        policy: () => ({ mode, pins: [] }),
        toolBudgetChars: surfaceChars(whole), // the whole surface fits exactly
      })
      return names((await ctx.assemble()).tools)
    }

    expect(await assembled('disclosure')).toEqual(['mcp__a__one', 'mcp__beta__run'])
    expect(await assembled('direct')).toEqual(['mcp__a__one', 'mcp__beta__run'])
    expect(await assembled('off')).toEqual(['mcp__beta__run'])
  })

  it('returns the continuation\u2019s value by identity when nothing is foreign', async () => {
    const project = tool('mcp__a__one')
    const ctx = new FakeAgentCtx()
    ctx.innerTools = [project]
    wiring(ctx, () => createActivationState(), () => undefined, () => [project], {
      foreign: () => new Set<string>(),
      policy: () => ({ mode: 'direct', pins: [] }),
    })
    expect(await ctx.assemble()).toBe(ctx.lastInner)
  })

  it('never lets a foreign name reach the model through the discovery catalogue', async () => {
    const project = tool('mcp__a__one', 'first project tool')
    const foreignTool = tool('mcp__gamma__run', 'another project\u2019s tool')
    const ctx = new FakeAgentCtx()
    wiring(ctx, () => createActivationState(), () => undefined, () => [project], {
      visible: () => [project, foreignTool],
      foreign: () => new Set([foreignTool.name]),
    })

    // The assembly drops the foreign name, and the catalogue the search reads must
    // not name it either: a hit would hand the foreign catalogue over as text one
    // step after containment removed it from the request.
    expect(names((await ctx.assemble()).tools)).toEqual([])
    const search = searchToolOf(ctx)
    const found = (await search.execute({ query: 'gamma' }, undefined)) as SearchValue
    expect(found.matches).toEqual([])
    expect(found.activated).toEqual([])
  })

  it('still counts a foreign name in the visible surface the budget measures', async () => {
    const own = tool('mcp__a__one', 'first project tool')
    const foreignTool = tool('mcp__gamma__run', 'another project\u2019s tool')
    const whole = [own, foreignTool]

    // The budget is one under the merged surface. Because the foreign name is
    // still part of the surface the budget measures, the gate defers and the
    // assembly is trimmed to the discovery tool alone. Were containment to drop
    // the foreign name from the surface too, the surface would fit and the
    // assembly would come back carrying the own tool instead.
    const ctx = new FakeAgentCtx()
    ctx.innerTools = [...whole]
    wiring(ctx, () => createActivationState(), () => undefined, () => [own], {
      visible: () => whole,
      foreign: () => new Set([foreignTool.name]),
      toolBudgetChars: surfaceChars(whole) - 1,
    })
    expect((await ctx.assemble()).tools.map((schema) => schema.name)).toEqual([SEARCH_TOOL_NAME])
  })
})

describe('runtime wiring', () => {
  /** The tools row one session of the only project in the snapshot carries. */
  function sessionTools(runtime: ProjectMcpRuntime, sessionId: string): SessionTools | undefined {
    const project = runtime.snapshot().projects[0]
    return project?.sessions.find((session) => session.id === sessionId)?.tools
  }

  it('offers a searched tool the session can see — project or profile plane — and refuses a name it cannot', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const runtime = runtimeFor()
    const ctx = new FakeAgentCtx()
    // A profile-level tool is visible in the session's scope but is not this
    // plugin's mount: the whole-surface budget and the discovery tool still reach
    // it, so it is searchable and, once activated, offered.
    ctx.extraSchemas.add('mcp__beta__run')
    const agent = fakeAgent('session-1', project.session, ctx)
    runtime.attach(new FakeScope([agent]))
    await runtime.syncNow()

    expect(names((await ctx.assemble()).tools)).toEqual([])

    const search = searchToolOf(ctx)
    const profile = (await search.execute({ query: 'beta' }, undefined)) as SearchValue
    expect(profile.activated).toEqual(['mcp__beta__run'])
    expect(names((await ctx.assemble()).tools)).toEqual(['mcp__beta__run'])

    // A name the session never sees is still refused, whatever its `mcp__` shape.
    const foreign = (await search.execute({ query: 'gamma' }, undefined)) as SearchValue
    expect(foreign.matches).toEqual([])
    expect(foreign.message).toContain('no MCP tool')

    const own = (await search.execute({ query: 'alpha' }, undefined)) as SearchValue
    expect(own.activated).toEqual(['mcp__alpha__tool'])
    expect(names((await ctx.assemble()).tools)).toEqual(['mcp__alpha__tool', 'mcp__beta__run'])

    await runtime.disposeAll()
  })

  it('presents counter-seeded tools from the first assembly, without a search', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const store = new UsageStore({ file: join(tmp(), 'usage.json'), flushMs: 60_000 })
    for (let index = 0; index < 2; index += 1) {
      store.record({
        projectRoot: project.root,
        serverName: 'alpha',
        tool: 'tool',
        isError: false,
        at: AT + index,
        sessionId: 'session-one',
      })
    }
    const runtime = runtimeFor({ activationMinCalls: 2 }, { usage: store })
    const ctx = new FakeAgentCtx()
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session, ctx)]))
    await runtime.syncNow()

    expect(names((await ctx.assemble()).tools)).toEqual(['mcp__alpha__tool'])

    await runtime.disposeAll()
    store.dispose()
  })

  it('drops an activated tool after the idle window, and a real call keeps it fresh', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const runtime = runtimeFor({ toolIdleMs: 40 })
    const ctx = new FakeAgentCtx()
    const agent = fakeAgent('session-1', project.session, ctx)
    const scope = new FakeScope([agent])
    runtime.attach(scope)
    await runtime.syncNow()

    const search = searchToolOf(ctx)
    await search.execute({ query: 'alpha' }, undefined)
    expect(names((await ctx.assemble()).tools)).toEqual(['mcp__alpha__tool'])

    await sleep(60)
    scope.emit('agent/status', { agent, status: 'idle' })
    expect(names((await ctx.assemble()).tools)).toEqual([])

    // Freshness is a real call: the same tool activated again and used survives
    // the very sweep that would otherwise drop it.
    await search.execute({ query: 'alpha' }, undefined)
    runtime.noteToolUse('session-1', 'mcp__alpha__tool')
    scope.emit('agent/status', { agent, status: 'running' })
    expect(names((await ctx.assemble()).tools)).toEqual(['mcp__alpha__tool'])

    await runtime.disposeAll()
  })

  it('registers no search tool and changes no assembly when activation is disabled', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const runtime = runtimeFor({ activationEnabled: false })
    const ctx = new FakeAgentCtx()
    const agent = fakeAgent('session-1', project.session, ctx)
    const scope = new FakeScope([agent])
    runtime.attach(scope)
    await runtime.syncNow()

    expect(ctx.registered.size).toBe(0)
    expect(ctx.listening('system-prompt/assemble')).toBe(0)
    expect(ctx.listening('session/event')).toBe(0)
    scope.emit('agent/status', { agent, status: 'running' })
    expect(names((await ctx.assemble()).tools)).toEqual([])

    await runtime.disposeAll()
  })

  it('disposes the search tool with the session scope and reinstalls it on the next mount', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const runtime = runtimeFor()
    const ctx = new FakeAgentCtx()
    const agent = fakeAgent('session-1', project.session, ctx)
    const scope = new FakeScope([agent])
    runtime.attach(scope)
    await runtime.syncNow()

    expect(ctx.registered.has(SEARCH_TOOL_NAME)).toBe(true)
    // The tool acts on the session's activation state even when the assembly is
    // asked for while the scope is live.
    const search = searchToolOf(ctx)
    await search.execute({ query: 'alpha' }, undefined)

    await runtime.release('session-1')
    expect(ctx.registered.size).toBe(0)
    expect(ctx.listening('system-prompt/assemble')).toBe(0)

    // The session keeps what it activated across the release: the fresh scope
    // offers it again without another search.
    scope.emit('agent/status', { agent, status: 'running' })
    await runtime.syncNow()
    expect(ctx.registered.has(SEARCH_TOOL_NAME)).toBe(true)
    expect(names((await ctx.assemble()).tools)).toEqual(['mcp__alpha__tool'])

    await runtime.disposeAll()
  })

  it('reads the shipped defaults when the config object predates the feature', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const {
      activationEnabled: _enabled,
      activationSeeded: _seeded,
      activationMinCalls: _minCalls,
      toolIdleMs: _idleMs,
      ...legacy
    } = config()
    const runtime = runtimeForConfig(legacy)
    const ctx = new FakeAgentCtx()
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session, ctx)]))
    await runtime.syncNow()

    expect(DEFAULT_ACTIVATION_SEEDED).toBe(8)
    expect(DEFAULT_ACTIVATION_MIN_CALLS).toBe(5)
    expect(ctx.registered.has(SEARCH_TOOL_NAME)).toBe(true)

    await runtime.disposeAll()
  })

  it('offers a context match from the session’s own project', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const runtime = runtimeFor()
    const ctx = new FakeAgentCtx()
    const agent = fakeAgent('session-1', project.session, ctx)
    const scope = new FakeScope([agent])
    runtime.attach(scope)
    await runtime.syncNow()

    expect(names((await ctx.assemble()).tools)).toEqual([])

    ctx.emitSessionEvent({
      type: 'user/message',
      data: {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'please alpha the thing' }],
      },
    })
    expect(names((await ctx.assemble()).tools)).toEqual(['mcp__alpha__tool'])

    // A later step with the same task text offers the same set, and the
    // listener re-applies it to the list the inner listeners rebuilt.
    expect(names((await ctx.assemble()).tools)).toEqual(['mcp__alpha__tool'])

    await runtime.disposeAll()
  })

  it('resolves each session’s task text against its own project’s mounts', async () => {
    const first = makeProject({ alpha: { command: 'npx' } })
    const second = makeProject({ beta: { command: 'npx' } })
    const runtime = runtimeFor()
    const ctxA = new FakeAgentCtx()
    const ctxB = new FakeAgentCtx()
    const agentA = fakeAgent('session-a', first.session, ctxA)
    const agentB = fakeAgent('session-b', second.session, ctxB)
    runtime.attach(new FakeScope([agentA, agentB]))
    await runtime.syncNow()

    const asked = (text: string): { type: string; data: unknown } => ({
      type: 'user/message',
      data: {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text }],
      },
    })
    ctxA.emitSessionEvent(asked('please alpha the thing'))
    ctxB.emitSessionEvent(asked('please alpha the thing'))

    // Both sessions see the same task text, but each ranks only the tools its
    // own project mounted: the second project has no `alpha` server at all.
    expect(names((await ctxA.assemble()).tools)).toEqual(['mcp__alpha__tool'])
    expect(names((await ctxB.assemble()).tools)).toEqual([])

    await runtime.disposeAll()
  })

  it('offers a pinned tool from the first assembly and keeps it through compaction and the idle sweep', async () => {
    const project = makeProject({ alpha: { command: 'npx' }, beta: { command: 'npx' } })
    const store = new PolicyStore({ file: join(tmp(), 'policy.json'), flushMs: 60_000 })
    store.setPin(project.root, 'mcp__alpha__tool', true)
    // Budget `0` defers every surface, so the unpinned name really is hidden and
    // the pin has to survive the same gates an activated tool obeys.
    const runtime = runtimeFor({ activationToolBudgetChars: 0, toolIdleMs: 40 }, { policy: store })
    const ctx = new FakeAgentCtx()
    const agent = fakeAgent('session-1', project.session, ctx)
    const scope = new FakeScope([agent])
    runtime.attach(scope)
    await runtime.syncNow()

    // From the first assembly on, with no counter and no activation behind it.
    expect(names((await ctx.assemble()).tools)).toEqual(['mcp__alpha__tool'])
    const first = sessionTools(runtime, 'session-1')
    expect(first?.baseline).toEqual(['mcp__alpha__tool'])
    expect(first?.deferred).toEqual(['mcp__beta__tool'])
    expect(first?.deferring).toBe(true)

    // A compaction clears the session's activations and context offers; a pin is
    // project state, so it is offered on the step after it all the same.
    ctx.emitSessionEvent({ type: 'compaction/end' })
    expect(names((await ctx.assemble()).tools)).toEqual(['mcp__alpha__tool'])

    // The idle sweep drops session-activated tools; it cannot reach a pin.
    await sleep(60)
    scope.emit('agent/status', { agent, status: 'idle' })
    expect(names((await ctx.assemble()).tools)).toEqual(['mcp__alpha__tool'])
    const after = sessionTools(runtime, 'session-1')
    expect(after?.baseline).toEqual(['mcp__alpha__tool'])
    // Over budget, and the pinned name is still not part of what is hidden.
    expect(after?.deferred).toEqual(['mcp__beta__tool'])
    expect(after?.deferring).toBe(true)

    await runtime.disposeAll()
    store.dispose()
  })

  it('budgets the whole visible surface, not just this plugin\u2019s mounts', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const alphaSchema = tool('mcp__alpha__tool')
    const betaSchema = tool('mcp__beta__run')
    const mergedChars = surfaceChars([alphaSchema, betaSchema])

    // One above the merged surface: the listener hands the inner assembly back by
    // identity (nothing deferred, nothing trimmed).
    const fits = runtimeFor({ activationToolBudgetChars: mergedChars + 1 })
    const ctxFits = new FakeAgentCtx()
    ctxFits.extraSchemas.add('mcp__beta__run')
    fits.attach(new FakeScope([fakeAgent('session-1', project.session, ctxFits)]))
    await fits.syncNow()
    expect(await ctxFits.assemble()).toBe(ctxFits.lastInner)
    await fits.disposeAll()

    // One below: the profile-plane name is over budget, so it is deferred — the
    // assembly carries only the discovery tool until the search reaches it.
    const over = runtimeFor({ activationToolBudgetChars: mergedChars - 1 })
    const ctxOver = new FakeAgentCtx()
    ctxOver.extraSchemas.add('mcp__beta__run')
    over.attach(new FakeScope([fakeAgent('session-1', project.session, ctxOver)]))
    await over.syncNow()
    expect(names((await ctxOver.assemble()).tools)).toEqual([])

    const search = searchToolOf(ctxOver)
    const found = (await search.execute({ query: 'beta' }, undefined)) as SearchValue
    expect(found.activated).toEqual(['mcp__beta__run'])
    expect(names((await ctxOver.assemble()).tools)).toEqual(['mcp__beta__run'])
    await over.disposeAll()
  })

  it('keeps a cross-plane pin direct and shows it in the presentation row', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const store = new PolicyStore({ file: join(tmp(), 'policy.json'), flushMs: 60_000 })
    store.setPin(project.root, 'mcp__beta__run', true)
    const runtime = runtimeFor({ activationToolBudgetChars: 0 }, { policy: store })
    const ctx = new FakeAgentCtx()
    ctx.extraSchemas.add('mcp__beta__run')
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session, ctx)]))
    await runtime.syncNow()

    // A pin to a profile-plane name is offered from the first step, with no
    // counter and no activation behind it, and it is never the hidden tier.
    expect(names((await ctx.assemble()).tools)).toEqual(['mcp__beta__run'])
    const first = sessionTools(runtime, 'session-1')
    expect(first?.baseline).toEqual(['mcp__beta__run'])
    expect(first?.deferred).toEqual(['mcp__alpha__tool'])
    expect(first?.deferring).toBe(true)

    // A compaction clears the session's activations; a pin is project state, so
    // it is offered on the step after it all the same.
    ctx.emitSessionEvent({ type: 'compaction/end' })
    expect(names((await ctx.assemble()).tools)).toEqual(['mcp__beta__run'])

    await runtime.disposeAll()
    store.dispose()
  })

  it('publishes the project policy and stores a panel pin and mode change', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const store = new PolicyStore({ file: join(tmp(), 'policy.json'), flushMs: 60_000 })
    const runtime = runtimeFor({}, { policy: store })
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session, new FakeAgentCtx())]))
    await runtime.syncNow()

    // Every project in a snapshot carries a policy, defaulted when the user never
    // touched one: the absent field is meant for a host without the store.
    expect(runtime.snapshot().projects[0]?.policy).toEqual(DEFAULT_TOOL_POLICY)

    expect(
      runtime.setPin({ projectRoot: project.root, tool: 'mcp__alpha__tool', pinned: true }).ok,
    ).toBe(true)
    expect(runtime.snapshot().projects[0]?.policy).toEqual({
      mode: 'disclosure',
      pins: ['mcp__alpha__tool'],
    })

    expect(runtime.setPolicy({ projectRoot: project.root, mode: 'off' }).ok).toBe(true)
    expect(runtime.snapshot().projects[0]?.policy).toEqual({
      mode: 'off',
      pins: ['mcp__alpha__tool'],
    })

    // A project this host has no session in is refused, and nothing is stored
    // under it; a mode no assembly knows is refused as well, without touching the
    // mode already in force. The request type forbids the last case, so a body
    // that lies about it is cast — that is exactly the untrusted route path.
    expect(
      runtime.setPin({ projectRoot: '/tmp/gone', tool: 'mcp__alpha__tool', pinned: true }),
    ).toMatchObject({ ok: false, code: 'not-found' })
    expect(store.forProject('/tmp/gone')).toEqual(DEFAULT_TOOL_POLICY)
    expect(
      runtime.setPolicy({ projectRoot: project.root, mode: 'sometimes' as unknown as ToolMode }),
    ).toMatchObject({ ok: false, code: 'invalid' })
    expect(store.forProject(project.root)).toEqual({ mode: 'off', pins: ['mcp__alpha__tool'] })

    await runtime.disposeAll()
    store.dispose()
  })

  it('applies a stored mode to the next assembly without re-minting the scope', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const store = new PolicyStore({ file: join(tmp(), 'policy.json'), flushMs: 60_000 })
    const runtime = runtimeFor({ activationToolBudgetChars: 0 }, { policy: store })
    const ctx = new FakeAgentCtx()
    const agent = fakeAgent('session-1', project.session, ctx)
    runtime.attach(new FakeScope([agent]))
    await runtime.syncNow()

    // Disclosure over its budget: the listener re-adds the discovery tool.
    const before = await ctx.assemble()
    expect(before).not.toBe(ctx.lastInner)
    expect(before.tools.map((schema) => schema.name)).toEqual([SEARCH_TOOL_NAME])

    // The scope the listener lives in is never re-minted: the next assembly of
    // the same context already sees the stored mode.
    runtime.setPolicy({ projectRoot: project.root, mode: 'direct' })
    expect(await ctx.assemble()).toBe(ctx.lastInner)

    runtime.setPolicy({ projectRoot: project.root, mode: 'off' })
    expect(await ctx.assemble()).toBe(ctx.lastInner)
    expect(ctx.listening('system-prompt/assemble')).toBe(1)

    await runtime.disposeAll()
    store.dispose()
  })
})
