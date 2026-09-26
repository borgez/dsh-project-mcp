/**
 * Context-driven tool offers: the pure BM25 ranking, the sticky window that
 * keeps a name offered across steps, the task-context reads, and the scope
 * wiring that puts an offered tool into the assembled request.
 *
 * The contract under test is narrow. Ranking is deterministic and total, the
 * offered set is capped and sticky, and the wiring rebuilds its additions from
 * the list the inner listeners produced — never from a memo of what it wanted,
 * because those listeners rebuild and re-trim that list on every step. A
 * request whose tool list this module does not have to change comes back as the
 * identical object, so the prompt prefix — and the model's cache — is stable.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AUTO_ACTIVATION_LIMIT,
  DEFAULT_AUTO_ACTIVATION_STICKY_STEPS,
  DEFAULT_TOOL_BUDGET_CHARS,
  MAX_AUTO_ACTIVATION_LIMIT,
  MAX_AUTO_QUERY_CHARS,
  MIN_AUTO_SCORE,
  SEARCH_TOOL_NAME,
  advanceAutoOffer,
  autoOfferLimit,
  autoOfferStickySteps,
  autoPresentedNames,
  boundTaskText,
  createAutoOfferState,
  installActivation,
  rankToolsByQuery,
  readUserMessage,
  resetAutoOffer,
  surfaceChars,
  tokenize,
} from '../src/activation.ts'
import type {
  ActivationContextLike,
  ActivationState,
  AssemblyLike,
  AutoOfferState,
  ListenerLike,
  SessionEventLike,
  ToolDefinitionLike,
  ToolSchemaLike,
} from '../src/activation.ts'
import { createActivationState } from '../src/activation.ts'

/** One schema as the registry publishes it, with a description that matters. */
function tool(name: string, description: string): ToolSchemaLike {
  return { name, description, parameters: {} }
}

function names(state: AutoOfferState): string[] {
  return [...autoPresentedNames(state)]
}

/**
 * The project's MCP tools an assembly carries, without this plugin's own
 * discovery tool: every deferred assembly offers that one on purpose, and these
 * assertions are about which MCP tools the session may call.
 */
function mcpNames(assembly: AssemblyLike): string[] {
  return assembly.tools.map((schema) => schema.name).filter((name) => name !== SEARCH_TOOL_NAME)
}

/** Whether an assembly still carries the discovery tool that finds the rest. */
function offersSearch(assembly: AssemblyLike): boolean {
  return assembly.tools.some((schema) => schema.name === SEARCH_TOOL_NAME)
}

/** One committed human `user/message` event, with the source the harness sets. */
function userMessage(text: string): SessionEventLike {
  return {
    type: 'user/message',
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  }
}

/** One plugin-authored context injection, which shares the `user/message` type. */
function injectedMessage(text: string): SessionEventLike {
  return {
    type: 'user/message',
    data: {
      role: 'user',
      source: { kind: 'plugin', plugin: 'hindsight', form: 'notice', summary: 'memory' },
      content: [{ type: 'text', text }],
    },
  }
}

/** One committed `tool/call` event. */
function toolCall(name: string): SessionEventLike {
  return { type: 'tool/call', data: { name, arguments: '{}' } }
}

const REVIEW = tool('mcp__alpha__code_review', 'Review a pull request diff and report findings')
const DEPLOY = tool('mcp__alpha__deploy', 'Deploy the service to the production cluster')
const LINT = tool('mcp__alpha__lint', 'Tidy formatting and warnings')
const RANKED_REVIEW = 'review a pull request diff'
const RANKED_DEPLOY = 'deploy the service to the production cluster'
const SCHEMAS = [REVIEW, DEPLOY, LINT]

/** A corpus where only some tools carry the query term, so IDF discriminates. */
function kubernetesCorpus(matching: number, others = 3): ToolSchemaLike[] {
  const corpus: ToolSchemaLike[] = []
  for (let index = 0; index < matching; index += 1) {
    corpus.push(tool(`mcp__alpha__kubernetes_${index}`, 'kubernetes cluster helper'))
  }
  for (let index = 0; index < others; index += 1) {
    corpus.push(tool(`mcp__alpha__other_${index}`, 'unrelated helper for the build pipeline'))
  }
  return corpus
}

describe('tokenize', () => {
  it('splits case boundaries, separators, and punctuation into lowercase terms', () => {
    expect(tokenize('runSQL run_sql run-sql')).toEqual(
      ['run', 'sql', 'run', 'sql', 'run', 'sql'],
    )
    expect(tokenize('mcp__alpha__codeReview-v2')).toEqual(
      ['mcp', 'alpha', 'code', 'review', 'v2'],
    )
  })

  it('keeps versions and digits whole and drops punctuation-only pieces', () => {
    expect(tokenize('v2.0 release! (stable)')).toEqual(['v2', '0', 'release', 'stable'])
  })

  it('returns nothing for empty or punctuation-only text', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize('  --  __  ')).toEqual([])
  })
})

describe('BM25 ranking', () => {
  it('ranks the tool that matches the task text first', () => {
    const ranked = rankToolsByQuery(SCHEMAS, RANKED_REVIEW, 12, MIN_AUTO_SCORE)
    expect(ranked).toEqual(['mcp__alpha__code_review'])
  })

  it('is deterministic: the same corpus and query always produce one order', () => {
    const query = 'deploy the production cluster'
    const twice = rankToolsByQuery(SCHEMAS, query, 12, MIN_AUTO_SCORE)
    expect(twice).toEqual(rankToolsByQuery(SCHEMAS, query, 12, MIN_AUTO_SCORE))
    expect(twice).toEqual(['mcp__alpha__deploy'])
  })

  it('breaks an exact score tie by name, not by input order', () => {
    const left = tool('mcp__alpha__aaa', 'same words here')
    const right = tool('mcp__alpha__bbb', 'same words here')
    const ranked = rankToolsByQuery([right, left], 'same', 12, 0)
    expect(ranked).toEqual(['mcp__alpha__aaa', 'mcp__alpha__bbb'])
  })

  it('caps the returned names and honours the score floor', () => {
    const many = kubernetesCorpus(5)
    expect(rankToolsByQuery(many, 'kubernetes', 2, MIN_AUTO_SCORE)).toHaveLength(2)
    expect(rankToolsByQuery(many, 'kubernetes', 12, MIN_AUTO_SCORE)).toHaveLength(5)
    // A term no tool carries matches nothing at all.
    expect(rankToolsByQuery(SCHEMAS, 'kubernetes', 12, MIN_AUTO_SCORE)).toEqual([])
    // A score floor nothing clears drops everything.
    expect(rankToolsByQuery(SCHEMAS, RANKED_REVIEW, 12, 1_000)).toEqual([])
  })

  it('returns nothing for an empty query, an empty corpus, or a zero cap', () => {
    expect(rankToolsByQuery(SCHEMAS, '', 12, MIN_AUTO_SCORE)).toEqual([])
    expect(rankToolsByQuery([], 'review', 12, MIN_AUTO_SCORE)).toEqual([])
    expect(rankToolsByQuery(SCHEMAS, 'review', 0, MIN_AUTO_SCORE)).toEqual([])
  })

  it('ranks a name hit above a description-only hit', () => {
    const named = tool('mcp__alpha__deploy', 'push it')
    const described = tool('mcp__alpha__push', 'push the deployment')
    const ranked = rankToolsByQuery([described, named], 'deploy service', 12, MIN_AUTO_SCORE)
    expect(ranked[0]).toBe('mcp__alpha__deploy')
  })
})

describe('sticky window', () => {
  it('offers the ranked names, then returns the identical state when nothing moved', () => {
    const first = advanceAutoOffer(createAutoOfferState(), { userText: RANKED_REVIEW }, SCHEMAS)
    expect(names(first)).toEqual(['mcp__alpha__code_review'])

    const again = advanceAutoOffer(first, { userText: RANKED_REVIEW }, SCHEMAS)
    expect(again).toBe(first)
  })

  it('keeps a name offered after its score dips, for the configured window', () => {
    const hot = [tool('mcp__alpha__hot', 'hot topic')]
    const cold = [tool('mcp__alpha__cold', 'cold topic')]
    const beta = [tool('mcp__alpha__beta', 'beta topic')]
    const gamma = [tool('mcp__alpha__gamma', 'gamma topic')]
    const delta = [tool('mcp__alpha__delta', 'delta topic')]

    // Advance 1: `hot` enters.
    let state = advanceAutoOffer(createAutoOfferState(), { userText: 'hot topic' }, hot)
    expect(names(state)).toEqual(['mcp__alpha__hot'])

    // Advance 2: the task moved on, but `hot` is still inside its window.
    state = advanceAutoOffer(state, { userText: 'cold topic' }, cold)
    expect(names(state)).toEqual(['mcp__alpha__cold', 'mcp__alpha__hot'])

    // Advance 3: the last advance `hot` is offered for (`stickySteps` of 2
    // means two further advances after the one that ranked it).
    state = advanceAutoOffer(state, { userText: 'beta topic' }, beta)
    expect(names(state)).toEqual(['mcp__alpha__beta', 'mcp__alpha__cold', 'mcp__alpha__hot'])

    // Advance 4: out of the window, three advances after it entered.
    state = advanceAutoOffer(state, { userText: 'gamma topic' }, gamma)
    expect(names(state)).toEqual(['mcp__alpha__beta', 'mcp__alpha__cold', 'mcp__alpha__gamma'])

    // Advance 5: `cold` is on its last advance, `beta` still holds.

    state = advanceAutoOffer(state, { userText: 'delta topic' }, delta)
    expect(names(state)).toEqual([
      'mcp__alpha__beta',
      'mcp__alpha__delta',
      'mcp__alpha__gamma',
    ])
  })

  it('keeps a name offered only for this advance when the window is zero', () => {
    const hot = [tool('mcp__alpha__hot', 'hot topic')]
    const cold = [tool('mcp__alpha__cold', 'cold topic')]
    let state = advanceAutoOffer(
      createAutoOfferState(),
      { userText: 'hot topic' },
      hot,
      { stickySteps: 0 },
    )
    // The parameter named first is the query; the tool list is the second.
    const after = advanceAutoOffer(state, { userText: 'cold topic' }, cold, { stickySteps: 0 })
    expect(names(after)).toEqual(['mcp__alpha__cold'])
  })

  it('honours the offered-set cap', () => {
    const state = advanceAutoOffer(
      createAutoOfferState(),
      { userText: 'kubernetes' },
      kubernetesCorpus(5),
      { limit: 2 },
    )
    expect(names(state)).toHaveLength(2)
  })

  it('starts empty and clears on an input that offers nothing', () => {
    const empty = createAutoOfferState()
    expect(names(empty)).toEqual([])
    expect(autoPresentedNames(empty).size).toBe(0)

    const filled = advanceAutoOffer(empty, { userText: RANKED_REVIEW }, SCHEMAS)
    const cleared = advanceAutoOffer(filled, { userText: '' }, [])
    expect(names(cleared)).toEqual([])
    expect(cleared.window.size).toBe(0)
  })

  it('offers a freshly called tool through the recent-call history', () => {
    const state = advanceAutoOffer(
      createAutoOfferState(),
      { userText: 'unrelated words', recentCalls: ['mcp__alpha__deploy'] },
      SCHEMAS,
    )
    expect(names(state)).toEqual(['mcp__alpha__deploy'])

    // The call keeps evidence until the same tool is ranked again, and the
    // window then holds it rather than dropping it one advance later.
    const ranked = advanceAutoOffer(state, { userText: RANKED_DEPLOY }, SCHEMAS)
    expect(names(ranked)).toEqual(['mcp__alpha__deploy'])
  })

  it('never offers a call to a tool this plugin did not mount', () => {
    // `mcp__alpha__ghost` is not in the mounted corpus, so the call cannot put
    // a foreign schema into the offered set — and with nothing ranked either,
    // the advance offers nothing at all.
    const state = advanceAutoOffer(
      createAutoOfferState(),
      { userText: 'unrelated words', recentCalls: ['mcp__alpha__ghost'] },
      SCHEMAS,
    )
    expect(names(state)).toEqual([])
  })

  it('resets to an empty state on compaction, and is total on an empty state', () => {
    const filled = advanceAutoOffer(createAutoOfferState(), { userText: RANKED_REVIEW }, SCHEMAS)
    expect(names(resetAutoOffer(filled))).toEqual([])

    const empty = createAutoOfferState()
    expect(resetAutoOffer(empty)).toBe(empty)
  })
})

describe('configuration clamps', () => {
  it('reads the shipped defaults when nothing is configured', () => {
    expect(DEFAULT_AUTO_ACTIVATION_LIMIT).toBe(12)
    expect(DEFAULT_AUTO_ACTIVATION_STICKY_STEPS).toBe(2)
    expect(autoOfferLimit(undefined)).toBe(12)
    expect(autoOfferStickySteps(undefined)).toBe(2)
    expect(MIN_AUTO_SCORE).toBeGreaterThan(0)
  })

  it('clamps a negative value to zero and an oversized one to the cap', () => {
    expect(autoOfferLimit(-5)).toBe(0)
    expect(autoOfferLimit(10_000)).toBe(MAX_AUTO_ACTIVATION_LIMIT)
    expect(autoOfferStickySteps(-1)).toBe(0)
    expect(autoOfferStickySteps(10_000)).toBe(20)
  })

  it('disables the tier at a zero cap', () => {
    const state = advanceAutoOffer(createAutoOfferState(), { userText: RANKED_REVIEW }, SCHEMAS, {
      limit: 0,
    })
    expect(names(state)).toEqual([])
  })
})

describe('task context reads', () => {
  it('joins the text blocks of a user message', () => {
    const event: SessionEventLike = {
      type: 'user/message',
      data: {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'first' }, { type: 'image' }, { type: 'text', text: 'second' }],
      },
    }
    expect(readUserMessage(event)).toBe('first\nsecond')
  })

  it('ignores a plugin-authored context injection', () => {
    expect(readUserMessage(injectedMessage('memory recall summary'))).toBe('')
    expect(readUserMessage(userMessage('fix the deploy pipeline'))).toBe('fix the deploy pipeline')
    // A message with no source at all is not provably human either.
    expect(readUserMessage({ type: 'user/message', data: { role: 'user', content: [] } })).toBe('')
  })

  it('bounds a long task text to its newest tail', () => {
    const long = `${'x'.repeat(MAX_AUTO_QUERY_CHARS)}TAIL`
    const bounded = boundTaskText(long)
    expect(bounded).toHaveLength(MAX_AUTO_QUERY_CHARS)
    expect(bounded.endsWith('TAIL')).toBe(true)
    expect(boundTaskText('short')).toBe('short')
  })

  it('reads nothing from another event, a foreign role, or malformed data', () => {
    expect(readUserMessage({ type: 'tool/call', data: { name: 'x' } })).toBe('')
    expect(readUserMessage({ type: 'user/message', data: { role: 'assistant', content: [] } })).toBe('')
    expect(readUserMessage({ type: 'user/message', data: 'not a record' })).toBe('')
    expect(readUserMessage({})).toBe('')
  })
})

/**
 * Scope double for the wiring: a waterfall whose built-in assembly is empty
 * ("a presentation plugin filtered everything away"), plus the session-event
 * feed the harness publishes.
 */
class FakeScopeCtx {
  readonly registered = new Map<string, ToolDefinitionLike>()
  private readonly listeners = new Map<string, ListenerLike[]>()
  lastInner: AssemblyLike | undefined
  /**
   * What the "rest of the harness" hands the waterfall as its built-in result.
   * Empty by default, which is the interesting case: a presentation plugin that
   * rebuilds a trimmed list on every step, like `dsh-progressive-tools`.
   */
  innerTools: ToolSchemaLike[] = []

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

  /** Run the waterfall and report the built-in result this call produced. */
  async assembleWithInner(): Promise<{ assembly: AssemblyLike; inner: AssemblyLike }> {
    const assembly = await this.assemble()
    return { assembly, inner: this.lastInner as AssemblyLike }
  }

  /** Run the waterfall the way cordis does, with the plugin's listener outermost. */
  async assemble(): Promise<AssemblyLike> {
    const inner: AssemblyLike = { tools: [...this.innerTools] }
    this.lastInner = inner
    const records = [...(this.listeners.get('system-prompt/assemble') ?? [])]
    let index = 0
    const call = async (): Promise<AssemblyLike> => {
      const listener = records[index]
      index += 1
      if (listener === undefined) return inner
      return (listener as unknown as (
        assembly: AssemblyLike,
        context: unknown,
        next: () => Promise<AssemblyLike>,
      ) => Promise<AssemblyLike>)(inner, { scope: this }, call)
    }
    return call()
  }

  emitSessionEvent(event: SessionEventLike): void {
    for (const listener of [...(this.listeners.get('session/event') ?? [])]) {
      ;(listener as unknown as (session: unknown, event: SessionEventLike) => void)({}, event)
    }
  }

  dispose(): void {
    for (const [name, list] of this.listeners) {
      this.listeners.set(name, [...list])
    }
    this.listeners.clear()
    this.registered.clear()
  }
}

/**
 * Install the wiring over a scope double.
 *
 * `toolBudgetChars` defaults to `0` here — the deferral gate switched off — so
 * a test that is about ranking, activation or eviction exercises that behaviour
 * with the small fixture corpus. The budget gate itself gets its own tests with
 * real budgets.
 */
function wiring(
  ctx: FakeScopeCtx,
  available: () => readonly ToolSchemaLike[],
  overrides: {
    state?: () => ActivationState
    autoLimit?: number
    autoStickySteps?: number
    toolBudgetChars?: number
    onAutoState?: (next: AutoOfferState) => void
    onError?: (error: unknown) => void
  } = {},
): () => void {
  let activation = createActivationState()
  return installActivation({
    ctx: ctx as unknown as ActivationContextLike,
    state: overrides.state ?? (() => activation),
    setState: (next) => {
      activation = next
    },
    available,
    toolBudgetChars: overrides.toolBudgetChars ?? 0,
    ...(overrides.autoLimit === undefined ? {} : { autoLimit: overrides.autoLimit }),
    ...(overrides.autoStickySteps === undefined ? {} : { autoStickySteps: overrides.autoStickySteps }),
    ...(overrides.onAutoState === undefined ? {} : { setAutoState: overrides.onAutoState }),
    ...(overrides.onError === undefined ? {} : { onError: overrides.onError }),
  })
}

describe('scope wiring', () => {
  it('offers a context match from the assembled request', async () => {
    const ctx = new FakeScopeCtx()
    wiring(ctx, () => SCHEMAS)

    const before = await ctx.assemble()
    expect(mcpNames(before)).toEqual([])
    // The discovery tool is offered even before anything is activated: without
    // it the session could never ask for a tool it cannot see.
    expect(offersSearch(before)).toBe(true)

    ctx.emitSessionEvent(userMessage(RANKED_REVIEW))
    const offered = await ctx.assemble()
    expect(mcpNames(offered)).toEqual(['mcp__alpha__code_review'])
    expect(offersSearch(offered)).toBe(true)
  })

  it('re-offers the same tools after an inner listener rebuilt a trimmed list', async () => {
    const ctx = new FakeScopeCtx()
    wiring(ctx, () => SCHEMAS)
    ctx.emitSessionEvent(userMessage(RANKED_REVIEW))

    const first = await ctx.assembleWithInner()
    expect(mcpNames(first.assembly)).toEqual(['mcp__alpha__code_review'])

    // A presentation plugin rebuilds and re-trims the list on every step, so
    // "the names this module wants did not change" can never mean "the inner
    // assembly already carries them": the offer has to be re-applied each step.
    const second = await ctx.assembleWithInner()
    const third = await ctx.assembleWithInner()
    expect(mcpNames(second.assembly)).toEqual(['mcp__alpha__code_review'])
    expect(mcpNames(third.assembly)).toEqual(['mcp__alpha__code_review'])
    expect(offersSearch(third.assembly)).toBe(true)
  })

  it('offers its own discovery tool, which no registry entry carries', async () => {
    const ctx = new FakeScopeCtx()
    wiring(ctx, () => SCHEMAS)

    // `available` never names the search tool — it is this module's own — so the
    // assembly listener is the only thing that can put it into a request.
    expect(SCHEMAS.some((schema) => schema.name === SEARCH_TOOL_NAME)).toBe(false)
    expect(ctx.registered.has(SEARCH_TOOL_NAME)).toBe(true)
    expect(offersSearch(await ctx.assemble())).toBe(true)
  })

  it('hands back the untouched assembly when the inner list already carries the wanted tools', async () => {
    const ctx = new FakeScopeCtx()
    wiring(ctx, () => SCHEMAS)
    ctx.emitSessionEvent(userMessage(RANKED_REVIEW))
    // The wanted set is the context match plus this module's own discovery tool.
    // An inner list that already equals it leaves the offer nothing to do, so the
    // request keeps the identical object and the prompt prefix stays stable.
    ctx.innerTools = [
      REVIEW,
      { name: SEARCH_TOOL_NAME, description: 'already offered', parameters: {} },
    ]

    const result = await ctx.assembleWithInner()
    expect(result.assembly).toBe(result.inner)
  })

  it('trims the inner list of the tools the budget pushed out', async () => {
    const ctx = new FakeScopeCtx()
    wiring(ctx, () => SCHEMAS)
    ctx.emitSessionEvent(userMessage(RANKED_REVIEW))
    // A presentation owner that lists the whole catalogue leaves the session over
    // budget: the deferred names have to go, so the assembly can no longer be the
    // object the inner listener built — the offer is authoritative about removal.
    ctx.innerTools = [
      ...SCHEMAS,
      { name: SEARCH_TOOL_NAME, description: 'already offered', parameters: {} },
    ]

    const result = await ctx.assembleWithInner()
    expect(result.assembly).not.toBe(result.inner)
    expect(mcpNames(result.assembly)).toEqual(['mcp__alpha__code_review'])
    expect(offersSearch(result.assembly)).toBe(true)
  })

  it('offers the tools the session called', async () => {
    const ctx = new FakeScopeCtx()
    wiring(ctx, () => SCHEMAS, { autoStickySteps: 0 })

    ctx.emitSessionEvent(toolCall('mcp__alpha__deploy'))
    const called = await ctx.assemble()
    // `next()` produced nothing, so this is the one assembly the offer built.
    expect(mcpNames(called)).toEqual(['mcp__alpha__deploy'])
  })

  it('ignores a message whose task text did not change and a text-less message', async () => {
    const ctx = new FakeScopeCtx()
    wiring(ctx, () => SCHEMAS)

    ctx.emitSessionEvent(userMessage(RANKED_REVIEW))
    expect(mcpNames(await ctx.assemble())).toEqual(['mcp__alpha__code_review'])

    // Same text, then a message with no text at all: neither may change the
    // offered set, so the request keeps the tools it already had.
    ctx.emitSessionEvent(userMessage(RANKED_REVIEW))
    expect(mcpNames(await ctx.assemble())).toEqual(['mcp__alpha__code_review'])
    ctx.emitSessionEvent({
      type: 'user/message',
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'image' }] },
    })
    expect(mcpNames(await ctx.assemble())).toEqual(['mcp__alpha__code_review'])
  })

  it('does not offer a context match when the context tier is disabled', async () => {
    const ctx = new FakeScopeCtx()
    wiring(ctx, () => SCHEMAS, { autoLimit: 0 })

    ctx.emitSessionEvent(userMessage(RANKED_REVIEW))
    const assembly = await ctx.assemble()
    // Only the automatic tier is off; the explicit search path stays.
    expect(mcpNames(assembly)).toEqual([])
    expect(offersSearch(assembly)).toBe(true)
  })

  it('clears the context offers on compaction while the baseline stays', async () => {
    const ctx = new FakeScopeCtx()
    const baseline = createActivationState(['mcp__alpha__lint'])
    wiring(ctx, () => SCHEMAS, { state: () => baseline })

    ctx.emitSessionEvent(userMessage(RANKED_REVIEW))
    expect(mcpNames(await ctx.assemble())).toEqual([
      'mcp__alpha__code_review',
      'mcp__alpha__lint',
    ])

    ctx.emitSessionEvent({ type: 'compaction/end' })
    expect(mcpNames(await ctx.assemble())).toEqual(['mcp__alpha__lint'])
  })

  it('reports the advanced state to the caller that owns it', async () => {
    const ctx = new FakeScopeCtx()
    const seen: AutoOfferState[] = []
    wiring(ctx, () => SCHEMAS, { onAutoState: (next) => void seen.push(next) })

    ctx.emitSessionEvent(userMessage(RANKED_REVIEW))
    await ctx.assemble()
    expect(seen).toHaveLength(1)
    expect([...autoPresentedNames(seen[0] as AutoOfferState)]).toEqual(['mcp__alpha__code_review'])
  })

  it('keeps this plugin’s own failure off the request path', async () => {
    const ctx = new FakeScopeCtx()
    const errors: unknown[] = []
    wiring(
      ctx,
      () => {
        throw new Error('probe failed')
      },
      { onError: (error) => void errors.push(error) },
    )

    ctx.emitSessionEvent(userMessage(RANKED_REVIEW))
    expect(await ctx.assemble()).toBe(ctx.lastInner)
    expect(errors.length).toBeGreaterThan(0)
  })

  it('disposes both listeners with the scope', () => {
    const ctx = new FakeScopeCtx()
    const dispose = wiring(ctx, () => SCHEMAS)
    expect(ctx.registered.has('mcp_search_tools')).toBe(true)

    dispose()
    expect(ctx.registered.size).toBe(0)
    // A disposed listener must not observe anything anymore.
    const before = ctx.lastInner
    ctx.emitSessionEvent(userMessage(RANKED_REVIEW))
    expect(before).toBeUndefined()
  })
})

describe('deferral budget', () => {
  it('ships a ten-thousand-token default budget', () => {
    expect(DEFAULT_TOOL_BUDGET_CHARS).toBe(40_000)
  })

  it('counts name, description and serialized parameters', () => {
    const schema: ToolSchemaLike = {
      name: 'mcp__alpha__run',
      description: 'run it',
      parameters: { type: 'object' },
    }
    expect(surfaceChars([schema])).toBe(
      'mcp__alpha__run'.length + 'run it'.length + JSON.stringify({ type: 'object' }).length,
    )
    expect(surfaceChars([])).toBe(0)
  })

  it('counts a schema whose parameters cannot be serialized as its text', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(surfaceChars([{ name: 'ab', description: 'cd', parameters: cyclic }])).toBe(4)
  })

  it('leaves a surface that exactly fits the budget untouched, and still offers the discovery tool', async () => {
    const ctx = new FakeScopeCtx()
    wiring(ctx, () => SCHEMAS, { toolBudgetChars: surfaceChars(SCHEMAS) })

    ctx.emitSessionEvent(userMessage(RANKED_REVIEW))
    const result = await ctx.assembleWithInner()
    // Nothing is deferred, so every mounted tool stays listed — and the
    // discovery tool is pinned: it appears in every disclosure assembly so the
    // model can always discover tools as the project grows.
    expect(result.assembly).not.toBe(result.inner)
    expect(mcpNames(result.assembly)).toEqual(['mcp__alpha__code_review'])
    expect(offersSearch(result.assembly)).toBe(true)
  })

  it('starts deferring one character over the budget', async () => {
    const ctx = new FakeScopeCtx()
    wiring(ctx, () => SCHEMAS, { toolBudgetChars: surfaceChars(SCHEMAS) - 1 })

    ctx.emitSessionEvent(userMessage(RANKED_REVIEW))
    const assembly = await ctx.assemble()
    expect(mcpNames(assembly)).toEqual(['mcp__alpha__code_review'])
    expect(offersSearch(assembly)).toBe(true)
  })

  it('defers every surface when the budget is zero', async () => {
    const ctx = new FakeScopeCtx()
    wiring(ctx, () => [tool('mcp__alpha__ping', 'ping')], { toolBudgetChars: 0 })

    expect(offersSearch(await ctx.assemble())).toBe(true)
  })

  it('adds nothing when the project mounts no MCP tool at all', async () => {
    const ctx = new FakeScopeCtx()
    wiring(ctx, () => [], { toolBudgetChars: 0 })

    const result = await ctx.assembleWithInner()
    expect(result.assembly).toBe(result.inner)
    expect(offersSearch(result.assembly)).toBe(false)
  })
})
