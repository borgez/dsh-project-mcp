/**
 * F-19 storm: what one MCP generation costs every bridged session.
 *
 * The production profile this file models was measured, not imagined: a 54.6 s
 * stall holding 417k samples, whose root frame was `@deepseek-ai/dsh-mcp-client`'s
 * `syncTools` — ONE synchronous `for` loop calling `ctx.tools.register(definition)`
 * once per tool of one server's `tools/list`. The harness registry announces
 * `tools/change` once per entry applied and once per entry disposed
 * (`ScopedLayers.effect`), so that one loop is a burst of thousands of
 * announcements, and every bridged session watching the project ran a whole
 * forwarding pass per announcement — each pass projecting the project's catalog,
 * which the registry answers by deep-cloning every visible JSON schema. 47% of
 * the samples sat inside the bridge's sync and 52% in the collector those
 * projections feed.
 *
 * The fix this file pins is the seat the subscription takes: {@link ForwardBatch.note},
 * which folds a burst into one queued pass, instead of {@link ForwardBatch.sync},
 * which runs the pass inside the announcement. This file holds that contract
 * against the harness's own machinery rather than a hand-written model:
 *
 * - `Context`, `ctx.plugin` and `createScope` are the real `@deepseek-ai/cordis`
 *   and `@deepseek-ai/dsh-scope` packages;
 * - the registry's visibility, shadowing and disposal are the real
 *   `ScopedLayers`/`NamedEntries` store, the exact implementation `ToolRuntime`
 *   builds its layers on, including the `tools/change` announcement;
 * - the three sessions are bound to one standing preset key before the project's
 *   key could join their chain, which is the bridged shape (`bindScopeParent` is
 *   once-only);
 * - the one generation is published in ONE synchronous loop inside one plugin
 *   apply, which is the `syncTools` shape.
 *
 * Two properties, both asserted per session batch:
 *
 * - **deferred** — while the publishing `apply` is still on the stack, no batch
 *   has run a pass, probed, or minted a forwarder. Registering a tool therefore
 *   never pays for the sessions watching the project.
 * - **coalesced** — one whole generation costs a batch at most two passes: the
 *   pass that replaced its batch, plus the single round its own announcements
 *   re-enter it with. Nothing per announcement.
 *
 * The same generation is then replayed under the wiring that caused the outage
 * (`() => batch.sync()` in the subscription), which must cost an order of
 * magnitude more passes. Its exact number is deliberately not pinned: it grows
 * with the number of watchers and the size of the generation, and a frozen
 * number nobody reads would only break the next time the harness shifts.
 *
 * Probes are bounded one step looser than passes, on purpose. A batch's own
 * replacing pass reads the project's catalog twice — once to find the set, once
 * for the round its registrations re-enter it with — and a *sibling* batch's
 * registrations announce `tools/change` too, so a batch that has already
 * finished its pass is noted again, once, by a sibling's burst: one extra probe,
 * and no extra pass. That cross-talk is why the catalog projections are the
 * expensive part of the storm, and it is asserted rather than smoothed away.
 *
 * **Regression guard.** The fixed run's claims are about cost and timing, not
 * only about the final name set. Replace `FIXED_WIRING`'s `batch.note()` with
 * `batch.sync()` — the revert this file exists for — and it fails twice over:
 * `whileApplying.passes` stops being zero, and every batch's pass count blows
 * past the two-pass ceiling. A test that only compared each session's names to
 * the project's would stay green through exactly that revert, which is why the
 * cost assertions are separate ones.
 *
 * Measured on this harness with a 24-tool generation and three sessions: the
 * fixed wiring pays 3 passes and 8 probes in total, the `sync()` wiring 72
 * passes and 1872 probes for the same generation. The fixed numbers are flat in
 * the generation's size; only the outsized one grows with it.
 *
 * @module tests/bridge-storm
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { NamedEntries, ScopedLayers, bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import type { Scope, ScopeKey } from '@deepseek-ai/dsh-scope'
import { describe, expect, it } from 'vitest'
import {
  ForwardBatch,
  forwardProjectTools,
  projectToolNames,
  type BridgeContextLike,
  type BridgeRegistryLike,
  type ForwardableDefinition,
} from '../src/bridge.ts'

// ---- A registry facade over the harness's real scope store ----------------

/** One scope's aggregate layer, as `ScopedLayers` requires it. */
interface FacadeLayer {
  readonly tools: NamedEntries<ForwardableDefinition>
  isEmpty(): boolean
}

/**
 * Minimal stand-in for `ctx.tools`, built on the harness's real scoped store.
 *
 * Visibility, shadowing, inheritance and disposal come from `ScopedLayers` +
 * `NamedEntries`, and the `tools/change` announcement comes from the store's own
 * `onChange` — the same wiring `ToolRuntime` builds its layers with. Only the
 * method shapes are local, because `@deepseek-ai/dsh-tools` is a peer this
 * repository does not import.
 */
class ToolFacade extends Service {
  private readonly store: ScopedLayers<FacadeLayer>

  /**
   * Build the store over the context this service is provided into.
   * @param ctx - context that owns the service.
   */
  constructor(ctx: Context) {
    super(ctx, 'tools')
    this.store = new ScopedLayers(
      () => {
        const tools = new NamedEntries<ForwardableDefinition>(name => new Error(`duplicate tool "${name}"`))
        return { tools, isEmpty: () => tools.isEmpty() }
      },
      () => {
        this.ctx.emit('tools/change')
      },
    )
  }

  /**
   * Register a definition in the calling scope's layer.
   * @param definition - schema plus execution to retain.
   * @returns the exact disposer that removes it.
   */
  register(definition: unknown): () => void {
    const tool = definition as ForwardableDefinition
    return this.store.effect(this.ctx, layer => layer.tools.insert(tool.name, tool), { label: 'tools.register()' })
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

  /**
   * The names one scope resolves, in registry order.
   *
   * This is the reading the storm's claims are made on: the sessions' layers
   * against the project's own, so a forwarder that landed in the wrong order —
   * or that a nested frame registered as a second copy — is visible as a
   * mismatch rather than as a plausible-looking set.
   * @param scope - viewing scope key, or undefined for the global view.
   * @returns the visible names, nearest scope last.
   */
  namesIn(scope?: ScopeKey): string[] {
    return [...this.store.merge(scope, layer => layer.tools).keys()]
  }

  /**
   * Schemas one scope resolves, as `projectToolNames` probes them.
   * @param scope - viewing scope key, or undefined for the global view.
   * @returns one model-facing schema per visible tool, in registry order.
   */
  schemas(scope?: ScopeKey): { name: string; description: string; parameters: Record<string, unknown> }[] {
    return [...this.store.merge(scope, layer => layer.tools).values()].map(definition => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    }))
  }
}

/**
 * The facade as this test uses it.
 *
 * `ctx.tools` is typed by the harness's `ToolRuntime`, which this file must not
 * reach for — the plugin under test deliberately does not import it — so the
 * surface is narrowed once here instead of casting at every call site.
 */
interface FacadeSurface {
  readonly tools: {
    register(definition: unknown): () => void
  }
}

/** Cordis plugin that provides the facade into a fresh context. */
const provideTools = {
  name: 'bridge-storm-tools',
  apply: (ctx: Context): void => {
    void new ToolFacade(ctx)
  },
}

// ---- Fixtures -------------------------------------------------------------

/** How many tools one MCP generation carries. */
const GENERATION = 24

/** How many bridged sessions watch the project at once. */
const SESSIONS = 3

/** One live instance of a fake MCP server, as its tools report it. */
interface Instance {
  /** Instance identity, reported by every tool it owns. */
  readonly id: number
  /** Calls this instance answered, in order. */
  readonly calls: string[]
}

/** One tool definition, shaped like the one `mcp-client` registers. */
interface TestDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => readonly { type: string }[]
  }
  execute(args: unknown, exec?: unknown): Promise<unknown>
}

/**
 * One tool of the project's shared instance, named the way `mcp-client` names
 * its own: `mcp__<server>__<tool>`.
 *
 * Only the fields a forwarder has to carry are set: the point of the storm is
 * how many times these get registered, not what they execute.
 * @param instance - the shared instance the call is reported on.
 * @param rawName - the upstream tool name, as the server publishes it.
 * @returns the definition.
 */
function projectTool(instance: Instance, rawName: string): TestDefinition {
  const name = `mcp__alpha__${rawName}`
  return {
    name,
    description: `${rawName} on alpha`,
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
    output: {
      schema: { type: 'object', properties: { instance: { type: 'number' }, call: { type: 'string' } } },
      render: () => [],
    },
    execute: async (args) => {
      instance.calls.push(`${rawName}:${JSON.stringify(args)}`)
      return { instance: instance.id, call: name }
    },
  }
}

// ---- The storm ------------------------------------------------------------

/**
 * The counters one session's batch is measured by.
 *
 * They live in a record the batch's own callbacks close over, so the batch
 * neither knows it is being measured nor carries the numbers itself.
 */
interface BatchCost {
  /** How many times the batch asked its `register` callback for a whole batch. */
  passes: number
  /** How many times the batch probed the project's live names. */
  probes: number
}

/** One session's batch together with its counters. */
interface BatchMeter {
  /** The batch whose cost is counted. */
  readonly batch: ForwardBatch
  /** The counters its callbacks increment. */
  readonly cost: BatchCost
}

/** One bridged session: the key the preset bound, its scope, and its batch. */
interface StormSession {
  /** Scope key of the session, parented to the standing preset key. */
  readonly key: ScopeKey
  /** The session's own scope, whose context carries the bridge. */
  readonly scope: Scope
  /** The session's forwarding batch and its counters. */
  readonly meter: BatchMeter
}

/**
 * What the publisher's own frame had already paid when it returned.
 *
 * Read inside the publishing `apply`, so "already" means "with the frame that
 * registered the generation still on the stack" — which is the whole claim.
 */
interface ApplyingCost {
  /** Passes the batches had run in that window, summed over sessions. */
  readonly passes: number
  /** Probes the batches had run in that window, summed over sessions. */
  readonly probes: number
  /** Forwarders visible in each session's layer in that window, in session order. */
  readonly minted: readonly number[]
}

/** Everything one storm run exposes to its assertions. */
interface StormRun {
  /** The registry facade the project and the sessions share. */
  readonly tools: ToolFacade
  /** The project's scope key, whose view the sessions mirror. */
  readonly projectKey: ScopeKey
  /** The bridged sessions, in subscription order. */
  readonly sessions: readonly StormSession[]
  /** What the publishing frame had paid when it returned. */
  readonly whileApplying: ApplyingCost
}

/**
 * The seat a `tools/change` subscription takes.
 *
 * It is a function rather than a flag because this is the exact line the fix
 * moved, and the two variants have to be written out — not selected by a
 * branch that could quietly make both runs take the same seat.
 */
type ChangeWiring = (batch: ForwardBatch) => void

/**
 * The fixed wiring: note the change, run one pass off this stack.
 *
 * Swapping this body to `batch.sync()` is the revert the module note describes,
 * and the fixed run's assertions fail on it.
 * @param batch - the session's batch.
 * @returns nothing; the pass is queued, not run.
 */
const FIXED_WIRING: ChangeWiring = (batch) => {
  batch.note()
}

/**
 * The wiring that caused the outage: run a whole pass inside the announcement.
 *
 * `tools/change` is emitted once per entry, from inside the registry's own
 * insertion, so this runs a replacing pass — and a full catalog projection —
 * once per entry of the generation, for every session watching the project.
 * @param batch - the session's batch.
 * @returns nothing; the pass runs synchronously.
 */
const OUTAGE_WIRING: ChangeWiring = (batch) => {
  batch.sync()
}

/**
 * Let every pass a batch queued run.
 *
 * The fixed wiring answers `tools/change` on the microtask queue — that is what
 * makes a burst of announcements cost one pass — so a claim about what it did
 * has to be made after the queue drains. Two hops are enough for the queue the
 * fixed wiring opens, exactly as `tests/bridge.spec.ts` reads the same property.
 * @returns a promise resolved once the queued passes have run.
 */
async function settled(): Promise<void> {
  await new Promise<void>(resolve => {
    queueMicrotask(() => resolve())
  })
  await new Promise<void>(resolve => {
    queueMicrotask(() => resolve())
  })
}

/**
 * Build one storm and publish one generation into it.
 *
 * Order is the point. The three sessions are subscribed to `tools/change`
 * *before* the generation is published, so the whole `syncTools`-shaped loop
 * reaches them as one burst; and the generation is registered from inside a
 * single `apply`, so the window "still publishing" is observable rather than
 * reconstructed afterwards.
 * @param wiring - the seat the subscription takes.
 * @returns the handles and counters the assertions read.
 */
async function storm(wiring: ChangeWiring): Promise<StormRun> {
  const root = new Context()
  await root.plugin(provideTools)
  const tools = (root as unknown as FacadeSurface).tools as unknown as ToolFacade

  // One instance for the whole project, as the bridge keeps it: the sessions
  // forward, they do not mount a second one.
  const instance: Instance = { id: 1, calls: [] }
  const servers: ReadonlySet<string> = new Set(['alpha'])
  const projectKey: ScopeKey = { projectRoot: '/tmp/example-project' }
  const project = createScope(root, projectKey)

  const registry: BridgeRegistryLike = {
    get: (name, scope) => tools.get(name, scope),
    schemas: scope => tools.schemas(scope),
  }

  const standingKey: ScopeKey = { roster: 'web' }
  const sessions: StormSession[] = []
  for (let index = 0; index < SESSIONS; index += 1) {
    const key: ScopeKey = {}
    // Every composed agent is bound to its preset's standing key before it is
    // published, and `bindScopeParent` is once-only — the project's key can
    // never join this chain, which is the only reason a forwarder exists.
    bindScopeParent(key, standingKey)
    const scope = createScope(root, key)

    const cost: BatchCost = { passes: 0, probes: 0 }
    const batch = new ForwardBatch({
      names: () => {
        cost.probes += 1
        return projectToolNames(projectKey, viewing => tools.schemas(viewing), servers)
      },
      register: (names) => {
        cost.passes += 1
        return forwardProjectTools({
          ctx: scope.ctx as unknown as BridgeContextLike,
          project: projectKey,
          names,
          registry,
        })
      },
    })
    // The seat `src/runtime.ts` `installBridge` takes: `note` folds the burst of
    // `tools/change` into one queued pass; `sync` runs one per announcement.
    scope.ctx.on('tools/change', () => {
      wiring(batch)
    })
    sessions.push({ key, scope, meter: { batch, cost } })
  }

  const applying: { passes: number; probes: number; minted: number[] } = { passes: 0, probes: 0, minted: [] }
  await project.ctx.plugin({
    name: 'bridge-storm-generation',
    inject: ['tools'],
    apply: (ctx: Context) => {
      const facade = ctx as unknown as FacadeSurface
      // One generation, one synchronous loop: the `syncTools` shape the profile
      // was taken under.
      for (let index = 0; index < GENERATION; index += 1) {
        facade.tools.register(projectTool(instance, `gen${index}`))
      }
      // Counted here so the reading is taken with this frame still on the stack:
      // a subscription that ran its pass inside an announcement has paid by now,
      // and one that noted the burst has paid nothing.
      for (const session of sessions) {
        applying.passes += session.meter.cost.passes
        applying.probes += session.meter.cost.probes
        applying.minted.push(tools.namesIn(session.key).length)
      }
    },
  })

  return { tools, projectKey, sessions, whileApplying: applying }
}

/**
 * Sum one run's passes across its sessions.
 * @param run - the storm run to total.
 * @returns the passes every batch paid together.
 */
function totalPasses(run: StormRun): number {
  return run.sessions.reduce((total, session) => total + session.meter.cost.passes, 0)
}

/**
 * Sum one run's probes across its sessions.
 * @param run - the storm run to total.
 * @returns the probes every batch ran together.
 */
function totalProbes(run: StormRun): number {
  return run.sessions.reduce((total, session) => total + session.meter.cost.probes, 0)
}

// ---- The claims -----------------------------------------------------------

describe('F-19 storm: one generation against every bridged session', () => {
  it('defers the whole generation off the publisher’s stack, then pays one pass per batch', async () => {
    const run = await storm(FIXED_WIRING)

    // The publisher's frame paid nothing: every announcement was noted, and the
    // pass waits for the microtask queue. This is the property, not just the
    // number — registering a tool does not pay for the sessions watching it.
    expect(run.whileApplying.passes).toBe(0)
    expect(run.whileApplying.probes).toBe(0)
    // ...and no session had a forwarder yet, which is the same statement in the
    // registry's own terms: the pass is what mints them.
    expect(run.whileApplying.minted).toEqual(run.sessions.map(() => 0))

    // The shape the bridge exists for: the preset bound each key before the
    // project's key existed, and the binding is once-only.
    for (const session of run.sessions) {
      expect(() => bindScopeParent(session.key, run.projectKey)).toThrow(/already bound/)
    }

    await settled()

    const projectNames = run.tools.namesIn(run.projectKey)
    expect(projectNames).toHaveLength(GENERATION)
    for (const session of run.sessions) {
      // The project's exact set, in the project's order: not the subset a
      // step-aside left behind, and not an order a nested frame registered the
      // tail in.
      expect(run.tools.namesIn(session.key)).toEqual(projectNames)
      // One replacing pass plus the single round its own announcements re-enter
      // it with, and nothing per announcement.
      expect(session.meter.cost.passes).toBeLessThanOrEqual(2)
      // Two of the probes are that same pass reading the catalog twice; the
      // third is the bounded cross-talk every sibling's own registrations cause,
      // which costs one catalog projection and no pass. See the module note.
      expect(session.meter.cost.probes).toBeLessThanOrEqual(3)
    }
    // Every tool of the generation announced itself, and the whole burst cost
    // three replacing passes — one per watching session.
    expect(totalPasses(run)).toBeLessThanOrEqual(SESSIONS * 2)
  })

  it('pays a pass per announcement when the subscription takes sync() (the outage wiring)', async () => {
    const fixed = await storm(FIXED_WIRING)
    await settled()
    const outage = await storm(OUTAGE_WIRING)
    await settled()

    const fixedPasses = totalPasses(fixed)
    const outagePasses = totalPasses(outage)
    const fixedProbes = totalProbes(fixed)
    const outageProbes = totalProbes(outage)

    // The contrast at the seat itself: the outage wiring had already run passes
    // while the generation was still being published, and every batch paid far
    // more than the two-pass ceiling the fixed wiring fits in.
    expect(outage.whileApplying.passes).toBeGreaterThan(0)
    for (const session of outage.sessions) {
      expect(session.meter.cost.passes).toBeGreaterThan(2)
    }

    // The claim the outage produced: an order of magnitude more passes for the
    // same generation. Only the factor is pinned — the exact count grows with
    // the number of watchers and the size of the generation, and freezing it
    // would pin a number nobody reads.
    expect(outagePasses).toBeGreaterThan(fixedPasses * 10)
    // ...while both wirings land the same set, which is why the fix was about
    // cost and not about correctness.
    const projectNames = outage.tools.namesIn(outage.projectKey)
    expect(projectNames).toHaveLength(GENERATION)
    for (const session of outage.sessions) {
      expect(outage.tools.namesIn(session.key)).toEqual(projectNames)
    }

    // The measured numbers, printed so a profile comparison has a baseline: the
    // fixed wiring's cost is flat in the number of announcements, the outage
    // wiring's is not. Per batch, `passes/probes`.
    const perBatch = (run: StormRun): string =>
      run.sessions
        .map(session => `${String(session.meter.cost.passes)}p/${String(session.meter.cost.probes)}r`)
        .join(' ')
    console.info(
      `bridge-storm: ${String(GENERATION)} tools x ${String(SESSIONS)} sessions — ` +
        `fixed ${String(fixedPasses)} passes / ${String(fixedProbes)} probes (${perBatch(fixed)}), ` +
        `sync wiring ${String(outagePasses)} passes / ${String(outageProbes)} probes (${perBatch(outage)})`,
    )
  })
})
