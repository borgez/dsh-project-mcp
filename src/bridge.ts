/**
 * F-19 forwarding bridge: one `mcp-client` per project, a thin definition per
 * session.
 *
 * A preset composition mounts each session's tools from its own preset subtree,
 * and `agent-presets` binds every composed agent's scope key to the preset's
 * standing key *before* the agent is published. `dsh-scope` binds a key to one
 * parent exactly once, so the project's scope can never join that session's
 * chain — `bindScopeParent` throws, and the runtime's only remaining option was
 * to mount the same declarations again under the session's own scope: one child
 * process per session.
 *
 * The bridge takes the other path. The project keeps its one instance mounted in
 * the project's own scope; a session whose chain cannot reach that scope gets a
 * *forwarding* definition registered in its own layer instead. The forwarder
 * carries the project tool's model-facing surface, and each call resolves the
 * project's live definition by name and runs it:
 *
 * ```
 * project scope                      session scope (per session)
 * ┌────────────────────────┐         ┌──────────────────────────────────┐
 * │ mcp-client instance    │         │ register("mcp__a__run") ──────┐  │
 * │  register("mcp__a__run")│◄────────┼── get("mcp__a__run", project) │  │
 * │  execute(args, exec)   │         │   → projectDefinition.execute │  │
 * └────────────────────────┘         └──────────────────────────────────┘
 * ```
 *
 * The resolution is by name at call time, not a captured definition object,
 * because `mcp-client` swaps its whole tool generation on every `tools/list`
 * refresh: a captured definition would keep executing a disposed generation.
 *
 * One session owns one live batch of forwarders, and {@link ForwardBatch} keeps
 * it level with the project's live set: the set is re-read on every trigger,
 * the batch is replaced as a whole (released before the replacement is
 * registered), and the re-entry every registration forces on the sync through
 * `tools/change` is owned rather than left to tear the batch down.
 *
 * The module is import-free of `@deepseek-ai/dsh-tools` on purpose, exactly like
 * {@link ./activation.ts}: the registry, definition and schema surfaces are
 * described by the minimal structural types below, so the plugin stays
 * installable in a deployment that does not carry the tools package.
 *
 * @module dsh-project-mcp/bridge
 */

/**
 * Minimal structural view of one model-facing content block.
 *
 * Deliberately open: every block the harness vocabulary carries has a `type` and
 * its own fields, so this is a supertype of all of them. That is what lets a
 * project definition typed against the real `ContentBlock` be copied into a
 * forwarder without a cast at the seam.
 */
export interface TextBlockLike {
  /** Block discriminant, eg `text`. */
  readonly type: string
  /** Every other block field, unread here. */
  readonly [key: string]: unknown
}

/**
 * Minimal structural view of one model-facing tool schema.
 *
 * It is the shape of `ctx.tools.schemas(scope)` entries, described locally
 * because `@deepseek-ai/dsh-tools` is a peer this plugin does not import.
 */
export interface BridgeToolSchema {
  /** Public registry name, eg `mcp__alpha__run`. */
  readonly name: string
  /** Model-facing description. */
  readonly description: string
  /** JSON Schema object arguments. */
  readonly parameters: Record<string, unknown>
}

/**
 * Minimal structural view of one registered tool definition.
 *
 * Every field except `execute` is carried over from the project's definition
 * verbatim — copied as a whole (`forwarder` spreads the definition), never by
 * enumerating the fields this module happens to know, so the forwarding entry is
 * indistinguishable from the original to everything that reads a definition:
 * schema projection, presentation metadata and callbacks, the concurrency
 * classifier, the timeout budget, the output renderer and the last-mile
 * `finalizeContent` the registry snapshots from the definition the session
 * resolves.
 */
export interface ForwardableDefinition extends BridgeToolSchema {
  /** Canonical output contract: schema plus model-facing renderer. */
  readonly output: {
    /** Enforced JSON Schema of the canonical value `execute` returns. */
    readonly schema: Record<string, unknown>
    /**
     * Project the canonical value onto model-facing content.
     * @param args - parsed call arguments.
     * @param value - the validated canonical value.
     * @returns the content blocks the model sees.
     */
    render(args: unknown, value: never): readonly TextBlockLike[]
    /**
     * Optional presentation projection, preserved so a call renders the same
     * card through either layer.
     * @param args - parsed call arguments.
     * @param value - the validated canonical value.
     * @returns the presentation metadata.
     */
    presentationMeta?(args: unknown, value: never): unknown
  }
  /** Cooperative timeout budget, preserved for the timeout policy wrapper. */
  readonly timeoutMs?: number
  /**
   * Pure sibling-overlap classifier. Preserved: a forwarder that dropped it
   * would make every forwarded call exclusive while the project tool is
   * parallel-safe.
   * @param args - parsed call arguments.
   * @returns whether this call may join a parallel group.
   */
  isConcurrencySafe?(args: unknown): boolean
  /**
   * Last-mile transform of the model-facing content, preserved.
   *
   * The registry snapshots this from the definition the *session* resolves —
   * which is the forwarder, not the project's entry — and calls it once per
   * normalized outcome. A forwarder that dropped it would silently degrade
   * every provider result that relies on it: an MCP result's stored images, for
   * one, would arrive as the adapter's plain text fallback.
   * @param exec - the execution identity, passed through unchanged.
   * @param result - the normalized outcome before materialization.
   * @returns replacement content, or `undefined` to preserve the current one.
   */
  finalizeContent?(exec: unknown, result: unknown): readonly TextBlockLike[] | undefined
  /**
   * Pending-state presentation, preserved so a forwarded call renders the same
   * card as the project's own entry.
   * @param args - parsed call arguments.
   * @returns the presentation intent, or `undefined` for the generic card.
   */
  presentCall?(args: unknown): unknown
  /**
   * Completed-state presentation, preserved for the same reason.
   * @param args - parsed call arguments.
   * @param result - the durable result projection.
   * @returns the presentation intent, or `undefined` to keep the pending one.
   */
  presentResult?(args: unknown, result: unknown): unknown
  /**
   * Run one accepted call.
   * @param args - parsed call arguments.
   * @param exec - execution identity, cancellation, and context deferral.
   * @returns the canonical value declared by `output.schema`.
   */
  execute(args: unknown, exec: never): Promise<unknown>
}

/**
 * The registry surface the bridge reads: one scoped lookup and one scoped
 * schema probe.
 *
 * `get(name, scope)` is the registry's public lookup and `schemas(scope)` its
 * public schema projection (`@deepseek-ai/dsh-tools` `ToolRuntime`); passing the
 * project's scope key reads the project's own layer and its ancestors, which is
 * where the shared instance registered its tools.
 */
export interface BridgeRegistryLike {
  /**
   * Resolve one tool as one scope sees it.
   * @param name - registered tool name.
   * @param scope - viewing scope key; omitted reads the global view.
   * @returns the visible definition, or `undefined` when none is.
   */
  get(name: string, scope?: object): ForwardableDefinition | undefined
  /**
   * Project one scope's visible definitions onto their model-facing schemas.
   * @param scope - viewing scope key; omitted reads the global view.
   * @returns one schema per visible tool, in registry order.
   */
  schemas(scope?: object): readonly BridgeToolSchema[]
}

/**
 * The registration context slices the bridge touches.
 *
 * A session's scope context is passed in, so `register` files every entry into
 * that session's own layer — the one layer this session owns, where the name is
 * visible to itself and to nobody else.
 */
export interface BridgeContextLike {
  /** Resolve one service, the injection-free read the plugin already uses. */
  get(name: string): unknown
}

/** Options for {@link forwardProjectTools}. */
export interface ForwardProjectToolsOptions {
  /** Session-scope context; every forwarder is registered through it. */
  readonly ctx: BridgeContextLike
  /** Project scope key whose definitions are executed. */
  readonly project: object
  /** Names to forward, as {@link projectToolNames} resolved them. */
  readonly names: readonly string[]
  /** Registry lookup used to resolve the live project definition per call. */
  readonly registry: BridgeRegistryLike
}

/**
 * Marker a forwarder carries, naming the definition it delegates to.
 *
 * The harness's registry has no "forwarded" concept and needs none — this is
 * addressed only to a test double standing in for the registry, which must tell
 * a forwarder from one of the session's own tools to resolve a call the way the
 * registry would.
 */
export const FORWARDED_TO = Symbol('dsh-project-mcp.forwarded-to')

/**
 * Build one forwarding definition over a project's live definition.
 *
 * The schema fields are copied once, at registration time; the executable
 * delegate is resolved per call, so a project re-sync (which disposes and
 * re-registers every tool) never leaves a forwarder pointing at a dead
 * generation. Calling the project's definition directly — rather than
 * dispatching through the registry — is deliberate: the outer call already
 * traversed the policy pipeline under this session's identity, and a second
 * dispatch would apply pre-execute listeners and guards twice.
 * @param project - the definition to forward, read for its surface.
 * @param lookup - resolves the current project definition of this name.
 * @returns the definition to register in a session's layer.
 */
function forwarder(
  project: ForwardableDefinition,
  lookup: () => ForwardableDefinition | undefined,
): ForwardableDefinition {
  // The marker rides outside the definition's own surface: it is addressed to a
  // test double standing in for the registry, never to the harness.
  return Object.assign(
    {
      // Every field the project declared rides along verbatim, including the
      // ones this module never reads — `finalizeContent`, `presentCall`,
      // `presentResult`, and whatever a future provider adds. Enumerating them
      // is what silently lost `dsh-mcp-client`'s finalizer: the registry takes
      // it from the definition the session resolves, which is this one.
      ...project,
      async execute(args: unknown, exec: never): Promise<unknown> {
        const live = lookup()
        if (live === undefined) {
          throw new Error(`the project's "${project.name}" is no longer registered; the shared instance was released or replaced`)
        }
        return await live.execute(args, exec)
      },
    },
    { [FORWARDED_TO]: project },
  )
}

/**
 * Register one thin definition per name in the session's layer.
 *
 * A name the session already resolves to a definition of its own is skipped:
 * registering over it would either shadow the session's registration (if the
 * session's own layer holds it) or throw on a duplicate, and either way the
 * session's own tool is the one it should call.
 * @param options - session context, project key, names, and registry lookup.
 * @returns the exact releaser that drops every forwarder this call added.
 */
export function forwardProjectTools(options: ForwardProjectToolsOptions): () => void {
  // `ctx.get(name)` rather than `ctx.tools`: the session's scope context is a
  // raw extended context (the runtime mints it with `createScope`, not with a
  // plugin that injects `tools`), and a dot-read there throws
  // `cannot get property "tools" without inject`.
  const tools = options.ctx.get('tools') as {
    register(definition: ForwardableDefinition): () => void
  }
  const disposes: (() => void)[] = []
  for (const name of options.names) {
    const project = options.registry.get(name, options.project)
    if (project === undefined) continue
    try {
      disposes.push(tools.register(forwarder(project, () => options.registry.get(name, options.project))))
    } catch {
      // A duplicate in this session's own layer is the session's own tool: it
      // keeps the name, and the bridge steps aside rather than failing a mount.
      continue
    }
  }
  let released = false
  return () => {
    if (released) return
    released = true
    for (const dispose of disposes.reverse()) {
      try {
        dispose()
      } catch {
        // Disposal is idempotent at the registry, and a failure here must not
        // keep the remaining forwarders registered.
      }
    }
  }
}

/**
 * The names to forward, and how to register one batch of them.
 *
 * Both are read fresh on every pass: `names` because a server publishing a late
 * `tools/list` (or dropping one) is the ordinary life of a project, and
 * `register` because a pass can be requested from inside a pass.
 */
export interface ForwardBatchOptions {
  /**
   * The project's live tool names, probed on every pass.
   *
   * `undefined` reports a probe that failed: it says nothing about what the
   * project publishes, so the batch it could not describe is the batch that
   * stays live.
   * @returns the names this session should forward, or `undefined` on failure.
   */
  readonly names: () => readonly string[] | undefined
  /**
   * Register one batch of forwarders over the session's layer, which this call
   * reaches empty-handed: the batch it replaces is released first.
   * @param names - the names to forward, in registry order.
   * @returns the exact releaser that drops the whole batch.
   */
  readonly register: (names: readonly string[]) => () => void
}

/**
 * One session's live forwarding batch, kept level with the project's live tools.
 *
 * The registry announces every registration by emitting `tools/change`
 * synchronously from inside the insertion, and a bridged session is subscribed
 * to exactly that event (`src/runtime.ts`, `installBridge`). A pass therefore
 * re-enters itself once per forwarder it registers. Nothing else owns that
 * re-entry, and left unowned it tears the batch down: the nested pass finds a
 * batch still being built, releases it, and registers a second copy of it —
 * which the live first copy refuses as a duplicate. A bridge that steps aside
 * for a duplicate (it must, for the session's own tools) then drops those names
 * silently, and a full pass records `namesIn` as the whole set, so the loss is
 * frozen for every later pass. That is the defect this class exists to close.
 *
 * So: a pass requested from inside a pass only marks the batch dirty, and the
 * frame that owns the batch runs one more pass when it is complete — which is
 * also how a project set that changed mid-registration is still honoured. And
 * the old batch is released **before** the new one is registered, because one
 * layer holds one entry per name: registering over a live batch would refuse
 * every name it already had.
 */
export class ForwardBatch {
  /** The names the live batch was registered for; `undefined` before the first pass. */
  #namesIn: readonly string[] | undefined = undefined
  /** Disposer of the live registration batch; `undefined` while none is live. */
  #release: (() => void) | undefined = undefined
  /** Whether an owning frame is inside {@link sync}, registering right now. */
  #building = false
  /** Whether a pass asked for while {@link #building} still needs a run. */
  #again = false

  constructor(private readonly options: ForwardBatchOptions) {}

  /**
   * The names the live batch was registered for.
   *
   * `undefined` before the first successful pass, and again after a pass whose
   * registration failed: an unset state is what makes the next pass retry
   * rather than short-circuit on a set that never landed.
   */
  get namesIn(): readonly string[] | undefined {
    return this.#namesIn
  }

  /**
   * Bring the session's layer level with the project's live tool set.
   *
   * Cheap when it already is: an unchanged set short-circuits and leaves the
   * live batch — and its generation of definitions — untouched. Re-entrant
   * while registering: see the class note.
   * @returns nothing; a failure from the probe or the registry propagates.
   */
  sync(): void {
    if (this.#building) {
      this.#again = true
      return
    }
    this.#building = true
    try {
      do {
        this.#again = false
        this.#syncOnce()
      } while (this.#again)
    } finally {
      this.#building = false
    }
  }

  /**
   * Drop the live batch: the session keeps no forwarder, and the next
   * {@link sync} starts from nothing rather than amending a stale set.
   * Idempotent.
   *
   * The release announces itself (`tools/change`) once per entry, and the
   * session is subscribed to that event; a pass re-entered from there must not
   * resurrect the batch it is watching being dropped. So the guard is held for
   * the whole release, and the pass it queues is discarded rather than run.
   */
  drop(): void {
    this.#building = true
    try {
      this.#releaseBatch()
    } finally {
      this.#building = false
      this.#again = false
    }
  }

  /** One pass: read the project's set, then replace the batch when it moved. */
  #syncOnce(): void {
    const names = this.options.names()
    if (names === undefined) return
    if (this.#namesIn !== undefined && sameNames(this.#namesIn, names)) return
    // Released first, and deliberately — see the class note. Until the new batch
    // is registered the session's layer is empty for the length of one
    // synchronous call, which is the price of every forwarded name being free.
    try {
      this.#releaseBatch()
    } catch {
      // The registry's disposer is exact and idempotent, and a failure here must
      // not keep the new batch from registering.
    }
    this.#release = this.options.register(names)
    this.#namesIn = names
  }

  /**
   * Release the live batch and forget it.
   *
   * The fields are cleared before the disposer runs, so a throw leaves the batch
   * in the retryable empty state rather than half-released and half-claimed.
   */
  #releaseBatch(): void {
    const release = this.#release
    this.#release = undefined
    this.#namesIn = undefined
    release?.()
  }
}

/**
 * The project scope's tool names, restricted to the servers the project
 * actually mounted.
 *
 * The probe reads the PROJECT scope, not the session's: the shared instance
 * registered its tools there, so a session's own view would also carry its own
 * registrations (and could not tell them apart). `servers` keeps a name another
 * scope's server happens to publish from being forwarded.
 * @param project - project scope key whose view is probed.
 * @param schemas - reads one scope's visible schemas, as `ctx.tools.schemas`.
 * @param servers - server namespaces the project mounted.
 * @returns the tool names to forward, in registry order.
 */
export function projectToolNames(
  project: object,
  schemas: (scope: object) => readonly BridgeToolSchema[],
  servers: ReadonlySet<string>,
): string[] {
  const names: string[] = []
  for (const schema of schemas(project)) {
    const match = /^mcp__([A-Za-z0-9_-]+?)__/.exec(schema.name)
    if (match === null) continue
    if (!servers.has(match[1] as string)) continue
    names.push(schema.name)
  }
  return names
}

/**
 * Whether two name lists are the same set in the same order.
 *
 * A sync is skipped when the project publishes exactly what the last one
 * forwarded: re-registering an unchanged batch would dispose and rebuild every
 * forwarder for nothing, and the registry announces each change to every
 * watcher.
 * @param left - the names the last sync forwarded.
 * @param right - the names this sync found.
 * @returns whether the two lists match entry for entry.
 */
export function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index])
}
