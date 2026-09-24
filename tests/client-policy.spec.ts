/**
 * The per-project policy helpers: what the panel posts and what it reads back.
 *
 * The request bodies are frozen by the host contract (`PinRequest`,
 * `PolicyRequest` in `src/shared.ts`), so the checks here are provenance checks:
 * the exact body that leaves the browser for a `Pin` click or a mode switch, and
 * the exact reading a project with no stored policy falls back to. The fetch is
 * faked — no server, no DOM.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_TOOL_POLICY } from '../src/types.ts'
import type { ProjectSnapshot } from '../src/types.ts'
import { ROUTE_ACTIONS, ROUTE_PREFIX } from '../src/shared.ts'
import {
  operatorBody,
  pinBody,
  conflictBody,
  policyBody,
  policyOf,
  postPin,
  postConflict,
  postPolicyMode,
  requestConflict,
  requestMode,
} from '../src/client/policy.ts'

/** One project as the host publishes it, with or without a stored policy. */
function project(policy?: ProjectSnapshot['policy']): ProjectSnapshot {
  const base: ProjectSnapshot = {
    projectRoot: '/repo/project1',
    sessionIds: ['session-aaa11111'],
    rows: [],
    issues: [],
    sessions: [],
  }
  return policy === undefined ? base : { ...base, policy }
}

/** Answer the next fetch with one envelope, and record what was sent. */
function fetchOnce(payload: unknown, status = 200): { url: string; init: RequestInit | undefined } {
  const seen: { url: string; init: RequestInit | undefined } = { url: '', init: undefined }
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    seen.url = url
    seen.init = init
    return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(payload) })
  })
  return seen
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the policy a project follows', () => {
  it('reads the stored policy when the host published one', () => {
    const policy = { mode: 'off' as const, pins: ['mcp__tglider__workspace'] }

    expect(policyOf(project(policy))).toBe(policy)
  })

  it('falls back to the frozen default for a host older than the policy store', () => {
    expect(policyOf(project())).toBe(DEFAULT_TOOL_POLICY)
    // The default is the shipped behaviour, read rather than re-declared: a
    // project the host says nothing about offers the disclosing baseline.
    expect(policyOf(project()).mode).toBe('disclosure')
    expect(policyOf(project()).pins).toEqual([])
  })
})

describe('the request bodies', () => {
  it('shapes a pin and an unpin exactly as `PinRequest` fixes them', () => {
    expect(pinBody('/repo/project1', 'mcp__tglider__workspace', true)).toEqual({
      projectRoot: '/repo/project1',
      tool: 'mcp__tglider__workspace',
      pinned: true,
    })
    expect(pinBody('/repo/project1', 'mcp__tglider__workspace', false).pinned).toBe(false)
  })

  it('shapes a mode write exactly as `PolicyRequest` fixes it', () => {
    expect(policyBody('/repo/project1', 'direct')).toEqual({
      projectRoot: '/repo/project1',
      mode: 'direct',
    })
    expect(policyBody('/repo/project1', 'off').mode).toBe('off')
  })

  it('shapes a conflict choice exactly as `ConflictRequest` fixes it', () => {
    // The name travels as declared, never as the local alias the panel printed:
    // the alias is the host's own computation, and sending one back would pin
    // the panel to a name the host may recompute.
    expect(conflictBody('/repo/project1', 'grafana-local', 'local')).toEqual({
      projectRoot: '/repo/project1',
      server: 'grafana-local',
      choice: 'local',
    })
    expect(conflictBody('/repo/project1', 'grafana-local', 'profile').choice).toBe('profile')
    // The third answer names nothing either: the host mounts the project's own
    // declaration under the name it declares, so no alias travels back.
    expect(conflictBody('/repo/project1', 'grafana-local', 'native').choice).toBe('native')
  })

  it('names the project an operator action belongs to, so the host scopes it', () => {
    expect(operatorBody('/repo/project1')).toEqual({ projectRoot: '/repo/project1' })
    // A surface that lists every project asks for the whole answer back.
    expect(operatorBody('/repo/project1', true)).toEqual({
      projectRoot: '/repo/project1',
      full: true,
    })
    // Nothing to name: the request stays the global one it always was.
    expect(operatorBody(undefined)).toEqual({})
    expect(operatorBody(undefined, true)).toEqual({})
  })
})

describe('posting a pin', () => {
  it('posts to the pin route and hands back the snapshot the host re-read', async () => {
    const seen = fetchOnce({ ok: true, value: { ready: true, projects: [], watchedFiles: [] } })
    const answer = await postPin(pinBody('/repo/project1', 'mcp__tglider__workspace', true))

    expect(seen.url).toBe(`${ROUTE_PREFIX}/${ROUTE_ACTIONS.pin}`)
    expect(seen.init?.method).toBe('POST')
    expect(JSON.parse(String(seen.init?.body))).toEqual({
      projectRoot: '/repo/project1',
      tool: 'mcp__tglider__workspace',
      pinned: true,
    })
    expect(answer).toEqual({ ok: true, snapshot: { ready: true, projects: [], watchedFiles: [] } })
  })

  it('reads a refusal as a refusal: the host’s own words, nothing written', async () => {
    fetchOnce({ ok: false, error: { code: 'unknown-project', message: 'no live session in /repo' } }, 400)
    const answer = await postPin(pinBody('/repo/project1', 'mcp__tglider__workspace', true))

    expect(answer).toEqual({ ok: false, message: 'no live session in /repo' })
  })

  it('carries the refusal’s wire code and params beside the prose (F-48)', async () => {
    fetchOnce(
      {
        ok: false,
        error: {
          code: 'not-found',
          message: 'no live session in /repo',
          messageCode: 'save.noLiveSession',
          messageParams: { projectRoot: '/repo' },
        },
      },
      400,
    )
    const answer = await postPin(pinBody('/repo', 'mcp__tglider__workspace', true))

    expect(answer).toEqual({
      ok: false,
      message: 'no live session in /repo',
      messageCode: 'save.noLiveSession',
      messageParams: { projectRoot: '/repo' },
    })
  })

  it('falls back to the status line when the host refuses without a message', async () => {
    fetchOnce({ ok: false }, 400)

    expect(await postPin(pinBody('/repo/project1', 'x', false))).toEqual({
      ok: false,
      message: 'request failed (400)',
    })
  })

  it('reports a transport failure instead of throwing at the click site', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('Failed to fetch')))

    expect(await postPin(pinBody('/repo/project1', 'x', true))).toEqual({
      ok: false,
      message: 'Failed to fetch',
    })
  })
})

describe('posting a mode', () => {
  it('posts to the policy route', async () => {
    const seen = fetchOnce({ ok: true, value: { ready: true, projects: [], watchedFiles: [] } })
    const answer = await postPolicyMode(policyBody('/repo/project1', 'direct'))

    expect(seen.url).toBe(`${ROUTE_PREFIX}/${ROUTE_ACTIONS.policy}`)
    expect(JSON.parse(String(seen.init?.body))).toEqual({
      projectRoot: '/repo/project1',
      mode: 'direct',
    })
    expect(answer.ok).toBe(true)
  })
})

describe('posting a conflict choice', () => {
  it('posts to the conflict route and carries the declared name', async () => {
    const seen = fetchOnce({ ok: true, value: { ready: true, projects: [], watchedFiles: [] } })
    const answer = await postConflict(conflictBody('/repo/project1', 'grafana-local', 'local'))

    expect(seen.url).toBe(`${ROUTE_PREFIX}/${ROUTE_ACTIONS.conflict}`)
    expect(JSON.parse(String(seen.init?.body))).toEqual({
      projectRoot: '/repo/project1',
      server: 'grafana-local',
      choice: 'local',
    })
    expect(answer.ok).toBe(true)
  })

  it('reports the start and the settle of a choice, and a refusal in the host words', async () => {
    fetchOnce({ ok: false, error: { message: 'no live session in /repo/gone' } }, 400)
    const events: string[] = []
    const answer = await requestConflict(conflictBody('/repo/gone', 'alpha', 'local'), {
      onStart: (server) => events.push(`start ${server}`),
      onSettled: (server) => events.push(`settled ${server}`),
      onRefused: (message) => events.push(`refused: ${message}`),
    })

    expect(answer.ok).toBe(false)
    expect(events).toEqual(['start alpha', 'settled alpha', 'refused: no live session in /repo/gone'])
  })
})

describe('requestMode', () => {
  it('reports the start and the settle of a write that landed', async () => {
    fetchOnce({ ok: true, value: { ready: true, projects: [], watchedFiles: [] } })
    const events: string[] = []
    const answer = await requestMode(policyBody('/repo/project1', 'off'), {
      onStart: (root) => events.push(`start ${root}`),
      onSettled: (root) => events.push(`settled ${root}`),
      onRefused: (message) => events.push(`refused ${message}`),
    })

    expect(answer.ok).toBe(true)
    expect(events).toEqual(['start /repo/project1', 'settled /repo/project1'])
  })

  it('reports a refusal with the host’s message, after settling', async () => {
    fetchOnce({ ok: false, error: { message: 'unknown mode "sideways"' } }, 400)
    const events: string[] = []
    const answer = await requestMode(policyBody('/repo/project1', 'direct'), {
      onStart: () => events.push('start'),
      onSettled: () => events.push('settled'),
      onRefused: (message) => events.push(`refused: ${message}`),
    })

    expect(answer).toEqual({ ok: false, message: 'unknown mode "sideways"' })
    expect(events).toEqual(['start', 'settled', 'refused: unknown mode "sideways"'])
  })

  it('hands the refusal’s code and params to onRefused beside the message (F-48)', async () => {
    fetchOnce(
      {
        ok: false,
        error: {
          code: 'not-found',
          message: 'no live session in /repo/gone',
          messageCode: 'save.noLiveSession',
          messageParams: { projectRoot: '/repo/gone' },
        },
      },
      400,
    )
    const refused: [string, string | undefined, Record<string, string> | undefined][] = []
    const answer = await requestMode(policyBody('/repo/gone', 'direct'), {
      onRefused: (message, messageCode, messageParams) => refused.push([message, messageCode, messageParams]),
    })

    expect(answer.ok).toBe(false)
    expect(refused).toEqual([
      ['no live session in /repo/gone', 'save.noLiveSession', { projectRoot: '/repo/gone' }],
    ])
  })
})
