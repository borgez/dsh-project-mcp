/**
 * The host's usage counters as a surface reads them: how often one tool was
 * called, and how long a server has been idle.
 *
 * Both readings are pure arithmetic over `ProjectSnapshot.usage`
 * (`src/types.ts:425`) and neither invents a value the host did not publish: a
 * counter that is absent and a server the host never recorded are different
 * states, and a date that does not parse is not a quiet server. The module is
 * the one place those two readings live, so the tab, the settings page and the
 * pin picker cannot drift from one another.
 *
 * @module tests/usage-view
 */

import { describe, expect, it } from 'vitest'
import type { ServerUsage } from '../src/types.ts'
import { byCalls, callsOfToolName, idleOf, toolCalls } from '../src/client/usage-view.ts'

/** One server's record, with only the fields a reading here touches. */
function record(
  calls: number,
  tools: Record<string, number>,
  lastUsedAt?: string,
): ServerUsage {
  return lastUsedAt === undefined
    ? { calls, errors: 0, tools }
    : { calls, errors: 0, tools, lastUsedAt }
}

/** A fixed `now`, so every expectation below is a fact rather than a clock. */
const NOW = Date.UTC(2026, 0, 2, 12, 0, 0)

/** `lastUsedAt` that many milliseconds before {@link NOW}. */
function ago(ms: number): string {
  return new Date(NOW - ms).toISOString()
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('callsOfToolName', () => {
  const usage = {
    tglider: record(182, { workspace: 180, find__refs: 2 }, ago(3 * DAY)),
    grafana: record(3, {}),
  }

  it('reads the counter of the tool a public name holds', () => {
    expect(callsOfToolName('mcp__tglider__workspace', usage)).toBe(180)
    // The tool key is what follows the second `__`, not the first: a declared
    // name of its own may hold the separator.
    expect(callsOfToolName('mcp__tglider__find__refs', usage)).toBe(2)
    expect(callsOfToolName('mcp__grafana__query', { grafana: record(0, { query: 0 }) })).toBe(0)
  })

  it('answers nothing for a name that carries no server to look up', () => {
    // A built-in, or a name another owner contributes: no `mcp__<server>__`
    // prefix means no server record, and no record means no number.
    expect(callsOfToolName('workspace', usage)).toBeUndefined()
    expect(callsOfToolName('mcp__', usage)).toBeUndefined()
    expect(callsOfToolName('mcp__tglider', usage)).toBeUndefined()
  })

  it('answers nothing for a server the host did not record', () => {
    expect(callsOfToolName('mcp__memory__search_nodes', usage)).toBeUndefined()
  })

  it('answers nothing for a tool the server recorded no counter for', () => {
    // The server is in the snapshot, this tool is not: the surface reads that
    // as "never called", and the counter itself stays absent.
    expect(callsOfToolName('mcp__grafana__query', usage)).toBeUndefined()
  })

  it('answers nothing at all while the host published no usage', () => {
    expect(callsOfToolName('mcp__tglider__workspace', undefined)).toBeUndefined()
  })
})

describe('idleOf', () => {
  it('counts whole days once a full day has passed', () => {
    expect(idleOf(ago(3 * DAY), NOW)).toEqual({ unit: 'day', count: 3 })
    // Exactly 24 h is the first day, not a 24-hour span.
    expect(idleOf(ago(DAY), NOW)).toEqual({ unit: 'day', count: 1 })
    // 47 h is still one whole day: the reading is floored, not rounded.
    expect(idleOf(ago(47 * HOUR), NOW)).toEqual({ unit: 'day', count: 1 })
  })

  it('counts whole hours under a day', () => {
    expect(idleOf(ago(23 * HOUR), NOW)).toEqual({ unit: 'hour', count: 23 })
    expect(idleOf(ago(90 * MINUTE), NOW)).toEqual({ unit: 'hour', count: 1 })
    expect(idleOf(ago(HOUR), NOW)).toEqual({ unit: 'hour', count: 1 })
  })

  it('falls back to whole minutes, zero included', () => {
    expect(idleOf(ago(59 * MINUTE), NOW)).toEqual({ unit: 'minute', count: 59 })
    expect(idleOf(ago(30_000), NOW)).toEqual({ unit: 'minute', count: 0 })
    // `now` itself is not the future: a call that just landed is `idle 0m`.
    expect(idleOf(new Date(NOW).toISOString(), NOW)).toEqual({ unit: 'minute', count: 0 })
  })

  it('has nothing to say about a date that is not one', () => {
    expect(idleOf(undefined, NOW)).toBeUndefined()
    expect(idleOf('', NOW)).toBeUndefined()
    expect(idleOf('yesterday', NOW)).toBeUndefined()
  })

  it('has nothing to say about a date in the future', () => {
    // A host clock ahead of this one is not a server that has been idle for a
    // negative span, and printing one would be an invented number.
    expect(idleOf(ago(-MINUTE), NOW)).toBeUndefined()
    expect(idleOf(ago(-DAY), NOW)).toBeUndefined()
  })
})

describe('byCalls', () => {
  const usage = {
    srv: record(197, { hot: 182, warm: 12 }),
    other: record(4, {}),
  }

  it('puts the most-called name first', () => {
    const names = ['mcp__srv__warm', 'mcp__srv__hot']
    expect([...names].sort(byCalls(usage))).toEqual(['mcp__srv__hot', 'mcp__srv__warm'])
  })

  it('sinks a name whose server is recorded but whose counter is missing below every measured one', () => {
    // `cold` belongs to a server the counters know; the absence of its own
    // counter is "not measured", not "zero", so it must not outrank `warm`.
    const names = ['mcp__srv__cold', 'mcp__srv__warm']
    expect([...names].sort(byCalls(usage))).toEqual(['mcp__srv__warm', 'mcp__srv__cold'])
  })

  it('leaves every name without a number in the order the host gave them', () => {
    // Measured names first; the unnumbered ones — a server the counters never
    // recorded and a recorded server whose counter for this name is missing —
    // are one group, and the sort is stable, so the host's own order survives.
    const names = ['mcp__srv__cold', 'mcp__other__x', 'mcp__ghost__y']
    expect([...names].sort(byCalls(usage))).toEqual([
      'mcp__srv__cold',
      'mcp__other__x',
      'mcp__ghost__y',
    ])
  })

  it('keeps the host’s order for equal counts, so a list never reshuffles for nothing', () => {
    const tied = { srv: record(4, { b: 7, a: 7 }) }
    expect(['mcp__srv__b', 'mcp__srv__a'].sort(byCalls(tied))).toEqual([
      'mcp__srv__b',
      'mcp__srv__a',
    ])
  })

  it('is the identity when the host published nothing', () => {
    const names = ['mcp__b__x', 'mcp__a__x']
    expect([...names].sort(byCalls(undefined))).toEqual(names)
  })
})

describe('toolCalls', () => {
  /** One server the host splits by session: 182 project calls, 5 of them ours. */
  const usage = {
    srv: {
      calls: 187,
      errors: 0,
      tools: { hot: 182, warm: 12 },
      sessions: { 'session-a': { calls: 5, errors: 0, tools: { warm: 5 } } },
    },
  }

  it('reads the project total and this session’s own share', () => {
    expect(toolCalls('mcp__srv__warm', usage, 'session-a')).toEqual({
      recorded: true,
      split: true,
      project: 12,
      session: 5,
    })
  })

  it('says the session is split without a reading for a tool it never called', () => {
    // `hot` is in the project's counters and in the split's server record, but
    // not in this session's own tools: "never called here", not "no data".
    expect(toolCalls('mcp__srv__hot', usage, 'session-a')).toEqual({
      recorded: true,
      split: true,
      project: 182,
      session: undefined,
    })
  })

  it('marks a host that publishes no split at all, and reads the project only', () => {
    const unsplit = { srv: { calls: 182, errors: 0, tools: { hot: 182 } } }
    expect(toolCalls('mcp__srv__hot', unsplit, 'session-a')).toEqual({
      recorded: true,
      split: false,
      project: 182,
      session: undefined,
    })
  })

  it('marks a session the host recorded without this server', () => {
    expect(toolCalls('mcp__srv__hot', usage, 'session-b')).toEqual({
      recorded: true,
      split: false,
      project: 182,
      session: undefined,
    })
  })

  it('marks a name whose server the counters never recorded', () => {
    expect(toolCalls('mcp__srv__hot', undefined, 'session-a')).toEqual({
      recorded: false,
      split: false,
      project: undefined,
      session: undefined,
    })
    expect(toolCalls('not-a-registry-name', usage, 'session-a').recorded).toBe(false)
  })
})

describe('byCalls with a session split', () => {
  /** `theirs` is hot for the project and cold for us; `ours` is the reverse. */
  const usage = {
    srv: {
      calls: 300,
      errors: 0,
      tools: { theirs: 290, ours: 10 },
      sessions: { me: { calls: 10, errors: 0, tools: { ours: 10 } } },
    },
  }

  it('orders by the figure the row leads with, not by the project total', () => {
    const names = ['mcp__srv__theirs', 'mcp__srv__ours']
    // By the project, `theirs` wins; by our own session, `ours` does, and the
    // session's reading is the one the row leads with.
    expect([...names].sort(byCalls(usage, 'me'))).toEqual(['mcp__srv__ours', 'mcp__srv__theirs'])
    expect([...names].sort(byCalls(usage))).toEqual(['mcp__srv__theirs', 'mcp__srv__ours'])
  })
})
