/**
 * Host HTTP surface for the sidebar panel.
 *
 * The browser half of a DSH composition is a different process from this one, so
 * the panel cannot call the `projectMcp` service in process: it fetches these
 * routes, which is how every browser-facing service in DSH reaches its host.
 * Every response is `{ ok: true, value }` or `{ ok: false, error }`.
 *
 * @module dsh-project-mcp/ui
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ProjectMcpService } from './index.ts'
import { page } from './logs.ts'
import { isConflictChoice, isToolMode } from './policy.ts'
import type { PolicyOutcome } from './runtime.ts'
import type {
  ConflictRequest,
  OperatorRequest,
  PinRequest,
  PolicyRequest,
  SaveErrorCode,
  SaveRequest,
} from './shared.ts'
import { ROUTE_PREFIX } from './shared.ts'
import type { EntrySnapshot, McpSnapshot, SnapshotChange } from './types.ts'

/** The subset of the DSH web server this plugin registers on. */
export interface WebServerLike {
  /** Register one route and return its disposer, in whatever shape the server uses. */
  register(route: { kind: 'prefix'; path: string; handler: RouteHandler }): unknown
}

/** Node HTTP handler signature the web server expects. */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

/** Largest request body accepted for a session id. */
const MAX_BODY_BYTES = 4_096

/** Largest request body accepted for a save: one entry body plus its extras. */
const MAX_SAVE_BYTES = 64 * 1024

/**
 * How often a quiet stream is poked.
 *
 * The channel can be silent for minutes — nothing happens in a project, so
 * nothing is announced — and an idle connection is what proxies and browsers
 * reap. A comment frame is not an event: the panel does not see it, the socket
 * stays warm. `unref`'d, so a headless host is never kept alive for it.
 */
const HEARTBEAT_MS = 15_000

/**
 * The status channel: one open `GET events` response per panel, and a frame
 * whenever the picture changes.
 *
 * Server-Sent Events rather than polling: DSH's own web server hands a route the
 * raw response ("owns the full response lifecycle, may hold the response open,
 * e.g. SSE") and exempts `text/event-stream` from its gzip filter, and the
 * browser's `EventSource` reconnects on its own. The subscription is only held
 * while somebody is listening, and the heartbeat only runs with a stream open.
 */
export interface EventStream {
  /** Serve one `GET events`: the response stays open until the client leaves. */
  serve(req: IncomingMessage, res: ServerResponse): void
  /** Close every open stream and stop listening; the route's disposer calls it. */
  dispose(): void
}

/**
 * Build the status channel of one route registration.
 * @param service - the runtime's published service.
 * @returns the channel's `serve`/`dispose` pair.
 */
export function createEventStream(service: ProjectMcpService): EventStream {
  const streams = new Set<ServerResponse>()
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let unsubscribe: (() => void) | undefined
  let latest: SnapshotChange | undefined

  /**
   * Write one frame, dropping a stream that has already gone: a dead socket
   * raises on `write`, and an exception here would reach the pass that
   * announced the change rather than the panel it was meant for.
   */
  const write = (res: ServerResponse, frame: string): void => {
    try {
      res.write(frame)
    } catch {
      streams.delete(res)
    }
  }

  const frame = (event: 'hello' | 'change', change: SnapshotChange): string =>
    `event: ${event}\ndata: ${JSON.stringify(change)}\n\n`

  const stop = (): void => {
    if (heartbeat !== undefined) clearInterval(heartbeat)
    heartbeat = undefined
    unsubscribe?.()
    unsubscribe = undefined
  }

  /**
   * Start listening, if this is the first stream. The subscription answers with
   * the picture as it is now, which is also what a stream opened later replays:
   * every frame carries the whole snapshot, so the newest one is always current.
   */
  const start = (): void => {
    if (unsubscribe !== undefined) return
    unsubscribe = service.subscribe((change) => {
      latest = change
      for (const stream of [...streams]) write(stream, frame('change', change))
    })
    heartbeat = setInterval(() => {
      for (const stream of [...streams]) write(stream, ': ping\n\n')
    }, HEARTBEAT_MS)
    heartbeat.unref?.()
  }

  return {
    serve(req, res): void {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      })
      // A comment first — DSH's own HMR stream does the same — so the browser
      // sees a live channel before anything happens, plus how fast to come back.
      res.write(': connected\nretry: 2000\n\n')
      // Subscribe before joining the fan-out: the subscription answers with the
      // picture as it is, which is this stream's `hello` — a `change` frame for a
      // change that predates the panel would say the same thing twice.
      start()
      streams.add(res)
      if (latest !== undefined) write(res, frame('hello', latest))
      const leave = (): void => {
        streams.delete(res)
        if (streams.size === 0) stop()
      }
      req.on('close', leave)
      res.on('error', leave)
    },
    dispose(): void {
      stop()
      for (const stream of [...streams]) {
        streams.delete(stream)
        try {
          stream.end()
        } catch {
          // The socket is already gone; nothing to end.
        }
      }
    },
  }
}

/**
 * HTTP status each coded refusal answers with. The policy routes reuse the same
 * vocabulary as a save: `invalid`/`not-found` are the panel's 400s, `failed` a
 * 500.
 */
const SAVE_STATUS: Record<SaveErrorCode, number> = {
  invalid: 400,
  blocked: 400,
  'not-found': 400,
  conflict: 409,
  failed: 500,
}

/**
 * HTTP status a `GET tool` refusal answers with: the same vocabulary, one
 * different reading.
 *
 * A save or a policy change names something the panel is looking at *and
 * edits*, so a name this host does not know is a malformed request there —
 * `400`. A tool read is a *fetch* of a row the panel already drew, so an
 * unknown project, session or name means the picture moved under it, which is
 * exactly what `404` says: `GET logs` answers the same question the same way.
 */
const TOOL_STATUS: Record<SaveErrorCode, number> = {
  ...SAVE_STATUS,
  'not-found': 404,
}

/**
 * Read one numeric query parameter.
 *
 * The panel decides the window, so the host refuses rather than guesses: a
 * parameter the URL does not carry is absent, and one it carries as anything but
 * a finite number — `abc`, an empty value — is `'invalid'`, which the route
 * answers with `bad-request`.
 * @param raw - the raw value, `null` when the query string omits it.
 * @returns the number, `undefined` when absent, `'invalid'` when unusable.
 */
function numberParam(raw: string | null): number | undefined | 'invalid' {
  if (raw === null) return undefined
  const value = Number(raw)
  return raw.trim() === '' || !Number.isFinite(value) ? 'invalid' : value
}

/**
 * Build the route handler for {@link ROUTE_PREFIX}.
 *
 * Both operator actions — `Sync` and `Retry` — answer as soon as they are
 * accepted, never once the servers they touch have settled: the pass they queue
 * runs in the background, and the panel reads the outcome from the status
 * channel. A response held open for a mount that is still connecting is exactly
 * the hang this route no longer produces.
 *
 * @param service - the runtime's published service.
 * @param events - the status channel to serve; built from the service when omitted.
 * @returns a handler for `GET snapshot|events|logs`, `POST sync|retry|release|save`.
 */
export function createRouteHandler(
  service: ProjectMcpService,
  events: EventStream = createEventStream(service),
): RouteHandler {
  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  const reply = async (
    res: ServerResponse,
    action: () => Promise<void>,
    request: OperatorRequest = {},
  ): Promise<void> => {
    try {
      await action()
      send(res, 200, { ok: true, value: operatorAnswer(service, request) })
    } catch (error) {
      send(res, 500, {
        ok: false,
        error: { code: 'failed', message: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  /**
   * Answer a pin or mode change with the same envelope a save uses: the fresh
   * snapshot, or the refusal code's status. The service method is synchronous —
   * the policy is not part of any document, so no rescan follows — but a store
   * that still fails answers `500` rather than breaking the route.
   */
  const replyPolicy = (res: ServerResponse, change: () => PolicyOutcome): void => {
    try {
      const outcome = change()
      if (outcome.ok) {
        send(res, 200, { ok: true, value: outcome.snapshot })
        return
      }
      send(res, SAVE_STATUS[outcome.code], {
        ok: false,
        error: {
          code: outcome.code,
          message: outcome.message,
          // The F-48 companions ride the envelope only when the outcome has
          // them: an uncoded refusal's body is byte-identical to before.
          ...(outcome.messageCode === undefined
            ? {}
            : { messageCode: outcome.messageCode, messageParams: outcome.messageParams }),
        },
      })
    } catch (error) {
      send(res, 500, {
        ok: false,
        error: { code: 'failed', message: error instanceof Error ? error.message : String(error) },
      })
    }
  }
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const action = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+|\/+$/g, '')
    const method = req.method ?? 'GET'
    if (method === 'GET' && action === 'snapshot') {
      send(res, 200, { ok: true, value: service.snapshot() })
      return
    }
    if (method === 'POST' && action === 'sync') {
      const request = operatorRequestOf(await readJson(req))
      // The pass is background work from here on, so the answer is the picture
      // as it is now — the status channel carries the rest.
      service.syncSoon(request.projectRoot)
      send(res, 200, { ok: true, value: operatorAnswer(service, request) })
      return
    }
    if (method === 'GET' && action === 'events') {
      events.serve(req, res)
      return
    }
    // The tab is drawn from the snapshot, which carries the newest page of the
    // ring; this route is "show older". It reads the ring directly — the buffer
    // has one owner (`src/logs.ts`) and no runtime state to ask for — and it
    // answers even when the named project is unknown to the runtime: the ring
    // is keyed by the root, and an empty page is an answer, not a refusal.
    if (method === 'GET' && action === 'logs') {
      const projectRoot = url.searchParams.get('projectRoot')
      const before = numberParam(url.searchParams.get('before'))
      const limit = numberParam(url.searchParams.get('limit'))
      if (projectRoot === null || projectRoot === '' || before === 'invalid' || limit === 'invalid') {
        send(res, 400, {
          ok: false,
          error: {
            code: 'bad-request',
            message: 'GET logs needs a projectRoot, and before/limit as finite numbers',
          },
        })
        return
      }
      send(res, 200, {
        ok: true,
        value: page({
          projectRoot,
          ...(before === undefined ? {} : { before }),
          ...(limit === undefined ? {} : { limit }),
        }),
      })
      return
    }
    // One tool's detail, for a row the panel opened. On demand rather than in
    // the snapshot — descriptions and schemas are the expensive part, and every
    // change frame and poll carries the whole snapshot — so nothing grows on the
    // wire and the answer is fetched once per opened row. The same precedent as
    // `logs`: the route checks that it was given three names at all and refuses
    // a request missing one, while "this host does not know that project,
    // session or tool" is the service's `404` rather than the route's `400`.
    if (method === 'GET' && action === 'tool') {
      const projectRoot = url.searchParams.get('projectRoot')
      const sessionId = url.searchParams.get('sessionId')
      const name = url.searchParams.get('name')
      if (projectRoot === null || projectRoot === '') {
        send(res, 400, {
          ok: false,
          error: { code: 'bad-request', message: 'GET tool needs a projectRoot' },
        })
        return
      }
      if (sessionId === null || sessionId === '') {
        send(res, 400, {
          ok: false,
          error: { code: 'bad-request', message: 'GET tool needs a sessionId' },
        })
        return
      }
      if (name === null || name === '') {
        send(res, 400, {
          ok: false,
          error: { code: 'bad-request', message: 'GET tool needs a name' },
        })
        return
      }
      const outcome = service.toolFacts(projectRoot, sessionId, name)
      if (!outcome.ok) {
        send(res, TOOL_STATUS[outcome.code], {
          ok: false,
          error: { code: outcome.code, message: outcome.message },
        })
        return
      }
      send(res, 200, { ok: true, value: outcome.value })
      return
    }
    if (method === 'POST' && action === 'retry') {
      const request = operatorRequestOf(await readJson(req))
      await reply(res, () => service.retry(request.projectRoot), request)
      return
    }
    if (method === 'POST' && action === 'release') {
      const body = await readJson(req)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined
      await reply(res, () => service.release(sessionId))
      return
    }
    if (method === 'POST' && action === 'save') {
      const request = saveRequestOf(await readJson(req, MAX_SAVE_BYTES))
      if (request === undefined) {
        send(res, 400, {
          ok: false,
          error: { code: 'invalid', message: 'the save body is not a well-formed entry request' },
        })
        return
      }
      try {
        const outcome = await service.save(request)
        if (outcome.ok) {
          send(res, 200, { ok: true, value: outcome.snapshot })
          return
        }
        send(res, SAVE_STATUS[outcome.code], {
          ok: false,
          error: {
            code: outcome.code,
            message: outcome.message,
            // The F-48 companions ride the envelope only when the outcome has
            // them: an uncoded refusal's body is byte-identical to before.
            ...(outcome.messageCode === undefined
              ? {}
              : { messageCode: outcome.messageCode, messageParams: outcome.messageParams }),
          },
        })
      } catch (error) {
        send(res, 500, {
          ok: false,
          error: { code: 'failed', message: error instanceof Error ? error.message : String(error) },
        })
      }
      return
    }
    // A pin and a mode are durable plugin state, not document edits: neither
    // route rescans, and both answer with the snapshot rebuilt on the spot.
    if (method === 'POST' && action === 'pin') {
      const request = pinRequestOf(await readJson(req))
      if (request === undefined) {
        send(res, 400, {
          ok: false,
          error: { code: 'invalid', message: 'the pin body is not a well-formed pin request' },
        })
        return
      }
      replyPolicy(res, () => service.setPin(request))
      return
    }
    if (method === 'POST' && action === 'policy') {
      const request = policyRequestOf(await readJson(req))
      if (request === undefined) {
        send(res, 400, {
          ok: false,
          error: { code: 'invalid', message: 'the policy body is not a well-formed mode request' },
        })
        return
      }
      replyPolicy(res, () => service.setPolicy(request))
      return
    }
    if (method === 'POST' && action === 'conflict') {
      const request = conflictRequestOf(await readJson(req))
      if (request === undefined) {
        send(res, 400, {
          ok: false,
          error: {
            code: 'invalid',
            message: 'the conflict body is not a well-formed conflict request',
          },
        })
        return
      }
      replyPolicy(res, () => service.setConflictChoice(request))
      return
    }
    send(res, 404, {
      ok: false,
      error: { code: 'not-found', message: `unknown route ${method} ${url.pathname}` },
    })
  }
}

/**
 * The operator request a `sync` or `retry` body carries. A body that is not an
 * operator request at all — a surface that predates the field, a `{}`, a
 * malformed value — reads as the global call it used to be.
 * @param body - the parsed request body.
 * @returns the project the action applies to, and the answer shape asked for.
 */
export function operatorRequestOf(body: Record<string, unknown>): OperatorRequest {
  const projectRoot = body.projectRoot
  return {
    ...(typeof projectRoot === 'string' && projectRoot !== '' ? { projectRoot } : {}),
    ...(body.full === true ? { full: true } : {}),
  }
}

/**
 * The snapshot an operator route answers with.
 *
 * A single-project surface (the sidebar tab, a row's own `Retry`) gets that
 * project's slice: it shows one project, and answering with every project made a click in one of them look like it had touched all of them. A
 * surface that lists every project asks for `full`, because a narrowed answer
 * would empty the list it renders.
 * @param service - the runtime's published service.
 * @param request - the operator request the caller sent.
 * @returns the snapshot, narrowed when the caller asked for one project.
 */
export function operatorAnswer(service: ProjectMcpService, request: OperatorRequest): McpSnapshot {
  const snapshot = service.snapshot()
  if (request.full === true || request.projectRoot === undefined) return snapshot
  return projectSlice(snapshot, request.projectRoot)
}

/**
 * One project's slice of a snapshot: its own project record and the root the
 * panel prints as watched, with the other projects dropped.
 * @param snapshot - the whole snapshot.
 * @param projectRoot - the project to keep.
 * @returns the narrowed snapshot.
 */
export function projectSlice(snapshot: McpSnapshot, projectRoot: string): McpSnapshot {
  return {
    ...snapshot,
    projects: snapshot.projects.filter((project) => project.projectRoot === projectRoot),
    watchedFiles: snapshot.watchedFiles.filter((file) => file === projectRoot),
  }
}

/**
 * Register the panel routes on the DSH web server.
 * @param webServer - the injected web server service.
 * @param service - the runtime's published service.
 * @returns the disposer: it closes the open status streams, then the routes.
 */
export function registerRoutes(webServer: WebServerLike, service: ProjectMcpService): () => void {
  const events = createEventStream(service)
  const registration = webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: createRouteHandler(service, events),
  })
  return () => {
    events.dispose()
    disposeRegistration(registration)
  }
}

/**
 * Run one registration's disposer, whichever shape the web server hands back:
 * Cordis only ever calls a disposer *function* for an effect, and the server may
 * return a `{ dispose() }` object instead.
 * @param registration - the value `registerRoutes` returned.
 */
export function disposeRegistration(registration: unknown): void {
  if (typeof registration === 'function') {
    ;(registration as () => void)()
    return
  }
  if (typeof registration !== 'object' || registration === null) return
  const dispose = (registration as { dispose?: unknown }).dispose
  if (typeof dispose === 'function') (dispose as () => void).call(registration)
}

/**
 * Read a bounded JSON body; anything unparseable, oversized or non-object stays
 * an empty object.
 * @param req - the incoming request.
 * @param limit - largest body accepted, in bytes.
 * @returns the parsed object body, or `{}` when there is none.
 */
async function readJson(req: IncomingMessage, limit: number = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limit) return {}
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Shape one `POST save` body into a {@link SaveRequest}.
 *
 * Only the envelope is checked here: whether the entry itself parses, and
 * whether the document may be written, is the runtime's decision and comes back
 * as a coded refusal.
 * @param body - parsed request body.
 * @returns the request, or `undefined` when a required field is missing.
 */
function saveRequestOf(body: Record<string, unknown>): SaveRequest | undefined {
  const { projectRoot, server, document, revision, entry } = body
  if (typeof projectRoot !== 'string' || projectRoot === '') return undefined
  if (typeof server !== 'string' || server === '') return undefined
  if (typeof document !== 'string' || document === '') return undefined
  if (typeof revision !== 'string' || revision === '') return undefined
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
  return {
    projectRoot,
    server,
    document,
    revision,
    ...(body.consent === true ? { consent: true } : {}),
    entry: entry as EntrySnapshot,
  }
}

/**
 * Shape one `POST pin` body into a {@link PinRequest}.
 *
 * Only the envelope is checked here: whether the project has a live session is
 * the runtime's decision and comes back as a coded refusal.
 * @param body - parsed request body.
 * @returns the request, or `undefined` when a required field is missing.
 */
function pinRequestOf(body: Record<string, unknown>): PinRequest | undefined {
  const { projectRoot, tool, pinned } = body
  if (typeof projectRoot !== 'string' || projectRoot === '') return undefined
  if (typeof tool !== 'string' || tool === '') return undefined
  if (typeof pinned !== 'boolean') return undefined
  return { projectRoot, tool, pinned }
}

/**
 * Shape one `POST policy` body into a {@link PolicyRequest}.
 *
 * The mode is validated here as well as in the runtime, so a switch carrying a
 * mode this build does not know is a `400` and never reaches the store.
 * @param body - parsed request body.
 * @returns the request, or `undefined` when a required field is missing.
 */
function policyRequestOf(body: Record<string, unknown>): PolicyRequest | undefined {
  const { projectRoot, mode } = body
  if (typeof projectRoot !== 'string' || projectRoot === '') return undefined
  if (!isToolMode(mode)) return undefined
  return { projectRoot, mode }
}

/**
 * Shape one `POST conflict` body into a {@link ConflictRequest}.
 *
 * The answer is checked here as well as in the runtime, so a request carrying a
 * choice this build does not know is a `400` and never reaches the store. The
 * name itself is not checked against anything: a project that does not conflict
 * over it yet may still be given an answer, which is what makes the choice
 * survive a declaration that comes and goes.
 * @param body - parsed request body.
 * @returns the request, or `undefined` when a required field is missing.
 */
function conflictRequestOf(body: Record<string, unknown>): ConflictRequest | undefined {
  const { projectRoot, server, choice } = body
  if (typeof projectRoot !== 'string' || projectRoot === '') return undefined
  if (typeof server !== 'string' || server === '') return undefined
  if (!isConflictChoice(choice)) return undefined
  return { projectRoot, server, choice }
}
