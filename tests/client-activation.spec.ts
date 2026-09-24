/**
 * Activation guard for the browser half.
 *
 * Every other client test drives `apply` with a hand-written context double, so
 * a double that answers service properties happily hides the production rule:
 * the DSH client serves services through a Cordis proxy that throws
 * `cannot get property "…" without inject` for a name the fiber did not declare
 * (`<harness>/vendor/cordis/src/reflect.ts`), and a throwing `apply` fails the
 * entry, which takes the whole DSH web boot down. The shipped 0.1.9 bundle did
 * exactly that by reading `ctx.locale` and `ctx.betterSidebar` as properties.
 *
 * Two guards cover it: `tests/bundle.spec.ts` drives the built bundle through a
 * proxy that throws the same way, and this spec drives the source against a real
 * `Context` that provides none of the optional services.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

describe('the browser half against a real Cordis context', () => {
  it('declares no module-level dependency: every service it uses is optional', () => {
    expect(inject).toEqual([])
  })

  it('activates in a composition that provides none of the services it uses', () => {
    const ctx = new Context()

    expect(() => {
      apply(ctx)
    }).not.toThrow()
  })

  it('answers `undefined` for the optional services instead of failing the entry', () => {
    const ctx = new Context()

    expect(ctx.get('betterSidebar')).toBeUndefined()
    expect(ctx.get('locale')).toBeUndefined()
  })

  it('registers nothing through the slot services it does not have', () => {
    const ctx = new Context()

    apply(ctx)

    expect(ctx.get('slots')).toBeUndefined()
  })
})
