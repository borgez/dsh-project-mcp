/**
 * Scope doubles for a runtime under test.
 *
 * The runtime mints one Cordis scope per session and one per project, and it
 * links a session key to its project key itself (`bindScopeParent`), because
 * that link is what the tools registry walks to resolve a session's catalog
 * (`scopeChainOf`). A test double that hands every scope the session's own
 * context would therefore model neither where a mount lives nor what a session
 * sees; these doubles do:
 *
 * - one double per scope key, a fresh project double per project;
 * - the chain a session resolves read back through the runtime's own parent
 *   links, so a released session really stops seeing its project's tools;
 * - the exact `createScope` the runtime consumes, so a test asserts on the
 *   scopes and instances the runtime created rather than on a parallel model.
 *
 * @module tests/helpers/scopes
 */

import { scopeChainOf } from '@deepseek-ai/dsh-scope'
import type { Context } from '@deepseek-ai/cordis'
import { isProjectScopeKey } from '../../src/runtime.ts'

/** One scope double, plus the lookups a test needs to read what it owns. */
export interface FakeScopes<C> {
  /** Factory for `RuntimeOptions.createScope`. */
  readonly createScope: (ctx: Context, key: object) => { ctx: Context; dispose: () => Promise<void> }
  /**
   * The doubles one session resolves, nearest scope first — exactly the order
   * the registry merges a scope chain in. Empty of project doubles while the
   * session holds none (it was released, or never took a hold).
   * @param agent - the session key the runtime minted its scope with.
   * @returns the doubles of its chain, nearest first.
   */
  chainOf(agent: object): C[]
  /**
   * The project double minted for one project root.
   * @param projectRoot - absolute project root.
   * @returns the double, or `undefined` while nothing was mounted there.
   */
  forProject(projectRoot: string): C | undefined
  /**
   * The double one scope key resolves to.
   * @param key - session or project scope key the runtime minted a scope for.
   * @returns the double, or `undefined` while the runtime minted none for it.
   */
  doubleOf(key: object): C | undefined
  /** Every project double the runtime minted, in mint order. */
  readonly projects: readonly C[]
}

/**
 * Build the scope doubles of one runtime.
 * @param makeProjectCtx - creates the double of one project scope.
 * @param sessionCtx - reads the double of one session key.
 * @param dispose - disposes one double, as scope disposal does.
 * @returns the factory and the lookups over what it minted.
 */
export function fakeScopes<C>(
  makeProjectCtx: () => C,
  sessionCtx: (key: object) => C,
  dispose: (ctx: C) => unknown,
): FakeScopes<C> {
  const byKey = new Map<object, C>()
  const byRoot = new Map<string, C>()
  const projects: C[] = []

  const createScope = (_ctx: Context, key: object): { ctx: Context; dispose: () => Promise<void> } => {
    let double: C
    if (isProjectScopeKey(key)) {
      double = makeProjectCtx()
      projects.push(double)
      byRoot.set(key.projectRoot, double)
    } else {
      double = sessionCtx(key)
    }
    byKey.set(key, double)
    return {
      ctx: double as unknown as Context,
      dispose: async () => {
        await dispose(double)
      },
    }
  }

  const chainOf = (agent: object): C[] => {
    const chain: C[] = []
    for (const key of scopeChainOf(agent)) {
      const double = byKey.get(key) ?? (key === agent ? sessionCtx(agent) : undefined)
      if (double !== undefined) chain.push(double)
    }
    return chain
  }

  return {
    createScope,
    chainOf,
    doubleOf: (key) => byKey.get(key),
    forProject: (projectRoot) => byRoot.get(projectRoot),
    projects,
  }
}

/**
 * Merge a session's chain into the catalog it resolves: nearest scope first,
 * first name wins, the way the registry shadows a farther registration.
 * @param doubles - one session's chain, nearest first.
 * @param schemasOf - reads one double's own layer.
 * @returns the schemas this session can see.
 */
export function chainSchemas<C, S extends { name: string }>(
  doubles: readonly C[],
  schemasOf: (ctx: C) => readonly S[],
): S[] {
  const seen = new Set<string>()
  const merged: S[] = []
  for (const double of doubles) {
    for (const schema of schemasOf(double)) {
      if (seen.has(schema.name)) continue
      seen.add(schema.name)
      merged.push(schema)
    }
  }
  return merged
}
