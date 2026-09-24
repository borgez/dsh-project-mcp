/**
 * Reproduction: per-project MCP tool isolation under a preset-composed session.
 *
 * Real primitives throughout, following `tests/bridge.spec.ts`: a real
 * `Context`, the real `ScopedLayers` / `NamedEntries` scope store the harness
 * `ToolRuntime` is built on, the real `createScope` / `bindScopeParent`, and the
 * plugin's real `ProjectMcpRuntime` driven through its real pass — real scopes
 * (`RuntimeOptions.createScope`), a real registry (`RuntimeOptions.registry`),
 * and the real bridge (`bridgeContext` unset, so the default path is what runs).
 *
 * The one thing this file injects is the preset roster's own bind: every agent
 * composed from a preset is parented to the preset's STANDING scope key before
 * it is published (`agent-presets/src/index.ts`, `mount()`:
 * `this.bindings.set(agentKey, bindScopeParent(agentKey, standing.key))`), and
 * that standing key is shared by every agent composed from the same preset id.
 * That is exactly the precondition `src/runtime.ts` `holdProject` documents as
 * the reason a bridged session exists at all.
 *
 * @module tests/isolation
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { NamedEntries, ScopedLayers, bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { afterEach, describe, expect, it } from 'vitest'
import type { ForwardableDefinition } from '../src/bridge.ts'
import { PolicyStore } from '../src/policy.ts'
import { ProjectMcpRuntime, type AgentLike, type AgentScopeLike, type RuntimeConfig } from '../src/runtime.ts'

// ---- A real registry over the harness's real scope store -------------------

/** One scope's aggregate layer, as `ScopedLayers` requires it. */
interface Layer {
  readonly tools: NamedEntries<ForwardableDefinition>
  isEmpty(): boolean
}

/**
 * Minimal stand-in for `ctx.tools`, built on the harness's real scoped store.
 *
 * Visibility, shadowing, inheritance and disposal come from `ScopedLayers` +
 * `NamedEntries`; only the four method envelopes are local, as
 * `tests/bridge.spec.ts` narrows them. This is the surface the plugin consumes
 * (`bridgeRegistry()` reads `tools.get` / `tools.schemas`, and a server
 * registers through the scope context it was mounted into).
 */
class ToolFacade extends Service {
  private readonly store: ScopedLayers<Layer>

  constructor(ctx: Context) {
    super(ctx, 'tools')
    this.store = new ScopedLayers(
      () => {
        const tools = new NamedEntries<ForwardableDefinition>(name => new Error(`duplicate tool "${name}"`))
        return { tools, isEmpty: () => tools.isEmpty() }
      },
      () => undefined,
    )
  }

  /**
   * Register a definition in the calling scope's layer.
   * @param definition - schema plus execution to retain.
   * @returns the exact disposer that removes it.
   */
  register(definition: unknown): () => void {
    const tool = definition as ForwardableDefinition
    return this.store.effect(this.ctx, layer => layer.tools.insert(tool.name, tool), {
      label: 'tools.register()',
    })
  }

  /**
   * Resolve a name as one scope sees it.
   * @param name - registered tool name.
   * @param scope - viewing scope key, or undefined for the global view.
   * @returns the visible definition, or undefined.
   */
  get(name: string, scope?: object): ForwardableDefinition | undefined {
    return this.store.merge(scope as ScopeKey, layer => layer.tools).get(name)
  }

  /**
   * Schemas one scope resolves: the global layer first, then the scope chain,
   * nearest scope last.
   * @param scope - viewing scope key, or undefined for the global view.
   * @returns one model-facing schema per visible tool.
   */
  schemas(scope?: object): { name: string; description: string; parameters: Record<string, unknown> }[] {
    return [...this.store.merge(scope as ScopeKey, layer => layer.tools).values()].map(definition => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    }))
  }

  /**
   * The names one scope resolves, in registry order.
   * @param scope - viewing scope key, or undefined for the global view.
   * @returns the visible names, nearest scope last.
   */
  namesIn(scope?: object): string[] {
    return [...this.store.merge(scope as ScopeKey, layer => layer.tools).keys()]
  }

  /** Every `mcp__*` name one scope resolves. */
  mcpNamesIn(scope?: object): string[] {
    return this.namesIn(scope).filter(name => name.startsWith('mcp__'))
  }
}

/** Cordis plugin publishing the registry into a fresh root context. */
const provideTools = {
  name: 'isolation-spec-tools',
  apply: (ctx: Context): void => {
    void new ToolFacade(ctx)
  },
}

// ---- Fixtures --------------------------------------------------------------

const created: string[] = []
/** Durable policy stores this suite opened, disposed with the temp dirs. */
const policyStores: PolicyStore[] = []

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'project-mcp-isolation-'))
  created.push(dir)
  return dir
}

/** One project with a `.dsh/mcp.json` declaring exactly one server. */
function makeProject(serverName: string): { root: string; session: string } {
  const root = tmp()
  mkdirSync(join(root, '.dsh'), { recursive: true })
  mkdirSync(join(root, 'src', 'nested'), { recursive: true })
  writeFileSync(
    join(root, '.dsh', 'mcp.json'),
    JSON.stringify({ mcpServers: { [serverName]: { command: 'npx', args: ['-y', serverName] } } }),
  )
  return { root, session: join(root, 'src', 'nested') }
}

/** One tool definition shaped like the one `dsh-mcp-client` registers. */
function serverDefinition(serverName: string): ForwardableDefinition {
  return {
    name: `mcp__${serverName}__tool`,
    description: `${serverName} tool`,
    parameters: {},
    output: { schema: {}, render: () => [] },
    execute: async () => ({ server: serverName }),
  }
}

/**
 * The server double: a real Cordis plugin, plugged into the project's scope the
 * way `mcp-client` is, registering through that scope's context — so the entry
 * lands in the project scope's own layer of the real store.
 */
const fakeMcpClient = {
  name: 'isolation-spec-mcp',
  inject: ['tools'],
  apply(ctx: Context, config: { serverName: string }): void {
    const tools = (ctx as unknown as { get(name: string): unknown }).get('tools') as ToolFacade
    tools.register(serverDefinition(config.serverName))
  },
}

/** Resolved configuration, as `tests/runtime.spec.ts` builds it. */
function config(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    localFiles: ['.dsh/mcp.json'],
    globalFiles: [],
    inputs: {},
    projectMarkers: ['.git', '.dsh', 'package.json'],
    fileMarkers: ['.sln', '.slnx', '.csproj'],
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
    connectTimeoutMs: 5_000,
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

/** The host's agent service, as the runtime consumes it. */
class FakeHostScope implements AgentScopeLike {
  private readonly handlers = new Map<string, ((event: never, next: () => Promise<unknown>) => unknown)[]>()

  constructor(private readonly agents_: AgentLike[]) {}

  get agents() {
    return { list: () => [...this.agents_] }
  }

  on(name: string, handler: (event: never, next: () => Promise<unknown>) => unknown): () => void {
    const list = this.handlers.get(name) ?? []
    list.push(handler)
    this.handlers.set(name, list)
    return () => undefined
  }

  effect(): () => void {
    return () => undefined
  }
}

/** The runtime plus the readers a test asserts through. */
interface Wired {
  readonly runtime: ProjectMcpRuntime
  readonly tools: ToolFacade
  /** The real scoped context an agent's own key resolves through. */
  contextFor(key: object): Context
  /** Every `mcp__*` name one scope key resolves. */
  namesFor(key: object): string[]
}

/**
 * Wire the real runtime over the real registry and real scopes.
 *
 * Each agent's own key gets its real scoped context up front, in the order the
 * harness uses: the agent's scope is minted under the agent itself, and the
 * preset roster then binds that same key to the standing key — after which the
 * key can never be parented to anything else.
 * @param agents - the preset-composed agents' scope keys, already bound.
 * @returns the runtime and the readers a test asserts through.
 */
async function wire(agents: readonly object[]): Promise<Wired> {
  const root = new Context()
  await root.plugin(provideTools)
  const tools = (root as unknown as { tools: ToolFacade }).tools
  // The composition the plugin itself sees: a context that resolves the
  // registry without an `inject` declaration, which is what the runtime mints
  // its scopes from (`createScope(this.ctx, key)`).
  const hostCtx = root.extend({})
  const contexts = new Map<object, Context>()
  const store = new PolicyStore({ file: join(tmp(), 'policy.json'), flushMs: 60_000 })
  policyStores.push(store)
  const runtime = new ProjectMcpRuntime(root, config(), {
    plugin: fakeMcpClient,
    createScope: (_ctx, key) => {
      const existing = contexts.get(key as object)
      if (existing !== undefined) return { ctx: existing, dispose: async () => undefined }
      const scope = createScope(hostCtx, key as ScopeKey)
      contexts.set(key as object, scope.ctx)
      return scope
    },
    registry: {
      get: (name, scope) => tools.get(name, scope),
      schemas: scope => tools.schemas(scope),
    },
    policy: store,
  })
  for (const agent of agents) {
    const scope = createScope(hostCtx, agent as ScopeKey)
    contexts.set(agent, scope.ctx)
  }
  return {
    runtime,
    tools,
    contextFor: key => {
      const ctx = contexts.get(key)
      if (ctx === undefined) throw new Error('no scope context was minted for that key')
      return ctx
    },
    namesFor: key => tools.mcpNamesIn(key),
  }
}

afterEach(() => {
  for (const store of policyStores.splice(0)) store.dispose()
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('project isolation under a preset-composed session', () => {
  it.fails("session A and session B see disjoint mcp__* namespaces, each its own project's", async () => {
    const projectA = makeProject('alpha')
    const projectB = makeProject('beta')

    // Two preset-composed sessions. The agent IS its scope key
    // (`agent-loop/src/agent.ts`: `createScope(loopCtx, this)`).
    const a = { id: 'session-a', session: { header: { cwd: projectA.session } }, ctx: undefined as never }
    const b = { id: 'session-b', session: { header: { cwd: projectB.session } }, ctx: undefined as never }
    const { runtime, contextFor, namesFor } = await wire([a, b])
    for (const agent of [a, b]) {
      ;(agent as unknown as { ctx: Context }).ctx = contextFor(agent)
    }

    // INJECTED ASSUMPTION — the one fact this file adds to the runtime's own
    // path: session B's scope key arrives already bound, to session A's key, so
    // B's resolution walks through A's own layer. `agent-presets` creates
    // exactly this relation: the first agent composed from a preset id becomes
    // that preset's standing mount key (`mount.ts` line 405,
    // `mounts.add({ …, key: scopeOf(agentCtx) })`) and every later agent is
    // bound to that key (`index.ts` line 454,
    // `bindScopeParent(agentKey, standing.key)`), while A is instead bound to
    // the preset's own standing key. Everything else below is the runtime's
    // real path: real scopes, real registry, real `linkScopeParent`, real
    // bridge, real pass.
    //
    // On the current code the split is: A links to its project (the ordinary
    // path, `parentLinked`), and B — already parented — cannot link and takes
    // the bridge. The bridge then registers B's forwarders into the layer of
    // B's agent key, which is the layer every later session of that preset
    // resolves THROUGH. So a session's own layer is not private, and A's
    // project tools appear in B's catalog.
    const standingKey: ScopeKey = { agentPreset: 'main' }
    bindScopeParent(a as unknown as ScopeKey, standingKey)
    bindScopeParent(b as unknown as ScopeKey, a as unknown as ScopeKey)

    // Session A passes alone first, so A's project is the one the runtime links
    // and mounts (the ordinary, unbridged path).
    runtime.attach(new FakeHostScope([a] as unknown as AgentLike[]))
    await runtime.syncNow()
    await settle(() => namesFor(a).includes('mcp__alpha__tool'))

    // Session B joins under its own cwd.
    runtime.attach(new FakeHostScope([a, b] as unknown as AgentLike[]))
    await runtime.syncNow()
    await settle(() => namesFor(b).includes('mcp__beta__tool'))

    const namesA = namesFor(a)
    const namesB = namesFor(b)
    // The observed namespaces of this reproduction, for a human reading the
    // failure: session A => ['alpha'], session B => ['alpha', 'beta'].
    const namespaces = (names: readonly string[]): string[] => [
      ...new Set(names.map(name => name.split('__')[1] ?? name)),
    ].sort()
    // Each session resolves its own project's namespace…
    expect(namespaces(namesA)).toContain('alpha')
    expect(namespaces(namesB)).toContain('beta')
    // …and the invariant: neither session resolves the other project's tools.
    // FALSE while the host defect stands — B resolves A's project through A's
    // own layer. `it.fails` encodes exactly that: the case passes while the
    // invariant is broken and turns red the moment a host fix lands, which is
    // the signal to flip it back to `it`. A plugin-side attempt to fix it from
    // inside was tried and rejected: minting the session's own layer under a
    // private key made the session blind to its OWN project's tools, because the
    // preset roster has already bound the agent key, so nothing can link that
    // private key into the session's chain. See the F-42 row in docs/features.md.
    expect(namesA.filter(name => namesB.includes(name))).toEqual([])
  })
})

/** Wait for a condition, bounded, so a watched activation cannot stall the test. */
async function settle(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (ready()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
