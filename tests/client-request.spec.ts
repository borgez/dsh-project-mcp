/**
 * How the browser half calls a host route.
 *
 * One rule decides the HTTP method: the action, not whether a payload happened to
 * be passed. That distinction was a real defect — the panel's `Sync` and `Retry`
 * carry no body, were sent as `GET`, and the host answered `404` for both, while
 * `Release` (which sends a session id) worked. The rule is pinned here for every
 * action the contract declares, so a route added later cannot quietly inherit the
 * wrong method.
 */

import { describe, expect, it } from 'vitest'
import { ROUTE_ACTIONS } from '../src/shared.ts'
import { routeInit } from '../src/client/view.ts'

describe('route transport', () => {
  it('reads the snapshot with a GET', () => {
    expect(routeInit(ROUTE_ACTIONS.snapshot)).toEqual({})
  })

  it('reads the status channel with a GET — it is a stream, not an action', () => {
    expect(routeInit(ROUTE_ACTIONS.events)).toEqual({})
  })

  it('reads the logs page with a GET, because it only asks for a slice', () => {
    expect(routeInit(ROUTE_ACTIONS.logs)).toEqual({})
  })

  it('posts every action the contract declares, payload or not', () => {
    const reads: string[] = [ROUTE_ACTIONS.snapshot, ROUTE_ACTIONS.events, ROUTE_ACTIONS.logs]
    const actions = Object.values(ROUTE_ACTIONS).filter((action) => !reads.includes(action))
    expect(actions.length).toBeGreaterThan(3)
    for (const action of actions) {
      // No body at all: this is exactly the case that used to degrade to GET.
      const init = routeInit(action)
      expect(init.method, action).toBe('POST')
      expect(init.body, action).toBe('{}')
      expect(init.headers, action).toMatchObject({ 'content-type': 'application/json' })
    }
  })

  it('carries the payload an action does take', () => {
    const init = routeInit(ROUTE_ACTIONS.release, { sessionId: 'session-1' })
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ sessionId: 'session-1' }))
  })

  it('sends an empty object rather than an empty body', () => {
    // An empty string would be a body the host cannot parse; `{}` is a request
    // with no fields, which every action route accepts.
    expect(routeInit(ROUTE_ACTIONS.sync)).toMatchObject({ body: '{}' })
  })
})
