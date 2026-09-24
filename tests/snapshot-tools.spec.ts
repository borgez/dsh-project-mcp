/**
 * The per-session tool presentation row: what one session offers the model, and
 * how much of its mounted surface the request leaves out.
 *
 * The contract under test is a measurement, not a decision. `mounted` counts the
 * schemas the caller probed, `deferred` is exactly what is not in the request,
 * and the tier lists name why the rest is. A session that mounts no tool has no
 * row at all — "not mounted" and "offers nothing" are different statements — and
 * the derivation reads its inputs at call time, so a row read after an
 * activation lists it.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TOOL_BUDGET_CHARS,
  activate,
  advanceAutoOffer,
  autoOffers,
  createActivationState,
  createAutoOfferState,
  surfaceChars,
  toolsFor,
} from '../src/activation.ts'
import type { SessionToolInput, ToolSchemaLike } from '../src/activation.ts'

const AT = Date.UTC(2024, 4, 6, 7, 8, 9)

/** One schema as the registry publishes it; the description feeds the surface. */
function tool(name: string, description = ''): ToolSchemaLike {
  return { name, description, parameters: {} }
}

function input(overrides: Partial<SessionToolInput> = {}): SessionToolInput {
  return {
    sessionId: 'session-1',
    mounted: [tool('mcp__alpha__one'), tool('mcp__alpha__two')],
    activation: undefined,
    auto: undefined,
    activationEnabled: true,
    ...overrides,
  }
}

describe('toolsFor', () => {
  it('has nothing to report for a session that mounts no tool', () => {
    expect(toolsFor(input({ mounted: [] }))).toBeUndefined()
  })

  it('measures the mounted surface and the part the request leaves out', () => {
    const mounted = [tool('mcp__alpha__one', 'first'), tool('mcp__alpha__two', 'second')]
    const row = toolsFor(
      input({ mounted, activation: createActivationState(['mcp__alpha__one']), budgetChars: 0 }),
    )

    expect(row).toEqual({
      sessionId: 'session-1',
      baseline: ['mcp__alpha__one'],
      activated: [],
      context: [],
      deferred: ['mcp__alpha__two'],
      mounted: 2,
      surfaceChars: surfaceChars(mounted),
      visibleChars: surfaceChars([mounted[0] as ToolSchemaLike]),
      deferredChars: surfaceChars([mounted[1] as ToolSchemaLike]),
      budgetChars: 0,
      deferring: true,
    })
  })

  it('uses the shipped budget when the caller configures none', () => {
    const row = toolsFor(input())
    expect(row?.budgetChars).toBe(DEFAULT_TOOL_BUDGET_CHARS)
    expect(row?.deferring).toBe(false)
    expect(row?.deferred).toEqual([])
  })

  it('hides nothing while the surface fits the budget, and one character over it', () => {
    const mounted = [tool('mcp__alpha__one', 'first'), tool('mcp__alpha__two', 'second')]
    const fits = toolsFor(input({ mounted, budgetChars: surfaceChars(mounted) }))
    expect(fits?.deferring).toBe(false)
    expect(fits?.deferred).toEqual([])

    const over = toolsFor(input({ mounted, budgetChars: surfaceChars(mounted) - 1 }))
    expect(over?.deferring).toBe(true)
    expect(over?.deferred).toEqual(['mcp__alpha__one', 'mcp__alpha__two'])
  })

  it('reports the session activations oldest first, with their touch time', () => {
    const mounted = [
      tool('mcp__alpha__one'),
      tool('mcp__alpha__two'),
      tool('mcp__alpha__three'),
    ]
    let activation = createActivationState()
    activation = activate(activation, ['mcp__alpha__two'], AT + 2_000)
    activation = activate(activation, ['mcp__alpha__three'], AT + 1_000)
    const row = toolsFor(input({ mounted, activation, budgetChars: 0 }))

    expect(row?.activated).toEqual([
      { name: 'mcp__alpha__three', via: 'session', at: AT + 1_000 },
      { name: 'mcp__alpha__two', via: 'session', at: AT + 2_000 },
    ])
    expect(row?.deferred).toEqual(['mcp__alpha__one'])
  })

  it('drops tier names the session no longer mounts', () => {
    const mounted = [tool('mcp__alpha__one')]
    const activation = activate(
      createActivationState(['mcp__alpha__gone_baseline']),
      ['mcp__alpha__gone_active'],
      AT,
    )
    const row = toolsFor(input({ mounted, activation, budgetChars: 0 }))

    expect(row?.baseline).toEqual([])
    expect(row?.activated).toEqual([])
    expect(row?.deferred).toEqual(['mcp__alpha__one'])
  })

  it('orders the context tier by the advance that offered each name', () => {
    // The first advance offers the name that sorts *after* the second one, so a
    // name-ordered list would disagree with the advance-ordered one under test.
    const mounted = [tool('mcp__alpha__zeta'), tool('mcp__alpha__beta')]
    let auto = createAutoOfferState()
    auto = advanceAutoOffer(auto, { userText: 'zeta' }, mounted, {})
    auto = advanceAutoOffer(auto, { userText: 'beta' }, mounted, {})

    expect(autoOffers(auto)).toEqual(['mcp__alpha__zeta', 'mcp__alpha__beta'])

    const row = toolsFor(input({ mounted, auto, budgetChars: 0 }))
    expect(row?.context).toEqual([
      { name: 'mcp__alpha__zeta', via: 'context' },
      { name: 'mcp__alpha__beta', via: 'context' },
    ])
    expect(row?.deferred).toEqual([])
  })

  it('leaves the whole surface in the request when activation is off', () => {
    const row = toolsFor(input({ budgetChars: 0, activationEnabled: false }))
    expect(row?.deferring).toBe(false)
    expect(row?.deferred).toEqual([])
    expect(row?.mounted).toBe(2)
  })

  it('reads the tiers again on every call, so the next row shows an activation', () => {
    const mounted = [tool('mcp__alpha__one')]
    const before = toolsFor(input({ mounted, budgetChars: 0 }))
    expect(before?.activated).toEqual([])
    expect(before?.deferred).toEqual(['mcp__alpha__one'])

    const activation = activate(createActivationState(), ['mcp__alpha__one'], AT)
    const after = toolsFor(input({ mounted, activation, budgetChars: 0 }))
    expect(after?.activated).toEqual([{ name: 'mcp__alpha__one', via: 'session', at: AT }])
    expect(after?.deferred).toEqual([])
  })

  it('offers a pinned name from the first row, whatever the counters say', () => {
    const mounted = [tool('mcp__alpha__one', 'first'), tool('mcp__alpha__two', 'second')]
    const row = toolsFor(
      input({ mounted, budgetChars: 0, policy: { mode: 'disclosure', pins: ['mcp__alpha__two'] } }),
    )

    // No counters, no activation, no context: the pin alone is offered, so a
    // budget of `0` (every surface counts as over it) hides only the unpinned name.
    expect(row?.baseline).toEqual(['mcp__alpha__two'])
    expect(row?.deferred).toEqual(['mcp__alpha__one'])
    expect(row?.deferring).toBe(true)
  })

  it('adds pins to the counter baseline, sorted and without duplicates', () => {
    const mounted = [tool('mcp__alpha__one'), tool('mcp__alpha__two')]
    const row = toolsFor(
      input({
        mounted,
        budgetChars: 0,
        activation: createActivationState(['mcp__alpha__one']),
        policy: { mode: 'disclosure', pins: ['mcp__alpha__two', 'mcp__alpha__one'] },
      }),
    )

    expect(row?.baseline).toEqual(['mcp__alpha__one', 'mcp__alpha__two'])
    expect(row?.deferred).toEqual([])
  })

  it('drops a pinned name the session no longer mounts, and never hides one', () => {
    const mounted = [tool('mcp__alpha__one')]
    const policy = { mode: 'disclosure' as const, pins: ['mcp__alpha__gone'] }
    const row = toolsFor(input({ mounted, budgetChars: 0, policy }))

    // The row describes what is offered, so an unmounted pin is not in it — the
    // policy keeps the name itself, which is where the panel reads it from.
    expect(row?.baseline).toEqual([])
    expect(policy.pins).toEqual(['mcp__alpha__gone'])
    expect(row?.deferred).toEqual(['mcp__alpha__one'])
  })

  it('defers nothing in direct mode, whatever the budget says', () => {
    const mounted = [tool('mcp__alpha__one', 'first'), tool('mcp__alpha__two', 'second')]
    const row = toolsFor(
      input({
        mounted,
        // The same gate that hides everything in `disclosure` defers nothing
        // here: the assembly listener adds nothing in this mode either.
        budgetChars: 0,
        activation: createActivationState(['mcp__alpha__two']),
        policy: { mode: 'direct', pins: ['mcp__alpha__one'] },
      }),
    )

    expect(row?.deferring).toBe(false)
    expect(row?.deferred).toEqual([])
    expect(row?.mounted).toBe(2)
    // The request carries the whole catalogue in this mode, so the baseline is
    // not a promise about what is hidden — it is still the counters plus the
    // pins, which is what the panel's "pinned" badge reads.
    expect(row?.baseline).toEqual(['mcp__alpha__one', 'mcp__alpha__two'])
  })

  it('offers nothing in off mode, and hides the whole mounted surface', () => {
    const mounted = [tool('mcp__alpha__one'), tool('mcp__alpha__two')]
    const row = toolsFor(
      input({
        mounted,
        budgetChars: 0,
        activation: createActivationState(['mcp__alpha__one']),
        policy: { mode: 'off', pins: ['mcp__alpha__two'] },
      }),
    )

    // Off offers none of the project's tools, so no tier of the row offers one:
    // a pin stays in the policy and the counter baseline stays in the counters,
    // but the row promises nothing, and the whole surface is therefore what this
    // plugin leaves out of the request. The panel reads the mode itself instead
    // of printing these numbers as "hidden".
    expect(row?.deferring).toBe(false)
    expect(row?.baseline).toEqual([])
    expect(row?.activated).toEqual([])
    expect(row?.context).toEqual([])
    expect(row?.deferred).toEqual(['mcp__alpha__one', 'mcp__alpha__two'])
    expect(row?.mounted).toBe(2)
  })
})
