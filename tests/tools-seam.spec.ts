/**
 * The seam between the host's tool-presentation row and the panel that draws it.
 *
 * `toolsFor()` (host, `src/activation.ts`) produces `SessionTools`; the sidebar
 * and the settings page turn it into counters, a budget line and a hidden split.
 * Those two halves meet at a frozen type and nothing else, so
 * the readings that are easy to get subtly wrong are checked here on the host's
 * own output instead of on hand-made fixtures: what a fitting surface reports,
 * what a deployment with no threshold reports, and what an unmounted session
 * reports (nothing at all — not zeroes).
 */

import { describe, expect, it } from 'vitest'
import { toolsFor } from '../src/activation.ts'
import type { SessionToolInput, ToolSchemaLike } from '../src/activation.ts'
import type { SessionTools } from '../src/types.ts'
import { budgetLine, budgetSplit, fallbackTranslate, hiddenByServer, toolCounts } from '../src/client/view.ts'

/** One schema as the registry publishes it. */
function tool(name: string): ToolSchemaLike {
  return { name, description: 'helper tool', parameters: {} }
}

/**
 * One published row, with the fields these checks do not care about left absent.
 * @param overrides - the session and its mounted schemas, plus what the check sets.
 * @returns what the host would publish for that session.
 */
function rowFor(
  overrides: Omit<SessionToolInput, 'activation' | 'auto' | 'activationEnabled'> & {
    activation?: SessionToolInput['activation']
    auto?: SessionToolInput['auto']
    activationEnabled?: boolean
  },
): SessionTools | undefined {
  return toolsFor({
    activationEnabled: true,
    activation: undefined,
    auto: undefined,
    ...overrides,
  })
}

const SURFACE = [
  tool('mcp__tglider__workspace'),
  tool('mcp__tglider__find_references'),
  tool('mcp__grafana__query_prometheus'),
]

/** Everything the panel can read out of one published row, as one string. */
function lineOf(tools: SessionTools): string {
  return texts(budgetLine(tools, fallbackTranslate)).join(' ')
}

/** Text inside a rendered tree, the way the panel's own specs read it. */
function texts(node: unknown): string[] {
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (Array.isArray(node)) return node.flatMap((child) => texts(child))
  const element = node as { props: { children?: unknown } }
  return texts(element.props.children)
}

describe('tool presentation seam', () => {
  it('publishes nothing at all for a session that mounted nothing', () => {
    // "Not mounted" is absence, not a row of zeroes: the panel must be able to
    // tell the two apart, and only the host can say which one this is.
    expect(rowFor({ sessionId: 's1', mounted: [], activationEnabled: true })).toBeUndefined()
  })

  it('reports a fitting surface as no line at all, not as a budget spent', () => {
    const row = rowFor({
      sessionId: 's1',
      mounted: SURFACE,
      budgetChars: 40_000,
    })
    expect(row?.deferring).toBe(false)
    expect(row?.deferred).toEqual([])

    expect(toolCounts(row as SessionTools).hidden).toBe(0)
    expect(budgetSplit(row as SessionTools).exhausted).toBe(false)
    // The line must not tell the user the gate is off here: the gate is on, the
    // surface simply fits — and a fitting surface has nothing to report, so the
    // budget prints no sentence rather than one about nothing.
    expect(lineOf(row as SessionTools)).toBe('')
    expect(budgetLine(row as SessionTools, fallbackTranslate)).toBe(null)
  })

  it('defers the whole surface when the deployment set no threshold', () => {
    // The host reads a zero budget as "no threshold at all", so every tool is
    // over it. A panel that read zero as "nothing is deferred" would show a
    // session offering nothing with no explanation.
    const row = rowFor({
      sessionId: 's1',
      mounted: SURFACE,
      budgetChars: 0,
    })
    expect(row?.deferring).toBe(true)
    expect(toolCounts(row as SessionTools).hidden).toBe(SURFACE.length)
    expect(budgetSplit(row as SessionTools).exhausted).toBe(true)
    // The line speaks the real measured surface in characters; the mockup's
    // disclosure slots are gone from the panel entirely (F-11, contract C7).
    expect(lineOf(row as SessionTools)).not.toContain('slot')
    expect(lineOf(row as SessionTools)).toContain('char')
    // And it must not claim the gate is off while it is deferring tools.
    expect(lineOf(row as SessionTools)).not.toContain('gate is off')
  })

  it('derives the hidden split from the deferred names the host published', () => {
    const row = rowFor({
      sessionId: 's1',
      mounted: SURFACE,
      budgetChars: 0,
    })
    const groups = hiddenByServer((row as SessionTools).deferred)
    // Busiest server first, so the biggest hole in the request reads first.
    expect(groups.map((group) => group.server)).toEqual(['tglider', 'grafana'])
    expect(groups.map((group) => group.count)).toEqual([2, 1])
    // The sum is the hidden count the counters show — one number, one source.
    expect(groups.reduce((total, group) => total + group.count, 0)).toBe(
      toolCounts(row as SessionTools).hidden,
    )
  })

  it('offers a counter-seeded tool from the first snapshot, with no disclosure', () => {
    const row = rowFor({
      sessionId: 's1',
      mounted: SURFACE,
      budgetChars: 0,
      activation: { baseline: new Set(['mcp__tglider__workspace']), active: new Map(), used: new Set() },
    })
    expect(row?.baseline).toEqual(['mcp__tglider__workspace'])
    const counts = toolCounts(row as SessionTools)
    expect(counts.pinned).toBe(1)
    expect(counts.disclosed).toBe(0)
    // A pinned tool is offered, so it is no longer part of the hidden remainder.
    expect(counts.hidden).toBe(SURFACE.length - 1)
  })

  it('shows a session disclosure as disclosed, with the host’s clock reading', () => {
    const at = Date.UTC(2026, 0, 2, 3, 4, 5)
    const row = rowFor({
      sessionId: 's1',
      mounted: SURFACE,
      budgetChars: 0,
      activation: {
        baseline: new Set(),
        active: new Map([['mcp__tglider__find_references', at]]),
        used: new Set(),
      },
    })
    expect(row?.activated).toEqual([
      { name: 'mcp__tglider__find_references', via: 'session', at },
    ])
    expect(toolCounts(row as SessionTools).disclosed).toBe(1)
    expect(toolCounts(row as SessionTools).hidden).toBe(SURFACE.length - 1)
  })
})
