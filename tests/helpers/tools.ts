/**
 * A synthetic {@link SessionTools} for the client tests.
 *
 * The host publishes one `SessionTools` per session; {@link demoTools} paints the
 * branches the surfaces have to render without a running runtime — a session
 * that pinned something, disclosed two tools and deferred three, one whose
 * budget is already spent, and one the host has not mounted for yet (pass an
 * override, or `mounted: 0`). It used to live beside the sidebar panel's
 * placeholder constants (`src/client/demo.ts`); those are gone, the fixture
 * stayed and moved under `tests/` with the rest of the test doubles.
 *
 * @module tests/helpers/tools
 */

import type { SessionTools } from '../../src/types.ts'

/**
 * A synthetic {@link SessionTools} for tests.
 *
 * @param overrides - fields to replace on the default (1 pinned, 2 disclosed, 3 deferred).
 * @returns one session's tool offer.
 */
export function demoTools(overrides: Partial<SessionTools> = {}): SessionTools {
  return {
    sessionId: 'session-demo',
    baseline: ['mcp__tglider__workspace'],
    activated: [
      { name: 'mcp__tglider__find_references', via: 'session', at: 1_700_000_000_000 },
      { name: 'mcp__tglider__get_cascade_impact', via: 'session', at: 1_700_000_000_100 },
    ],
    context: [],
    deferred: [
      'mcp__tglider__symbol',
      'mcp__grafana-local__query_prometheus',
      'mcp__memory__search_nodes',
    ],
    mounted: 47,
    surfaceChars: 0,
    budgetChars: 0,
    deferring: false,
    ...overrides,
  }
}
