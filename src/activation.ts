/**
 * Session-scoped activation of the MCP tools a project mounts.
 *
 * A project can declare a large MCP surface, and a model request must not carry
 * every tool the project owns. This module keeps the *presentation* list small
 * without touching the registry:
 *
 * - the usage counters seed a **baseline** of tools the project actually calls
 *   ({@link seedFromUsage}) — they are offered directly from the first step on;
 * - the newest task text ranks the project's mounted tools with BM25, and the
 *   best matches are offered through a **sticky window** that holds one offered
 *   set across several steps ({@link advanceAutoOffer});
 * - the rest are discovered through the `mcp_search_tools` tool this module
 *   registers in the agent scope, which **activates** the matches for the next
 *   step ({@link activate});
 * - a tool that is never called falls out again ({@link pruneIdle}), and a
 *   compaction ends the session's activations while the counter baseline stays
 *   ({@link onCompaction});
 * - the agent's own `system-prompt/assemble` listener puts the active schemas
 *   back into the assembled request ({@link withActiveTools}).
 *
 * Everything the registry owns stays untouched: no tool is unregistered and no
 * restriction is installed (`ctx.tools.restrict()` cannot hide a scope-local
 * registration anyway — exactly where mcp-client registers its tools). The
 * listener only *adds* schemas to an assembly it did not author, and it is
 * contained: a failure of this plugin's own work returns the continuation's
 * value unchanged.
 *
 * The module is import-free of `@deepseek-ai/dsh-tools` on purpose: that peer is
 * not installed in every deployment, so the registry, definition and schema
 * surfaces are described by the minimal structural types below.
 *
 * @module dsh-project-mcp/activation
 */

import { DEFAULT_TOOL_POLICY } from './types.ts'
import type { OfferedTool, ServerUsage, SessionTools, ToolPolicy } from './types.ts'

/** `true` while the session may offer MCP tools through search + activation. */
export const DEFAULT_ACTIVATION_ENABLED = true

/** Tools seeded into the baseline from the durable counters. */
export const DEFAULT_ACTIVATION_SEEDED = 8

/** Calls one tool needs in the counters before it is seeded. */
export const DEFAULT_ACTIVATION_MIN_CALLS = 5

/** How long a session-activated tool survives without a call (`0` disables). */
export const DEFAULT_TOOL_IDLE_MS = 1_800_000

/** Matches one `mcp_search_tools` call activates when it omits `limit`. */
export const DEFAULT_SEARCH_LIMIT = 8

/** Hard cap on matches one `mcp_search_tools` call may activate. */
export const MAX_SEARCH_LIMIT = 50

/**
 * Distinct query words one `mcp_search_tools` call scores at most. A query
 * longer than that is a sentence, and its tail words add noise rather than
 * signal — the first words are the ones the model chose first.
 */
export const MAX_SEARCH_TOKENS = 8

/** Registry name of the discovery tool this module registers. */
export const SEARCH_TOOL_NAME = 'mcp_search_tools'

/** Empty foreign set: what the containment reads when nothing is wired or foreign. */
const NO_FOREIGN: ReadonlySet<string> = new Set<string>()

/**
 * Tools the context-driven tier may offer at once when `activationAutoLimit` is
 * unset; `0` disables the tier.
 */
export const DEFAULT_AUTO_ACTIVATION_LIMIT = 12

/** Hard cap on the context-driven tier, however the config asks for more. */
export const MAX_AUTO_ACTIVATION_LIMIT = 50

/**
 * Extra user messages a context-driven offer survives after the one that ranked
 * it; `0` keeps only that message. The offering set is recomputed when the task
 * context moves, so this is what holds one tool list across several steps.
 */
export const DEFAULT_AUTO_ACTIVATION_STICKY_STEPS = 2

/** Hard cap on the sticky window, however the config asks for more. */
export const MAX_AUTO_ACTIVATION_STICKY_STEPS = 20

/**
 * Serialized size of the MCP surface a session may offer directly before this
 * module defers anything, in characters. Roughly four characters per token, so
 * the default is about 10K tokens: below it the request would carry every
 * mounted tool anyway, and rewriting the prompt prefix to hide a few of them
 * buys nothing and costs the model its cache. `0` disables the gate and defers
 * the whole surface however small it is.
 */
export const DEFAULT_TOOL_BUDGET_CHARS = 40_000

/** BM25 term-frequency saturation. */
export const BM25_K1 = 1.2

/** BM25 document-length normalization. */
export const BM25_B = 0.75

/**
 * Weight one tool-name hit carries over the same hit in the description. A name
 * hit is what a tool *is*, so it outranks a description that merely mentions the
 * term — without the weight a name repeated in a short description and a
 * description-only hit score nearly the same.
 */
export const BM25_NAME_WEIGHT = 1.5

/**
 * Raw BM25 score a tool needs before the context-driven tier may offer it.
 *
 * The floor is what keeps a tool whose name or description shares one incidental
 * word with the task text out of the offered list. A term that stands out in the
 * corpus is worth roughly 1.4 for its first occurrence, one that is merely
 * frequent is worth under 0.3, and a term every tool shares is worth nothing —
 * so the floor sits above the ambient noise a plural or a common verb produces
 * and below a genuine match. Activation through `mcp_search_tools` stays
 * available for anything the floor rejects, and `activationAutoLimit: 0` turns
 * the tier off outright.
 */
export const MIN_AUTO_SCORE = 0.6

/** Maximum task-context characters one advance considers (the newest tail wins). */
export const MAX_AUTO_QUERY_CHARS = 2_000

/** Maximum tool names the recent-call history carries between advances. */
export const MAX_AUTO_RECENT_CALLS = 16

/**
 * Minimal structural view of one model-facing tool schema.
 *
 * It is the exact element type of `system-prompt/assemble`'s `tools` list and of
 * `ctx.tools.schemas()`, described locally because `@deepseek-ai/dsh-tools` is a
 * peer this plugin does not import.
 */
export interface ToolSchemaLike {
  /** Public registry name, eg `mcp__alpha__run`. */
  readonly name: string
  /** Model-facing description. */
  readonly description: string
  /** JSON Schema object arguments. */
  readonly parameters: Record<string, unknown>
}

/** One text block of the model-facing content vocabulary. */
export interface TextBlockLike {
  /** Always `text`; the only block this module renders. */
  readonly type: 'text'
  /** Human-readable text. */
  readonly text: string
}

/**
 * Minimal structural view of a tool definition as `ctx.tools.register` accepts
 * it. Only the fields this module writes are declared.
 */
export interface ToolDefinitionLike {
  /** Registry name presented to the model. */
  readonly name: string
  /** Model-facing description. */
  readonly description: string
  /** JSON Schema object arguments. */
  readonly parameters: Record<string, unknown>
  /** Canonical output contract: a schema to validate and a content renderer. */
  readonly output: {
    /** Enforced JSON Schema of the canonical value `execute` returns. */
    readonly schema: Record<string, unknown>
    /**
     * Project the canonical value onto model-facing content.
     * @param args - parsed call arguments.
     * @param value - the validated canonical value.
     * @returns the content blocks the model sees.
     */
    render(args: unknown, value: unknown): readonly TextBlockLike[]
  }
  /**
   * Run one accepted call.
   * @param args - parsed call arguments.
   * @param context - execution identity; unused here.
   * @returns the canonical value declared by `output.schema`.
   */
  execute(args: unknown, context: unknown): Promise<unknown>
}

/** One listener as `ctx.on` accepts it (method syntax keeps parameters bivariant). */
export type ListenerLike = (...args: never[]) => unknown

/**
 * The agent-scoped context slices this module touches. Described structurally so
 * the wiring is testable without a live harness.
 */
export interface ActivationContextLike {
  /**
   * Register an event listener through the scope; the scope owns its disposal.
   * @param name - event name.
   * @param listener - listener called with the event's dispatch arguments.
   * @param options - `prepend` places the listener outermost in a waterfall.
   * @returns the disposer, or anything the runtime returns for one.
   */
  on(name: string, listener: ListenerLike, options?: { prepend?: boolean }): unknown
  /** The tool registry, through the scope so registrations stay scope-local. */
  readonly tools: {
    /**
     * Register a tool in the calling scope.
     * @param definition - schema and execution.
     * @returns the exact disposer that unregisters the tool.
     */
    register(definition: ToolDefinitionLike): () => void
  }
}

/** The subset of one prompt assembly this module reads and returns. */
export interface AssemblyLike {
  /** Model-facing tool schemas, already in canonical order. */
  tools: ToolSchemaLike[]
}

/** Handler of the `system-prompt/assemble` waterfall this module installs. */
export type AssembleListener = (
  assembly: AssemblyLike,
  context: unknown,
  next: () => Promise<AssemblyLike>,
) => Promise<AssemblyLike>

/**
 * The fields the wiring reads from one appended session event: enough to catch
 * a `compaction/end` and to recover the task text of a committed `user/message`.
 */
export interface SessionEventLike {
  /** Session event type, eg `compaction/end`. */
  readonly type?: unknown
  /** Event payload, present on every committed event (`event.data`). */
  readonly data?: unknown
}

/**
 * One session's activation state.
 *
 * `baseline` is the counter-seeded set and outlives a compaction; `active` holds
 * the names this session activated through search, each with the epoch
 * milliseconds of its last touch, and is what idle pruning and compaction clear.
 * Both are read-only because every transition returns a new state.
 */
export interface ActivationState {
  /** Public names the durable counters proved hot; always offered. */
  readonly baseline: ReadonlySet<string>
  /** Session-activated public names mapped to their last touch. */
  readonly active: ReadonlyMap<string, number>
}

/**
 * Build one session's state.
 * @param baseline - counter-seeded public names; defaults to none.
 * @returns an empty active set over that baseline.
 */
export function createActivationState(baseline: Iterable<string> = []): ActivationState {
  return { baseline: new Set(baseline), active: new Map() }
}

/** How {@link seedFromUsage} reads the durable counters. */
export interface SeedOptions {
  /** Maximum names seeded; `0` seeds none. */
  readonly count: number
  /** Calls one tool needs before it is seeded. */
  readonly minCalls: number
}

/**
 * Seed the baseline from a project's durable counters.
 *
 * The counters key tools by the name the server declares them under and servers
 * by `serverName`, so the public registry name is the `mcp__<server>` prefix plus
 * the tool key — the same reconstruction the counter's own attribution relies
 * on. A name the registry had to truncate cannot be reversed this way; such a
 * tool is simply not seeded, which is why the search tool stays the discovery
 * path of record.
 *
 * @param usage - counters of one project, or `undefined` when none were recorded.
 * @param options - seed cap and per-tool minimum.
 * @returns the baseline names, most-called first (name order breaks ties).
 */
export function seedFromUsage(
  usage: Record<string, ServerUsage> | undefined,
  options: SeedOptions,
): Set<string> {
  const baseline = new Set<string>()
  if (usage === undefined || options.count <= 0) return baseline
  const candidates: { name: string; calls: number }[] = []
  for (const [server, serverUsage] of Object.entries(usage)) {
    for (const [tool, calls] of Object.entries(serverUsage.tools)) {
      if (calls < options.minCalls) continue
      candidates.push({ name: `mcp__${server}__${tool}`, calls })
    }
  }
  candidates.sort((left, right) => right.calls - left.calls || compareNames(left.name, right.name))
  for (const candidate of candidates.slice(0, options.count)) baseline.add(candidate.name)
  return baseline
}

/**
 * Activate names for this session, idempotently.
 *
 * A baseline name is skipped: it is already offered, so tracking it in the
 * session set would only make a compaction look like it changed something.
 *
 * @param state - activation state before the activation.
 * @param names - public names activated (already filtered to this plugin's mounts).
 * @param at - epoch milliseconds of the activation.
 * @returns the updated state, or the input when nothing changed.
 */
export function activate(
  state: ActivationState,
  names: Iterable<string>,
  at: number,
): ActivationState {
  let active: Map<string, number> | undefined
  for (const name of names) {
    if (state.baseline.has(name)) continue
    if (state.active.get(name) === at) continue
    active ??= new Map(state.active)
    active.set(name, at)
  }
  return active === undefined ? state : { baseline: state.baseline, active }
}

/**
 * Refresh the freshness of a tool the session actually called. A call is what
 * keeps a session-activated tool offered; a name that is not active (a baseline
 * tool, or a tool the model called by name without activating it) is untouched.
 *
 * @param state - activation state before the call.
 * @param name - public name of the called tool.
 * @param at - epoch milliseconds of the call.
 * @returns the updated state, or the input when nothing changed.
 */
export function noteUse(state: ActivationState, name: string, at: number): ActivationState {
  const previous = state.active.get(name)
  if (previous === undefined || previous === at) return state
  const active = new Map(state.active)
  active.set(name, at)
  return { baseline: state.baseline, active }
}

/**
 * Drop the session-activated tools that have not been called for `idleMs`.
 * The baseline is never pruned: it comes from the durable counters, not from the
 * session. `idleMs <= 0` disables pruning.
 *
 * @param state - activation state at `now`.
 * @param now - epoch milliseconds of the sweep.
 * @param idleMs - age at which a tool falls out.
 * @returns the updated state, or the input when nothing was stale.
 */
export function pruneIdle(state: ActivationState, now: number, idleMs: number): ActivationState {
  if (idleMs <= 0 || state.active.size === 0) return state
  let active: Map<string, number> | undefined
  for (const [name, at] of state.active) {
    if (now - at < idleMs) continue
    active ??= new Map(state.active)
    active.delete(name)
  }
  return active === undefined ? state : { baseline: state.baseline, active }
}

/**
 * End the session's activations — a compaction rewrote the conversation they
 * belonged to — while keeping the counter baseline.
 * @param state - activation state before the compaction.
 * @returns the updated state, or the input when no session tool was active.
 */
export function onCompaction(state: ActivationState): ActivationState {
  if (state.active.size === 0) return state
  return { baseline: state.baseline, active: new Map() }
}

/**
 * Every name this session currently offers: the baseline plus the session's own
 * activations.
 * @param state - current activation state.
 * @returns the union; the baseline itself when nothing is session-activated.
 */
export function presentedNames(state: ActivationState): ReadonlySet<string> {
  if (state.active.size === 0) return state.baseline
  return new Set([...state.baseline, ...state.active.keys()])
}

/**
 * Serialized size of a tool surface, in characters.
 *
 * Counts what a request actually carries per schema — name, description and the
 * JSON form of the parameters — so the number is comparable with
 * {@link DEFAULT_TOOL_BUDGET_CHARS}. Total: a `parameters` value that cannot be
 * serialized (a cycle) contributes nothing instead of throwing.
 *
 * @param schemas - the schemas a session may offer.
 * @returns the summed character count.
 */
export function surfaceChars(schemas: readonly ToolSchemaLike[]): number {
  let total = 0
  for (const schema of schemas) total += schemaChars(schema)
  return total
}

/**
 * Serialized size of one tool schema, in characters: the same measurement
 * {@link surfaceChars} sums, so a caller that splits a surface into two halves
 * counts each half by one rule.
 *
 * Exported for the same reason {@link surfaceChars} is: the on-demand tool
 * detail route answers the *size of one definition* as a host measurement, and
 * a reason line that recomputed it would risk a different number than the
 * budget decision it explains.
 *
 * @param schema - one schema a session may offer.
 * @returns its character count.
 */
export function schemaChars(schema: ToolSchemaLike): number {
  return schema.name.length + schema.description.length + serializedLength(schema.parameters)
}

/**
 * Whether one mounted surface is over the deferral budget.
 *
 * This is exactly the gate {@link installActivation} applies before it defers
 * anything, so a reader that reports the decision cannot drift from the
 * listener that makes it: a surface that fits the budget exactly is carried
 * whole, and a budget of `0` disables the comparison so every surface is over
 * it.
 *
 * @param chars - serialized surface size, as {@link surfaceChars} measures it.
 * @param budgetChars - configured budget in characters.
 * @returns `true` when the surface must be handed over on demand.
 */
export function overToolBudget(chars: number, budgetChars: number): boolean {
  return budgetChars <= 0 || chars > budgetChars
}

/**
 * The model-facing schema of a definition this module built itself, so its own
 * tool can be offered from the assembly listener rather than through the
 * registry alone.
 *
 * @param definition - a registry-ready tool definition.
 * @returns the three fields an assembly carries for it.
 */
function schemaOf(definition: ToolDefinitionLike): ToolSchemaLike {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
  }
}

/** `JSON.stringify` length of one value, or `0` when it cannot be serialized. */
function serializedLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

/**
 * Merge the session's active schemas into an already assembled tool list.
 *
 * Total and side-effect free: it copies the base list, never removes or reorders
 * an entry that is already there, and only appends an active schema that the
 * base does not already carry and that `available` actually publishes (a stale
 * baseline name of a server that is no longer mounted is silently skipped).
 * Missing schemas are inserted at their sorted position, so with the canonical
 * (lexicographic) base order DSH produces the result stays sorted; a deployment
 * with a custom `toolOrder` keeps its existing entries exactly where they were.
 *
 * @param baseTools - the assembly's tool list as the inner listeners left it.
 * @param available - live schemas this plugin may offer for the session.
 * @param activeNames - baseline plus session-activated public names.
 * @returns a new list; equal input yields an equal list.
 */
export function withActiveTools(
  baseTools: readonly ToolSchemaLike[],
  available: readonly ToolSchemaLike[],
  activeNames: ReadonlySet<string>,
): ToolSchemaLike[] {
  const result = [...baseTools]
  if (activeNames.size === 0 || available.length === 0) return result
  const present = new Set(result.map((tool) => tool.name))
  const byName = new Map<string, ToolSchemaLike>()
  for (const tool of available) {
    if (!byName.has(tool.name)) byName.set(tool.name, tool)
  }
  const missing: ToolSchemaLike[] = []
  for (const name of activeNames) {
    if (present.has(name)) continue
    const tool = byName.get(name)
    if (tool === undefined) continue
    present.add(name)
    missing.push(tool)
  }
  missing.sort((left, right) => compareNames(left.name, right.name))
  for (const tool of missing) {
    const index = result.findIndex((existing) => compareNames(existing.name, tool.name) > 0)
    if (index === -1) result.push(tool)
    else result.splice(index, 0, tool)
  }
  return result
}

/**
 * The task context one auto-offer decision reads: the newest user-role text the
 * session committed, plus the tools it called since the last decision.
 *
 * A called name is context, never activation. Only names inside `available`
 * — the tools this plugin mounted for the session — can enter the window, so a
 * call to a profile-level or other-project tool cannot smuggle a foreign schema
 * into the request.
 */
export interface AutoOfferInput {
  /** Newest committed user message text; `''` when the session has none yet. */
  readonly userText: string
  /**
   * Tool names called since the last decision, call order preserved. Repeating
   * the list is safe: a name already inside the window keeps its stamp.
   */
  readonly recentCalls?: readonly string[]
}

/** How the context-driven tier ranks, caps, and holds one decision. */
export interface AutoOfferOptions {
  /** Maximum names one decision may offer; `0` disables the tier. */
  readonly limit?: number
  /**
   * Extra user messages a name survives after the one that ranked it. One
   * decision runs per new task text, so this is the sticky window width.
   */
  readonly stickySteps?: number
  /** Raw BM25 score a tool needs before it may be offered. */
  readonly minScore?: number
}

/**
 * The context-driven tier's state: a sticky window over the BM25 ranking of the
 * session's available tools.
 *
 * `window` maps a name to the decision that put it there, so a later decision
 * can count how long the name has been offered without renumbering anything.
 * {@link autoPresentedNames} reads the offered set back out. The state is
 * immutable; a decision that changes nothing returns its input object.
 */
export interface AutoOfferState {
  /** Name -> decision stamp of every name still inside the sticky window. */
  readonly window: ReadonlyMap<string, number>
}

/**
 * One empty context-driven state.
 * @returns a state whose window is empty.
 */
export function createAutoOfferState(): AutoOfferState {
  return { window: new Map() }
}

/**
 * Split free text into lowercase search tokens.
 *
 * Separators, punctuation and case boundaries all delimit a token, so `runSQL`,
 * `run_sql`, `run-sql` and `mcp__alpha__run` all yield `run`/`sql`/`mcp`/
 * `alpha` as separate terms instead of one opaque blob. A token must hold at
 * least one letter or digit, which drops the punctuation-only pieces.
 *
 * @param text - raw name, description, or task text.
 * @returns the tokens in source order, duplicates kept (BM25 needs term counts).
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const chunk of text.split(/[^\p{L}\p{N}]+/u)) {
    if (chunk === '') continue
    for (const piece of chunk.split(/(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u)) {
      if (piece === '') continue
      const token = piece.toLowerCase()
      if (/[\p{L}\p{N}]/u.test(token)) tokens.push(token)
    }
  }
  return tokens
}

/**
 * Rank the available schemas against one task text with BM25.
 *
 * The corpus is each tool's name plus its description; the query is the task
 * text tokenized the same way. The name is repeated so a name hit outweighs a
 * description hit, and the name breaks score ties, so one corpus and query
 * always produce the same list. Candidates below `minScore` are dropped.
 *
 * @param schemas - live schemas this plugin may offer for the session.
 * @param query - task text to rank against.
 * @param limit - maximum names to return.
 * @param minScore - raw BM25 score a candidate needs.
 * @returns the top names, best first, deterministically ordered.
 */
export function rankToolsByQuery(
  schemas: readonly ToolSchemaLike[],
  query: string,
  limit: number,
  minScore: number,
): string[] {
  const queryTokens = [...new Set(tokenize(query))]
  if (queryTokens.length === 0 || limit <= 0 || schemas.length === 0) return []

  const documents: {
    tool: ToolSchemaLike
    nameTokens: string[]
    descriptionTokens: string[]
  }[] = []
  const nameFrequency = new Map<string, number>()
  const descriptionFrequency = new Map<string, number>()
  let nameLength = 0
  let descriptionLength = 0
  for (const tool of schemas) {
    const description = typeof tool.description === 'string' ? tool.description : ''
    const nameTokens = tokenize(tool.name)
    const descriptionTokens = tokenize(description)
    documents.push({ tool, nameTokens, descriptionTokens })
    nameLength += nameTokens.length
    descriptionLength += descriptionTokens.length
    for (const token of new Set(nameTokens)) nameFrequency.set(token, (nameFrequency.get(token) ?? 0) + 1)
    for (const token of new Set(descriptionTokens)) {
      descriptionFrequency.set(token, (descriptionFrequency.get(token) ?? 0) + 1)
    }
  }
  const averageNameLength = Math.max(nameLength / documents.length, 1)
  const averageDescriptionLength = Math.max(descriptionLength / documents.length, 1)

  /** One field's BM25 contribution for one query term, matching the term count. */
  const fieldScore = (
    frequency: number,
    tokens: number,
    documentFrequency: number,
    averageLength: number,
  ): number => {
    const inverse = Math.log(
      1 + (documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5),
    )
    const saturation =
      (frequency * (BM25_K1 + 1)) /
      (frequency + BM25_K1 * (1 - BM25_B + (BM25_B * tokens) / averageLength))
    return inverse * saturation
  }

  const ranked: { name: string; score: number }[] = []
  for (const document of documents) {
    const nameCounts = countTokens(document.nameTokens)
    const descriptionCounts = countTokens(document.descriptionTokens)
    let score = 0
    for (const token of queryTokens) {
      if (nameCounts.has(token)) {
        score +=
          BM25_NAME_WEIGHT *
          fieldScore(
            nameCounts.get(token) ?? 0,
            document.nameTokens.length,
            nameFrequency.get(token) ?? 0,
            averageNameLength,
          )
      }
      if (descriptionCounts.has(token)) {
        score += fieldScore(
          descriptionCounts.get(token) ?? 0,
          document.descriptionTokens.length,
          descriptionFrequency.get(token) ?? 0,
          averageDescriptionLength,
        )
      }
    }
    if (score < minScore) continue
    ranked.push({ name: document.tool.name, score })
  }
  ranked.sort((left, right) => right.score - left.score || compareNames(left.name, right.name))
  return ranked.slice(0, limit).map((candidate) => candidate.name)
}

/** Term counts of one field, keyed by token. */
function countTokens(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  return counts
}

/**
 * Read the newest user-role text out of one committed session event.
 *
 * Only text blocks enter the task context: an image or file block carries no
 * words to rank against, and an event that is not a `user/message` is not task
 * text at all.
 *
 * Neither is a synthetic `user/message`. The same event type carries every
 * plugin-authored context injection — runtime context snapshots, agent
 * instructions, skill catalogues, cron notices — and they are distinguished
 * only by `source.kind` (`plugin` against a human prompt's `user`). Ranking a
 * tool offer against a context snapshot rather than against the task is worse
 * than ranking against nothing, so only a `user` source is accepted. A
 * deployment that injects its own task text as a `plugin` message therefore
 * ranks on the last human turn instead of that injection.
 *
 * @param event - one event as the `session/event` listener receives it.
 * @returns the message text, or `''` when this event carries none.
 */
export function readUserMessage(event: SessionEventLike): string {
  if (event?.type !== 'user/message' || !isRecord(event.data)) return ''
  const source = event.data.source
  if (!isRecord(source) || source.kind !== 'user') return ''
  const content = event.data.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'text') continue
    if (typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * Reset the context-driven tier: a compaction rewrote the conversation the
 * offers belonged to, so nothing sticky survives it.
 *
 * @param state - state before the compaction.
 * @returns an empty state, or the input when it was already empty.
 */
export function resetAutoOffer(state: AutoOfferState): AutoOfferState {
  if (state.window.size === 0) return state
  return createAutoOfferState()
}

/**
 * Bound one task text to the newest {@link MAX_AUTO_QUERY_CHARS} characters.
 *
 * The tail is the part that matters — a long message states its request last —
 * and the bound keeps one very long paste from turning every later ranking pass
 * into a scan of the whole message.
 *
 * @param text - committed user message text.
 * @returns the text unchanged when it is already short enough.
 */
export function boundTaskText(text: string): string {
  return text.length <= MAX_AUTO_QUERY_CHARS ? text : text.slice(text.length - MAX_AUTO_QUERY_CHARS)
}

/**
 * Advance the context-driven tier by one input: recompute the BM25 ranking and
 * merge it into the sticky window.
 *
 * A name survives for the advance that offered it plus `stickySteps` later
 * advances, instead of falling out the moment its score dips — that is what
 * keeps one tool list across the steps of a turn. An input that offers nothing
 * clears the window: there is nothing to be sticky about. Nothing here reads a
 * clock; the caller decides what one advance is, so the model stays
 * deterministic and testable.
 *
 * @param previous - state before this input.
 * @param input - the session's newest task text and recent calls.
 * @param available - live schemas this plugin may offer for the session.
 * @param options - ranking and window configuration.
 * @returns the next state, or the input state when nothing changed.
 */
export function advanceAutoOffer(
  previous: AutoOfferState,
  input: AutoOfferInput,
  available: readonly ToolSchemaLike[],
  options: AutoOfferOptions = {},
): AutoOfferState {
  const limit = autoOfferLimit(options.limit)
  const stickySteps = autoOfferStickySteps(options.stickySteps)
  const ranked = rankToolsByQuery(available, input.userText, limit, options.minScore ?? MIN_AUTO_SCORE)
  const previousAdvance = currentAdvance(previous)

  // A called name is context, never activation: only a tool this plugin
  // mounted for the session may enter the window, so a call to a profile-level
  // or other-project tool cannot smuggle a foreign schema into the request.
  const mounted = new Set(available.map((schema) => schema.name))
  const calls: string[] = []
  for (const name of input.recentCalls ?? []) {
    if (name !== '' && mounted.has(name) && !calls.includes(name)) calls.push(name)
  }
  if (ranked.length === 0 && calls.length === 0) {
    const empty = createAutoOfferState()
    return sameAutoOffer(previous, empty) ? previous : empty
  }

  const advance = previousAdvance + 1
  // The stamp of the oldest advance still offered. A name entered at advance
  // `E` is offered at `E` itself plus the next `stickySteps` advances, so this
  // advance still shows `advance - stickySteps` and drops anything older.
  const firstKeptAdvance = Math.max(advance - stickySteps, 0)
  const window = new Map<string, number>()
  for (const [name, stamp] of previous.window) {
    if (name === AUTO_ADVANCE_KEY || stamp < firstKeptAdvance) continue
    window.set(name, stamp)
  }
  // A name the window already carries keeps the stamp its offer was made with,
  // so being called never shortens an offer; a fresh one is stamped current.
  for (const name of ranked) window.set(name, advance)
  for (const name of calls) {
    if (!window.has(name)) window.set(name, advance)
  }
  window.set(AUTO_ADVANCE_KEY, advance)

  const next: AutoOfferState = { window }
  return sameAutoOffer(previous, next) ? previous : next
}



/**
 * Reserved window key that records the advance the state has reached. A real
 * tool name can never collide with it: registry names are non-empty, and this
 * key is empty. {@link autoPresentedNames} skips it.
 */
const AUTO_ADVANCE_KEY = ''

/** The advance one state has reached; `0` for a state that never advanced. */
function currentAdvance(state: AutoOfferState): number {
  return state.window.get(AUTO_ADVANCE_KEY) ?? 0
}

/**
 * Every name the context-driven tier currently offers.
 * @param state - current context-driven state.
 * @returns the offered names, in code-unit order.
 */
export function autoPresentedNames(state: AutoOfferState): ReadonlySet<string> {
  const names = new Set<string>()
  for (const name of state.window.keys()) {
    if (name !== AUTO_ADVANCE_KEY) names.add(name)
  }
  return new Set([...names].sort(compareNames))
}

/**
 * Every name the context-driven tier currently offers, oldest offer first.
 *
 * The window stamps are advances, not clock readings: this state deliberately
 * holds no wall-clock time, so the order is recency in *decisions*. A caller
 * that needs a timestamp cannot read one from here.
 *
 * @param state - current context-driven state.
 * @returns the offered names, ordered by the advance that offered each.
 */
export function autoOffers(state: AutoOfferState): readonly string[] {
  const entries: { name: string; advance: number }[] = []
  for (const [name, advance] of state.window) {
    if (name === AUTO_ADVANCE_KEY) continue
    entries.push({ name, advance })
  }
  entries.sort((left, right) => left.advance - right.advance || compareNames(left.name, right.name))
  return entries.map((entry) => entry.name)
}

/** Whether two context-driven states describe the same offered set and history. */
function sameAutoOffer(left: AutoOfferState, right: AutoOfferState): boolean {
  const leftNames = autoPresentedNames(left)
  const rightNames = autoPresentedNames(right)
  if (leftNames.size !== rightNames.size) return false
  for (const name of leftNames) {
    if (!rightNames.has(name)) return false
  }
  return true
}

/**
 * Read the offered-set cap, clamped to the supported range.
 * @param value - configured cap, or `undefined` for the shipped default.
 * @returns the effective cap; `0` disables the context-driven tier.
 */
export function autoOfferLimit(value: number | undefined): number {
  return Math.min(Math.max(value ?? DEFAULT_AUTO_ACTIVATION_LIMIT, 0), MAX_AUTO_ACTIVATION_LIMIT)
}

/**
 * Read the sticky-window configuration, clamped to the supported range.
 * @param value - configured extra advances, or `undefined` for the shipped default.
 * @returns the effective extra advances; `0` keeps only the current advance.
 */
export function autoOfferStickySteps(value: number | undefined): number {
  return Math.min(
    Math.max(value ?? DEFAULT_AUTO_ACTIVATION_STICKY_STEPS, 0),
    MAX_AUTO_ACTIVATION_STICKY_STEPS,
  )
}

/**
 * One live session's presentation inputs, read where the session's state lives.
 *
 * Every field is a snapshot-time read: `mounted` is the registry probe the
 * activation wiring itself consumes, and both states are the session's own, so
 * a caller that derives a row again after an activation sees it — nothing here
 * is a copy a later path updates.
 */
export interface SessionToolInput {
  /** Live agent (session) id the row describes. */
  readonly sessionId: string
  /** Schemas this plugin mounted for the session, as the registry lists them now. */
  readonly mounted: readonly ToolSchemaLike[]
  /** Activation state of the session; absent before its first seed. */
  readonly activation: ActivationState | undefined
  /** Context-driven window of the session; absent before its first advance. */
  readonly auto: AutoOfferState | undefined
  /** `false` when activation is off, so every mounted tool stays in the request. */
  readonly activationEnabled: boolean
  /** Deferral budget in characters; defaults to {@link DEFAULT_TOOL_BUDGET_CHARS}. */
  readonly budgetChars?: number
  /**
   * Tool policy of the session's project; absent means the shipped default,
   * {@link DEFAULT_TOOL_POLICY}. Read at call time like every other field here,
   * so the row follows a pin or a mode change as soon as it is stored.
   */
  readonly policy?: ToolPolicy
  /**
   * Step each session activation was recorded on, keyed by public name, and the
   * step this row is being read on. Both are optional and independent: `steps`
   * stamps the `activated` tier with the step its offer happened on, while
   * `step` stamps the context tier with the step the request belongs to. Absent
   * means the caller counts no steps, and then no tier carries a number — the
   * panel draws no step tag rather than a zero.
   */
  readonly steps?: ReadonlyMap<string, number>
  /** Step this row is read on; see {@link SessionToolInput.steps}. */
  readonly step?: number
}

/**
 * Derive what one session offers the model right now from its live state.
 *
 * The row is a *measurement*, not a decision: `mounted` counts the schemas the
 * caller probed, and `deferred` is exactly the part of that surface the request
 * does not carry, so `deferred.length` is the panel's "hidden" number and the
 * tier lists name why the rest is there. Nothing is cached: the same inputs
 * read after an activation list it.
 *
 * Names of tiers that the session no longer mounts are dropped, because the
 * row describes what is offered, not what once was. The context tier carries no
 * `at`: the live window stamps an advance, not a wall-clock time.
 *
 * The project's policy is read here too, and it decides all three fields. In
 * `disclosure` the row offers the counter baseline and the pins and hides the
 * part of the mounted surface the budget pushed out of the request. `direct`
 * filters nothing, so it hides nothing: `deferring` is `false` and `deferred` is
 * empty however large the surface is. `off` offers none of the project's tools,
 * so every tier of this row is empty and the whole mounted surface is `deferred`
 * — the row reports what *this* plugin contributes, and a project the user
 * switched off contributes nothing, whether or not another presentation plugin
 * leaves the tools visible to the model. Pinned names join the counter baseline,
 * so in `disclosure` and `direct` they are offered from the first step of every
 * request and are never counted as hidden, whatever the counters and the budget
 * say.
 *
 * @param input - live mount, activation, context, config and policy of one session.
 * @returns the presentation row, or `undefined` when the session mounts no tool
 * (a session the host has not turned has nothing to report, and an empty row
 * would claim it offers nothing rather than that its surface is absent).
 */
export function toolsFor(input: SessionToolInput): SessionTools | undefined {
  const mounted = input.mounted
  if (mounted.length === 0) return undefined
  const mountedNames = new Set(mounted.map((schema) => schema.name))
  const chars = surfaceChars(mounted)
  const budgetChars = input.budgetChars ?? DEFAULT_TOOL_BUDGET_CHARS
  const policy = input.policy ?? DEFAULT_TOOL_POLICY
  // Nothing is hidden while the surface fits: the activation listener leaves the
  // assembly untouched then, so a name a tier would have offered is in the
  // request anyway. Only a surface the gate defers can hide anything — and only
  // `disclosure` defers by size at all: `direct` filters nothing and `off`
  // offers nothing.
  const deferring =
    policy.mode === 'disclosure' && input.activationEnabled && overToolBudget(chars, budgetChars)
  // `off` offers none of the project's tools, so no tier of this row offers one
  // either. The pins stay in the policy and the session keeps its activations —
  // the mode is read again on the next assembly, so switching back finds them —
  // but a row that promises nothing is what makes the whole mounted surface
  // `deferred` below.
  const offersNothing = policy.mode === 'off'

  // A pin is the user's own always-offered name, so it belongs to the baseline
  // next to the counter-seeded ones. A pinned name the project no longer mounts
  // is not part of this row — but stays pinned in the policy store, so the
  // declaration coming back finds it again.
  const baselineNames = new Set<string>(input.activation?.baseline ?? [])
  for (const pin of policy.pins) baselineNames.add(pin)
  const baseline = offersNothing
    ? []
    : [...baselineNames].filter((name) => mountedNames.has(name)).sort(compareNames)
  // The step an activation was recorded on, when the caller counted one; `0`
  // (or no map at all) is "this host does not count steps", and a tier must then
  // carry no number rather than a zero a panel would draw as a step tag.
  const stepOf = (name: string): number | undefined => {
    const step = input.steps?.get(name)
    return step === undefined || step <= 0 ? undefined : step
  }
  const activated: OfferedTool[] = offersNothing
    ? []
    : [...(input.activation?.active ?? [])]
        .filter(([name]) => mountedNames.has(name))
        .sort(
          ([leftName, leftAt], [rightName, rightAt]) =>
            leftAt - rightAt || compareNames(leftName, rightName),
        )
        .map(([name, at]): OfferedTool => {
          const step = stepOf(name)
          return { name, via: 'session', at, ...(step === undefined ? {} : { step }) }
        })
  // The context tier is a live window, not a record of offers made: the stamp it
  // carries is the step this row is read on, which is the step the request it
  // describes belongs to. A caller that counts no steps leaves it absent.
  const context: OfferedTool[] = offersNothing
    ? []
    : (input.auto === undefined ? [] : autoOffers(input.auto))
        .filter((name) => mountedNames.has(name))
        .map((name): OfferedTool => ({
          name,
          via: 'context',
          ...(input.step === undefined ? {} : { step: input.step }),
        }))

  const offered = new Set<string>(baseline)
  for (const tool of activated) offered.add(tool.name)
  for (const tool of context) offered.add(tool.name)

  // `off` promises nothing, so the whole mounted surface is what this plugin
  // does not offer; `direct` filters nothing, so it hides nothing; only
  // `disclosure` over its budget hides the difference between the two.
  const deferred =
    offersNothing
      ? [...mountedNames].sort(compareNames)
      : deferring
        ? [...mountedNames].filter((name) => !offered.has(name)).sort(compareNames)
        : []

  // The request's own weight, split the way the request is: exactly the names in
  // `deferred` are the ones the assembly leaves out, so a surface that fits the
  // budget carries all of it and defers nothing, and what hiding saved is
  // `surfaceChars - visibleChars`. Both halves are measured with
  // {@link surfaceChars}, the same rule the budget gate uses, so the numbers
  // cannot drift from the decision.
  const deferredNames = new Set(deferred)
  let visibleChars = 0
  let deferredChars = 0
  for (const schema of mounted) {
    if (deferredNames.has(schema.name)) deferredChars += schemaChars(schema)
    else visibleChars += schemaChars(schema)
  }

  return {
    sessionId: input.sessionId,
    baseline,
    activated,
    context,
    deferred,
    mounted: mounted.length,
    surfaceChars: chars,
    visibleChars,
    deferredChars,
    budgetChars,
    deferring,
  }
}

/** Construction options for the `mcp_search_tools` definition. */
export interface SearchToolOptions {
  /** Live schemas the search matches and may activate: the whole visible MCP surface. */
  readonly available: () => readonly ToolSchemaLike[]
  /** Record the matched names as activated for the session. */
  readonly activate: (names: readonly string[]) => void
  /** Cap applied when a call omits `limit`; defaults to {@link DEFAULT_SEARCH_LIMIT}. */
  readonly defaultLimit?: number
}

/** One search result: what the model may call directly from the next step on. */
interface SearchMatch {
  readonly name: string
  readonly description: string
}

/**
 * Build the `mcp_search_tools` definition.
 *
 * The tool never pretends: a query that matches nothing says so, and it only
 * ever offers schemas its session actually sees (the caller supplies that
 * filtered list). Activating is enough to present a tool from the *next* step
 * on, because the assembly listener reads the state at every request.
 *
 * @param options - the session's visible schemas and activation sink.
 * @returns a registry-ready definition.
 */
export function createSearchTool(options: SearchToolOptions): ToolDefinitionLike {
  const defaultLimit = options.defaultLimit ?? DEFAULT_SEARCH_LIMIT
  return {
    name: SEARCH_TOOL_NAME,
    description:
      'Search the MCP tools this session sees and activate every match, so the activated tools are offered directly from the next model step on. Use it when the tool you need is not listed: a tool it activates joins the offered list from the next model step on, and until then only the tools already listed are reliable. `query` matches tool names and descriptions — case-insensitive, each word on its own, so separate keywords (`issue update`) find what a whole sentence does not; `limit` caps how many matches are activated.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'A keyword or name fragment of the needed MCP tool; several words are matched one by one.',
        },
        limit: {
          type: 'integer',
          description: `Maximum matches to activate; default ${defaultLimit}.`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      // The canonical value is a small JSON object; any of its shapes is valid.
      schema: {},
      render: (_args, value) => [{ type: 'text', text: renderJson(value) }],
    },
    async execute(args) {
      const query = readQuery(args)
      if (query === '') {
        throw new Error(`${SEARCH_TOOL_NAME}: "query" must be a non-empty string`)
      }
      const matches = searchTools(options.available(), query, readLimit(args, defaultLimit))
      options.activate(matches.map((match) => match.name))
      return {
        query,
        matches,
        activated: matches.map((match) => match.name),
        message:
          matches.length === 0
            ? `no MCP tool of this project matches ${JSON.stringify(query)}`
            : `${matches.length} MCP tool(s) match and will be offered from the next step on`,
      }
    },
  }
}

/** What the wiring needs from the runtime; everything is read at use time. */
export interface ActivationWiringOptions {
  /** Agent-scoped context; both the listener and the search tool live here. */
  readonly ctx: ActivationContextLike
  /** Current activation state of the session. */
  readonly state: () => ActivationState
  /** Replace the session's activation state after a transition. */
  readonly setState: (next: ActivationState) => void
  /** Live schemas of the tools this plugin mounted for the session. */
  readonly available: () => readonly ToolSchemaLike[]
  /**
   * Every MCP schema the session sees — the profile plane, this plugin's own
   * mounts, and any F-19 forwarders — beyond {@link available}. The deferral
   * budget and the discovery tool count this whole surface, while the
   * context-driven tier and the usage counters keep reading `available` alone.
   * Absent means `available` is the whole surface, so a deployment whose
   * presentation owner already hides the profile plane keeps today's behaviour.
   */
  readonly visible?: () => readonly ToolSchemaLike[]
  /**
   * Names that belong to ANOTHER project mounted in this process, which this
   * session must never be offered. The runtime computes the set from the other
   * projects it manages, and the assembly listener drops every such name from
   * the assembled request — whatever the tool mode, and however large the
   * surface. The budget and the discovery tool keep counting the whole visible
   * surface, so this only trims the final list and never re-feeds the deferral
   * decision. Absent means nothing is foreign, which keeps a deployment without
   * the containment probe on today's behaviour.
   */
  readonly foreign?: () => ReadonlySet<string>
  /** Cap on the tools one search activates; defaults to {@link DEFAULT_SEARCH_LIMIT}. */
  readonly searchLimit?: number
  /**
   * Cap on the names the context-driven tier offers at once; defaults to
   * {@link DEFAULT_AUTO_ACTIVATION_LIMIT}, and `0` disables the tier.
   */
  readonly autoLimit?: number
  /** Extra advances a context offer survives; defaults to {@link DEFAULT_AUTO_ACTIVATION_STICKY_STEPS}. */
  readonly autoStickySteps?: number
  /** Lowest BM25 score the context-driven tier may offer; defaults to {@link MIN_AUTO_SCORE}. */
  readonly autoMinScore?: number
  /**
   * Serialized size of the MCP surface, in characters, above which this module
   * defers tools at all; defaults to {@link DEFAULT_TOOL_BUDGET_CHARS}. `0`
   * defers every surface, however small.
   */
  readonly toolBudgetChars?: number
  /**
   * Live tool policy of the session's project; absent means the shipped default,
   * {@link DEFAULT_TOOL_POLICY}. Read at every assembly, so a mode or pin change
   * applies from the next step on, without re-minting the scope.
   */
  readonly policy?: () => ToolPolicy
  /**
   * Number of the agent step this plugin is currently on, counted by the caller
   * from its own `agent/pre-step` hook. Read when a search activates names, so
   * the record of that offer carries the step it happened on. Absent means the
   * caller counts no steps, and then an activation records none.
   */
  readonly step?: () => number
  /**
   * Told the names one search just activated, and the step it happened on, so
   * the caller can keep that stamp for the lifetime of the session — longer
   * than one scope's wiring, which an idle release disposes. Absent drops the
   * stamp: the offer is still recorded, it simply carries no step.
   */
  readonly onActivated?: (names: readonly string[], step: number) => void
  /**
   * Told that a compaction ended the session's activations, so the caller can
   * drop the step records that belong to them. Absent leaves the records in
   * place, which only means a later activation of the same name may carry the
   * step of the offer the compaction removed.
   */
  readonly onCompaction?: () => void
  /** Context-driven state to start from; defaults to an empty state. */
  readonly autoState?: AutoOfferState
  /** Sink for the context-driven state after every advance that changed it. */
  readonly setAutoState?: (next: AutoOfferState) => void
  /** Sink for a contained failure of this plugin's own work. */
  readonly onError?: (error: unknown) => void
}

/**
 * The context-driven tier's live inputs, owned by the wiring for one scope.
 *
 * `userText` is the newest committed `user/message` and `calls` holds the tool
 * names called since the last advance; both are read from the events the
 * harness already dispatches, and `changed` records that the task context moved
 * since the offered set was last computed.
 */
interface ActivationQueryTracker {
  /** Context-driven state as of the last advance. */
  state: AutoOfferState
  /** Newest committed user-role text, `''` until the session has one. */
  userText: string
  /** Tool names called since the last advance, call order preserved. */
  calls: string[]
  /** `true` while a committed user message arrived after the last advance. */
  changed: boolean
}

/**
 * Install the session wiring on one agent scope: the `system-prompt/assemble`
 * listener, the `mcp_search_tools` registration, and the `session/event`
 * listener that feeds compaction, the task context, and the recent-call names.
 *
 * The listener is prepended so it is the **outermost** handler of the waterfall:
 * `next()` has already run every plugin that filters the catalogue (the
 * `dsh-progressive-tools` presentation this replaces), and the list it returns is
 * the one that runs. Idle pruning is not wired here — the runtime already
 * watches `agent/status`, and it calls {@link pruneIdle} on that transition.
 *
 * The context-driven tier advances only when the task context actually moves: a
 * new user message or a new tool call. When it does, and the resulting offered
 * set is the one the previous advance produced, this returns the identical
 * assembly object, so nothing downstream treats the tool list as changed.
 *
 * @param options - scope, session state accessors, and the mounted-schema probe.
 * @returns the disposer that unregisters everything installed here.
 */
export function installActivation(options: ActivationWiringOptions): () => void {
  const tracker: ActivationQueryTracker = {
    state: options.autoState ?? createAutoOfferState(),
    userText: '',
    calls: [],
    changed: false,
  }

  /**
   * Record the step an activation happened on. Owned by the caller, because the
   * session, not one scope's wiring, is what keeps an activation across an idle
   * release; this is the only place a search activation happens, so it is the
   * only place the record can be made.
   */
  const recordActivated = (names: readonly string[]): void => {
    const step = options.step?.() ?? 0
    if (step > 0) options.onActivated?.(names, step)
  }

  const dispose = (fn: () => void): void => {
    try {
      fn()
    } catch (error) {
      options.onError?.(error)
    }
  }
  const listen = (name: string, listener: ListenerLike, prepend: boolean): (() => void) => {
    const registered = options.ctx.on(name, listener, { prepend })
    return typeof registered === 'function' ? (registered as () => void) : () => undefined
  }

  /** Recompute the context-driven offer whenever the task context actually moved. */
  const advance = (): void => {
    const calls = tracker.calls
    tracker.calls = []
    // Nothing new: the offered set from the previous advance is still current,
    // so not touching it is what keeps the request prefix byte-identical.
    if (!tracker.changed && calls.length === 0) return
    tracker.changed = false
    if (autoOfferLimit(options.autoLimit) === 0) return
    const next = advanceAutoOffer(
      tracker.state,
      { userText: tracker.userText, recentCalls: calls },
      options.available(),
      {
        ...(options.autoLimit === undefined ? {} : { limit: options.autoLimit }),
        ...(options.autoStickySteps === undefined ? {} : { stickySteps: options.autoStickySteps }),
        ...(options.autoMinScore === undefined ? {} : { minScore: options.autoMinScore }),
      },
    )
    if (next === tracker.state) return
    tracker.state = next
    options.setAutoState?.(next)
  }

  /** Every name the session's explicit activation and context-driven tiers offer. */
  const offeredNames = (): ReadonlySet<string> => {
    const names = new Set(presentedNames(options.state()))
    for (const name of autoPresentedNames(tracker.state)) names.add(name)
    return names
  }

  /**
   * Every MCP schema the session sees, as one name-keyed surface: this plugin's
   * own mounts first, then the profile plane and any F-19 forwarders, each name
   * once. This plugin's discovery tool is left out by identity — it is added
   * separately below, so a profile that already lists a tool named
   * `mcp_search_tools` cannot shadow the one this module mints.
   */
  const wholeSurface = (): readonly ToolSchemaLike[] => {
    const available = options.available()
    const visible = options.visible?.() ?? []
    if (visible.length === 0) return available
    const seen = new Set<string>()
    const merged: ToolSchemaLike[] = []
    for (const schema of available) {
      if (schema.name === SEARCH_TOOL_NAME) continue
      seen.add(schema.name)
      merged.push(schema)
    }
    for (const schema of visible) {
      if (schema.name === SEARCH_TOOL_NAME || seen.has(schema.name)) continue
      seen.add(schema.name)
      merged.push(schema)
    }
    return merged
  }

  /**
   * Whether the whole visible MCP surface is large enough to be worth deferring
   * at all. A surface that already fits the budget is carried whole by the
   * request, so hiding a few of its tools would rewrite the prompt prefix — and
   * cost the model its cache — to save nothing. `0` disables the gate.
   */
  const deferring = (surface: readonly ToolSchemaLike[]): boolean =>
    overToolBudget(
      surfaceChars(surface),
      options.toolBudgetChars ?? DEFAULT_TOOL_BUDGET_CHARS,
    )

  /**
   * Containment: a name another project mounts in this process never reaches the
   * assembled request, whatever the mode does around it. The set is read fresh on
   * every assembly, and the whole visible surface the budget measures is
   * deliberately unchanged — containment trims the final list only, so the
   * deferral decision still counts a foreign name the host defect leaked into the
   * session's chain. Absent (or empty) means nothing is foreign, and the
   * continuation's value comes back by identity.
   */
  const contain = (result: AssemblyLike): AssemblyLike => {
    const foreign = options.foreign?.() ?? NO_FOREIGN
    if (foreign.size === 0) return result
    const kept = result.tools.filter((tool) => !foreign.has(tool.name))
    return kept.length === result.tools.length ? result : { ...result, tools: kept }
  }

  /**
   * The visible surface without the names another project's mount leaked into
   * this session's chain. The discovery catalogue is built from this rather than
   * from {@link wholeSurface}: a name the session may never be offered must not
   * come back as text through a search either, or the containment would hand the
   * foreign catalogue over one step later. The deferral decision still counts the
   * whole surface, foreign names included — they occupy the request just as
   * locally mounted ones would.
   */
  const searchable = (): readonly ToolSchemaLike[] => {
    const foreign = options.foreign?.() ?? NO_FOREIGN
    const surface = wholeSurface()
    return foreign.size === 0 ? surface : surface.filter((schema) => !foreign.has(schema.name))
  }

  const merge = (result: AssemblyLike): AssemblyLike => {
    const surface = wholeSurface()
    // Nothing is visible: there is nothing to find, so nothing is added.
    if (surface.length === 0) return contain(result)
    const policy = options.policy?.() ?? DEFAULT_TOOL_POLICY
    // `off` promises that the project's tools are not offered, and the promise is
    // about the request, not only about what the panel says: the project plane
    // leaves the assembly here. Only this plugin's own mounts go — the profile
    // plane and other plugins' tools are none of this mode's business — and a pin
    // does not cancel the mode, so the discovery tool is not advertised either,
    // because there is nothing it may disclose.
    if (policy.mode === 'off') {
      const mounted = options.available()
      if (mounted.length === 0) return contain(result)
      const offNames = new Set(mounted.map((schema) => schema.name))
      const kept = result.tools.filter((tool) => !offNames.has(tool.name))
      return contain(kept.length === result.tools.length ? result : { ...result, tools: kept })
    }
    // `direct` is the opposite promise: the whole visible catalogue is listed, so
    // the assembly is handed back exactly as the rest of the harness produced it
    // and the discovery tool is not advertised — except that another project's
    // tools, which this session must never carry, still leave it.
    if (policy.mode !== 'disclosure') return contain(result)
    advance()
    // The discovery tool is pinned: offered in every disclosure assembly,
    // whatever the budget says. A surface inside the budget is carried whole —
    // every mounted tool stays listed — and the search tool is added alongside
    // them so the model can always discover tools as the project grows. Over
    // budget, this module does the trimming a presentation owner would
    // otherwise do: every `mcp__` tool the budget pushed out is dropped, while
    // the non-MCP tools the inner listeners listed (core tools, other plugins)
    // are kept. `withActiveTools` inserts the wanted schemas at their sorted
    // position and never duplicates or reorders an existing entry. Pins are
    // wanted unconditionally — offered from the first step of every request,
    // whatever the counters and the budget say — and a pin or activation may
    // name a profile-plane tool, whose schema is found in `surface` and
    // re-inserted.
    const defer = deferring(surface)
    const wanted = new Set(offeredNames())
    for (const pin of policy.pins) wanted.add(pin)
    wanted.add(SEARCH_TOOL_NAME)
    const kept = defer
      ? result.tools.filter(
          (tool) => wanted.has(tool.name) || !tool.name.startsWith('mcp__'),
        )
      : result.tools
    const merged = withActiveTools(kept, [...surface, schemaOf(search)], wanted)
    // Identity is decided on the list this call produced, never on whether the
    // names this module wants have changed: the inner listeners rebuild the
    // registry list from scratch on every step and re-apply their own filtering,
    // so a memoized "nothing changed" answer would hand back their trimmed list
    // with this module's additions missing, one step after they appeared.
    // Returning `result` when nothing was dropped or added keeps the prompt
    // prefix — and the model's cache — byte-identical, the property that matters.
    const changed = kept.length !== result.tools.length || merged.length !== kept.length
    return contain(changed ? { ...result, tools: merged } : result)
  }

  const assemble: AssembleListener = async (_assembly, _context, next) => {
    const result = await next()
    try {
      return merge(result)
    } catch (error) {
      // A listener that throws would break every model request of the session;
      // this one degrades to "the assembly the rest of the harness produced".
      options.onError?.(error)
      return result
    }
  }

  const observe = (_session: unknown, event: SessionEventLike): void => {
    try {
      if (event?.type === 'compaction/end') {
        options.setState(onCompaction(options.state()))
        // The step records belong to activations a compaction has just dropped,
        // so they go with them: a name activated again after this is stamped
        // with the step it returns on, not with the one it left on.
        options.onCompaction?.()
        // A compaction rewrote the conversation the offers belonged to, so the
        // context tier starts over; the counter baseline is untouched.
        tracker.state = resetAutoOffer(tracker.state)
        tracker.calls = []
        tracker.changed = false
        return
      }
      if (event?.type === 'user/message') {
        const text = readUserMessage(event)
        // An empty text (an image-only or non-text message) says nothing about
        // the task, so it must not wipe a context an earlier message set up.
        if (text !== '' && text !== tracker.userText) {
          const bounded = boundTaskText(text)
          tracker.changed = bounded !== tracker.userText
          tracker.userText = bounded
        }
        return
      }
      if (event?.type === 'tool/call') {
        const name = readCallName(event)
        if (name !== '') {
          tracker.calls.push(name)
          if (tracker.calls.length > MAX_AUTO_RECENT_CALLS) {
            tracker.calls.splice(0, tracker.calls.length - MAX_AUTO_RECENT_CALLS)
          }
        }
      }
    } catch (error) {
      options.onError?.(error)
    }
  }

  const search = createSearchTool({
    available: searchable,
    activate: (names) => {
      recordActivated(names)
      options.setState(activate(options.state(), names, Date.now()))
    },
    ...(options.searchLimit === undefined ? {} : { defaultLimit: options.searchLimit }),
  })

  const disposers: (() => void)[] = [
    listen('system-prompt/assemble', assemble as unknown as ListenerLike, true),
    listen('session/event', observe as unknown as ListenerLike, false),
  ]
  try {
    disposers.push(options.ctx.tools.register(search))
  } catch (error) {
    options.onError?.(error)
  }
  return () => {
    for (const registered of disposers) dispose(registered)
  }
}

/**
 * Read the tool name out of one committed `tool/call` event.
 *
 * The recent calls are context evidence only, never activation: a name the
 * context tier offers is still filtered by the runtime's own mount records, so
 * a call to a profile-level tool cannot smuggle a foreign name into the list.
 *
 * @param event - one event as the `session/event` listener receives it.
 * @returns the called tool's public name, or `''` when the event carries none.
 */
function readCallName(event: SessionEventLike): string {
  if (event.type !== 'tool/call' || !isRecord(event.data)) return ''
  const name = event.data.name
  return typeof name === 'string' ? name : ''
}

/** Read and normalize the `query` argument. */
function readQuery(args: unknown): string {
  if (!isRecord(args)) return ''
  const query = args.query
  return typeof query === 'string' ? query.trim() : ''
}

/** Read the `limit` argument, clamped to the tool's supported range. */
function readLimit(args: unknown, fallback: number): number {
  if (!isRecord(args)) return fallback
  const raw = args.limit
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
  const limit = Math.trunc(raw)
  if (limit <= 0) return fallback
  return Math.min(limit, MAX_SEARCH_LIMIT)
}

/**
 * Score one schema against the query: an exact name beats a name substring, and
 * both beat a description hit. Results keep the best score first and the name
 * order breaks ties, so one query always returns the same list.
 */
function searchTools(
  available: readonly ToolSchemaLike[],
  query: string,
  limit: number,
): SearchMatch[] {
  const needle = query.toLowerCase()
  const tokens = searchTokens(needle)
  const scored: { match: SearchMatch; score: number }[] = []
  for (const tool of available) {
    const description = typeof tool.description === 'string' ? tool.description : ''
    const score = scoreTool(tool.name, description, needle, tokens)
    if (score === 0) continue
    scored.push({ match: { name: tool.name, description }, score })
  }
  scored.sort((left, right) => right.score - left.score || compareNames(left.match.name, right.match.name))
  return scored.slice(0, limit).map((entry) => entry.match)
}

/**
 * Distinct words of a query, lowercased, in first-use order. Words shorter
 * than two characters are dropped (a one-letter word is a substring of half
 * the catalog and scores noise, not intent); the split keeps letters, digits
 * and underscores, so a query may quote a tool name verbatim (`issue_update`)
 * as well as name its concepts (`issue update`).
 */
function searchTokens(needle: string): string[] {
  const tokens: string[] = []
  const seen = new Set<string>()
  for (const piece of needle.split(/[^\p{L}\p{N}_]+/u)) {
    if (piece.length < 2 || seen.has(piece)) continue
    seen.add(piece)
    tokens.push(piece)
    if (tokens.length >= MAX_SEARCH_TOKENS) break
  }
  return tokens
}

/**
 * Score one candidate tool; `0` means no match. The whole query as one
 * substring stays the strongest signal (an exact name beats a phrase that
 * happens to sit inside a description), and every query word then adds its
 * own hit — a word in the name outweighs the same word in the description.
 * The per-word tier is what keeps a natural query like "issue get create
 * update" useful: no tool contains that phrase, but the tools that contain
 * most of its words are exactly the ones the model meant.
 */
function scoreTool(name: string, description: string, needle: string, tokens: readonly string[]): number {
  const lowerName = name.toLowerCase()
  if (lowerName === needle) return 1_000
  const lowerDescription = description.toLowerCase()
  let score = 0
  if (lowerName.includes(needle)) score += 500
  else if (lowerDescription.includes(needle)) score += 250
  for (const token of tokens) {
    if (lowerName.includes(token)) score += 10
    else if (lowerDescription.includes(token)) score += 1
  }
  return score
}

/** Code-unit name comparison, matching the canonical tool order of DSH. */
function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Serialize one canonical value for the model; total by construction. */
function renderJson(value: unknown): string {
  const text = JSON.stringify(value, undefined, 2)
  return text === undefined ? String(value) : text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
