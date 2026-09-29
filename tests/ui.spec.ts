/**
 * Host HTTP surface of the sidebar panel: the browser half can only reach the
 * runtime over these routes, so the routing, the envelope and the failure
 * behaviour are pinned here without starting a server.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ProjectMcpService } from '../src/index.ts'
import { clear as clearLogs, record as recordLog } from '../src/logs.ts'
import type {
  ConflictRequest,
  PinRequest,
  PolicyRequest,
  SaveErrorCode,
  SaveRequest,
} from '../src/shared.ts'
import { ROUTE_PREFIX } from '../src/shared.ts'
import type { LogEvent, McpSnapshot, SnapshotChange } from '../src/types.ts'
import { createEventStream, createRouteHandler, disposeRegistration, registerRoutes } from '../src/ui.ts'

const SNAPSHOT: McpSnapshot = {
  ready: true,
  projects: [
    {
      projectRoot: '/tmp/repo',
      sessionIds: ['session-1', 'session-2'],
      rows: [{ name: 'alpha', status: 'active', projectRoot: '/tmp/repo' }],
      issues: [],
      sessions: [
        { id: 'session-1', rows: [{ name: 'alpha', status: 'idle', projectRoot: '/tmp/repo' }], issues: [] },
        { id: 'session-2', rows: [{ name: 'alpha', status: 'active', projectRoot: '/tmp/repo' }], issues: [] },
      ],
    },
  ],
  watchedFiles: ['/tmp/repo'],
}

function fakeService(overrides: Partial<ProjectMcpService> = {}) {
  const calls: string[] = []
  const service: ProjectMcpService = {
    snapshot: () => SNAPSHOT,
    syncNow: async (projectRoot) => {
      calls.push(projectRoot === undefined ? 'syncNow' : `syncNow:${projectRoot}`)
    },
    syncSoon: (projectRoot) => {
      calls.push(projectRoot === undefined ? 'syncSoon' : `syncSoon:${projectRoot}`)
    },
    retry: async (projectRoot) => {
      calls.push(projectRoot === undefined ? 'retry' : `retry:${projectRoot}`)
    },
    release: async (agentId) => {
      calls.push(`release:${agentId ?? 'all'}`)
    },
    save: async () => ({ ok: true, snapshot: SNAPSHOT }),
    setPin: () => ({ ok: true, snapshot: SNAPSHOT }),
    setPolicy: () => ({ ok: true, snapshot: SNAPSHOT }),
    setConflictChoice: () => ({ ok: true, snapshot: SNAPSHOT }),
    // `GET tool` is covered by `tests/tool-detail.spec.ts`; here the stub only
    // carries the interface, and a call records the three names it was asked
    // for so this file's route surface stays the ones it pins.
    toolFacts: (projectRoot, sessionId, name) => {
      calls.push(`toolFacts:${projectRoot}:${sessionId}:${name}`)
      return { ok: false, code: 'not-found', message: `no tool ${name}` }
    },
    subscribe: () => () => undefined,
    ...overrides,
  }
  return { service, calls }
}

const SAVE_BODY: SaveRequest = {
  projectRoot: '/tmp/repo',
  server: 'alpha',
  document: '/tmp/repo/.dsh/mcp.json',
  revision: 'abc123abc123abc1',
  entry: { transport: 'stdio', command: 'npx' },
}

interface Captured {
  status: number
  headers: Record<string, string>
  body: { ok: boolean; value?: McpSnapshot; error?: { code: string; message: string } } | undefined
}

function fakeRes(captured: Captured): ServerResponse {
  return {
    writeHead: (status: number, headers?: Record<string, string>) => {
      captured.status = status
      captured.headers = headers ?? {}
    },
    end: (text?: string) => {
      captured.body = text === undefined ? undefined : JSON.parse(text)
    },
  } as unknown as ServerResponse
}

function fakeReq(method: string, path: string, body?: unknown): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url: path,
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) yield chunk
    },
  } as unknown as IncomingMessage
}

async function call(
  handler: ReturnType<typeof createRouteHandler>,
  method: string,
  path: string,
  body?: unknown,
): Promise<Captured> {
  const captured: Captured = { status: 0, headers: {}, body: undefined }
  await handler(fakeReq(method, path, body), fakeRes(captured))
  return captured
}

/** One project plus a second one, for the answers an operator route narrows. */
const TWO_PROJECTS: McpSnapshot = {
  ready: true,
  projects: [
    ...SNAPSHOT.projects,
    { projectRoot: '/tmp/other', sessionIds: ['session-9'], rows: [], issues: [], sessions: [] },
  ],
  watchedFiles: ['/tmp/repo', '/tmp/other'],
}

/** An open event stream, as the panel sees it: headers, frames, and an end. */
interface FakeStream {
  res: ServerResponse
  headers: Record<string, string>
  frames: string[]
  ended: boolean
}

function fakeSse(): FakeStream {
  const stream: FakeStream = { res: undefined as unknown as ServerResponse, headers: {}, frames: [], ended: false }
  stream.res = {
    writeHead: (_status: number, headers?: Record<string, string>) => {
      stream.headers = headers ?? {}
    },
    write: (frame: string) => {
      stream.frames.push(frame)
      return true
    },
    end: () => {
      stream.ended = true
    },
    on: () => stream.res,
  } as unknown as ServerResponse
  return stream
}

/** A request whose `close` handler the test can fire. */
function fakeEventReq(): { req: IncomingMessage; close: () => void } {
  const handlers: (() => void)[] = []
  const req = {
    method: 'GET',
    url: `${ROUTE_PREFIX}/events`,
    on: (_event: string, handler: () => void) => {
      handlers.push(handler)
      return req
    },
  } as unknown as IncomingMessage
  return { req, close: () => handlers.forEach((handler) => handler()) }
}

describe('panel routes', () => {
  it('serves the snapshot on GET', async () => {
    const { service, calls } = fakeService()
    const captured = await call(createRouteHandler(service), 'GET', `${ROUTE_PREFIX}/snapshot`)

    expect(captured.status).toBe(200)
    expect(captured.headers['content-type']).toBe('application/json')
    expect(captured.body).toEqual({ ok: true, value: SNAPSHOT })
    expect(calls).toEqual([])
  })

  it('carries the per-session breakdown over the wire', async () => {
    const { service } = fakeService()
    const captured = await call(createRouteHandler(service), 'GET', `${ROUTE_PREFIX}/snapshot`)
    const project = captured.body?.value?.projects[0]

    expect(project?.sessions.map((session) => [session.id, session.rows[0]?.status])).toEqual([
      ['session-1', 'idle'],
      ['session-2', 'active'],
    ])
    // The merged row reports the mount the second session holds, not the first
    // session's idle declaration.
    expect(project?.rows.map((row) => row.status)).toEqual(['active'])
  })

  it('answers sync and retry with the fresh snapshot, without waiting for the pass', async () => {
    const { service, calls } = fakeService()
    const handler = createRouteHandler(service)

    expect((await call(handler, 'POST', `${ROUTE_PREFIX}/sync`)).body?.ok).toBe(true)
    expect((await call(handler, 'POST', `${ROUTE_PREFIX}/retry`)).body?.ok).toBe(true)
    // `Sync` never takes the awaiting form: the pass it queues is background
    // work, and the status channel is what reports the outcome.
    expect(calls).toEqual(['syncSoon', 'retry'])
  })

  it('scopes an operator request to the project it names, and answers with its slice', async () => {
    const { service, calls } = fakeService({ snapshot: () => TWO_PROJECTS })
    const handler = createRouteHandler(service)

    const retry = await call(handler, 'POST', `${ROUTE_PREFIX}/retry`, { projectRoot: '/tmp/repo' })
    const sync = await call(handler, 'POST', `${ROUTE_PREFIX}/sync`, { projectRoot: '/tmp/repo' })

    expect(calls).toEqual(['retry:/tmp/repo', 'syncSoon:/tmp/repo'])
    // The other project is neither acted on nor answered with.
    expect(retry.body?.value?.projects.map((project: { projectRoot: string }) => project.projectRoot)).toEqual([
      '/tmp/repo',
    ])
    expect(retry.body?.value?.watchedFiles).toEqual(['/tmp/repo'])
    expect(sync.body?.value?.projects).toHaveLength(1)
  })

  it('keeps the whole snapshot for a surface that lists every project', async () => {
    const { service, calls } = fakeService({ snapshot: () => TWO_PROJECTS })
    const captured = await call(createRouteHandler(service), 'POST', `${ROUTE_PREFIX}/retry`, {
      projectRoot: '/tmp/repo',
      full: true,
    })

    // The action stays inside the named project; only the answer is whole.
    expect(calls).toEqual(['retry:/tmp/repo'])
    expect(captured.body?.value?.projects).toHaveLength(2)
  })

  it('reads a malformed operator body as the global call it used to be', async () => {
    const { service, calls } = fakeService()
    const captured = await call(createRouteHandler(service), 'POST', `${ROUTE_PREFIX}/sync`, {
      projectRoot: 42,
    })

    expect(calls).toEqual(['syncSoon'])
    expect(captured.body?.value).toEqual(SNAPSHOT)
  })

  it('opens a stream on the current picture, then writes one frame per change', async () => {
    const listeners: ((change: SnapshotChange) => void)[] = []
    const { service } = fakeService({
      subscribe: (listener) => {
        listeners.push(listener)
        listener({ revision: 0, snapshot: SNAPSHOT })
        return () => listeners.splice(listeners.indexOf(listener), 1)
      },
    })
    const stream = fakeSse()
    const request = fakeEventReq()
    createEventStream(service).serve(request.req, stream.res)

    expect(stream.headers['content-type']).toBe('text/event-stream; charset=utf-8')
    // A comment first, so the browser sees a live channel before anything happens.
    expect(stream.frames[0]).toBe(': connected\nretry: 2000\n\n')
    expect(stream.frames[1]).toBe(
      `event: hello\ndata: ${JSON.stringify({ revision: 0, snapshot: SNAPSHOT })}\n\n`,
    )

    const change: SnapshotChange = { revision: 1, snapshot: { ...SNAPSHOT, ready: false } }
    listeners[0]?.(change)
    expect(stream.frames[2]).toBe(`event: change\ndata: ${JSON.stringify(change)}\n\n`)
  })

  it('closes every open stream and stops listening when the route is disposed', () => {
    const listeners: ((change: SnapshotChange) => void)[] = []
    const { service } = fakeService({
      subscribe: (listener) => {
        listeners.push(listener)
        return () => listeners.splice(listeners.indexOf(listener), 1)
      },
    })
    const events = createEventStream(service)
    const first = fakeSse()
    const second = fakeSse()
    events.serve(fakeEventReq().req, first.res)
    events.serve(fakeEventReq().req, second.res)
    expect(listeners).toHaveLength(1)

    events.dispose()

    expect(first.ended).toBe(true)
    expect(second.ended).toBe(true)
    expect(listeners).toHaveLength(0)
  })

  it('drops a client that left, and the last one stops the subscription', () => {
    let disposed = 0
    const { service } = fakeService({
      subscribe: () => () => {
        disposed += 1
      },
    })
    const events = createEventStream(service)
    const first = fakeSse()
    const second = fakeSse()
    const one = fakeEventReq()
    events.serve(one.req, first.res)
    events.serve(fakeEventReq().req, second.res)

    one.close()
    expect(disposed).toBe(0)

    events.serve(fakeEventReq().req, fakeSse().res)
    events.dispose()
    expect(disposed).toBe(1)
  })

  it('releases one session, or every mounted session without a body', async () => {
    const { service, calls } = fakeService()
    const handler = createRouteHandler(service)

    await call(handler, 'POST', `${ROUTE_PREFIX}/release`, { sessionId: 'session-1' })
    await call(handler, 'POST', `${ROUTE_PREFIX}/release`)
    await call(handler, 'POST', `${ROUTE_PREFIX}/release`, { sessionId: 42 })

    expect(calls).toEqual(['release:session-1', 'release:all', 'release:all'])
  })

  it('rejects unknown routes', async () => {
    const { service } = fakeService()
    const captured = await call(createRouteHandler(service), 'GET', `${ROUTE_PREFIX}/nope`)

    expect(captured.status).toBe(404)
    expect(captured.body?.ok).toBe(false)
    expect(captured.body?.error?.message).toContain('/project-mcp/nope')
  })

  it('saves an entry and answers with the fresh snapshot', async () => {
    const saved: SaveRequest[] = []
    const { service } = fakeService({
      save: async (request) => {
        saved.push(request)
        return { ok: true, snapshot: SNAPSHOT }
      },
    })
    const captured = await call(createRouteHandler(service), 'POST', `${ROUTE_PREFIX}/save`, {
      ...SAVE_BODY,
      consent: true,
    })

    expect(captured.status).toBe(200)
    expect(captured.body).toEqual({ ok: true, value: SNAPSHOT })
    expect(saved).toEqual([{ ...SAVE_BODY, consent: true }])
  })

  it('maps every save refusal onto its own status and code', async () => {
    const cases: Array<[SaveErrorCode, number]> = [
      ['invalid', 400],
      ['blocked', 400],
      ['not-found', 400],
      ['conflict', 409],
      ['failed', 500],
    ]
    for (const [code, status] of cases) {
      const { service } = fakeService({
        save: async () => ({ ok: false, code, message: `${code} happened` }),
      })
      const captured = await call(createRouteHandler(service), 'POST', `${ROUTE_PREFIX}/save`, SAVE_BODY)

      expect(captured.status).toBe(status)
      expect(captured.body).toEqual({ ok: false, error: { code, message: `${code} happened` } })
    }
  })

  it('rejects a save body that is not a complete request, without calling the runtime', async () => {
    const asked: SaveRequest[] = []
    const { service } = fakeService({
      save: async (request) => {
        asked.push(request)
        return { ok: true, snapshot: SNAPSHOT }
      },
    })
    const handler = createRouteHandler(service)
    const bodies = [undefined, {}, { ...SAVE_BODY, revision: 7 }, { ...SAVE_BODY, entry: 'nope' }]

    for (const body of bodies) {
      const captured = await call(handler, 'POST', `${ROUTE_PREFIX}/save`, body)
      expect(captured.status).toBe(400)
      expect(captured.body?.error?.code).toBe('invalid')
    }
    expect(asked).toEqual([])
  })

  it('rejects a save body larger than the route accepts', async () => {
    const asked: SaveRequest[] = []
    const { service } = fakeService({
      save: async (request) => {
        asked.push(request)
        return { ok: true, snapshot: SNAPSHOT }
      },
    })
    const captured = await call(createRouteHandler(service), 'POST', `${ROUTE_PREFIX}/save`, {
      ...SAVE_BODY,
      entry: { transport: 'stdio', command: 'npx', extra: { blob: 'x'.repeat(70_000) } },
    })

    expect(captured.status).toBe(400)
    expect(captured.body?.error?.code).toBe('invalid')
    expect(asked).toEqual([])
  })

  it('pins a tool and answers with the fresh snapshot', async () => {
    const asked: PinRequest[] = []
    const { service } = fakeService({
      setPin: (request) => {
        asked.push(request)
        return { ok: true, snapshot: SNAPSHOT }
      },
    })
    const captured = await call(createRouteHandler(service), 'POST', `${ROUTE_PREFIX}/pin`, {
      projectRoot: '/tmp/repo',
      tool: 'mcp__tglider__workspace',
      pinned: true,
    })

    expect(captured.status).toBe(200)
    expect(captured.body).toEqual({ ok: true, value: SNAPSHOT })
    expect(asked).toEqual([
      { projectRoot: '/tmp/repo', tool: 'mcp__tglider__workspace', pinned: true },
    ])
  })

  it('rejects a pin body that is not a complete request, without calling the service', async () => {
    const asked: PinRequest[] = []
    const { service } = fakeService({
      setPin: (request) => {
        asked.push(request)
        return { ok: true, snapshot: SNAPSHOT }
      },
    })
    const handler = createRouteHandler(service)
    const bodies = [
      undefined,
      {},
      { tool: 'mcp__tglider__workspace', pinned: true },
      { projectRoot: '/tmp/repo', pinned: true },
      { projectRoot: '/tmp/repo', tool: '', pinned: true },
      { projectRoot: '/tmp/repo', tool: 'mcp__tglider__workspace', pinned: 'yes' },
    ]

    for (const body of bodies) {
      const captured = await call(handler, 'POST', `${ROUTE_PREFIX}/pin`, body)
      expect(captured.status).toBe(400)
      expect(captured.body?.error?.code).toBe('invalid')
    }
    expect(asked).toEqual([])
  })

  it('stores one project mode and answers with the fresh snapshot', async () => {
    const asked: PolicyRequest[] = []
    const { service } = fakeService({
      setPolicy: (request) => {
        asked.push(request)
        return { ok: true, snapshot: SNAPSHOT }
      },
    })
    const captured = await call(createRouteHandler(service), 'POST', `${ROUTE_PREFIX}/policy`, {
      projectRoot: '/tmp/repo',
      mode: 'direct',
    })

    expect(captured.status).toBe(200)
    expect(captured.body).toEqual({ ok: true, value: SNAPSHOT })
    expect(asked).toEqual([{ projectRoot: '/tmp/repo', mode: 'direct' }])
  })

  it('rejects an unknown mode or a missing project, without calling the service', async () => {
    const asked: PolicyRequest[] = []
    const { service } = fakeService({
      setPolicy: (request) => {
        asked.push(request)
        return { ok: true, snapshot: SNAPSHOT }
      },
    })
    const handler = createRouteHandler(service)
    const bodies = [
      undefined,
      {},
      { projectRoot: '/tmp/repo' },
      { mode: 'off' },
      { projectRoot: '/tmp/repo', mode: 'sometimes' },
      { projectRoot: '/tmp/repo', mode: 7 },
    ]

    for (const body of bodies) {
      const captured = await call(handler, 'POST', `${ROUTE_PREFIX}/policy`, body)
      expect(captured.status).toBe(400)
      expect(captured.body?.error?.code).toBe('invalid')
    }
    expect(asked).toEqual([])
  })

  it('carries a conflict choice to the service and back with the fresh snapshot', async () => {
    const asked: ConflictRequest[] = []
    const { service } = fakeService({
      setConflictChoice: (request) => {
        asked.push(request)
        return { ok: true, snapshot: SNAPSHOT }
      },
    })
    const handler = createRouteHandler(service)
    // Every answer this build knows travels as itself: the route is the door a
    // third one would otherwise be narrowed to the profile at.
    for (const choice of ['profile', 'local', 'native'] as const) {
      const captured = await call(handler, 'POST', `${ROUTE_PREFIX}/conflict`, {
        projectRoot: '/tmp/repo',
        server: 'grafana-local',
        choice,
      })
      expect(captured.status).toBe(200)
      expect(captured.body).toEqual({ ok: true, value: SNAPSHOT })
    }
    expect(asked).toEqual([
      { projectRoot: '/tmp/repo', server: 'grafana-local', choice: 'profile' },
      { projectRoot: '/tmp/repo', server: 'grafana-local', choice: 'local' },
      { projectRoot: '/tmp/repo', server: 'grafana-local', choice: 'native' },
    ])
  })

  it('rejects a conflict body carrying an answer this build does not know', async () => {
    const asked: ConflictRequest[] = []
    const { service } = fakeService({
      setConflictChoice: (request) => {
        asked.push(request)
        return { ok: true, snapshot: SNAPSHOT }
      },
    })
    const handler = createRouteHandler(service)
    const bodies = [
      undefined,
      {},
      { projectRoot: '/tmp/repo', server: 'alpha' },
      { server: 'alpha', choice: 'local' },
      { projectRoot: '/tmp/repo', server: '', choice: 'local' },
      { projectRoot: '/tmp/repo', server: 'alpha', choice: 'both' },
      { projectRoot: '/tmp/repo', server: 'alpha', choice: true },
    ]

    for (const body of bodies) {
      const captured = await call(handler, 'POST', `${ROUTE_PREFIX}/conflict`, body)
      expect(captured.status).toBe(400)
      expect(captured.body?.error?.code).toBe('invalid')
    }
    expect(asked).toEqual([])
  })

  it('maps a policy refusal onto its own status and code', async () => {
    const message = 'no live session in /tmp/gone'
    const { service } = fakeService({
      setPolicy: () => ({ ok: false, code: 'not-found', message }),
    })
    const captured = await call(createRouteHandler(service), 'POST', `${ROUTE_PREFIX}/policy`, {
      projectRoot: '/tmp/gone',
      mode: 'off',
    })

    expect(captured.status).toBe(400)
    expect(captured.body).toEqual({ ok: false, error: { code: 'not-found', message } })
  })

  it('carries a refusal’s message code and params into the envelope, when the outcome has them (F-48)', async () => {
    const refusal = {
      ok: false as const,
      code: 'not-found' as const,
      message: 'no live session in /tmp/gone',
      messageCode: 'save.noLiveSession',
      messageParams: { projectRoot: '/tmp/gone' },
    }
    // The envelope's `error` is the refusal minus its own `ok` flag.
    const { ok: _refused, ...error } = refusal
    const policy = fakeService({ setPolicy: () => refusal })
    const policyAnswer = await call(createRouteHandler(policy.service), 'POST', `${ROUTE_PREFIX}/policy`, {
      projectRoot: '/tmp/gone',
      mode: 'off',
    })
    expect(policyAnswer.status).toBe(400)
    expect(policyAnswer.body).toEqual({ ok: false, error })

    const save = fakeService({ save: async () => refusal })
    const saveAnswer = await call(createRouteHandler(save.service), 'POST', `${ROUTE_PREFIX}/save`, SAVE_BODY)
    expect(saveAnswer.status).toBe(400)
    expect(saveAnswer.body).toEqual({ ok: false, error })
  })

  it('reports a failing action as an error envelope', async () => {
    const { service } = fakeService({
      retry: async () => {
        throw new Error('boom')
      },
    })
    const captured = await call(createRouteHandler(service), 'POST', `${ROUTE_PREFIX}/retry`)

    expect(captured.status).toBe(500)
    expect(captured.body?.error).toEqual({ code: 'failed', message: 'boom' })
  })

  it('disposes either shape a web server may return', () => {
    let called = 0
    disposeRegistration(() => {
      called += 1
    })
    disposeRegistration({ dispose: () => { called += 1 } })
    disposeRegistration(undefined)
    disposeRegistration({})

    expect(called).toBe(2)
  })
})

describe('registerRoutes', () => {
  it('registers one prefix route and closes the stream and the registration on dispose', () => {
    const { service } = fakeService()
    const routes: { kind: string; path: string; handler?: unknown }[] = []
    const disposed: string[] = []
    const webServer = {
      register: (route: { kind: string; path: string; handler?: unknown }) => {
        routes.push(route)
        // The object shape, not the function one: a real server may answer
        // either, and this is the harder of the two to dispose.
        return { dispose: () => disposed.push('registration') }
      },
    }

    const stop = registerRoutes(webServer as never, service)

    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: ROUTE_PREFIX })
    expect(typeof routes[0]?.handler).toBe('function')
    stop()
    expect(disposed).toEqual(['registration'])
  })
})

/** A `GET logs` answer: the envelope, holding a page rather than a snapshot. */
interface LogsBody {
  ok: boolean
  value?: { events: LogEvent[]; total: number; more: boolean }
  error?: { code: string; message: string }
}

/**
 * `GET logs`, the route behind "show older" (contract C1).
 *
 * The snapshot carries the newest page, so this route is only asked for history
 * the tab does not have yet. Its whole contract is the window, the exclusive
 * cursor the panel sends as `before`, and the refusal of a request that names no
 * project — the ring it reads has no runtime to ask about a root.
 */
describe('GET logs', () => {
  const handler = createRouteHandler(fakeService().service)

  function logsBody(captured: Captured): LogsBody {
    return captured.body as unknown as LogsBody
  }

  /** 120 events, one per millisecond, as a project's history. */
  function seedLogs(): void {
    for (let at = 1; at <= 120; at += 1) {
      recordLog({ at, level: 'info', projectRoot: '/tmp/repo', server: 'alpha', message: `event ${at}` })
    }
  }

  beforeEach(() => clearLogs())

  it('answers the newest page of the project, oldest first', async () => {
    seedLogs()

    const captured = await call(handler, 'GET', `${ROUTE_PREFIX}/logs?projectRoot=/tmp/repo`)

    expect(captured.status).toBe(200)
    const page = logsBody(captured).value
    expect(page?.events.map((event) => event.at)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 71),
    )
    expect(page?.total).toBe(120)
    expect(page?.more).toBe(true)
  })

  it('pages strictly before the cursor, at the size the panel asks for', async () => {
    seedLogs()

    const captured = await call(
      handler,
      'GET',
      `${ROUTE_PREFIX}/logs?projectRoot=/tmp/repo&before=61&limit=10`,
    )

    const page = logsBody(captured).value
    expect(page?.events.map((event) => event.at)).toEqual([51, 52, 53, 54, 55, 56, 57, 58, 59, 60])
    expect(page?.total).toBe(120)
    expect(page?.more).toBe(true)
  })

  it('answers the last page with more=false when the history ends at the cursor', async () => {
    recordLog({ at: 7, level: 'error', projectRoot: '/tmp/repo', server: 'alpha', message: 'boom' })

    const captured = await call(handler, 'GET', `${ROUTE_PREFIX}/logs?projectRoot=/tmp/repo&before=8`)

    expect(logsBody(captured).value).toMatchObject({ total: 1, more: false })
    expect(logsBody(captured).value?.events.map((event) => event.at)).toEqual([7])
  })

  it('answers an empty page for a project it has no events for', async () => {
    const captured = await call(handler, 'GET', `${ROUTE_PREFIX}/logs?projectRoot=/tmp/unknown`)

    expect(captured.status).toBe(200)
    expect(logsBody(captured).value).toEqual({ events: [], total: 0, more: false })
  })

  it('refuses a request without a project, or a window that is not a number', async () => {
    const refused = [
      `${ROUTE_PREFIX}/logs`,
      `${ROUTE_PREFIX}/logs?projectRoot=`,
      `${ROUTE_PREFIX}/logs?projectRoot=/tmp/repo&before=soon`,
      `${ROUTE_PREFIX}/logs?projectRoot=/tmp/repo&before=`,
      `${ROUTE_PREFIX}/logs?projectRoot=/tmp/repo&limit=nope`,
      `${ROUTE_PREFIX}/logs?projectRoot=/tmp/repo&limit=`,
    ]
    for (const path of refused) {
      const captured = await call(handler, 'GET', path)
      expect(captured.status, path).toBe(400)
      expect(logsBody(captured), path).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    }
  })
})
