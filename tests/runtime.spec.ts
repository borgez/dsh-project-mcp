import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { bindScopeParent } from '@deepseek-ai/dsh-scope'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SEARCH_TOOL_NAME } from '../src/activation.ts'
import { PolicyStore } from '../src/policy.ts'
import type { AssembleListener, ListenerLike, ToolDefinitionLike, ToolSchemaLike } from '../src/activation.ts'
import { defaultCredentialsPath } from '../src/discovery.ts'
import { FORWARDED_TO } from '../src/bridge.ts'
import { LOG_PAGE_SIZE, clear as clearLogs, latest, record as recordLog } from '../src/logs.ts'
import { en as hostEn } from '../src/client/locales/host.ts'
import {
  ProjectMcpRuntime,
  type AgentEventLike,
  type AgentLike,
  type AgentScopeLike,
  type RuntimeConfig,
} from '../src/runtime.ts'
import type { ConflictChoice } from '../src/types.ts'
import { documentRevision } from '../src/write.ts'
import { chainSchemas, fakeScopes } from './helpers/scopes.ts'
import type { FakeScopes } from './helpers/scopes.ts'

const created: string[] = []
/** Durable policy stores this suite opened, disposed with the temp dirs. */
const policyStores: PolicyStore[] = []

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'project-mcp-'))
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

function rewrite(root: string, servers: Record<string, unknown>): void {
  writeFileSync(join(root, '.dsh', 'mcp.json'), JSON.stringify({ mcpServers: servers }))
}

interface FakeMount {
  name: string
  config: Record<string, unknown>
  disposed: boolean
}

/**
 * Stands in for an agent-scoped Cordis context: mounts fake mcp-client fibers.
 *
 * `schemas()` lists every tool visible in this scope the way the real registry
 * does: the names the fake servers publish plus the definitions the plugin
 * registers here (its discovery tool). Only the server-published names can be
 * mount candidates, because the plugin probes them by mounted server prefix.
 */
class FakeAgentCtx {
  readonly names = new Set<string>()
  readonly mounts: FakeMount[] = []
  /** Whether this scope was disposed, as a real scope is unwound. */
  disposed = false
  /**
   * Forces the next activation in this scope to fail, the way a server that
   * exits on startup does — an operator fixes it outside the plugin, so a test
   * can clear this and retry without touching the document.
   */
  activationError: string | undefined = undefined
  /** Definitions registered in this scope, such as the discovery tool. */
  readonly definitions = new Map<string, ToolDefinitionLike>()
  /**
   * Definitions the forwarding bridge registered in this scope's layer. Each
   * carries the project definition it delegates to under `FORWARDED_TO`,
   * exactly as `src/bridge.ts` resolves it in production.
   */
  readonly forwarded = new Map<string, { definition: ToolDefinitionLike }>()
  /** Event listeners this scope installed, keyed by event name. */
  readonly listeners = new Map<string, ListenerLike[]>()
  /**
   * Every definition this scope's own layer holds: its published names, its own
   * registrations (the discovery tool), and the bridge's forwarders. The
   * registry resolves a scope by merging these, so the double hands out
   * definitions, never schemas — the schema projection belongs to `schemas`.
   */
  ownDefinitions(): ToolDefinitionLike[] {
    return [
      ...[...this.definitions.values()],
      ...[...this.forwarded.values()].map(({ definition }) => definition),
    ]
  }

  /**
   * Announced by the runtime under test on every registration change, wherever
   * it happened: `tools/change` is a registry-wide notification, so a scope's
   * listeners hear a change another scope's server made. The bridge's
   * session-scope subscription rides exactly that.
   */
  onChange: (() => void) | undefined

  /**
   * Insert one definition into this scope's own layer, exactly as the harness
   * registry does.
   *
   * The two facts the bridge depends on live here: a name already present in
   * the layer throws (`NamedEntries.insert` on the harness side, which is what
   * makes a second batch over a live one impossible), and the change is
   * announced (`tools/change`) only **after** the entry is in — the registry
   * emits from inside its registration effect, so a listener that re-enters the
   * sync sees the entry it was told about rather than the previous state. The
   * bridge writes its forwarders through this same entry point, so they are told
   * apart by the marker `src/bridge.ts` sets and kept where the registry lookup
   * finds them.
   * @param definition - the definition to retain.
   * @param forwarded - whether this is one of the bridge's thin definitions.
   * @returns the exact releaser, which announces the removal too.
   */
  private insert(definition: ToolDefinitionLike, forwarded: boolean): () => void {
    const name = definition.name
    if (forwarded) {
      if (this.forwarded.has(name)) throw new Error(`duplicate tool "${name}"`)
      const record = { definition }
      this.forwarded.set(name, record)
      this.onChange?.()
      return () => {
        if (this.forwarded.get(name) !== record) return
        this.forwarded.delete(name)
        this.onChange?.()
      }
    }
    if (this.definitions.has(name)) throw new Error(`duplicate tool "${name}"`)
    this.definitions.set(name, definition)
    this.onChange?.()
    return () => {
      if (this.definitions.get(name) !== definition) return
      this.definitions.delete(name)
      this.onChange?.()
    }
  }

  readonly tools = {
    register: (definition: ToolDefinitionLike): (() => void) =>
      this.insert(definition, (definition as unknown as Record<symbol, unknown>)[FORWARDED_TO] !== undefined),
    schemas: (): ToolSchemaLike[] => this.ownDefinitions(),
  }

  /**
   * Subscribe as a scope context does. `tools/change` is dispatched unfiltered
   * by the registry, so the scope's own layer receives it.
   */
  onEvent(name: string, listener: ListenerLike): () => void {
    const list = this.listeners.get(name) ?? []
    list.push(listener)
    this.listeners.set(name, list)
    return () => undefined
  }

  /**
   * Effects registered on this context, as cordis owns them. The runtime
   * registers one per live session, so a double without this cannot receive an
   * `agent/created` event.
   */
  readonly effects: (() => unknown)[] = []

  effect(fn: () => unknown): () => void {
    this.effects.push(fn)
    return () => undefined
  }

  /** Scope subscription, as the plugin's activation wiring installs it. */
  on(name: string, listener: ListenerLike): () => void {
    const list = this.listeners.get(name) ?? []
    list.push(listener)
    this.listeners.set(name, list)
    return () => undefined
  }

  /**
   * Whether this scope declared the `tools` service, as a scoped plugin must
   * before it reads `ctx.tools` (Cordis throws on an undeclared dot-read).
   */
  toolsInjected = false
  /** Mark the `tools` service as declared for this scope's subsequent plugins. */
  inject(names: string[]): void {
    if (names.includes('tools')) this.toolsInjected = true
  }

  /** Resolve one service as a scope context does: only what the scope injects. */
  get(name: string): unknown {
    if (name !== 'tools' || !this.toolsInjected) return undefined
    return this.tools
  }

  /** Run one registered definition the way the registry would. */
  async callTool(name: string, args: unknown): Promise<unknown> {
    const forwarded = this.forwarded.get(name)
    const definition = forwarded?.definition ?? this.definitions.get(name)
    if (definition === undefined) throw new Error(`${name} is not registered in this scope`)
    return await definition.execute(args, undefined)
  }

  plugin(_plugin: unknown, config: { serverName: string; command?: string }): unknown {
    const record: FakeMount = {
      name: config.serverName,
      config: config as unknown as Record<string, unknown>,
      disposed: false,
    }
    this.mounts.push(record)
    const names = this.names
    /** Exact releasers of the definitions this instance published, in order. */
    const published: (() => void)[] = []
    return {
      await: async () => {
        if (this.activationError !== undefined) throw new Error(this.activationError)
        if (config.command === 'explode') throw new Error('boom')
        const name = `mcp__${config.serverName}__tool`
        names.add(name)
        // The real mcp-client registers a definition, not a bare name, and the
        // registry hands a caller the definition it would execute. The bridge in
        // particular reads that definition and forwards its surface, so the
        // double has to publish one for a forwarding test to mean anything.
        // It goes in through the registry's own entry point, so the publication
        // announces itself (`tools/change`) exactly as it does in production —
        // the signal a bridged session's subscription lives on.
        published.push(this.insert({
          name,
          description: `${config.serverName} tool`,
          parameters: {},
          output: { schema: {}, render: () => [] },
          execute: async () => ({ server: config.serverName }),
        }, false))
      },
      dispose: async () => {
        record.disposed = true
        for (const release of published.reverse()) release()
        published.length = 0
        for (const name of [...names]) {
          if (name.startsWith(`mcp__${config.serverName}__`)) names.delete(name)
        }
      },
    }
  }

  /**
   * Scope disposal: every mount, name, definition and listener this double owns
   * goes away at once, exactly as unwinding a Cordis scope does.
   */
  async disposeAll(): Promise<void> {
    this.disposed = true
    for (const mount of this.mounts) mount.disposed = true
    this.names.clear()
    this.definitions.clear()
    this.forwarded.clear()
    this.listeners.clear()
  }
}

type ScopeHandler = (event: AgentEventLike, next: () => Promise<unknown>) => unknown

class FakeScope implements AgentScopeLike {
  private readonly handlers = new Map<string, ScopeHandler[]>()
  readonly effects: (() => unknown)[] = []

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
    this.effects.push(fn)
    return () => undefined
  }

  emit(name: string, payload: AgentEventLike): void {
    for (const handler of this.handlers.get(name) ?? []) {
      void handler(payload, async () => undefined)
    }
  }

  /**
   * Await one step the way the agent loop does: every `agent/pre-step` handler
   * runs to completion before the continuation, so the runtime's own
   * bookkeeping for the step is done by the time this returns.
   */
  async step(agent: AgentLike): Promise<void> {
    await this.dispatch('agent/pre-step', { agent }, async () => undefined)
  }

  /** Awaited waterfall call, as `dispatch.waterfall` delivers a hook. */
  async dispatch(
    name: string,
    payload: AgentEventLike,
    next: () => Promise<unknown>,
  ): Promise<void> {
    for (const handler of this.handlers.get(name) ?? []) await handler(payload, next)
  }
}

/**
 * One runtime wired to fake hosts: the scope doubles it mints, the tool catalog
 * a session resolves through them, and a logger the test can read.
 */
/**
 * One loader entry as the profile publishes it: the module it mounts, and the
 * fiber state that says whether that module is running.
 */
interface LoaderEntryStub {
  options: { name: string; id?: string; disabled?: boolean; config?: { serverName?: string } }
  fiber?: { state: number }
}

function harness(
  reserved: string[] = [],
  overrides: Partial<RuntimeConfig> = {},
  extraEntries: LoaderEntryStub[] = [],
) {
  /**
   * Activation failure armed for the project scopes this runtime mints next. A
   * project scope is minted with the pass that mounts, so a test that wants the
   * mount to fail cannot reach the double before the pass has created it.
   */
  const armed: { error: string | undefined } = { error: undefined }
  /** Every double this runtime minted, so a `tools/change` reaches them all. */
  const minted: FakeAgentCtx[] = []
  /**
   * How many `tools/change` announcements the doubles carried. The runtime's
   * bridge rides this event, so a test can tell a sync that rebuilt its batch
   * from one that found it level.
   */
  const changes = { count: 0 }
  const onChange = (): void => {
    changes.count += 1
    for (const double of minted) {
      for (const listener of double.listeners.get('tools/change') ?? []) void listener()
    }
  }
  const scopes = fakeScopes<FakeAgentCtx>(
    () => {
      const ctx = new FakeAgentCtx()
      ctx.activationError = armed.error
      ctx.onChange = onChange
      minted.push(ctx)
      return ctx
    },
    (key) => {
      const ctx = (key as AgentLike).ctx as unknown as FakeAgentCtx
      if (ctx !== undefined) minted.push(ctx)
      return ctx
    },
    (ctx) => ctx.disposeAll(),
  )
  const warnings: string[] = []
  const schemasCalls = { count: 0 }
  /** The double one scope key resolves to, as the runtime registers by key. */
  const doubleOf = (key: object): FakeAgentCtx => key as unknown as FakeAgentCtx
  /** The double one project's scope resolves to, minted with its first mount. */
  const projectDouble = (projectRoot: string): FakeAgentCtx => {
    const double = scopes.forProject(projectRoot)
    if (double === undefined) throw new Error(`no project scope was minted for ${projectRoot}`)
    return double
  }
  /**
   * The registry's own view of any scope the runtime probes: the scope's chain,
   * farthest ancestor first, the exact scope's own layer last, exactly as
   * `ScopedLayers.merge` builds it. Values are full definitions — `get` hands a
   * caller the definition it would execute, and only `schemas` projects one onto
   * the model-facing three fields.
   */
  const viewOf = (key: object | undefined): Map<string, ToolDefinitionLike> => {
    const merged = new Map<string, ToolDefinitionLike>()
    if (key === undefined) return merged
    for (const double of scopes.chainOf(key)) {
      for (const definition of double.ownDefinitions()) merged.set(definition.name, definition)
    }
    return merged
  }
  const registry = {
    get: (name: string, scope?: object) => viewOf(scope as object | undefined).get(name),
    schemas: (scope?: object) => [...viewOf(scope as object | undefined).values()].map((definition) => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    })),
  }
  const host = {
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (message: string) => warnings.push(message),
    },
    // The session catalog, resolved as the registry resolves it. The runtime
    // reads it through the session's HOME scope key (`src/runtime.ts`,
    // `mountedSchemas`), which is the project's key for every session — the
    // agent's key when it is its own home no longer exists.
    tools: {
      schemas: (key: object) => {
        schemasCalls.count += 1
        return [...viewOf(key).values()].map((definition) => ({
          name: definition.name,
          description: definition.description,
          parameters: definition.parameters,
        }))
      },
    },
    get: (name: string) =>
      name === 'loader'
        ? {
            entries: () => [
              ...reserved.map((serverName) => ({
                options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName } },
                fiber: { state: 2 },
              })),
              ...extraEntries,
            ],
          }
        : undefined,
  }
  // A real store on a throwaway document: the choice tests need the durable
  // path, and the rest of the suite never looks at it.
  const store = new PolicyStore({ file: join(tmp(), 'policy.json'), flushMs: 60_000 })
  policyStores.push(store)
  const runtime = new ProjectMcpRuntime(host as unknown as Context, config(overrides), {
    // The double stands in for the real mcp-client: its fiber is what the
    // runtime's mount starts, so its `apply` is where a scope declares the
    // service its registrations go through.
    plugin: {
      name: 'fake-mcp',
      inject: ['tools'],
      apply: (ctx: unknown) => {
        (ctx as FakeAgentCtx).inject(['tools'])
      },
    },
    createScope: scopes.createScope,
    registry: registry as never,
    policy: store,
    bridgeContext: (scope) => ({
      get: (name: string) => (name === 'tools' ? doubleOf((scope as { ctx: object }).ctx).tools : undefined),
    }) as never,
  })
  /**
   * Arm `error` for the project scopes this runtime has minted and will mint.
   *
   * A project scope is created by the pass that mounts, so a test cannot reach
   * its double before the first mount — this is how it primes one. The double
   * keeps the armed failure until the test clears it again, exactly as the
   * original session-scoped double did: the server is fixed outside the plugin.
   */
  const armActivationFailure = (error: string | undefined): void => {
    armed.error = error
    for (const double of minted) double.activationError = error
  }
  return { runtime, scopes, warnings, schemasCalls, changes, projectDouble, armActivationFailure, store }
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

function fakeAgent(id: string, cwd: string): { agent: AgentLike; ctx: FakeAgentCtx } {
  const ctx = new FakeAgentCtx()
  return {
    ctx,
    agent: {
      id,
      session: { header: { cwd } },
      ctx: ctx as unknown as Context,
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Poll until `probe` holds. A mount's activation settles behind the pass that
 * registered it, so a test that reads the outcome waits for it rather than
 * assuming the pass returned with it.
 */
async function waitFor(probe: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!probe() && Date.now() < deadline) await sleep(5)
}

/** The scope double a project's servers are registered in. */
function projectScope(scopes: FakeScopes<FakeAgentCtx>, projectRoot: string): FakeAgentCtx {
  const scope = scopes.forProject(projectRoot)
  if (scope === undefined) throw new Error(`no project scope was minted for ${projectRoot}`)
  return scope
}

/**
 * Every tool name one session actually resolves, as the registry resolves it:
 * the chain the runtime linked, plus the session's own layer — where the bridge
 * puts the forwarders when that chain does not carry the project's tools.
 */
function sessionNames(scopes: FakeScopes<FakeAgentCtx>, agent: AgentLike): string[] {
  const own = [...(scopes.doubleOf(agent)?.forwarded.values() ?? [])].map(({ definition }) => definition.name)
  const seen = new Set(own)
  const merged = [...own]
  for (const schema of chainSchemas(scopes.chainOf(agent), (ctx) => [...ctx.names].map((name) => ({ name })))) {
    if (seen.has(schema.name)) continue
    seen.add(schema.name)
    merged.push(schema.name)
  }
  return merged
}

/**
 * Drive one session's assembly wiring over a leaked inner catalog: whatever the
 * runtime's own assemble listener returns for a hand-built tool list. The host
 * defect is that the harness assembles another project's tools into a session's
 * request, so a test feeds both projects' names in and reads what containment
 * lets through.
 */
async function assemble(ctx: FakeAgentCtx, inner: ToolSchemaLike[]): Promise<ToolSchemaLike[]> {
  const listener = ctx.listeners.get('system-prompt/assemble')?.[0] as unknown as AssembleListener | undefined
  if (listener === undefined) return [...inner]
  const result = await listener({ tools: [...inner] }, {}, async () => ({ tools: [...inner] }))
  return result.tools
}

afterEach(() => {
  for (const store of policyStores.splice(0)) store.dispose()
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('ProjectMcpRuntime', () => {
  it('mounts a project document on the project scope and skips profile-reserved names', async () => {
    const project = makeProject({
      alpha: { command: 'npx', args: ['-y', 'alpha'] },
      beta: { url: 'http://127.0.0.1:1/mcp' },
    })
    const { runtime, scopes } = harness(['beta'])
    const { agent, ctx } = fakeAgent('session-1', project.session)
    runtime.attach(new FakeScope([agent]))

    await runtime.syncNow()

    // One instance for the project: the shared scope is where the mount lives,
    // and the session resolves its tool through the chain the runtime linked.
    const shared = projectScope(scopes, project.root)
    expect(shared.mounts.map((mount) => mount.name)).toEqual(['alpha'])
    expect(shared.mounts[0]?.config).toMatchObject({
      transport: 'stdio',
      serverName: 'alpha',
      cwd: project.root,
    })
    expect([...shared.names]).toEqual(['mcp__alpha__tool'])
    expect(sessionNames(scopes, agent)).toEqual(['mcp__alpha__tool'])

    const snapshot = runtime.snapshot()
    expect(snapshot.ready).toBe(true)
    expect(snapshot.projects).toHaveLength(1)
    expect(snapshot.projects[0]?.projectRoot).toBe(project.root)
    expect(snapshot.projects[0]?.sessionIds).toEqual(['session-1'])
    expect(snapshot.projects[0]?.rows.map((row) => [row.name, row.status])).toEqual([
      ['alpha', 'active'],
      ['beta', 'conflict'],
    ])
  })

  it('forwards the project shared instance into a session whose key the harness already parented', async () => {
    const project = makeProject({
      alpha: { command: 'npx', args: ['-y', 'alpha'] },
      beta: { url: 'http://127.0.0.1:1/mcp' },
    })
    const { runtime, scopes } = harness(['beta'])
    const { agent } = fakeAgent('session-1', project.session)
    // What the agent-preset roster does before an agent is published: the scope
    // key is already parented to its preset's standing scope, and `dsh-scope`
    // binds a key once, so the runtime's project link cannot succeed here.
    bindScopeParent(agent, { agentPreset: 'standard' })

    runtime.attach(new FakeScope([agent]))
    await runtime.syncNow()

    // The declaration runs ONCE, in the project's shared scope, even though this
    // session could not join that scope's chain; the session resolves the same
    // instance through the forwarding bridge in its own layer. Before F-19 this
    // was a second instance under the session's scope, one child process per
    // session of the whole web GUI.
    const shared = projectScope(scopes, project.root)
    expect(shared.mounts.map((mount) => mount.name)).toEqual(['alpha'])
    expect(scopes.projects).toHaveLength(1)
    // The session's layer holds the thin definition, and it delegates to the
    // project's own — never to a second instance.
    expect([...shared.forwarded.keys()]).toEqual([])
    const forwarded = scopes.doubleOf(agent)?.forwarded.get('mcp__alpha__tool')?.definition
    expect(forwarded).toBeDefined()
    expect(forwarded).not.toBe(shared.definitions.get('mcp__alpha__tool'))
    expect((forwarded as unknown as Record<symbol, unknown>)[FORWARDED_TO]).toBe(shared.definitions.get('mcp__alpha__tool'))
    expect(sessionNames(scopes, agent)).toEqual(['mcp__alpha__tool'])
    expect(runtime.snapshot().projects[0]?.rows.map((row) => [row.name, row.status])).toEqual([
      ['alpha', 'active'],
      ['beta', 'conflict'],
    ])
  })

  it('shares one forwarded instance between two preset-shaped sessions of one project', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime, scopes } = harness()
    const first = fakeAgent('session-1', project.session)
    const second = fakeAgent('session-2', project.session)
    // Both keys were parented by the preset roster before either session was
    // published, which is exactly the web-GUI shape: neither can join the
    // project's chain, and both must still run the project's one instance.
    bindScopeParent(first.agent, { agentPreset: 'standard' })
    bindScopeParent(second.agent, { agentPreset: 'standard' })

    runtime.attach(new FakeScope([first.agent, second.agent]))
    await runtime.syncNow()

    const shared = projectScope(scopes, project.root)
    expect(shared.mounts.map((mount) => mount.name)).toEqual(['alpha'])
    const projectDefinition = shared.definitions.get('mcp__alpha__tool')
    for (const ctx of [scopes.doubleOf(first.agent), scopes.doubleOf(second.agent)]) {
      const forwarded = ctx?.forwarded.get('mcp__alpha__tool')?.definition
      expect(forwarded).toBeDefined()
      expect((forwarded as unknown as Record<symbol, unknown>)[FORWARDED_TO]).toBe(projectDefinition)
    }
    // One child process for the whole project, and both sessions reach it: the
    // definition they execute is the project's own, instance and all.
    expect(shared.mounts).toHaveLength(1)
    expect(sessionNames(scopes, first.agent)).toEqual(['mcp__alpha__tool'])
    expect(sessionNames(scopes, second.agent)).toEqual(['mcp__alpha__tool'])
    expect(await scopes.doubleOf(first.agent)?.callTool('mcp__alpha__tool', {})).toEqual({ server: 'alpha' })
    expect(await scopes.doubleOf(second.agent)?.callTool('mcp__alpha__tool', {})).toEqual({ server: 'alpha' })
  })

  it('keeps a bridged session level with the project across repeated syncs, set and order intact', async () => {
    const project = makeProject({
      alpha: { command: 'npx', args: ['-y', 'alpha'] },
      beta: { command: 'npx', args: ['-y', 'beta'] },
      gamma: { command: 'npx', args: ['-y', 'gamma'] },
    })
    const { runtime, scopes, changes } = harness()
    const { agent } = fakeAgent('session-1', project.session)
    bindScopeParent(agent, { agentPreset: 'standard' })

    runtime.attach(new FakeScope([agent]))
    await runtime.syncNow()
    await waitFor(() => sessionNames(scopes, agent).length === 3)

    const shared = projectScope(scopes, project.root)
    /** What the project publishes, in the project's own registry order. */
    const published = (): string[] => [...shared.definitions.keys()]
    /** The session's own layer, which is the bridge's whole product. */
    const forwarded = (): Map<string, { definition: ToolDefinitionLike }> =>
      scopes.doubleOf(agent)?.forwarded ?? new Map()

    expect(published()).toEqual(['mcp__alpha__tool', 'mcp__beta__tool', 'mcp__gamma__tool'])
    // Exactly the project's set, in the project's order. A live batch the sync
    // re-entered used to leave the session with a subset (`[a]`) or with the
    // tail registered by a nested frame (`[a,c,b]`) while `namesIn` recorded the
    // full set — which froze the loss for every later pass.
    expect(sessionNames(scopes, agent)).toEqual(published())
    expect([...forwarded().keys()]).toEqual(published())

    // A second pass over an unchanged project is a no-op: the same live batch,
    // not a rebuilt one (a rebuild would take a new generation of definitions
    // and announce `tools/change` for every one of them).
    const batch = [...forwarded().values()].map(({ definition }) => definition)
    const announcements = changes.count
    await runtime.syncNow()
    expect([...forwarded().values()].map(({ definition }) => definition)).toEqual(batch)
    expect(changes.count).toBe(announcements)
    // The registry's own announcements were delivered all the same — the
    // subscription `installBridge` makes is what the syncs above ride on.
    expect(changes.count).toBeGreaterThan(0)

    // The operator adds a server: the project publishes one more tool, and the
    // session's batch is replaced as a whole.
    rewrite(project.root, {
      alpha: { command: 'npx', args: ['-y', 'alpha'] },
      beta: { command: 'npx', args: ['-y', 'beta'] },
      gamma: { command: 'npx', args: ['-y', 'gamma'] },
      delta: { command: 'npx', args: ['-y', 'delta'] },
    })
    await runtime.syncNow()
    await waitFor(() => sessionNames(scopes, agent).length === 4)
    expect(published()).toEqual([
      'mcp__alpha__tool',
      'mcp__beta__tool',
      'mcp__gamma__tool',
      'mcp__delta__tool',
    ])
    expect(sessionNames(scopes, agent)).toEqual(published())
    expect([...forwarded().keys()]).toEqual(published())

    // ...and removing one replaces the batch again, with no dead forwarder kept.
    rewrite(project.root, {
      beta: { command: 'npx', args: ['-y', 'beta'] },
      gamma: { command: 'npx', args: ['-y', 'gamma'] },
      delta: { command: 'npx', args: ['-y', 'delta'] },
    })
    await runtime.syncNow()
    await waitFor(() => sessionNames(scopes, agent).length === 3 && !sessionNames(scopes, agent).includes('mcp__alpha__tool'))
    expect(published()).toEqual(['mcp__beta__tool', 'mcp__gamma__tool', 'mcp__delta__tool'])
    expect(sessionNames(scopes, agent)).toEqual(published())
    // No forwarder outlives its project entry, and every survivor delegates to
    // the live definition — never to a disposed generation.
    expect([...forwarded().keys()]).toEqual(published())
    for (const name of published()) {
      expect((forwarded().get(name)?.definition as unknown as Record<symbol, unknown>)[FORWARDED_TO])
        .toBe(shared.definitions.get(name))
    }
    expect(await scopes.doubleOf(agent)?.callTool('mcp__beta__tool', {})).toEqual({ server: 'beta' })
  })

  it('re-mounts an errored mount in the project home on retry(), bridged into a preset-shaped session', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { agent } = fakeAgent('session-1', project.session)
    // The harness already parented this key, so the tools reach the session
    // through the bridge — but the instance, and therefore the errored mount the
    // panel's `Retry` has to find, lives in the project's shared home.
    bindScopeParent(agent, { agentPreset: 'standard' })
    const { runtime, scopes, armActivationFailure } = harness()
    armActivationFailure('boom')
    runtime.attach(new FakeScope([agent]))

    await runtime.syncNow()
    await waitFor(() => runtime.snapshot().projects[0]?.rows[0]?.status === 'error')

    // The server is fixed outside the plugin; `retry()` drops the errored mount
    // and the pass that follows mounts it again in the same home.
    armActivationFailure(undefined)
    await runtime.retry()
    await runtime.syncNow()
    // A mount's activation settles behind the pass that registered it, so the
    // retried instance is `active` — and its tool published — a moment later.
    await waitFor(() => runtime.snapshot().projects[0]?.rows[0]?.status === 'active', 500)

    const shared = projectScope(scopes, project.root)
    expect(sessionNames(scopes, agent)).toEqual(['mcp__alpha__tool'])
    expect(shared.mounts).toHaveLength(2)
    expect(shared.mounts[0]?.disposed).toBe(true)
    expect(scopes.doubleOf(agent)?.forwarded.get('mcp__alpha__tool')?.definition).toBeDefined()
    expect(runtime.snapshot().projects[0]?.rows[0]?.status).toBe('active')
  })

  it('re-mounts on a config change and unmounts on removal', async () => {
    const project = makeProject({ alpha: { command: 'npx', args: ['-y', 'alpha'] } })
    const { runtime, scopes } = harness()
    const { agent } = fakeAgent('session-1', project.session)
    runtime.attach(new FakeScope([agent]))
    await runtime.syncNow()
    const shared = projectScope(scopes, project.root)
    expect(shared.mounts).toHaveLength(1)

    rewrite(project.root, { alpha: { command: 'npx', args: ['-y', 'alpha@2'] } })
    await runtime.syncNow()
    expect(shared.mounts).toHaveLength(2)
    expect(shared.mounts[0]?.disposed).toBe(true)
    expect(shared.mounts[1]?.config.args).toEqual(['-y', 'alpha@2'])

    rewrite(project.root, {})
    await runtime.syncNow()
    expect(shared.mounts[1]?.disposed).toBe(true)
    expect(runtime.snapshot().projects[0]?.rows).toEqual([])
  })

  it('keeps projects isolated and never leaks a server across sessions', async () => {
    const first = makeProject({ only_a: { command: 'npx' } })
    const second = makeProject({ only_b: { command: 'npx' } })
    const { runtime, scopes } = harness()
    const a = fakeAgent('session-a', first.session)
    const b = fakeAgent('session-b', second.session)
    runtime.attach(new FakeScope([a.agent, b.agent]))

    await runtime.syncNow()

    // One scope and one instance per project, and neither session's chain
    // reaches the other project's layer.
    const scopeA = projectScope(scopes, first.root)
    const scopeB = projectScope(scopes, second.root)
    expect(scopes.projects).toHaveLength(2)
    expect(scopeA.mounts.map((mount) => mount.name)).toEqual(['only_a'])
    expect(scopeB.mounts.map((mount) => mount.name)).toEqual(['only_b'])
    expect(sessionNames(scopes, a.agent)).toEqual(['mcp__only_a__tool'])
    expect(sessionNames(scopes, b.agent)).toEqual(['mcp__only_b__tool'])
    expect(scopes.chainOf(a.agent)).not.toContain(scopeB)
    expect(scopes.chainOf(b.agent)).not.toContain(scopeA)
    expect(runtime.snapshot().projects.map((project) => project.projectRoot).sort()).toEqual(
      [first.root, second.root].sort(),
    )
  })

  it('containment drops each other project\u2019s names, never the session\u2019s own', async () => {
    const first = makeProject({ alpha: { command: 'npx' } })
    const second = makeProject({ beta: { command: 'npx' } })
    const { runtime, scopes } = harness()
    const a = fakeAgent('session-a', first.session)
    const b = fakeAgent('session-b', second.session)
    runtime.attach(new FakeScope([a.agent, b.agent]))
    await runtime.syncNow()

    // The host defect assembles both projects' tools into each session's
    // request. Containment drops exactly the other project's names and keeps the
    // session's own, so the foreign set each session resolves is the other
    // project's namespace — and never its own.
    const alpha = { name: 'mcp__alpha__tool', description: '', parameters: {} }
    const beta = { name: 'mcp__beta__tool', description: '', parameters: {} }
    const leak = [alpha, beta]

    expect((await assemble(a.ctx, leak)).map((schema) => schema.name)).toEqual([
      'mcp__alpha__tool',
      'mcp_search_tools',
    ])
    expect((await assemble(b.ctx, leak)).map((schema) => schema.name)).toEqual([
      'mcp__beta__tool',
      'mcp_search_tools',
    ])
    // Both projects are mounted in the one runtime, as the foreign computation
    // requires — the containment is per-session, not a process-wide cut.
    expect(scopes.projects).toHaveLength(2)
  })

  it('merges two sessions of one project by the most actionable status and splits them per session', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime, scopes } = harness()
    const idle = fakeAgent('session-idle', project.session)
    const busy = fakeAgent('session-busy', project.session)
    runtime.attach(new FakeScope([idle.agent, busy.agent]))
    await runtime.syncNow()

    // One shared instance for both sessions of the project.
    const shared = projectScope(scopes, project.root)
    expect(shared.mounts).toHaveLength(1)
    expect(sessionNames(scopes, idle.agent)).toEqual(['mcp__alpha__tool'])
    expect(sessionNames(scopes, busy.agent)).toEqual(['mcp__alpha__tool'])

    // The session registered *first* gives its hold back; the later one keeps
    // running. Registration order must not decide what the project reports.
    await runtime.release('session-idle')

    const snapshot = runtime.snapshot().projects[0]
    expect(shared.mounts[0]?.disposed).toBe(false)
    expect(shared.disposed).toBe(false)
    expect(snapshot?.sessionIds).toEqual(['session-idle', 'session-busy'])
    expect(snapshot?.rows.map((row) => [row.name, row.status])).toEqual([['alpha', 'active']])
    // The released session stops resolving the shared layer; the other keeps it.
    expect(sessionNames(scopes, idle.agent)).toEqual([])
    expect(sessionNames(scopes, busy.agent)).toEqual(['mcp__alpha__tool'])
    expect(snapshot?.sessions.map((entry) => [entry.id, entry.rows[0]?.status])).toEqual([
      ['session-idle', 'idle'],
      ['session-busy', 'active'],
    ])
  })

  it('mounts the same serverName independently in two projects', async () => {
    const first = makeProject({ shared: { command: 'npx', args: ['a'] } })
    const second = makeProject({ shared: { command: 'npx', args: ['b'] } })
    const { runtime, scopes } = harness()
    const a = fakeAgent('session-a', first.session)
    const b = fakeAgent('session-b', second.session)
    runtime.attach(new FakeScope([a.agent, b.agent]))

    await runtime.syncNow()

    // The same serverName twice is two scopes, so mcp-client's per-scope
    // reservation makes it two instances rather than a conflict.
    expect(scopes.projects).toHaveLength(2)
    expect(projectScope(scopes, first.root).mounts[0]?.config.args).toEqual(['a'])
    expect(projectScope(scopes, second.root).mounts[0]?.config.args).toEqual(['b'])
  })

  it('serves two sessions of one project from a single shared instance', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime, scopes } = harness()
    const first = fakeAgent('session-1', project.session)
    const second = fakeAgent('session-2', project.session)
    runtime.attach(new FakeScope([first.agent, second.agent]))

    await runtime.syncNow()

    // One project scope, one instance — and both sessions resolve its tool
    // through the chain, while neither of them registered a server itself.
    expect(scopes.projects).toHaveLength(1)
    const shared = projectScope(scopes, project.root)
    expect(shared.mounts.map((mount) => mount.name)).toEqual(['alpha'])
    expect(first.ctx.mounts).toEqual([])
    expect(second.ctx.mounts).toEqual([])
    expect(sessionNames(scopes, first.agent)).toEqual(['mcp__alpha__tool'])
    expect(sessionNames(scopes, second.agent)).toEqual(['mcp__alpha__tool'])
    expect(runtime.snapshot().projects[0]?.rows.map((row) => [row.name, row.status])).toEqual([
      ['alpha', 'active'],
    ])
  })

  it('lets a session that joins a mounted project share the running instance', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime, scopes } = harness()
    const first = fakeAgent('session-1', project.session)
    const second = fakeAgent('session-2', project.session)
    const listed: AgentLike[] = [first.agent]
    const scope = new FakeScope(listed)
    runtime.attach(scope)

    await runtime.syncNow()
    const shared = projectScope(scopes, project.root)
    expect(shared.mounts).toHaveLength(1)

    // The second session registers and starts working: no second process, and
    // the running instance's tool is in its catalog from its first pass on.
    listed.push(second.agent)
    scope.emit('agent/created', { agent: second.agent })
    await runtime.syncNow()

    expect(scopes.projects).toHaveLength(1)
    expect(shared.mounts).toHaveLength(1)
    expect(second.ctx.mounts).toEqual([])
    expect(sessionNames(scopes, second.agent)).toEqual(['mcp__alpha__tool'])
  })

  it('releases the shared instance only when its last holder lets go', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime, scopes } = harness()
    const first = fakeAgent('session-1', project.session)
    const second = fakeAgent('session-2', project.session)
    runtime.attach(new FakeScope([first.agent, second.agent]))

    await runtime.syncNow()
    const shared = projectScope(scopes, project.root)

    // One holder releases: the instance keeps running for the other one, and
    // the released session stops resolving its tool.
    await runtime.release('session-1')
    expect(shared.mounts[0]?.disposed).toBe(false)
    expect(shared.disposed).toBe(false)
    expect(sessionNames(scopes, first.agent)).toEqual([])
    expect(sessionNames(scopes, second.agent)).toEqual(['mcp__alpha__tool'])

    // The last holder releases: the instance and its scope go away.
    await runtime.release('session-2')
    expect(shared.mounts[0]?.disposed).toBe(true)
    expect(shared.disposed).toBe(true)
    expect(runtime.snapshot().projects[0]?.rows.map((row) => [row.name, row.status])).toEqual([
      ['alpha', 'idle'],
    ])
  })

  it('keeps a project running when a subagent session of it goes away', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime, scopes } = harness()
    const parent = fakeAgent('session-parent', project.session)
    const child = fakeAgent('session-child', project.session)
    const scope = new FakeScope([parent.agent, child.agent])
    runtime.attach(scope)

    await runtime.syncNow()
    const shared = projectScope(scopes, project.root)

    // The child session ends — a subagent finishing its task — and the project
    // the parent is still working in must not lose its servers.
    scope.emit('agent/disposed', { agent: child.agent })
    await runtime.syncNow()
    await sleep(1)

    expect(shared.mounts[0]?.disposed).toBe(false)
    expect(shared.disposed).toBe(false)
    expect(sessionNames(scopes, parent.agent)).toEqual(['mcp__alpha__tool'])
  })

  it('does not keep a project running after its last session moves away', async () => {
    const first = makeProject({ alpha: { command: 'npx' } })
    const second = makeProject({ beta: { command: 'npx' } })
    const { runtime, scopes } = harness()
    const target = fakeAgent('session-1', first.session)
    runtime.attach(new FakeScope([target.agent]))

    await runtime.syncNow()
    const old = projectScope(scopes, first.root)

    // The working directory moves: the old project loses its only holder, so
    // its instance goes away rather than outliving the session's interest.
    ;(target.agent.session as { header?: { cwd?: string } }).header = { cwd: second.session }
    await runtime.syncNow()

    expect(old.mounts[0]?.disposed).toBe(true)
    expect(old.disposed).toBe(true)
    expect(projectScope(scopes, second.root).mounts.map((mount) => mount.name)).toEqual(['beta'])
    expect(sessionNames(scopes, target.agent)).toEqual(['mcp__beta__tool'])
  })

  it('reports a failing mount as an error row', async () => {
    const project = makeProject({ broken: { command: 'explode' } })
    const { runtime, warnings } = harness()
    const { agent } = fakeAgent('session-1', project.session)
    runtime.attach(new FakeScope([agent]))

    await runtime.syncNow()
    await waitFor(() => runtime.snapshot().projects[0]?.rows[0]?.status === 'error')

    const row = runtime.snapshot().projects[0]?.rows[0]
    expect(row?.status).toBe('error')
    expect(row?.detail).toContain('boom')
    expect(warnings.some((message) => message.includes('broken'))).toBe(true)
  })

  it('reports an activation failure behind the pass, and never rejects that pass', async () => {
    const project = makeProject({ gateway: { command: 'npx', args: ['mcp', 'gateway'] } })
    // The instance lives in the project's shared home, whether or not the
    // session could join its chain, so the scope that has to fail is the
    // project's — minted with the pass that mounts.
    const { runtime, warnings, armActivationFailure } = harness()
    const { agent } = fakeAgent('session-1', project.session)
    bindScopeParent(agent, { agentPreset: 'standard' })
    armActivationFailure('the gateway closed the transport')
    runtime.attach(new FakeScope([agent]))

    // The pass that started the fiber answers on its own: the failure is the
    // watcher's to record, and it must never become an unhandled rejection.
    await expect(runtime.syncNow()).resolves.toBeUndefined()
    await waitFor(() => runtime.snapshot().projects[0]?.rows[0]?.status === 'error')

    const row = runtime.snapshot().projects[0]?.rows[0]
    expect(row?.status).toBe('error')
    expect(row?.detail).toContain('the gateway closed the transport')
    expect(
      warnings.some((message) => message.includes('the gateway closed the transport')),
    ).toBe(true)
  })

  it('parses a broken entry into an error row without dropping the document', async () => {
    const project = makeProject({ bad: { url: 42 }, good: { command: 'npx' } })
    const { runtime, scopes } = harness()
    const { agent } = fakeAgent('session-1', project.session)
    runtime.attach(new FakeScope([agent]))

    await runtime.syncNow()

    expect(projectScope(scopes, project.root).mounts.map((mount) => mount.name)).toEqual(['good'])
    expect(runtime.snapshot().projects[0]?.rows.map((row) => [row.name, row.status])).toEqual([
      ['bad', 'error'],
      ['good', 'active'],
    ])
    // The parse failure reaches the row with its code beside the prose (F-48):
    // the client translates `detailCode`, and `detail` stays the fallback.
    const broken = runtime.snapshot().projects[0]?.rows[0]
    expect(broken?.detail).toBe('http servers require a "url"')
    expect(broken?.detailCode).toBe('parse.entry.noUrl')
    expect(broken?.detailParams).toBeUndefined()
    // The same diagnostic rides the issue list, coded as well.
    const issues = runtime.snapshot().projects[0]?.issues ?? []
    expect(issues.find((issue) => issue.server === 'bad')?.code).toBe('parse.entry.noUrl')
  })

  it('mounts nothing for a session outside any project', async () => {
    const orphan = tmp()
    // Hermetic markers: the temp directory must not inherit a project root from
    // whatever tree `tmpdir()` happens to live in.
    const { runtime } = harness([], { projectMarkers: ['.definitely-not-a-marker'], fileMarkers: [] })
    const { agent, ctx } = fakeAgent('session-1', orphan)
    runtime.attach(new FakeScope([agent]))

    await runtime.syncNow()

    expect(ctx.mounts).toEqual([])
    expect(runtime.snapshot().projects).toEqual([])
  })

  it('does no work on a rescan when nothing changed', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime, schemasCalls } = harness()
    const { agent } = fakeAgent('session-1', project.session)
    runtime.attach(new FakeScope([agent]))

    await runtime.syncNow()
    const afterMount = schemasCalls.count
    expect(afterMount).toBeGreaterThan(0)

    await runtime.syncNow()
    expect(schemasCalls.count).toBe(afterMount)

    rewrite(project.root, { alpha: { command: 'npx', args: ['changed'] } })
    await runtime.syncNow()
    expect(schemasCalls.count).toBeGreaterThan(afterMount)
  })

  it('watches the project root while a session is bound to it', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime } = harness([], { watch: true, rescanIntervalMs: 60_000 })
    const { agent } = fakeAgent('session-1', project.session)
    runtime.attach(new FakeScope([agent]))

    await runtime.syncNow()
    expect(runtime.snapshot().watchedFiles).toEqual([project.root])

    await runtime.disposeAll()
    expect(runtime.snapshot().watchedFiles).toEqual([])
  })

  it('reads the documents this deployment configures, the later one winning', async () => {
    const project = makeProject({ alpha: { command: 'npx', args: ['wins'] } })
    // A second document, named by the config before `.dsh/mcp.json` and therefore
    // read first: its declaration of the same name loses.
    mkdirSync(join(project.root, '.config'), { recursive: true })
    writeFileSync(
      join(project.root, '.config', 'mcp.json'),
      JSON.stringify({ mcpServers: { alpha: { command: 'npx', args: ['loses'] } } }),
    )
    const { runtime, scopes } = harness([], {
      localFiles: ['.config/mcp.json', '.dsh/mcp.json'],
    })
    const { agent } = fakeAgent('session-1', project.session)
    runtime.attach(new FakeScope([agent]))

    await runtime.syncNow()

    expect(projectScope(scopes, project.root).mounts[0]?.config.args).toEqual(['wins'])
    const mergeWarning = runtime
      .snapshot()
      .projects[0]?.issues.find((issue) => issue.message.includes('more than one document'))
    expect(mergeWarning).toBeDefined()
    // The code the client compares (never the prose) and its one param (F-48).
    expect(mergeWarning?.code).toBe('parse.server.multiDocument')
    expect(mergeWarning?.params).toEqual({ name: 'alpha' })
    // The read order is a config fact and the panel numbers its rows by it.
    expect(runtime.snapshot().projects[0]?.files?.map((file) => file.path)).toEqual([
      join(project.root, '.config', 'mcp.json'),
      join(project.root, '.dsh', 'mcp.json'),
    ])
  })

  it('ignores a project document the config does not name', async () => {
    // `.kimi-code/mcp.json` is a file this deployment used to read and no longer
    // does: unless `localFiles` names it, its servers stay out of the project.
    const project = makeProject({ alpha: { command: 'npx' } })
    mkdirSync(join(project.root, '.kimi-code'), { recursive: true })
    writeFileSync(
      join(project.root, '.kimi-code', 'mcp.json'),
      JSON.stringify({ mcpServers: { beta: { command: 'npx' } } }),
    )
    const { runtime, scopes } = harness()
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session).agent]))

    await runtime.syncNow()

    expect(runtime.snapshot().projects[0]?.rows.map((row) => row.name)).toEqual(['alpha'])
    expect(projectScope(scopes, project.root).mounts.map((mount) => mount.name)).toEqual(['alpha'])
  })

  it('unmounts everything when the agent is disposed', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime, scopes } = harness()
    const { agent } = fakeAgent('session-1', project.session)
    const scope = new FakeScope([agent])
    runtime.attach(scope)
    await runtime.syncNow()
    const shared = projectScope(scopes, project.root)
    expect(shared.mounts).toHaveLength(1)

    scope.emit('agent/disposed', { agent })
    await runtime.syncNow()
    await sleep(1)

    expect(shared.mounts[0]?.disposed).toBe(true)
    expect(shared.disposed).toBe(true)
    expect(shared.names.size).toBe(0)
    expect(runtime.snapshot().projects).toEqual([])
  })

  it('reports each session tool presentation and picks up an activation in the next snapshot', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    // A zero budget defers the whole surface, so the mounted tool starts hidden.
    const { runtime } = harness([], { activationToolBudgetChars: 0 })
    const { agent, ctx } = fakeAgent('session-1', project.session)
    runtime.attach(new FakeScope([agent]))
    await runtime.syncNow()

    // The discovery tool sits in the session's scope catalog but never counts as
    // a mount candidate, so the presentation row is about the server's tool only.
    expect(ctx.definitions.has(SEARCH_TOOL_NAME)).toBe(true)
    expect([...ctx.names]).toEqual([])

    const before = runtime.snapshot().projects[0]?.sessions[0]?.tools
    expect(before).toMatchObject({
      sessionId: 'session-1',
      mounted: 1,
      deferred: ['mcp__alpha__tool'],
      deferring: true,
      baseline: [],
      activated: [],
      context: [],
    })
    expect(before?.surfaceChars).toBeGreaterThan(0)
    expect(before?.budgetChars).toBe(0)

    // The model finds the tool through the discovery tool the wiring registered.
    await ctx.callTool(SEARCH_TOOL_NAME, { query: 'alpha' })

    const after = runtime.snapshot().projects[0]?.sessions[0]?.tools
    expect(after?.activated).toEqual([
      { name: 'mcp__alpha__tool', via: 'session', at: expect.any(Number) },
    ])
    expect(after?.deferred).toEqual([])

    // A session whose mounts were released has nothing to report, not a row
    // claiming it offers nothing.
    await runtime.release('session-1')
    expect(runtime.snapshot().projects[0]?.sessions[0]?.tools).toBeUndefined()
  })

  it('stamps an activation with the step it happened on, and counts steps up', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    // A zero budget defers the whole surface, so the search tool is the only
    // way the mounted tool can be offered.
    const { runtime } = harness([], { activationToolBudgetChars: 0 })
    const { agent, ctx } = fakeAgent('session-1', project.session)
    const scope = new FakeScope([agent])
    runtime.attach(scope)

    await scope.step(agent)
    await waitFor(() => runtime.snapshot().projects[0]?.rows[0]?.status === 'active')

    // Step one: the tool is mounted and hidden, and nothing carries a step yet.
    const first = runtime.snapshot().projects[0]?.sessions[0]?.tools
    expect(first?.activated).toEqual([])
    expect(first?.deferred).toEqual(['mcp__alpha__tool'])

    await scope.step(agent)
    await ctx.callTool(SEARCH_TOOL_NAME, { query: 'alpha' })

    // The activation was recorded during step two, so it says so — and the
    // context tier, which is live state, is read on that same step two.
    const second = runtime.snapshot().projects[0]?.sessions[0]?.tools
    expect(second?.activated).toEqual([
      { name: 'mcp__alpha__tool', via: 'session', at: expect.any(Number), step: 2 },
    ])
    expect(second?.deferred).toEqual([])

    // A third step moves the counter on: the offer keeps the step it was made
    // on rather than being restamped with the step the panel happens to read.
    await scope.step(agent)
    const third = runtime.snapshot().projects[0]?.sessions[0]?.tools
    expect(third?.activated).toEqual([
      { name: 'mcp__alpha__tool', via: 'session', at: expect.any(Number), step: 2 },
    ])
    await runtime.disposeAll()
  })

  it('splits the mounted surface into offered and deferred characters', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime } = harness([], { activationToolBudgetChars: 0 })
    const { agent, ctx } = fakeAgent('session-1', project.session)
    const scope = new FakeScope([agent])
    runtime.attach(scope)
    await scope.step(agent)
    await waitFor(() => runtime.snapshot().projects[0]?.rows[0]?.status === 'active')

    const hidden = runtime.snapshot().projects[0]?.sessions[0]?.tools
    // Everything is deferred, so the request carries nothing of this project.
    expect(hidden?.deferredChars).toBe(hidden?.surfaceChars)
    expect(hidden?.visibleChars).toBe(0)

    await ctx.callTool(SEARCH_TOOL_NAME, { query: 'alpha' })
    const offered = runtime.snapshot().projects[0]?.sessions[0]?.tools
    // The two halves are the whole surface, measured by one rule: what hiding
    // saves is exactly `surfaceChars - visibleChars`.
    expect(offered?.deferred).toEqual([])
    expect(offered?.deferredChars).toBe(0)
    expect(offered?.visibleChars).toBe(offered?.surfaceChars)
    await runtime.disposeAll()
  })
})

describe('applyLiveConfig (F-54)', () => {
  it('moves the activation gate the next snapshot reads', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    // A zero budget defers the whole surface while activation is on, so the
    // session row starts with the mounted tool hidden.
    const { runtime } = harness([], { activationEnabled: true, activationToolBudgetChars: 0 })
    const { agent } = fakeAgent('session-1', project.session)
    runtime.attach(new FakeScope([agent]))
    await runtime.syncNow()
    await waitFor(() => runtime.snapshot().projects[0]?.rows[0]?.status === 'active')

    const before = runtime.snapshot().projects[0]?.sessions[0]?.tools
    expect(before?.deferring).toBe(true)
    expect(before?.deferred).toEqual(['mcp__alpha__tool'])

    // The live edit: the host re-resolved the volatile refs and the merge
    // flips the gate; the next snapshot offers the whole surface directly.
    runtime.applyLiveConfig(config({ activationEnabled: false, activationToolBudgetChars: 0 }))
    const after = runtime.snapshot().projects[0]?.sessions[0]?.tools
    expect(after?.deferring).toBe(false)
    expect(after?.deferred).toEqual([])
    await runtime.disposeAll()
  })

  it('merges only the volatile keys; structural keys keep their boot values', async () => {
    const { runtime } = harness([], { watch: false, idleTimeoutMs: 0 })
    runtime.attach(new FakeScope([]))
    const merged = (runtime as unknown as { config: RuntimeConfig }).config

    runtime.applyLiveConfig(
      config({
        idleTimeoutMs: 9_000,
        localFiles: ['other.json'],
        watch: true,
        credentialsFile: '/elsewhere/.credentials.yaml',
      }),
    )
    expect(merged.idleTimeoutMs).toBe(9_000)
    // None of the structural keys moved — not even `watch`, which is yaml-only
    // and therefore never re-armed from a live merge.
    expect(merged.localFiles).toEqual(['.dsh/mcp.json'])
    expect(merged.watch).toBe(false)
    expect(merged.credentialsFile).toBe('/definitely/missing/.credentials.yaml')

    // An `undefined` in the re-resolved config leaves the merged value alone.
    runtime.applyLiveConfig({ ...config(), idleTimeoutMs: undefined } as unknown as RuntimeConfig)
    expect(merged.idleTimeoutMs).toBe(9_000)
    await runtime.disposeAll()
  })

  it('arms the safety-net timer on 0→N and clears it on N→0 when watch is off', async () => {
    vi.useFakeTimers()
    try {
      const { runtime } = harness([], { watch: false, idleTimeoutMs: 0 })
      runtime.attach(new FakeScope([]))
      // Flush the attach pass's debounce, so only the interval counts below.
      await vi.advanceTimersByTimeAsync(0)
      const idle = vi.getTimerCount()

      runtime.applyLiveConfig(config({ watch: false, idleTimeoutMs: 5_000 }))
      expect(vi.getTimerCount()).toBe(idle + 1)

      runtime.applyLiveConfig(config({ watch: false, idleTimeoutMs: 0 }))
      expect(vi.getTimerCount()).toBe(idle)
      await runtime.disposeAll()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not arm the timer before attach; attach arms from the merged value', async () => {
    vi.useFakeTimers()
    try {
      const { runtime } = harness([], { watch: false, idleTimeoutMs: 0 })
      // A volatile update may land before the scope attaches: the merge lands,
      // but arming is `attach`'s job, so no interval leaks here.
      runtime.applyLiveConfig(config({ watch: false, idleTimeoutMs: 5_000 }))
      expect(vi.getTimerCount()).toBe(0)

      runtime.attach(new FakeScope([]))
      await vi.advanceTimersByTimeAsync(0)
      // Exactly one interval — attach armed from the merged config, and the
      // pre-attach merge did not leave a second one behind.
      expect(vi.getTimerCount()).toBe(1)
      await runtime.disposeAll()
    } finally {
      vi.useRealTimers()
    }
  })
})

/** The writable part of one row, with the fields a save request needs. */
function saveRow(runtime: ProjectMcpRuntime, name: string) {
  const rows = runtime.snapshot().projects.flatMap((project) => project.rows)
  const row = rows.find((candidate) => candidate.name === name)
  if (row?.source === undefined || row.documentRevision === undefined || row.entry === undefined) {
    throw new Error(`row "${name}" did not carry a writable entry`)
  }
  return { row, document: row.source, revision: row.documentRevision, entry: row.entry }
}

describe('serverName conflicts', () => {
  it('reports an empty list when nothing fights over a name', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime } = harness()
    const { agent } = fakeAgent('session-1', project.session)
    runtime.attach(new FakeScope([agent]))
    await runtime.syncNow()

    // An empty list is the answer "no conflicts", which is what lets a panel
    // report that instead of offering a button that never says anything.
    expect(runtime.snapshot().projects[0]?.conflicts).toEqual([])
    expect(runtime.snapshot().projects[0]?.sessions[0]?.conflicts).toEqual([])
    await runtime.disposeAll()
  })

  it('reports a name a profile-level instance already owns', async () => {
    const project = makeProject({ alpha: { command: 'npx' }, beta: { command: 'npx' } })
    const { runtime } = harness(['alpha'])
    const { agent } = fakeAgent('session-1', project.session)
    runtime.attach(new FakeScope([agent]))
    await runtime.syncNow()

    const snapshot = runtime.snapshot()
    expect(snapshot.projects[0]?.rows.map((row) => [row.name, row.status])).toEqual([
      ['alpha', 'conflict'],
      ['beta', 'active'],
    ])
    expect(snapshot.projects[0]?.conflicts).toEqual([
      {
        server: 'alpha',
        kind: 'profile',
        sources: [join(project.root, '.dsh', 'mcp.json')],
        // The report carries the local name this project could give the entry
        // (derived from the folder here, because no prefix is configured) and
        // the answer in force, so the panel offers the choice it describes.
        alias: expect.stringMatching(/^[A-Za-z0-9_-]{1,5}-alpha$/),
        choice: 'profile',
        // F-48: the wire code and its flat params ride beside the prose.
        code: 'conflict.profileAlias',
        params: { name: 'alpha', alias: expect.stringMatching(/^[A-Za-z0-9_-]{1,5}-alpha$/) },
        message: expect.stringContaining('profile-level mcp-client instance'),
      },
    ])
    await runtime.disposeAll()
  })

  it('mounts this project\'s copy under its local name once the user chooses it', async () => {
    const project = makeProject({ alpha: { command: 'npx' }, beta: { command: 'npx' } })
    // The shipped default: a session mounts on its first turn, and an operator
    // choice is what makes the shadowed entry mount outside one.
    const { runtime, scopes } = harness(['alpha'], { localPrefix: 'p', lazy: true })
    const { agent } = fakeAgent('session-1', project.session)
    runtime.attach(new FakeScope([agent]))
    await runtime.syncNow()

    // Profile's copy only: the contested name stays the profile instance's, and
    // the project declares a name nothing has mounted.
    const shared = projectScope(scopes, project.root)
    expect([...shared.names]).toEqual(['mcp__beta__tool'])
    expect(runtime.snapshot().projects[0]?.conflicts?.[0]).toMatchObject({
      server: 'alpha',
      kind: 'profile',
      alias: 'p-alpha',
      choice: 'profile',
    })

    const policy = runtime.setConflictChoice({
      projectRoot: project.root,
      server: 'alpha',
      choice: 'local',
    })
    expect(policy).toMatchObject({ ok: true })
    await runtime.syncNow()

    // Both toolsets now, each under its own name: the profile instance keeps
    // `mcp__alpha__` in its own scope, the project's copy is `mcp__p-alpha__`.
    // The contested name was never registered here — the project declared it
    // after the first pass, and the first pass mounted `beta` alone.
    expect([...shared.names].sort()).toEqual(['mcp__beta__tool', 'mcp__p-alpha__tool'])
    expect(shared.mounts.map((mount) => mount.config.serverName)).toEqual(['beta', 'p-alpha'])
    expect(runtime.snapshot().projects[0]?.rows.map((row) => [row.name, row.status])).toEqual([
      ['alpha', 'active'],
      ['beta', 'active'],
    ])
    expect(runtime.snapshot().projects[0]?.conflicts?.[0]).toMatchObject({
      server: 'alpha',
      alias: 'p-alpha',
      choice: 'local',
    })

    // A later pass with no operator intent must not drop it again: the choice
    // is durable state, not a one-pass hint.
    await runtime.syncNow()
    await runtime.syncNow()
    expect([...shared.names].sort()).toEqual(['mcp__beta__tool', 'mcp__p-alpha__tool'])
    expect(runtime.snapshot().projects[0]?.rows.map((row) => [row.name, row.status])).toEqual([
      ['alpha', 'active'],
      ['beta', 'active'],
    ])

    await runtime.disposeAll()
  })

  it('refuses a conflict choice that names no live project, and one no build knows', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime, store } = harness(['alpha'], { localPrefix: 'p' })
    const { agent } = fakeAgent('session-1', project.session)
    runtime.attach(new FakeScope([agent]))
    await runtime.syncNow()

    expect(
      runtime.setConflictChoice({ projectRoot: '/tmp/none', server: 'alpha', choice: 'local' }),
    ).toMatchObject({ ok: false, code: 'not-found' })
    expect(
      runtime.setConflictChoice({
        projectRoot: project.root,
        server: 'alpha',
        choice: 'both' as unknown as ConflictChoice,
      }),
    ).toMatchObject({ ok: false, code: 'invalid' })
    // Neither refusal reached the document: a refused click must not decide
    // anything, and the conflict report still says the profile's copy shows.
    expect(store.forProject(project.root).aliases).toEqual({})
    expect(runtime.snapshot().projects[0]?.conflicts?.[0]).toMatchObject({ choice: 'profile' })
    await runtime.disposeAll()
  })

  it('mounts this project\'s copy under the contested name when the user chooses to shadow the profile', async () => {
    const project = makeProject({ alpha: { command: 'npx' }, beta: { command: 'npx' } })
    const { runtime, scopes, store } = harness(['alpha'], { localPrefix: 'p', lazy: true })
    const { agent } = fakeAgent('session-1', project.session)
    runtime.attach(new FakeScope([agent]))
    await runtime.syncNow()

    const shared = projectScope(scopes, project.root)
    expect([...shared.names]).toEqual(['mcp__beta__tool'])

    expect(
      runtime.setConflictChoice({ projectRoot: project.root, server: 'alpha', choice: 'native' }),
    ).toMatchObject({ ok: true })
    await runtime.syncNow()

    // The project's own declaration under the name it declares: nothing is
    // renamed, so the registration sits in the project scope and the registry's
    // nearest-first merge resolves it wherever the profile instance is merged in
    // as well. The local name is still reported — it is the way back.
    expect([...shared.names].sort()).toEqual(['mcp__alpha__tool', 'mcp__beta__tool'])
    expect(shared.mounts.map((mount) => mount.config.serverName).sort()).toEqual(['alpha', 'beta'])
    expect(runtime.snapshot().projects[0]?.rows.map((row) => [row.name, row.status])).toEqual([
      ['alpha', 'active'],
      ['beta', 'active'],
    ])
    expect(runtime.snapshot().projects[0]?.conflicts?.[0]).toMatchObject({
      server: 'alpha',
      alias: 'p-alpha',
      choice: 'native',
    })
    // The row is `active` with no detail of its own — `decorate` drops a mounted
    // row's detail — so the report a mounted name still publishes is what says
    // which of the three readings it is, and it names both ways back.
    expect(runtime.snapshot().projects[0]?.conflicts?.[0]?.message).toContain('shadow')

    // Durable state, not a one-pass hint: no operator intent here, and the mount
    // still stands — the pass after the click is what mounts it.
    await runtime.syncNow()
    await runtime.syncNow()
    expect([...shared.names].sort()).toEqual(['mcp__alpha__tool', 'mcp__beta__tool'])

    // The way back to the profile's copy: the mount leaves, the name is a
    // conflict again, and the stored answer is gone rather than inert.
    runtime.setConflictChoice({ projectRoot: project.root, server: 'alpha', choice: 'profile' })
    await runtime.syncNow()
    expect([...shared.names]).toEqual(['mcp__beta__tool'])
    expect(runtime.snapshot().projects[0]?.rows.map((row) => [row.name, row.status])).toEqual([
      ['alpha', 'conflict'],
      ['beta', 'active'],
    ])
    // The profile is what an absent entry means, so the answer leaves the store
    // rather than sitting in it inert.
    expect(store.forProject(project.root).aliases).toBeUndefined()

    // And the other answer after it renames the mount instead of leaving both
    // names registered: the entry moves from the contested name to the local one.
    runtime.setConflictChoice({ projectRoot: project.root, server: 'alpha', choice: 'local' })
    await runtime.syncNow()
    expect([...shared.names].sort()).toEqual(['mcp__beta__tool', 'mcp__p-alpha__tool'])
    await runtime.disposeAll()
  })

  it('reports one name two documents declare, naming the winner first', async () => {
    const project = makeProject({ alpha: { command: 'npx', args: ['wins'] } })
    // The same name in a second, lower-priority document of the same project:
    // the merge keeps the highest-priority declaration and ignores the other.
    mkdirSync(join(project.root, '.config'), { recursive: true })
    writeFileSync(
      join(project.root, '.config', 'mcp.json'),
      JSON.stringify({ mcpServers: { alpha: { command: 'npx', args: ['loses'] } } }),
    )
    const { runtime, scopes } = harness([], {
      localFiles: ['.config/mcp.json', '.dsh/mcp.json'],
    })
    const { agent } = fakeAgent('session-1', project.session)
    runtime.attach(new FakeScope([agent]))
    await runtime.syncNow()

    const conflict = runtime.snapshot().projects[0]?.conflicts?.[0]
    expect(conflict).toMatchObject({ server: 'alpha', kind: 'duplicate' })
    expect(conflict?.sources).toHaveLength(2)
    // The winner is listed first: it is the document whose definition mounted.
    expect(conflict?.sources[0]).toBe(join(project.root, '.dsh', 'mcp.json'))
    expect(projectScope(scopes, project.root).mounts[0]?.config.args).toEqual(['wins'])
    expect(conflict?.message).toContain('wins')
    await runtime.disposeAll()
  })
})

describe('presentation owner', () => {
  it('reports a loaded second owner of the assembled tool list', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime } = harness([], {}, [
      { options: { name: 'dsh-progressive-tools' }, fiber: { state: 2 } },
    ])
    const { agent } = fakeAgent('session-1', project.session)
    runtime.attach(new FakeScope([agent]))
    await runtime.syncNow()

    expect(runtime.snapshot().projects[0]?.presentation).toMatchObject({
      name: 'dsh-progressive-tools',
      note: expect.stringContaining('assembly.tools'),
    })
    await runtime.disposeAll()
  })

  it('reports no owner when the profile mounts none, or mounts a stopped one', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    for (const extraEntries of [
      [],
      // Mounted but not running: an entry that shapes no request is no owner.
      [{ options: { name: 'dsh-progressive-tools' }, fiber: { state: 1 } }],
      [{ options: { name: 'dsh-progressive-tools', disabled: true }, fiber: { state: 2 } }],
      // A different plugin: owning another surface is not owning this one.
      [{ options: { name: 'dsh-better-sidebar' }, fiber: { state: 2 } }],
    ] satisfies LoaderEntryStub[][]) {
      const { runtime } = harness([], {}, extraEntries)
      const { agent } = fakeAgent('session-1', project.session)
      runtime.attach(new FakeScope([agent]))
      await runtime.syncNow()
      expect(runtime.snapshot().projects[0]?.presentation).toBeUndefined()
      await runtime.disposeAll()
    }
  })
})

/**
 * The conflict channel's wire codes (F-48, Task 4): every conflict the pass
 * reports and every shadowed row's detail carry a `code`/`params` pair beside
 * the byte-identical English prose, and the presentation owner's note carries
 * its `noteCode`. The fill-back assertions pin the `en` table to the emission
 * literals, so table/prose drift is a test failure here.
 */
describe('conflict and presentation wire codes (F-48)', () => {
  /** Substitute the way the harness's bound seat does, for the byte-identity check. */
  const fill = (template: string, params: Record<string, string>): string =>
    template.replace(/\{(\w+)\}/g, (whole, name: string) => params[name] ?? whole)
  /** The table read as a plain record, so a missing code fails the assertion instead of throwing. */
  const hostTable: Record<string, string> = hostEn

  it('codes a profile conflict with an alias, the report and the row detail alike', async () => {
    const project = makeProject({ alpha: { command: 'npx' }, beta: { command: 'npx' } })
    const { runtime } = harness(['alpha'], { localPrefix: 'p' })
    const { agent } = fakeAgent('session-1', project.session)
    runtime.attach(new FakeScope([agent]))
    await runtime.syncNow()

    const conflict = runtime.snapshot().projects[0]?.conflicts?.[0]
    expect(conflict?.code).toBe('conflict.profileAlias')
    expect(conflict?.params).toEqual({ name: 'alpha', alias: 'p-alpha' })
    expect(fill(hostTable['conflict.profileAlias'] ?? '', conflict?.params ?? {})).toBe(conflict?.message)

    // The shadowed row's detail is the same wire shape: prose plus its code.
    const row = runtime.snapshot().projects[0]?.rows.find((entry) => entry.name === 'alpha')
    expect(row?.status).toBe('conflict')
    expect(row?.detailCode).toBe('conflict.profileAliasDetail')
    expect(row?.detailParams).toEqual({ name: 'alpha', alias: 'p-alpha' })
    expect(fill(hostTable['conflict.profileAliasDetail'] ?? '', row?.detailParams ?? {})).toBe(row?.detail)
    await runtime.disposeAll()
  })

  it('codes a profile conflict a project has no alias to offer', async () => {
    // A folder whose name derives no local prefix (digits only) has no alias to
    // give: the other reading of both the report and the row detail.
    const root = join(tmp(), '12345')
    mkdirSync(join(root, '.dsh'), { recursive: true })
    mkdirSync(join(root, 'src', 'nested'), { recursive: true })
    writeFileSync(
      join(root, '.dsh', 'mcp.json'),
      JSON.stringify({ mcpServers: { alpha: { command: 'npx' } } }),
    )
    const { runtime } = harness(['alpha'])
    const { agent } = fakeAgent('session-1', join(root, 'src', 'nested'))
    runtime.attach(new FakeScope([agent]))
    await runtime.syncNow()

    const conflict = runtime.snapshot().projects[0]?.conflicts?.[0]
    expect(conflict?.alias).toBeUndefined()
    expect(conflict?.code).toBe('conflict.profile')
    expect(conflict?.params).toEqual({ name: 'alpha' })
    expect(fill(hostTable['conflict.profile'] ?? '', conflict?.params ?? {})).toBe(conflict?.message)

    const row = runtime.snapshot().projects[0]?.rows.find((entry) => entry.name === 'alpha')
    expect(row?.status).toBe('conflict')
    expect(row?.detailCode).toBe('conflict.profileDetail')
    expect(row?.detailParams).toEqual({ name: 'alpha' })
    expect(fill(hostTable['conflict.profileDetail'] ?? '', row?.detailParams ?? {})).toBe(row?.detail)
    await runtime.disposeAll()
  })

  it('codes a duplicate-document conflict, the document count stringified', async () => {
    const project = makeProject({ alpha: { command: 'npx', args: ['wins'] } })
    mkdirSync(join(project.root, '.config'), { recursive: true })
    writeFileSync(
      join(project.root, '.config', 'mcp.json'),
      JSON.stringify({ mcpServers: { alpha: { command: 'npx', args: ['loses'] } } }),
    )
    const { runtime } = harness([], {
      localFiles: ['.config/mcp.json', '.dsh/mcp.json'],
    })
    const { agent } = fakeAgent('session-1', project.session)
    runtime.attach(new FakeScope([agent]))
    await runtime.syncNow()

    const conflict = runtime.snapshot().projects[0]?.conflicts?.[0]
    expect(conflict?.kind).toBe('duplicate')
    expect(conflict?.code).toBe('conflict.documents')
    expect(conflict?.params).toEqual({
      name: 'alpha',
      count: '2',
      winner: join(project.root, '.dsh', 'mcp.json'),
    })
    expect(fill(hostTable['conflict.documents'] ?? '', conflict?.params ?? {})).toBe(conflict?.message)
    await runtime.disposeAll()
  })

  it('codes the presentation owner note', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime } = harness([], {}, [
      { options: { name: 'dsh-progressive-tools' }, fiber: { state: 2 } },
    ])
    const { agent } = fakeAgent('session-1', project.session)
    runtime.attach(new FakeScope([agent]))
    await runtime.syncNow()

    const presentation = runtime.snapshot().projects[0]?.presentation
    expect(presentation?.noteCode).toBe('present.ownerNote')
    // No params: the note is one fixed sentence, so the table entry *is* the note.
    expect(presentation?.note).toBe(hostTable['present.ownerNote'] ?? '')
    await runtime.disposeAll()
  })
})

describe('ProjectMcpRuntime.saveEntry', () => {
  it('publishes the entry body, the write tier and the revision the editor read', async () => {
    const project = makeProject({
      alpha: {
        command: 'npx',
        args: ['-y', 'alpha'],
        env: { PLAIN: 'one', API_KEY: 'literal-secret' },
        note: 'kept',
      },
    })
    const document = join(project.root, '.dsh', 'mcp.json')
    const text = readFileSync(document, 'utf8')
    const { runtime } = harness()
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session).agent]))

    await runtime.syncNow()

    const row = runtime.snapshot().projects[0]?.rows[0]
    expect(row?.writeScope).toBe('project')
    expect(row?.writeBlockedReason).toBeUndefined()
    expect(row?.documentRevision).toBe(documentRevision(text))
    expect(row?.entry).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'alpha'],
      env: [
        { key: 'PLAIN', value: 'one' },
        { key: 'API_KEY', masked: true },
      ],
      extra: { note: 'kept' },
    })
  })

  it('writes the edited entry back, keeps every other key and rescans', async () => {
    const project = makeProject({ alpha: { command: 'npx', args: ['old'] } })
    const document = join(project.root, '.dsh', 'mcp.json')
    writeFileSync(
      document,
      JSON.stringify({
        note: 'top-level key',
        mcpServers: { alpha: { command: 'npx', args: ['old'], note: 'kept' }, beta: { command: 'npx' } },
      }),
    )
    const before = readFileSync(document, 'utf8')
    const { runtime, scopes } = harness()
    const { agent } = fakeAgent('session-1', project.session)
    runtime.attach(new FakeScope([agent]))
    await runtime.syncNow()

    const target = saveRow(runtime, 'alpha')
    const outcome = await runtime.saveEntry({
      projectRoot: project.root,
      server: 'alpha',
      document: target.document,
      revision: target.revision,
      entry: { ...target.entry, args: ['new'] },
    })

    expect(outcome.ok).toBe(true)
    const after = readFileSync(document, 'utf8')
    expect(JSON.parse(after)).toEqual({
      note: 'top-level key',
      mcpServers: {
        alpha: { command: 'npx', args: ['new'], note: 'kept' },
        beta: { command: 'npx' },
      },
    })
    expect(after).toContain('\n  "mcpServers"')
    expect(after.endsWith('\n')).toBe(true)
    expect(readFileSync(`${document}.bak`, 'utf8')).toBe(before)
    // The rescan routed the written entry back into the shared mount.
    expect(projectScope(scopes, project.root).mounts.at(-1)?.config.args).toEqual(['new'])
    if (outcome.ok) {
      const fresh = outcome.snapshot.projects[0]?.rows.find((candidate) => candidate.name === 'alpha')
      expect(fresh?.documentRevision).toBe(documentRevision(after))
      expect(fresh?.entry?.args).toEqual(['new'])
    }
  })

  it('mounts only the edited project, never another project’s sessions', async () => {
    const project1 = makeProject({ alpha: { command: 'npx', args: ['old'] } })
    const project2 = makeProject({ beta: { command: 'npx' } })
    const { runtime, scopes } = harness([], { lazy: true })
    const first = fakeAgent('session-1', project1.session)
    const second = fakeAgent('session-2', project2.session)
    runtime.attach(new FakeScope([first.agent, second.agent]))
    // The lazy pass publishes both declarations and starts nothing.
    await sleep(20)
    expect(scopes.projects).toEqual([])

    const target = saveRow(runtime, 'alpha')
    const outcome = await runtime.saveEntry({
      projectRoot: project1.root,
      server: 'alpha',
      document: target.document,
      revision: target.revision,
      entry: { ...target.entry, args: ['new'] },
    })

    expect(outcome.ok).toBe(true)
    // An edit is one project's business: its own session picks the change up and
    // a session of another project mints no scope at all.
    expect(scopes.projects).toHaveLength(1)
    expect(projectScope(scopes, project1.root).mounts.at(-1)?.config.args).toEqual(['new'])
    expect(scopes.forProject(project2.root)).toBeUndefined()
    await runtime.disposeAll()
  })

  it('never writes a credentials-backed value, even when the submission carries one', async () => {
    const project = makeProject({ alpha: { command: 'npx', env: { TOKEN: '${input:PROJECT_MCP_TEST_TOKEN}' } } })
    const home = tmp()
    vi.stubEnv('DSH_HOME', home)
    const credentials = defaultCredentialsPath()
    writeFileSync(credentials, 'PROJECT_MCP_TEST_TOKEN: from-file\n')
    const document = join(project.root, '.dsh', 'mcp.json')
    const { runtime } = harness([], { credentialsFile: credentials })
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session).agent]))
    await runtime.syncNow()

    const target = saveRow(runtime, 'alpha')
    expect(target.entry.env).toEqual([{ key: 'TOKEN', masked: true, fromCredentials: true }])
    const outcome = await runtime.saveEntry({
      projectRoot: project.root,
      server: 'alpha',
      document: target.document,
      revision: target.revision,
      entry: {
        ...target.entry,
        env: [{ key: 'TOKEN', value: 'resolved-secret', fromCredentials: true }],
      },
    })

    expect(outcome.ok).toBe(true)
    const written = JSON.parse(readFileSync(document, 'utf8')) as {
      mcpServers: { alpha: { env: Record<string, string> } }
    }
    expect(written.mcpServers.alpha.env).toEqual({ TOKEN: '${input:PROJECT_MCP_TEST_TOKEN}' })
    expect(readFileSync(document, 'utf8')).not.toContain('resolved-secret')
  })

  it('refuses a save the document moved past, and writes nothing', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const document = join(project.root, '.dsh', 'mcp.json')
    const { runtime } = harness()
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session).agent]))
    await runtime.syncNow()

    const target = saveRow(runtime, 'alpha')
    const changed = JSON.stringify({ mcpServers: { alpha: { command: 'npx', args: ['elsewhere'] } } })
    writeFileSync(document, changed)
    const outcome = await runtime.saveEntry({
      projectRoot: project.root,
      server: 'alpha',
      document: target.document,
      revision: target.revision,
      entry: { ...target.entry, args: ['mine'] },
    })

    expect(outcome).toMatchObject({ ok: false, code: 'conflict' })
    expect(readFileSync(document, 'utf8')).toBe(changed)
  })

  it('answers not-found for an unknown server, an unknown project and a document it does not read', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime } = harness()
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session).agent]))
    await runtime.syncNow()

    const target = saveRow(runtime, 'alpha')
    const base = { projectRoot: project.root, revision: target.revision, entry: target.entry }
    expect(await runtime.saveEntry({ ...base, server: 'missing', document: target.document })).toMatchObject({
      ok: false,
      code: 'not-found',
    })
    expect(
      await runtime.saveEntry({ ...base, projectRoot: join(project.root, 'elsewhere'), server: 'alpha', document: target.document }),
    ).toMatchObject({ ok: false, code: 'not-found' })
    expect(
      await runtime.saveEntry({ ...base, server: 'alpha', document: join(project.root, '.kimi-code', 'mcp.json') }),
    ).toMatchObject({ ok: false, code: 'not-found' })
  })

  it('refuses an entry the mount path would not parse', async () => {
    const project = makeProject({ alpha: { command: 'npx', args: ['old'] } })
    const document = join(project.root, '.dsh', 'mcp.json')
    const before = readFileSync(document, 'utf8')
    const { runtime } = harness()
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session).agent]))
    await runtime.syncNow()

    const target = saveRow(runtime, 'alpha')
    const outcome = await runtime.saveEntry({
      projectRoot: project.root,
      server: 'alpha',
      document: target.document,
      revision: target.revision,
      entry: { transport: 'stdio', args: ['no command'] },
    })

    expect(outcome).toMatchObject({ ok: false, code: 'invalid' })
    if (!outcome.ok) expect(outcome.message).toContain('command')
    expect(readFileSync(document, 'utf8')).toBe(before)
  })

  it('reports failed and leaves the document when the write cannot start', async () => {
    const project = makeProject({ alpha: { command: 'npx', args: ['old'] } })
    const document = join(project.root, '.dsh', 'mcp.json')
    const before = readFileSync(document, 'utf8')
    mkdirSync(`${document}.bak`)
    const { runtime } = harness()
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session).agent]))
    await runtime.syncNow()

    const target = saveRow(runtime, 'alpha')
    const outcome = await runtime.saveEntry({
      projectRoot: project.root,
      server: 'alpha',
      document: target.document,
      revision: target.revision,
      entry: { ...target.entry, args: ['new'] },
    })

    expect(outcome).toMatchObject({ ok: false, code: 'failed' })
    expect(readFileSync(document, 'utf8')).toBe(before)
  })

  it('gates the global tier on both consent and allowGlobalWrite', async () => {
    const home = tmp()
    mkdirSync(join(home, 'dsh'), { recursive: true })
    const document = join(home, 'dsh', 'mcp.json')
    const before = JSON.stringify({ mcpServers: { alpha: { command: 'npx', args: ['old'] } } })
    writeFileSync(document, before)
    vi.stubEnv('HOME', home)
    vi.stubEnv('DSH_HOME', join(home, 'dsh'))
    const project = makeProject({})

    const readGlobal = async (overrides: Partial<RuntimeConfig>) => {
      const { runtime } = harness([], { globalFiles: ['$DSH_HOME/mcp.json'], ...overrides })
      runtime.attach(new FakeScope([fakeAgent('session-1', project.session).agent]))
      await runtime.syncNow()
      return runtime
    }

    const closed = await readGlobal({})
    const closedRow = closed.snapshot().projects[0]?.rows.find((candidate) => candidate.name === 'alpha')
    expect(closedRow?.source).toBe(document)
    expect(closedRow?.writeScope).toBe('global')
    expect(closedRow?.writeBlockedReason).toContain('allowGlobalWrite')
    const target = saveRow(closed, 'alpha')
    expect(
      await closed.saveEntry({
        projectRoot: project.root,
        server: 'alpha',
        document: target.document,
        revision: target.revision,
        consent: true,
        entry: { ...target.entry, args: ['new'] },
      }),
    ).toMatchObject({ ok: false, code: 'blocked' })

    const open = await readGlobal({ allowGlobalWrite: true })
    const openTarget = saveRow(open, 'alpha')
    expect(
      await open.saveEntry({
        projectRoot: project.root,
        server: 'alpha',
        document: openTarget.document,
        revision: openTarget.revision,
        entry: { ...openTarget.entry, args: ['no consent'] },
      }),
    ).toMatchObject({ ok: false, code: 'blocked' })

    expect(readFileSync(document, 'utf8')).toBe(before)
    const outcome = await open.saveEntry({
      projectRoot: project.root,
      server: 'alpha',
      document: openTarget.document,
      revision: openTarget.revision,
      consent: true,
      entry: { ...openTarget.entry, args: ['new'] },
    })
    expect(outcome.ok).toBe(true)
    expect(JSON.parse(readFileSync(document, 'utf8'))).toEqual({
      mcpServers: { alpha: { command: 'npx', args: ['new'] } },
    })
    expect(readFileSync(`${document}.bak`, 'utf8')).toBe(before)
  })
})

describe('save and policy refusals carry message codes (F-48)', () => {
  /** Substitute the way the harness seat does, for the byte-identity check. */
  const fill = (template: string, params: Record<string, string>): string =>
    template.replace(/\{(\w+)\}/g, (whole, name: string) => params[name] ?? whole)

  /**
   * The refusal carries `messageCode`, and its en template with the emitted
   * params fills back to the byte-identical `message`.
   */
  const expectCoded = (
    outcome: { ok: boolean; message?: string; messageCode?: string; messageParams?: Record<string, string> },
    code: keyof typeof hostEn,
    params?: Record<string, string>,
  ): void => {
    expect(outcome.ok).toBe(false)
    expect(outcome.messageCode).toBe(code)
    if (params !== undefined) expect(outcome.messageParams).toEqual(params)
    expect(fill(hostEn[code], outcome.messageParams ?? {})).toBe(outcome.message)
  }

  /** A runtime built without a policy store refuses before it looks at anything else. */
  const bare = (): ProjectMcpRuntime =>
    new ProjectMcpRuntime(
      { logger: { debug: () => undefined, info: () => undefined, warn: () => undefined } } as unknown as Context,
      config(),
      {},
    )

  it('codes the no-store refusal of the pin and mode writes', () => {
    const runtime = bare()
    expectCoded(
      runtime.setPin({ projectRoot: '/repo', tool: 'mcp__alpha__run', pinned: true }),
      'save.noPolicyStore',
    )
    expectCoded(runtime.setPolicy({ projectRoot: '/repo', mode: 'off' }), 'save.noPolicyStore')
    // A store-less choice write for a project nothing mounted names the project first.
    expectCoded(
      runtime.setConflictChoice({ projectRoot: '/repo', server: 'alpha', choice: 'local' }),
      'save.noLiveSession',
      { projectRoot: '/repo' },
    )
  })

  it('codes the unknown-mode and unknown-choice refusals with the value stringified', () => {
    const runtime = bare()
    expectCoded(
      runtime.setPolicy({ projectRoot: '/repo', mode: 'strange' as never }),
      'save.unknownMode',
      { mode: '"strange"' },
    )
    expectCoded(
      runtime.setConflictChoice({ projectRoot: '/repo', server: 'alpha', choice: 'strange' as never }),
      'save.unknownChoice',
      { choice: '"strange"' },
    )
  })

  it('codes the no-live-session refusal of all three policy writes', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime } = harness()
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session).agent]))
    await runtime.syncNow()

    expectCoded(
      runtime.setPin({ projectRoot: '/tmp/none', tool: 'mcp__alpha__run', pinned: true }),
      'save.noLiveSession',
      { projectRoot: '/tmp/none' },
    )
    expectCoded(runtime.setPolicy({ projectRoot: '/tmp/none', mode: 'off' }), 'save.noLiveSession', {
      projectRoot: '/tmp/none',
    })
    expectCoded(
      runtime.setConflictChoice({ projectRoot: '/tmp/none', server: 'alpha', choice: 'local' }),
      'save.noLiveSession',
      { projectRoot: '/tmp/none' },
    )
    await runtime.disposeAll()
  })

  it('codes the not-declared and declared-elsewhere refusals', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime } = harness()
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session).agent]))
    await runtime.syncNow()

    const target = saveRow(runtime, 'alpha')
    const base = { projectRoot: project.root, revision: target.revision, entry: target.entry }
    expectCoded(
      await runtime.saveEntry({ ...base, server: 'missing', document: target.document }),
      'save.serverNotDeclared',
      { server: 'missing', projectRoot: project.root },
    )
    expectCoded(
      await runtime.saveEntry({ ...base, server: 'alpha', document: join(project.root, 'elsewhere.json') }),
      'save.declaredElsewhere',
      { server: 'alpha', document: target.document },
    )
    await runtime.disposeAll()
  })

  it('codes the gone and changed refusals of the document under the save', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const document = join(project.root, '.dsh', 'mcp.json')
    const { runtime } = harness()
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session).agent]))
    await runtime.syncNow()

    const target = saveRow(runtime, 'alpha')
    rmSync(document)
    expectCoded(
      await runtime.saveEntry({
        projectRoot: project.root,
        server: 'alpha',
        document: target.document,
        revision: target.revision,
        entry: target.entry,
      }),
      'save.documentGone',
      { document },
    )

    writeFileSync(document, JSON.stringify({ mcpServers: { alpha: { command: 'npx', args: ['elsewhere'] } } }))
    expectCoded(
      await runtime.saveEntry({
        projectRoot: project.root,
        server: 'alpha',
        document: target.document,
        revision: target.revision,
        entry: target.entry,
      }),
      'save.documentChanged',
      { document },
    )
    await runtime.disposeAll()
  })

  it('codes the invalid-JSON and no-mcpServers refusals of a document read fresh', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const document = join(project.root, '.dsh', 'mcp.json')
    const { runtime } = harness()
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session).agent]))
    await runtime.syncNow()

    const target = saveRow(runtime, 'alpha')
    // The revision always matches the text as read: the editor's own revision
    // of the broken text, so the revision check passes and the parse refuses.
    writeFileSync(document, '{broken')
    const broken = await runtime.saveEntry({
      projectRoot: project.root,
      server: 'alpha',
      document: target.document,
      revision: documentRevision('{broken'),
      entry: target.entry,
    })
    expect(broken).toMatchObject({ ok: false, code: 'invalid', messageCode: 'save.invalidJson' })
    if (!broken.ok) {
      expect(broken.messageParams?.document).toBe(document)
      expect(fill(hostEn['save.invalidJson'], broken.messageParams ?? {})).toBe(broken.message)
    }

    const flat = JSON.stringify({ servers: { alpha: { command: 'npx' } } })
    writeFileSync(document, flat)
    expectCoded(
      await runtime.saveEntry({
        projectRoot: project.root,
        server: 'alpha',
        document: target.document,
        revision: documentRevision(flat),
        entry: target.entry,
      }),
      'save.noMcpServers',
      { document },
    )
    await runtime.disposeAll()
  })

  it('codes the no-longer-declared refusal', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const document = join(project.root, '.dsh', 'mcp.json')
    const { runtime } = harness()
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session).agent]))
    await runtime.syncNow()

    const target = saveRow(runtime, 'alpha')
    const renamed = JSON.stringify({ mcpServers: { beta: { command: 'npx' } } })
    writeFileSync(document, renamed)
    expectCoded(
      await runtime.saveEntry({
        projectRoot: project.root,
        server: 'alpha',
        document: target.document,
        revision: documentRevision(renamed),
        entry: target.entry,
      }),
      'save.noLongerDeclared',
      { server: 'alpha', document },
    )
    await runtime.disposeAll()
  })

  it('reuses the parse code of an entry the mount path would not mount', async () => {
    const project = makeProject({ alpha: { command: 'npx', args: ['old'] } })
    const { runtime } = harness()
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session).agent]))
    await runtime.syncNow()

    const target = saveRow(runtime, 'alpha')
    const outcome = await runtime.saveEntry({
      projectRoot: project.root,
      server: 'alpha',
      document: target.document,
      revision: target.revision,
      entry: { transport: 'stdio', args: ['no command'] },
    })

    // The refusal's prose is the parser's own sentence, so its code is the
    // parser's own code — `save.entryNotParsed` names only the fallback shape.
    expect(outcome).toMatchObject({ ok: false, code: 'invalid', messageCode: 'parse.entry.noCommand' })
    if (!outcome.ok) {
      expect(fill(hostEn['parse.entry.noCommand'], outcome.messageParams ?? {})).toBe(outcome.message)
    }
    await runtime.disposeAll()
  })

  it('codes the write failure with the document and the error', async () => {
    const project = makeProject({ alpha: { command: 'npx', args: ['old'] } })
    const document = join(project.root, '.dsh', 'mcp.json')
    mkdirSync(`${document}.bak`)
    const { runtime } = harness()
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session).agent]))
    await runtime.syncNow()

    const target = saveRow(runtime, 'alpha')
    const outcome = await runtime.saveEntry({
      projectRoot: project.root,
      server: 'alpha',
      document: target.document,
      revision: target.revision,
      entry: { ...target.entry, args: ['new'] },
    })

    expect(outcome).toMatchObject({ ok: false, code: 'failed', messageCode: 'save.writeFailed' })
    if (!outcome.ok) {
      expect(outcome.messageParams?.document).toBe(document)
      expect(typeof outcome.messageParams?.error).toBe('string')
      expect(fill(hostEn['save.writeFailed'], outcome.messageParams ?? {})).toBe(outcome.message)
    }
    await runtime.disposeAll()
  })

  it('codes the consent and disabled refusals of the global tier', async () => {
    const home = tmp()
    mkdirSync(join(home, 'dsh'), { recursive: true })
    const document = join(home, 'dsh', 'mcp.json')
    writeFileSync(document, JSON.stringify({ mcpServers: { alpha: { command: 'npx', args: ['old'] } } }))
    vi.stubEnv('HOME', home)
    vi.stubEnv('DSH_HOME', join(home, 'dsh'))
    const project = makeProject({})

    const { runtime } = harness([], { globalFiles: ['$DSH_HOME/mcp.json'], allowGlobalWrite: true })
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session).agent]))
    await runtime.syncNow()
    const target = saveRow(runtime, 'alpha')
    expectCoded(
      await runtime.saveEntry({
        projectRoot: project.root,
        server: 'alpha',
        document: target.document,
        revision: target.revision,
        entry: { ...target.entry, args: ['no consent'] },
      }),
      'save.needsConsent',
      { document },
    )
    await runtime.disposeAll()

    const { runtime: gated } = harness([], { globalFiles: ['$DSH_HOME/mcp.json'] })
    gated.attach(new FakeScope([fakeAgent('session-2', project.session).agent]))
    await gated.syncNow()
    const gatedTarget = saveRow(gated, 'alpha')
    expectCoded(
      await gated.saveEntry({
        projectRoot: project.root,
        server: 'alpha',
        document: gatedTarget.document,
        revision: gatedTarget.revision,
        consent: true,
        entry: { ...gatedTarget.entry, args: ['new'] },
      }),
      'save.globalDisabled',
    )
    await gated.disposeAll()
  })
})

describe('subscribe', () => {
  it('announces the first picture to a new listener and stops after its disposer', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime } = harness()
    const { agent } = fakeAgent('session-1', project.session)
    runtime.attach(new FakeScope([agent]))

    const revisions: number[] = []
    const stop = runtime.subscribe((change) => revisions.push(change.revision))

    // Opening a stream hands the current picture immediately, or a panel would
    // wait for the next change before painting anything at all.
    expect(revisions).toEqual([0])

    await runtime.syncNow()
    expect(revisions.length).toBeGreaterThan(1)

    const announced = revisions.length
    stop()
    await runtime.syncNow()
    expect(revisions).toHaveLength(announced)
  })

  it('reports a listener that throws on its first picture without failing the subscribe', () => {
    const { runtime, warnings } = harness()

    const stop = runtime.subscribe(() => {
      throw new Error('boom')
    })

    expect(warnings.some((line) => line.includes('announcing the first snapshot failed'))).toBe(true)
    stop()
  })
})

describe('agent lifecycle', () => {
  it('drops a session whose own scope disposes before the event reaches the plugin', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime } = harness()
    const { agent, ctx } = fakeAgent('session-1', project.session)
    // The agent is listed (a pass must not read it as abandoned) and announced:
    // the creation event is the path that installs the disposal effect on the
    // agent's own context.
    const scope = new FakeScope([agent])
    runtime.attach(scope)

    scope.emit('agent/created', { agent })
    // `syncNow()` answers as soon as the pass is queued, so the session's own
    // project is read on the pass that follows.
    await runtime.syncNow()
    await sleep(20)
    expect(runtime.snapshot().projects.flatMap((project) => project.sessionIds)).toContain('session-1')

    // What the host does when it disposes the agent without a matching event:
    // the effect the plugin installed on the agent's own context runs, and the
    // session must go with it rather than keep its mounts alive.
    const factory = ctx.effects.at(-1)
    expect(factory).toBeDefined()
    const disposer = factory?.() as (() => void) | undefined
    disposer?.()

    expect(
      runtime.snapshot().projects.flatMap((project) => project.sessionIds),
    ).not.toContain('session-1')
  })
})

/**
 * The logs ring as the snapshot carries it.
 *
 * The tab draws itself from the snapshot, so the newest page and both counters
 * have to travel with it; the levels are the ones the tab colours rows by, and a
 * project with no history must carry no list at all.
 */
describe('log events in the snapshot', () => {
  it('publishes the newest page, the ring size and the session count', async () => {
    clearLogs()
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime } = harness()
    const { agent } = fakeAgent('session-1', project.session)
    runtime.attach(new FakeScope([agent]))

    await runtime.syncNow()
    await waitFor(() => runtime.snapshot().projects[0]?.rows[0]?.status === 'active')

    // Registration and the first sight of the tools: two events, two levels.
    const mounted = runtime.snapshot().projects[0]
    expect(mounted?.logs?.map((event) => [event.level, event.server])).toEqual([
      ['info', 'alpha'],
      ['up', 'alpha'],
    ])
    expect(mounted?.logs?.[0]).toMatchObject({
      projectRoot: project.root,
      sessionId: 'session-1',
      server: 'alpha',
    })
    expect(mounted?.logs?.[0]?.message).toMatch(
      /^mounting for session session-1 \(trigger: \w+; one shared instance for every session of this project\)$/,
    )
    expect(mounted?.logs?.[1]?.message).toMatch(/^is up — tools visible to session session-1 after /)
    expect(mounted?.logCount).toBe(2)
    expect(mounted?.sessions[0]?.logCount).toBe(2)

    // A ring longer than one page: the snapshot carries the page, the count the
    // whole history behind it.
    for (let at = 1; at <= 60; at += 1) {
      recordLog({ at, level: 'warn', projectRoot: project.root, server: 'beta', message: `filler ${at}` })
    }
    const grown = runtime.snapshot().projects[0]
    expect(grown?.logs).toHaveLength(LOG_PAGE_SIZE)
    expect(grown?.logCount).toBe(2 + 60)
  })

  it('leaves a project that recorded nothing without a list or a count', async () => {
    clearLogs()
    const project = makeProject({})
    const { runtime } = harness()
    const { agent } = fakeAgent('session-1', project.session)
    runtime.attach(new FakeScope([agent]))

    await runtime.syncNow()

    const quiet = runtime.snapshot().projects[0]
    expect(quiet?.projectRoot).toBe(project.root)
    expect(quiet?.logs).toBeUndefined()
    expect(quiet?.logCount).toBeUndefined()
    expect(quiet?.sessions[0]?.logCount).toBeUndefined()
  })

  it('records a failed mount as an error carrying its three facts', async () => {
    clearLogs()
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime, armActivationFailure } = harness()
    const { agent } = fakeAgent('session-1', project.session)
    // The declaration mounts in the project's shared home — the one double whose
    // activation this test can fail — and reaches the preset-shaped session
    // through the bridge.
    bindScopeParent(agent, { agentPreset: 'standard' })
    armActivationFailure('boom')
    runtime.attach(new FakeScope([agent]))

    await runtime.syncNow()
    await waitFor(() => runtime.snapshot().projects[0]?.rows[0]?.status === 'error')

    const failure = runtime.snapshot().projects[0]?.logs?.find((event) => event.level === 'error')
    expect(failure).toMatchObject({ server: 'alpha', message: 'mount failed — boom' })
    expect(failure?.detail).toContain('mount failed — boom')
    expect(failure?.detail).toContain('endpoint: stdio npx')
    expect(failure?.detail).toContain('declared in:')
    // The row already offers the retry; the event carries facts, not advice.
    expect(failure?.detail).not.toContain('retry')

    // Tearing the failed instance down is the tail of that failure, and the tab
    // keeps it red rather than downgrading it to a warning.
    armActivationFailure(undefined)
    rewrite(project.root, {})
    await runtime.syncNow()

    const unmount = runtime
      .snapshot()
      .projects[0]?.logs?.find((event) => event.message.startsWith('unmounting'))
    expect(unmount?.level).toBe('error')
  })

  it('records the release of a healthy mount as a warning that names the reason', async () => {
    clearLogs()
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime } = harness()
    const { agent } = fakeAgent('session-1', project.session)
    runtime.attach(new FakeScope([agent]))

    await runtime.syncNow()
    await waitFor(() => runtime.snapshot().projects[0]?.rows[0]?.status === 'active')

    rewrite(project.root, {})
    await runtime.syncNow()

    const unmount = runtime
      .snapshot()
      .projects[0]?.logs?.find((event) => event.message.startsWith('unmounting'))
    expect(unmount).toMatchObject({ level: 'warn', server: 'alpha', projectRoot: project.root })
    expect(unmount?.message).toContain('the documents no longer declare it')
    // One shared instance serves every session, so its release is a project
    // event: the lifecycle line names no session, and neither does the event.
    expect(unmount?.sessionId).toBeUndefined()
  })
})

/**
 * The lifecycle channel's wire codes (F-48): every event the runtime publishes
 * and every idle/error detail it puts on a row carries its `code`/`params`
 * companions beside prose that stays byte-identical — checked by filling the
 * `en` table of `projectMcp.host` with the emitted params and comparing
 * against the emitted `message`/`detail` itself.
 */
describe('lifecycle events carry their wire codes (F-48)', () => {
  /** Substitute the way the harness seat does, for the byte-identity check. */
  const fill = (template: string, params: Record<string, string>): string =>
    template.replace(/\{(\w+)\}/g, (whole, name: string) => params[name] ?? whole)

  /**
   * The params a bound seat is called with: `*Code` values resolved two-level
   * through the `en` table and substituted under the plain name.
   */
  const resolveNested = (
    params: Record<string, string> | undefined,
  ): Record<string, string> => {
    const resolved: Record<string, string> = {}
    for (const [name, value] of Object.entries(params ?? {})) {
      if (name.endsWith('Code')) {
        const nested = hostEn[value as keyof typeof hostEn] as string | undefined
        expect(nested, `unknown nested code ${value}`).toBeDefined()
        resolved[name.slice(0, -'Code'.length)] = nested ?? value
      } else {
        resolved[name] = value
      }
    }
    return resolved
  }

  /** The event carries `code`, and its en template fills back to `message`. */
  const expectCoded = (
    event: { code?: string; params?: Record<string, string>; message: string } | undefined,
    code: keyof typeof hostEn,
  ): void => {
    expect(event, `an event coded ${code}`).toBeDefined()
    expect(event?.code).toBe(code)
    expect(fill(hostEn[code], resolveNested(event?.params))).toBe(event?.message)
  }

  it('codes the mounting and is-up events beside their byte-identical prose', async () => {
    clearLogs()
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime } = harness()
    const { agent } = fakeAgent('session-1', project.session)
    runtime.attach(new FakeScope([agent]))

    await runtime.syncNow()
    await waitFor(() => runtime.snapshot().projects[0]?.rows[0]?.status === 'active')

    const [mounting, up] = runtime.snapshot().projects[0]?.logs ?? []
    expectCoded(mounting, 'mount.starting')
    expect(mounting?.params).toMatchObject({
      sessionId: 'session-1',
      trigger: 'operator',
      sharingCode: 'mount.sharingShared',
    })
    expectCoded(up, 'mount.up')
    expect(up?.params?.sessionId).toBe('session-1')
    expect(up?.params?.elapsed).toMatch(/^\d/)
  })

  it('codes a failed mount, its three-fact detail, and the issue it republishes', async () => {
    clearLogs()
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime, armActivationFailure } = harness()
    const { agent } = fakeAgent('session-1', project.session)
    bindScopeParent(agent, { agentPreset: 'standard' })
    armActivationFailure('boom')
    runtime.attach(new FakeScope([agent]))

    await runtime.syncNow()
    await waitFor(() => runtime.snapshot().projects[0]?.rows[0]?.status === 'error')

    const failure = runtime.snapshot().projects[0]?.logs?.find((event) => event.level === 'error')
    expectCoded(failure, 'mount.failed')
    expect(failure?.params).toEqual({ error: 'boom' })
    expect(failure?.detailCode).toBe('mount.failedDetail')
    expect(failure?.detailParams).toEqual({
      name: 'alpha',
      error: 'boom',
      endpoint: 'stdio npx',
      source: join(project.root, '.dsh', 'mcp.json'),
    })
    // One code, one template with the newlines: the composite detail fills
    // back byte-identically.
    expect(fill(hostEn['mount.failedDetail'], failure?.detailParams ?? {})).toBe(failure?.detail)

    // The row carries the same companions, so its detail translates too.
    const row = runtime.snapshot().projects[0]?.rows[0]
    expect(row?.detailCode).toBe('mount.failedDetail')
    expect(row?.detailParams).toEqual(failure?.detailParams)
    expect(row?.detail).toBe(failure?.detail)

    // mountDiagnostics republishes the detail as a SnapshotIssue, code included.
    await runtime.syncNow()
    const issue = runtime
      .snapshot()
      .projects[0]?.issues.find((entry) => entry.server === 'alpha')
    expect(issue?.code).toBe('mount.failedDetail')
    expect(issue?.params).toEqual(failure?.detailParams)
    expect(issue?.message).toBe(failure?.detail)

    // Tearing the failed instance down names its reason as a code, and the
    // event still carries the failure's coded detail.
    rewrite(project.root, {})
    await runtime.syncNow()
    const unmount = runtime
      .snapshot()
      .projects[0]?.logs?.find((event) => event.message.startsWith('unmounting'))
    expectCoded(unmount, 'unmounting')
    expect(unmount?.params?.reasonCode).toBe('unmount.reason.undeclared')
    expect(unmount?.detailCode).toBe('mount.failedDetail')
  })

  it('codes an operator retry as the unmount reason', async () => {
    clearLogs()
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime, armActivationFailure } = harness()
    const { agent } = fakeAgent('session-1', project.session)
    armActivationFailure('boom')
    runtime.attach(new FakeScope([agent]))

    await runtime.syncNow()
    await waitFor(() => runtime.snapshot().projects[0]?.rows[0]?.status === 'error')

    await runtime.retry(project.root)

    const retried = runtime
      .snapshot()
      .projects[0]?.logs?.find((event) => event.code === 'unmounting')
    expectCoded(retried, 'unmounting')
    expect(retried?.params?.reasonCode).toBe('unmount.reason.operatorRetry')
    armActivationFailure(undefined)
  })

  it('codes a release on request: the unmount reason and the idle row detail', async () => {
    clearLogs()
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime } = harness()
    const { agent } = fakeAgent('session-1', project.session)
    runtime.attach(new FakeScope([agent]))

    await runtime.syncNow()
    await waitFor(() => runtime.snapshot().projects[0]?.rows[0]?.status === 'active')

    await runtime.release('session-1')

    const unmount = runtime
      .snapshot()
      .projects[0]?.logs?.find((event) => event.code === 'unmounting')
    expectCoded(unmount, 'unmounting')
    expect(unmount?.params?.reasonCode).toBe('unmount.reason.operatorReleased')

    const row = runtime.snapshot().projects[0]?.rows[0]
    expect(row?.status).toBe('idle')
    expect(row?.detailCode).toBe('idle.releasedRequest')
    expect(row?.detailParams).toEqual({ count: '1' })
    expect(fill(hostEn['idle.releasedRequest'], row?.detailParams ?? {})).toBe(row?.detail)
  })

  it('codes an idle-timeout release with its seconds and count', async () => {
    clearLogs()
    const project = makeProject({ alpha: { command: 'npx' } })
    const { runtime } = harness([], { idleTimeoutMs: 1 })
    const { agent } = fakeAgent('session-1', project.session)
    runtime.attach(new FakeScope([agent]))

    await runtime.syncNow()
    await waitFor(() => runtime.snapshot().projects[0]?.rows[0]?.status === 'active')
    await sleep(10)
    await runtime.syncNow()

    const row = runtime.snapshot().projects[0]?.rows[0]
    expect(row?.status).toBe('idle')
    expect(row?.detailCode).toBe('idle.releasedInactive')
    expect(row?.detailParams?.count).toBe('1')
    expect(row?.detailParams?.seconds).toMatch(/^\d+\.\ds$/)
    expect(fill(hostEn['idle.releasedInactive'], row?.detailParams ?? {})).toBe(row?.detail)

    const unmount = runtime
      .snapshot()
      .projects[0]?.logs?.find((event) => event.code === 'unmounting')
    expectCoded(unmount, 'unmounting')
    expect(unmount?.params?.reasonCode).toBe('unmount.reason.sessionIdle')
  })

  it('codes the disabled and the lazy row details', async () => {
    clearLogs()
    const disabled = makeProject({ alpha: { command: 'npx', enabled: false } })
    const { runtime } = harness()
    const { agent } = fakeAgent('session-1', disabled.session)
    runtime.attach(new FakeScope([agent]))

    await runtime.syncNow()
    const disabledRow = runtime.snapshot().projects[0]?.rows[0]
    expect(disabledRow?.status).toBe('disabled')
    expect(disabledRow?.detailCode).toBe('idle.disabled')
    expect(fill(hostEn['idle.disabled'], {})).toBe(disabledRow?.detail)

    const lazyProject = makeProject({ beta: { command: 'npx' } })
    const lazyRuntime = harness([], { lazy: true })
    const { agent: lazyAgent } = fakeAgent('session-2', lazyProject.session)
    lazyRuntime.runtime.attach(new FakeScope([lazyAgent]))

    // The attach pass is no operator call: with `lazy` on it publishes the
    // declaration as idle and mounts nothing (`tests/lazy.spec.ts` drives the
    // same pass the same way).
    await waitFor(
      () =>
        (lazyRuntime.runtime
          .snapshot()
          .projects.find((entry) => entry.projectRoot === lazyProject.root)?.rows.length ?? 0) > 0,
    )
    const lazyRow = lazyRuntime.runtime
      .snapshot()
      .projects.find((entry) => entry.projectRoot === lazyProject.root)?.rows[0]
    expect(lazyRow?.status).toBe('idle')
    expect(lazyRow?.detailCode).toBe('idle.lazy')
    expect(lazyRow?.detailParams).toBeUndefined()
    expect(fill(hostEn['idle.lazy'], {})).toBe(lazyRow?.detail)
  })

  it('codes the reason when a session moves to another project', async () => {
    clearLogs()
    const first = makeProject({ alpha: { command: 'npx' } })
    const second = makeProject({ beta: { command: 'npx' } })
    const { runtime } = harness()
    const { agent } = fakeAgent('session-1', first.session)
    runtime.attach(new FakeScope([agent]))

    await runtime.syncNow()
    await waitFor(() => runtime.snapshot().projects[0]?.rows[0]?.status === 'active')

    ;(agent.session as { header: { cwd: string } }).header.cwd = second.session
    await runtime.syncNow()

    // The project the session left drops out of the snapshot with its last
    // session, but the ring keeps the unmount event the teardown published.
    const moved = latest(first.root, 200).find((event) => event.code === 'unmounting')
    expectCoded(moved, 'unmounting')
    expect(moved?.params?.reasonCode).toBe('unmount.reason.sessionMoved')
  })
})
