/**
 * F-19 spike: does forwarding actually work on the harness?
 *
 * The bridge the contract asks for keeps one `mcp-client` per project and mints
 * a thin definition per session that executes the project's own. Whether that
 * is POSSIBLE is a harness question, not a design preference, so this file
 * answers it before any runtime integration and against the harness's own
 * machinery rather than a hand-written model of it:
 *
 * - `Context`, `ctx.plugin`, `ctx.effect` and `createScope` are the real
 *   `@deepseek-ai/cordis` and `@deepseek-ai/dsh-scope` packages the plugin
 *   already depends on;
 * - the registry's scope resolution is the real `ScopedLayers`/`NamedEntries`
 *   store — the exact implementation `ToolRuntime` builds its layers on
 *   (`packages/core/tools/src/index.ts`: `private readonly layers = new ScopedLayers(…)`);
 * - registrations are made from real scope contexts, so a registration made
 *   through `scope.ctx` lands in that scope's layer or the spike fails.
 *
 * The one thing that is NOT the harness is the registry method envelope:
 * `@deepseek-ai/dsh-tools` is a peer the plugin does not import (and this
 * repository does not declare), so the facade below mirrors its documented
 * surface — `register`, `get(name, scope)`, `schemas(scope)`, `execute` — over
 * the real store. Every fact the bridge relies on is therefore carried by
 * harness code except that envelope.
 *
 * @module tests/bridge
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { NamedEntries, ScopedLayers, bindScopeParent, createScope, scopeChainOf } from '@deepseek-ai/dsh-scope'
import type { Scope, ScopeKey } from '@deepseek-ai/dsh-scope'
import { describe, expect, it } from 'vitest'
import {
  ForwardBatch,
  forwardProjectTools,
  projectToolNames,
  type BridgeContextLike,
  type BridgeRegistryLike,
  type ForwardableDefinition,
  type TextBlockLike,
} from '../src/bridge.ts'

// ---- A registry facade over the harness's real scope store ----------------

/** What one registration returns, as the registry's own disposer does. */
interface RegisteredTool {
  readonly definition: ForwardableDefinition
  /** Exact disposer removing this registration from its layer. */
  readonly release: () => void
}

/** One scope's aggregate layer, as `ScopedLayers` requires it. */
interface FacadeLayer {
  readonly tools: NamedEntries<ForwardableDefinition>
  isEmpty(): boolean
}

/**
 * Minimal stand-in for `ctx.tools`, built on the harness's real scoped store.
 *
 * Visibility, shadowing, inheritance and disposal come from `ScopedLayers` +
 * `NamedEntries`; only the four method shapes are local.
 */
class ToolFacade extends Service {
  private readonly store: ScopedLayers<FacadeLayer>
  private readonly registered: RegisteredTool[] = []

  constructor(ctx: Context) {
    super(ctx, 'tools')
    this.store = new ScopedLayers(
      () => {
        const tools = new NamedEntries<ForwardableDefinition>(name => new Error(`duplicate tool "${name}"`))
        return { tools, isEmpty: () => tools.isEmpty() }
      },
      () => { this.ctx.emit('tools/change') },
    )
  }

  /**
   * Register a definition in the calling scope's layer.
   * @param definition - schema plus execution to retain.
   * @returns the exact disposer that removes it.
   */
  register(definition: unknown): () => void {
    const tool = definition as ForwardableDefinition
    const dispose = this.store.effect(this.ctx, layer => layer.tools.insert(tool.name, tool), {
      label: 'tools.register()',
    })
    const record: RegisteredTool = {
      definition: tool,
      release: () => {
        const at = this.registered.indexOf(record)
        if (at >= 0) this.registered.splice(at, 1)
        dispose()
      },
    }
    this.registered.push(record)
    return record.release
  }

  /**
   * Resolve a name as one scope sees it.
   * @param name - registered tool name.
   * @param scope - viewing scope key, or undefined for the global view.
   * @returns the visible definition, or undefined.
   */
  get(name: string, scope?: ScopeKey): ForwardableDefinition | undefined {
    return this.store.merge(scope, layer => layer.tools).get(name)
  }

  /** One definition the facade registered and has not released yet. */
  definitionOf(name: string): ForwardableDefinition | undefined {
    return this.registered.find(record => record.definition.name === name)?.definition
  }

  /**
   * The names one scope resolves, in registry order.
   *
   * `schemas()` answers the same order with the model-facing surface attached;
   * this is the projection a test reads when the claim is about *which* names
   * are in the session's layer, and in what order, rather than about their
   * fields.
   * @param scope - viewing scope key, or undefined for the global view.
   * @returns the visible names, nearest scope last.
   */
  namesIn(scope?: ScopeKey): string[] {
    return [...this.store.merge(scope, layer => layer.tools).keys()]
  }

  /**
   * Schemas one scope resolves: global layer first, then the scope chain,
   * nearest scope last.
   * @param scope - viewing scope key, or undefined for the global view.
   * @returns one model-facing schema per visible tool.
   */
  schemas(scope?: ScopeKey): { name: string; description: string; parameters: Record<string, unknown> }[] {
    return [...this.store.merge(scope, layer => layer.tools).values()].map(definition => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    }))
  }

  /**
   * Run one tool as the harness registry would, keeping the forwarder in the
   * path exactly as `ToolRuntime.execute()` does.
   * @param input - name, arguments, viewing scope.
   * @returns the canonical value the definition's `execute` returned.
   */
  async execute(input: { name: string; arguments: unknown; scope?: ScopeKey }): Promise<unknown> {
    const definition = this.get(input.name, input.scope)
    if (definition === undefined) throw new Error(`unknown tool "${input.name}"`)
    return await definition.execute(input.arguments, {} as never)
  }
}

/**
 * The facade as the test uses it. `ctx.tools` is typed by the harness's
 * `ToolRuntime`, which the test must not depend on (the plugin does not import
 * it), so the surface is narrowed once here instead of at every call.
 */
interface FacadeSurface {
  readonly tools: {
    register(definition: unknown): () => void
  }
}

/** Cordis plugin that provides the facade into a fresh context. */
const provideTools = {
  name: 'bridge-spec-tools',
  apply: (ctx: Context): void => {
    void new ToolFacade(ctx)
  },
}

// ---- Fixtures -------------------------------------------------------------

/** One live instance of a fake MCP server, as its tools report it. */
interface Instance {
  readonly id: number
  disposed: boolean
  readonly calls: string[]
}

/** Mints fake mcp-client instances and counts them, standing in for processes. */
class FakeServers {
  /** Every instance ever mounted, in mount order — the per-project count. */
  readonly instances: Instance[] = []
  /** Live instances, the way a running child process is live. */
  private live = 0
  private count = 0

  /**
   * Mount one server instance into a scope, as `mcp-client` does.
   * @param ctx - scope context the instance's registrations belong to.
   * @returns the instance record.
   */
  mount(ctx: Context): Instance {
    const instance: Instance = { id: ++this.count, disposed: false, calls: [] }
    this.live += 1
    this.instances.push(instance)
    ctx.effect(() => () => {
      instance.disposed = true
      this.live -= 1
    }, 'fake-mcp.instance')
    return instance
  }

  /** Live instance count, i.e. how many child processes would be running. */
  get running(): number {
    return this.live
  }
}

/** Await a condition, or fail the spike with a readable message. */
async function until(what: string, ready: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (ready()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** One tool definition, shaped like the one `mcp-client` registers. */
interface TestDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: Record<string, unknown>; render: (args: unknown, value: unknown) => readonly { type: string }[] }
  timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
  execute(args: unknown, exec?: unknown): Promise<unknown>
}

/** A tool definition carrying the fields a forwarder has to preserve. */
function projectTool(instance: Instance, serverName: string, rawName: string): TestDefinition {
  const name = `mcp__${serverName}__${rawName}`
  return {
    name,
    description: `${rawName} on ${serverName}`,
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
    output: {
      schema: { type: 'object', properties: { instance: { type: 'number' }, call: { type: 'string' } } },
      render: () => [] as { type: string }[],
    },
    timeoutMs: 4242,
    isConcurrencySafe: () => true,
    execute: async (args) => {
      instance.calls.push(`${serverName}:${JSON.stringify(args)}`)
      return { instance: instance.id, call: name }
    },
  }
}

/** One scenario: a real registry, a project scope, and one shared instance. */
interface Scenario {
  readonly root: Context
  readonly tools: ToolFacade
  readonly registry: BridgeRegistryLike
  readonly projectKey: ScopeKey
  readonly project: Scope
  readonly servers: FakeServers
  readonly instance: Instance
  /** Server namespaces the project mounted, as the runtime tracks them. */
  readonly mountedServers: ReadonlySet<string>
}

/**
 * Mount the real tools service, one project scope, and one shared instance.
 * @returns the scenario handles.
 */
async function scenario(): Promise<Scenario> {
  const root = new Context()
  await root.plugin(provideTools)
  const tools = (root as unknown as FacadeSurface).tools as unknown as ToolFacade
  const servers = new FakeServers()
  const projectKey: ScopeKey = { projectRoot: '/tmp/example-project' }
  const project = createScope(root, projectKey)
  const instance = servers.mount(project.ctx)
  await project.ctx.plugin({
    name: 'bridge-spec-mcp-alpha',
    inject: ['tools'],
    apply: (scoped: Context) => {
      ;(scoped as unknown as FacadeSurface).tools.register(projectTool(instance, 'alpha', 'run'))
    },
  })
  await until('project tool registration', () => tools.get('mcp__alpha__run', projectKey) !== undefined)
  return {
    root,
    tools,
    registry: {
      get: (name, scope) => tools.get(name as never, scope),
      schemas: scope => tools.schemas(scope),
    },
    projectKey,
    project,
    servers,
    instance,
    mountedServers: new Set(['alpha']),
  }
}

/**
 * One session whose key the harness already parented (the preset shape).
 *
 * The scope context is returned raw, exactly as the runtime mints it with
 * `createScope`, and the facade is reachable through `ctx.get('tools')`.
 */
async function session(
  root: Context,
  standingKey: ScopeKey,
): Promise<{ key: ScopeKey; scope: Scope; ctx: BridgeContextLike; tools: ToolFacade }> {
  const key: ScopeKey = {}
  // The preset roster binds every composed agent to its standing scope before
  // the agent is published, so the project can never join this chain.
  bindScopeParent(key, standingKey)
  const scope = createScope(root, key)
  let tools!: ToolFacade
  await scope.ctx.plugin({
    name: 'bridge-spec-session',
    inject: ['tools'],
    apply: (inner: Context) => {
      tools = inner.tools as unknown as ToolFacade
    },
  })
  return { key, scope, ctx: scope.ctx as unknown as BridgeContextLike, tools }
}

/**
 * Publish one more definition into a scope's layer, the way a server whose
 * `tools/list` answered late does: registered through a context bound to that
 * scope, so the entry lands in *its* layer and announces `tools/change`.
 * @param scope - the scope whose layer receives the definition.
 * @param definition - the definition to register.
 * @returns the exact releaser.
 */
async function publish(scope: Scope, definition: ForwardableDefinition): Promise<() => void> {
  let release!: () => void
  await scope.ctx.plugin({
    name: `bridge-spec-publish-${definition.name}`,
    inject: ['tools'],
    apply: (ctx: Context) => {
      release = (ctx as unknown as FacadeSurface).tools.register(definition) as () => void
    },
  })
  return release
}

/**
 * A definition shaped like the one `@deepseek-ai/dsh-mcp-client` registers
 * (`createMcpToolDefinition`, `<harness>/packages/mcp/mcp-client/src/tools.ts`).
 *
 * The harness package is a peer this repository does not depend on, so this is
 * its structural double: the same fields, including the `finalizeContent` that
 * rewrites a result with the images the adapter stored while the model-facing
 * projection carried only text. That finalizer is the one field the registry
 * takes from the definition the *session* resolves — which is the forwarder —
 * so a bridge that drops it silently flattens every MCP result.
 * @param instance - the project instance the call is reported on.
 * @param serverName - server namespace, as the tools register under it.
 * @param rawName - the upstream tool name.
 * @returns the definition.
 */
function mcpClientDefinition(
  instance: Instance,
  serverName: string,
  rawName: string,
): ForwardableDefinition {
  const storedImage = { type: 'image' }
  const projections = new WeakMap<object, readonly TextBlockLike[]>()
  const fallback = `[${rawName} text]`
  const definition = {
    name: `mcp__${serverName}__${rawName}`,
    description: `Run ${rawName} on ${serverName}`,
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
    output: {
      schema: { type: 'object', properties: { content: { type: 'array' } } },
      render: () => [{ type: 'text', text: fallback }],
    },
    timeoutMs: 1234,
    isConcurrencySafe: () => true,
    presentCall: (args: unknown) => ({ card: 'mcp-call', args }),
    presentResult: () => ({ card: 'mcp-result' }),
    async execute(args: unknown, exec: unknown): Promise<unknown> {
      instance.calls.push(`${serverName}:${rawName}`)
      projections.set(exec as object, [storedImage])
      return { content: [{ type: 'text', text: fallback }] }
    },
    finalizeContent(exec: unknown, result: unknown): readonly TextBlockLike[] | undefined {
      const image = projections.get(exec as object)
      if (image === undefined) return undefined
      projections.delete(exec as object)
      const outcome = result as { content: readonly TextBlockLike[] }
      return [...outcome.content, ...image]
    },
  }
  return definition as unknown as ForwardableDefinition
}

// ---- The spike ------------------------------------------------------------

describe('F-19 spike: forwarding into a session layer', () => {
  it('keeps one project instance and routes two preset-shaped sessions through it', async () => {
    const { root, tools, registry, projectKey, servers, instance, mountedServers } = await scenario()
    const standing: ScopeKey = { roster: 'web' }

    const first = await session(root, standing)
    const second = await session(root, standing)

    // THE harness fact the bridge exists for: the key was bound by the preset,
    // and `bindScopeParent` is once-only, so the project cannot join the chain.
    expect(() => bindScopeParent(first.key, projectKey)).toThrow(/already bound/)
    expect(scopeChainOf(first.key)).toEqual([first.key, standing])

    const names = projectToolNames(projectKey, scope => tools.schemas(scope), mountedServers)
    expect(names).toEqual(['mcp__alpha__run'])
    const releaseFirst = forwardProjectTools({ ctx: first.ctx, project: projectKey, names, registry })
    const releaseSecond = forwardProjectTools({ ctx: second.ctx, project: projectKey, names, registry })

    // The name is visible in exactly each session's own view...
    expect(tools.schemas(first.key).map(schema => schema.name)).toEqual(['mcp__alpha__run'])
    expect(tools.schemas(second.key).map(schema => schema.name)).toEqual(['mcp__alpha__run'])
    // ...and in nobody else's: an unrelated scope and the global view stay empty.
    expect(tools.schemas({ stranger: true })).toEqual([])
    expect(tools.schemas()).toEqual([])

    // Both sessions resolve their own thin definition, not the project's.
    const projectDefinition = tools.get('mcp__alpha__run', projectKey)
    expect(tools.get('mcp__alpha__run', first.key)).not.toBe(projectDefinition)
    expect(tools.get('mcp__alpha__run', second.key)).not.toBe(projectDefinition)

    // Calling through either session executes the single project instance.
    expect(await tools.execute({ name: 'mcp__alpha__run', arguments: { q: 'one' }, scope: first.key })).toEqual({
      instance: instance.id,
      call: 'mcp__alpha__run',
    })
    expect(await tools.execute({ name: 'mcp__alpha__run', arguments: { q: 'two' }, scope: second.key })).toEqual({
      instance: instance.id,
      call: 'mcp__alpha__run',
    })
    expect(instance.calls).toEqual(['alpha:{"q":"one"}', 'alpha:{"q":"two"}'])
    // ONE instance for the whole project: no second child process was started.
    expect(servers.instances).toHaveLength(1)
    expect(servers.running).toBe(1)

    releaseFirst()
    releaseSecond()
    expect(tools.schemas(first.key)).toEqual([])
    expect(tools.schemas(second.key)).toEqual([])
    // The project keeps its own instance and its own registration.
    expect(tools.schemas(projectKey).map(schema => schema.name)).toEqual(['mcp__alpha__run'])
    expect(servers.running).toBe(1)
  })

  it('steps aside when the session already registers the name', async () => {
    const { root, tools, registry, projectKey, servers, mountedServers } = await scenario()
    const first = await session(root, { roster: 'web' })
    const local = projectTool(servers.instances[0] as Instance, 'alpha', 'run')
    local.execute = async () => ({ instance: -1, call: 'local' })
    first.tools.register(local)

    const names = projectToolNames(projectKey, scope => tools.schemas(scope), mountedServers)
    const release = forwardProjectTools({ ctx: first.ctx, project: projectKey, names, registry })

    // One layer, one winner: the session's own definition keeps the name.
    expect(tools.schemas(first.key).map(schema => schema.name)).toEqual(['mcp__alpha__run'])
    expect(await tools.execute({ name: 'mcp__alpha__run', arguments: {}, scope: first.key })).toEqual({
      instance: -1,
      call: 'local',
    })
    release()
  })

  it('fails a forwarded call once the project instance is gone', async () => {
    const { root, tools, registry, projectKey, project, mountedServers } = await scenario()
    const first = await session(root, { roster: 'web' })
    const names = projectToolNames(projectKey, scope => tools.schemas(scope), mountedServers)
    forwardProjectTools({ ctx: first.ctx, project: projectKey, names, registry })

    // Releasing the project takes its registration with it, exactly as the
    // runtime's last-holder release does. Resolving the delegate per call is
    // what turns that into a readable error instead of a dead generation.
    await project.dispose()
    expect(tools.get('mcp__alpha__run', projectKey)).toBeUndefined()
    await expect(tools.execute({ name: 'mcp__alpha__run', arguments: {}, scope: first.key }))
      .rejects.toThrow(/no longer registered/)
  })

  it('refuses a second batch over a live one, and announces every entry it takes', async () => {
    const { root, tools, registry, projectKey, project, servers, mountedServers } = await scenario()
    const first = await session(root, { roster: 'web' })
    const instance = servers.instances[0] as Instance

    // The double carries the two registry facts a re-sync depends on: a change
    // is announced for every entry, and the announcement follows the insertion.
    const announced: number[] = []
    const detach = first.scope.ctx.on('tools/change', () => announced.push(announced.length))
    await publish(project, projectTool(instance, 'alpha', 'second'))
    await publish(project, projectTool(instance, 'alpha', 'third'))
    expect(announced).toHaveLength(2)

    const names = projectToolNames(projectKey, scope => tools.schemas(scope), mountedServers)
    expect(names).toEqual(['mcp__alpha__run', 'mcp__alpha__second', 'mcp__alpha__third'])
    const release = forwardProjectTools({ ctx: first.ctx, project: projectKey, names, registry })
    expect(tools.namesIn(first.key)).toEqual(names)
    expect(announced).toHaveLength(5)

    // One layer, one entry per name: while the batch above is live, the same
    // name cannot land a second time. This is the duplicate the bridge's
    // step-aside was written for — and over a live batch it is not the session's
    // own tool, so stepping aside there drops the name instead of deferring.
    expect(() => first.tools.register(projectTool(instance, 'alpha', 'second'))).toThrow(/duplicate/)
    const overLive = forwardProjectTools({ ctx: first.ctx, project: projectKey, names, registry })
    expect(tools.namesIn(first.key)).toEqual(names)
    // The abandoned batch releases nothing: the live forwarders stay live.
    overLive()
    expect(tools.namesIn(first.key)).toEqual(names)

    release()
    detach()
    expect(tools.namesIn(first.key)).toEqual([])
    // The project keeps its own three entries throughout.
    expect(tools.namesIn(projectKey)).toEqual(names)
  })

  it('carries the declaring definition through the forwarder, finalizeContent included', async () => {
    const { root, tools, registry, projectKey, project, instance, mountedServers } = await scenario()
    const definition = mcpClientDefinition(instance, 'alpha', 'shot')
    await publish(project, definition)

    const first = await session(root, { roster: 'web' })
    const names = projectToolNames(projectKey, scope => tools.schemas(scope), mountedServers)
    expect(names).toEqual(['mcp__alpha__run', 'mcp__alpha__shot'])
    const release = forwardProjectTools({ ctx: first.ctx, project: projectKey, names, registry })

    const live = tools.get('mcp__alpha__shot', projectKey) as unknown as Record<string, unknown>
    const forwarded = tools.get('mcp__alpha__shot', first.key) as unknown as Record<string, unknown>
    expect(forwarded).not.toBe(live)
    // Everything but the body is the project's own object: schema projection,
    // presentation, the concurrency classifier and the timeout budget are read
    // from the definition the session resolves, which is this forwarder.
    expect(forwarded.finalizeContent).toBe(live.finalizeContent)
    expect(forwarded.presentCall).toBe(live.presentCall)
    expect(forwarded.presentResult).toBe(live.presentResult)
    expect(forwarded.output).toBe(live.output)
    expect(forwarded.timeoutMs).toBe(1234)
    expect(forwarded.isConcurrencySafe).toBe(live.isConcurrencySafe)
    expect(forwarded.description).toBe(live.description)
    expect(forwarded.parameters).toBe(live.parameters)
    expect(forwarded.name).toBe('mcp__alpha__shot')
    expect(forwarded.execute).not.toBe(live.execute)

    // ...and the behaviour behind the field: the image the MCP adapter stored
    // while the model-facing projection carried only text comes back when the
    // session's definition finalizes the same execution.
    const execution = {}
    const value = await (forwarded.execute as (args: unknown, exec: unknown) => Promise<unknown>)({}, execution)
    expect(instance.calls).toEqual(['alpha:shot'])
    const finalizer = forwarded.finalizeContent as (
      exec: unknown,
      result: unknown,
    ) => readonly TextBlockLike[] | undefined
    expect(finalizer(execution, value)).toEqual([
      { type: 'text', text: '[shot text]' },
      { type: 'image' },
    ])
    // The finalizer is the project's own closure: consumed once, like the
    // registry's single snapshot-and-call.
    expect(finalizer(execution, value)).toBeUndefined()
    release()
  })

  it('keeps the project’s exact set and order across a live re-sync, leaving no dead forwarder', async () => {
    const { root, tools, registry, projectKey, project, servers, mountedServers } = await scenario()
    const first = await session(root, { roster: 'web' })
    const instance = servers.instances[0] as Instance
    const projectNames = (): string[] => tools.namesIn(projectKey)

    // The session subscribes exactly as the runtime does, and the batch does the
    // swapping. Registration announces itself through this very event, so each
    // pass below re-enters the batch from inside its own registration — the path
    // that used to release the batch being built and register a second copy.
    const batch = new ForwardBatch({
      names: () => projectToolNames(projectKey, scope => tools.schemas(scope), mountedServers),
      register: (names) => forwardProjectTools({ ctx: first.ctx, project: projectKey, names, registry }),
    })
    const detach = first.scope.ctx.on('tools/change', () => batch.sync())
    batch.sync()

    expect(projectNames()).toEqual(['mcp__alpha__run'])
    expect(tools.namesIn(first.key)).toEqual(projectNames())
    expect(batch.namesIn).toEqual(projectNames())

    // Two tools arrive in one generation, in a fixed order: the session has to
    // end up with the project's whole set in the project's order — not the
    // subset a step-aside left behind, and not the order a nested frame
    // registered the tail in.
    await publish(project, projectTool(instance, 'alpha', 'second'))
    await publish(project, projectTool(instance, 'alpha', 'third'))
    expect(projectNames()).toEqual(['mcp__alpha__run', 'mcp__alpha__second', 'mcp__alpha__third'])
    expect(tools.namesIn(first.key)).toEqual(projectNames())
    expect(batch.namesIn).toEqual(projectNames())

    // A dropped tool takes its forwarder with it: the session's layer mirrors
    // the project's set rather than keeping an entry that resolves to nothing.
    const releaseFourth = await publish(project, projectTool(instance, 'alpha', 'fourth'))
    expect(tools.namesIn(first.key)).toEqual(projectNames())
    releaseFourth()
    expect(projectNames()).toEqual(['mcp__alpha__run', 'mcp__alpha__second', 'mcp__alpha__third'])
    expect(tools.namesIn(first.key)).toEqual(projectNames())
    expect(tools.get('mcp__alpha__fourth', first.key)).toBeUndefined()

    // Every survivor still delegates to the live project entry, which is what
    // makes the batch a forwarding layer rather than a captured generation.
    for (const name of projectNames()) {
      const live = tools.get(name, projectKey)
      const forwarded = tools.get(name, first.key)
      expect(forwarded).toBeDefined()
      expect(forwarded).not.toBe(live)
      expect(await forwarded?.execute({}, {} as never)).toEqual({ instance: instance.id, call: name })
    }
    expect(instance.calls).toEqual(['alpha:{}', 'alpha:{}', 'alpha:{}'])

    batch.drop()
    detach()
    expect(tools.namesIn(first.key)).toEqual([])
    // ...and the project keeps its own entries throughout.
    expect(projectNames()).toEqual(['mcp__alpha__run', 'mcp__alpha__second', 'mcp__alpha__third'])
  })
})
