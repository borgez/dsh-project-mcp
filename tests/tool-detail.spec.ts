/**
 * The on-demand tool detail of one row a panel opened (F-56): `GET tool` and the
 * host read behind it.
 *
 * A description and a schema are the expensive part of a tool list and the
 * snapshot travels on every change frame and every poll, so neither rides the
 * snapshot: the route is asked once per opened row and answers a `ToolFacts`
 * record. This suite pins what that record is allowed to say — the
 * model-facing description, the schema's top-level properties, and a reason
 * built only from figures the host actually measured — and what it must not:
 * a nested schema expanded, a property's `default` republished, a reason on a
 * name this session's request does carry.
 *
 * The runtime here is the real one over the shared scope doubles, not a second
 * model of it: the store, the project mount, and the catalog read are the
 * production path, so a change to `mountedSchemas` or `toolsFor` shows up here.
 *
 * @module tests/tool-detail.spec
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { afterEach, describe, expect, it } from 'vitest'
import { schemaChars } from '../src/activation.ts'
import type { ToolDefinitionLike, ToolSchemaLike } from '../src/activation.ts'
import {
  ProjectMcpRuntime,
  type AgentEventLike,
  type AgentLike,
  type AgentScopeLike,
  type RuntimeConfig,
  type ToolFactsOutcome,
} from '../src/runtime.ts'
import type { ProjectMcpService } from '../src/index.ts'
import { ROUTE_PREFIX } from '../src/shared.ts'
import type { ToolFacts } from '../src/types.ts'
import { createRouteHandler } from '../src/ui.ts'
import { fakeScopes } from './helpers/scopes.ts'
import type { FakeScopes } from './helpers/scopes.ts'

const created: string[] = []

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'project-mcp-tool-detail-'))
  created.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * One scope double: a logger-free context the runtime can read a catalog from,
 * and one it can mount into.
 *
 * `catalog` is the scope's own layer and `schemas()` is the registry projection
 * of it — the three model-facing fields, exactly what `ToolSchemaLike`
 * describes. The definitions arrive the way production has them: the mount's
 * own plugin start (`mcp-client`'s fiber) is where a server's tools appear, so
 * `publish` hands them to the scope while that start is running. What the
 * runtime's detail read finds is then the same catalog a session resolves.
 */
class FakeCtx {
  readonly catalog: ToolDefinitionLike[] = []
  disposed = false

  /** Definitions this scope's mount publishes when its plugin starts. */
  readonly publishing: readonly ToolDefinitionLike[]

  constructor(publishing: readonly ToolDefinitionLike[] = []) {
    this.publishing = publishing
  }

  readonly tools = {
    /** The registry's projection: names, descriptions and schemas, nothing more. */
    schemas: (): ToolSchemaLike[] =>
      this.catalog.map((definition) => ({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
      })),
  }

  readonly logger = { debug: () => undefined, info: () => undefined, warn: () => undefined }

  effect(): () => void {
    return () => undefined
  }

  /** Mount as `ctx.plugin` does: the fiber's start publishes this scope's tools. */
  plugin(): { await: () => Promise<void>; dispose: () => Promise<void> } {
    return {
      await: async () => {
        this.catalog.push(...this.publishing)
      },
      dispose: async () => {
        this.catalog.length = 0
      },
    }
  }
}

/** One definition in the shape the registry hands the runtime. */
function definition(name: string, description: string, parameters: Record<string, unknown>): ToolDefinitionLike {
  return {
    name,
    description,
    parameters,
    output: { schema: {}, render: () => [] },
    execute: async () => ({}),
  }
}

/** The agent lifecycle service, delivering `agent/created` straight through. */
class FakeAgentScope implements AgentScopeLike {
  private readonly handlers = new Map<
    string,
    ((event: AgentEventLike, next: () => Promise<unknown>) => unknown)[]
  >()

  constructor(private readonly agents_: AgentLike[]) {}

  get agents() {
    return { list: () => [...this.agents_] }
  }

  on(
    name: string,
    handler: (event: AgentEventLike, next: () => Promise<unknown>) => unknown,
  ): () => void {
    const list = this.handlers.get(name) ?? []
    list.push(handler)
    this.handlers.set(name, list)
    return () => undefined
  }

  effect(): () => void {
    return () => undefined
  }

  /** Publish one agent, exactly as the host's own creation event does. */
  created(agent: AgentLike): void {
    for (const handler of this.handlers.get('agent/created') ?? []) {
      void handler({ agent }, async () => undefined)
    }
  }
}

function config(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    localFiles: ['.dsh/mcp.json'],
    globalFiles: [],
    inputs: {},
    projectMarkers: ['.git', '.dsh', 'package.json'],
    fileMarkers: ['.sln', '.slnx', '.csproj'],
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
    connectTimeoutMs: 60_000,
    lazy: false,
    idleTimeoutMs: 0,
    activationWaitMs: 0,
    profileWins: true,
    localPrefix: '',
    watch: false,
    debounceMs: 0,
    rescanIntervalMs: 1_000,
    credentialsFile: '/definitely/missing/.credentials.yaml',
    ...overrides,
  }
}

/** One project with a `.dsh/mcp.json` and a nested session directory. */
function makeProject(servers: Record<string, unknown>): { root: string; session: string } {
  const root = tmp()
  mkdirSync(join(root, '.dsh'), { recursive: true })
  mkdirSync(join(root, 'src', 'nested'), { recursive: true })
  writeFileSync(join(root, '.dsh', 'mcp.json'), JSON.stringify({ mcpServers: servers }))
  return { root, session: join(root, 'src', 'nested') }
}

/**
 * One runtime over the shared scope doubles: the registry view the runtime
 * reads is the double's own catalog, so what a mount publishes is exactly what
 * the detail read finds.
 * @param publishing - definitions every project scope's mount publishes.
 * @param overrides - runtime config a test needs beyond the shipped defaults.
 */
function harness(
  publishing: readonly ToolDefinitionLike[] = [],
  overrides: Partial<RuntimeConfig> = {},
) {
  const scopes = fakeScopes<FakeCtx>(
    () => new FakeCtx(publishing),
    () => new FakeCtx(),
    (ctx) => {
      ctx.disposed = true
    },
  )
  const host = {
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    get: () => undefined,
    // The registry's scoped lookup, as the real one resolves a key: the key's
    // own double, and the profile plane it carries for a session key.
    tools: {
      schemas: (key?: object): ToolSchemaLike[] => {
        const double = key === undefined ? undefined : scopes.doubleOf(key)
        return key !== undefined && double === undefined ? [] : (double?.tools.schemas() ?? [])
      },
    },
    // One of the doubles the scope factory minted holds this call: the runtime
    // starts a mount through the scope context it just created, so the
    // publishing start belongs to the double whose key that is.
    plugin: (): unknown => (scopes.projects.at(-1) ?? new FakeCtx()).plugin(),
  }
  const runtime = new ProjectMcpRuntime(host as unknown as Context, config(overrides), {
    // The double stands in for mcp-client: its activation is where the scope
    // declares the service its registrations go through, and where the
    // definitions of that scope's server appear.
    plugin: {
      name: 'fake-mcp',
      inject: ['tools'],
      apply: (ctx: unknown) => (ctx as FakeCtx),
    },
    createScope: (ctx, key) => scopes.createScope(ctx, key),
    registry: {
      get: (name: string, scope?: object) => {
        void name
        void scope
        return undefined
      },
      schemas: (scope?: object): readonly ToolSchemaLike[] =>
        (scope as FakeCtx | undefined)?.tools.schemas() ?? [],
    },
    bridgeContext: (scope) => ({
      get: (name: string) =>
        name === 'tools' ? (scopeOf(scope.ctx as Context) as unknown as FakeCtx).tools : undefined,
    }),
  })
  return { runtime, scopes }
}

/** Serve one request through the real route handler and capture the answer. */
interface Captured {
  status: number
  headers: Record<string, string>
  body: { ok: boolean; value?: ToolFacts; error?: { code: string; message: string } } | undefined
}

async function call(
  handler: ReturnType<typeof createRouteHandler>,
  path: string,
): Promise<Captured> {
  const captured: Captured = { status: 0, headers: {}, body: undefined }
  const res = {
    writeHead: (status: number, headers?: Record<string, string>) => {
      captured.status = status
      captured.headers = headers ?? {}
    },
    end: (text?: string) => {
      captured.body = text === undefined ? undefined : JSON.parse(text)
    },
  } as unknown as ServerResponse
  await handler({ method: 'GET', url: path } as unknown as IncomingMessage, res)
  return captured
}

/**
 * The host seam the route answers through, over a real runtime.
 *
 * Mounting is what makes a name answerable, so the fixture drives the real
 * path: one server per entry, and each mount's activation publishes the
 * definition the test handed it. What the route then reads is the same catalog
 * a session resolves.
 */
function service(overrides: Partial<ProjectMcpService> = {}): {
  service: ProjectMcpService
  runtime: ProjectMcpRuntime
  scopes: FakeScopes<FakeCtx>
} {
  const { runtime, scopes } = harness()
  return {
    runtime,
    scopes,
    service: {
      snapshot: () => runtime.snapshot(),
      syncNow: async (projectRoot) => runtime.syncNow(projectRoot),
      syncSoon: (projectRoot) => runtime.syncSoon(projectRoot),
      retry: async (projectRoot) => runtime.retry(projectRoot),
      release: async (agentId) => runtime.release(agentId),
      save: async () => ({ ok: true, snapshot: runtime.snapshot() }),
      setPin: () => ({ ok: true, snapshot: runtime.snapshot() }),
      setPolicy: () => ({ ok: true, snapshot: runtime.snapshot() }),
      setConflictChoice: () => ({ ok: true, snapshot: runtime.snapshot() }),
      toolFacts: (projectRoot, sessionId, name) =>
        runtime.toolFactsOf(projectRoot, sessionId, name),
      subscribe: () => () => undefined,
      ...overrides,
    },
  }
}

/** The realistic definition the F-56 requirement draws. */
const QUERY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    table: { type: 'string', description: 'Table to read from.' },
    // Drawn as its type and never expanded: the record answers what the tool
    // takes, and the nested graph is what the model-facing schema carries.
    where: {
      type: 'object',
      description: 'Equality filters.',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    rows: { type: 'array', description: 'Rows to return.', items: { type: 'string' } },
    // The host's own default for a call, never a value the tool publishes.
    timeoutMs: { type: 'number', description: 'Per-call timeout.', default: 30_000 },
    // A schema that names no type reads as `any`, the row vocabulary's word for it.
    hint: { description: 'Free-form hint.' },
  },
  required: ['table', 'where'],
}

const LIST_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { prefix: { type: 'string', description: 'Only names starting with this.' } },
  required: [],
}

/**
 * Mount one project and publish the definitions its declared server returns.
 *
 * The project scope and its mount are the runtime's own (`syncNow` is the pass
 * the plugin runs), and the definitions appear where production has them — on
 * the mount's fiber start — so the pass reads a catalog that already carries
 * them, exactly as it does when `mcp-client` comes up.
 *
 * @param project - project root and a nested session directory.
 * @param tools - one definition per public name, with the schema the test chose.
 * @param overrides - runtime config a test needs beyond the shipped defaults.
 * @returns the runtime, its scope doubles and the session it serves.
 */
async function mount(
  project: { root: string; session: string },
  tools: ReadonlyMap<string, Record<string, unknown>>,
  overrides: Partial<RuntimeConfig> = {},
): Promise<{ runtime: ProjectMcpRuntime; scopes: FakeScopes<FakeCtx>; agent: AgentLike }> {
  const publishing = [...tools].map(([name, parameters]) =>
    definition(name, `${name} does something`, parameters),
  )
  const { runtime, scopes } = harness(publishing, overrides)
  const agent: AgentLike = {
    id: 'session-1',
    session: { header: { cwd: project.session } },
    ctx: {} as Context,
  }
  runtime.attach(new FakeAgentScope([agent]))
  await runtime.syncNow()
  if (scopes.forProject(project.root) === undefined) {
    throw new Error('the project scope was not minted')
  }
  return { runtime, scopes, agent }
}

/** Call the runtime's detail read and unwrap the outcome, failing loudly. */
function factsOf(
  runtime: ProjectMcpRuntime,
  projectRoot: string,
  sessionId: string,
  name: string,
): ToolFacts {
  const outcome: ToolFactsOutcome = runtime.toolFactsOf(projectRoot, sessionId, name)
  if (!outcome.ok) throw new Error(`expected facts, got ${outcome.code}: ${outcome.message}`)
  return outcome.value
}

describe('GET tool — the host read', () => {
  it('answers the model-facing description and the schema\'s own top-level fields', async () => {
    const project = makeProject({ db: { command: 'npx' } })
    const { runtime } = await mount(project, new Map([['mcp__db__query', QUERY_SCHEMA]]))

    const facts = factsOf(runtime, project.root, 'session-1', 'mcp__db__query')

    expect(facts.name).toBe('mcp__db__query')
    expect(facts.description).toBe('mcp__db__query does something')
    expect(facts.fields).toEqual([
      { name: 'table', type: 'string', required: true, description: 'Table to read from.' },
      // Nested object: its own type, and no `properties` anywhere on the field.
      { name: 'where', type: 'object', required: true, description: 'Equality filters.' },
      { name: 'rows', type: 'array', required: false, description: 'Rows to return.' },
      { name: 'timeoutMs', type: 'number', required: false, description: 'Per-call timeout.' },
      // No `type` in the schema — `any`, never a guessed one.
      { name: 'hint', type: 'any', required: false, description: 'Free-form hint.' },
    ])
  })

  it('never publishes a schema default, and never expands a nested object', async () => {
    const project = makeProject({ db: { command: 'npx' } })
    const { runtime } = await mount(project, new Map([['mcp__db__query', QUERY_SCHEMA]]))

    const facts = factsOf(runtime, project.root, 'session-1', 'mcp__db__query')
    const serialized = JSON.stringify(facts)

    expect(serialized).not.toContain('30000')
    expect(serialized).not.toContain('default')
    expect(serialized).not.toContain('"id"')
    // `items` is the array field's schema, not a field of the record.
    expect(serialized).not.toContain('items')
  })

  it('omits the reason for a name the request does carry', async () => {
    const project = makeProject({ db: { command: 'npx' } })
    const { runtime } = await mount(project, new Map([['mcp__db__query', QUERY_SCHEMA]]))

    const facts = factsOf(runtime, project.root, 'session-1', 'mcp__db__query')

    expect(facts.reason).toBeUndefined()
  })

  it('answers a deferred name with the budget reason and its measured figures', async () => {
    const project = makeProject({ db: { command: 'npx' } })
    // A budget of `0` is the deferral mode at its strictest: nothing fits, so
    // every mounted name is hidden and each one carries the reason why.
    const { runtime } = await mount(
      project,
      new Map([
        ['mcp__db__query', QUERY_SCHEMA],
        ['mcp__db__list', LIST_SCHEMA],
      ]),
      { activationToolBudgetChars: 0 },
    )
    const schema: ToolSchemaLike = {
      name: 'mcp__db__query',
      description: 'mcp__db__query does something',
      parameters: QUERY_SCHEMA,
    }

    console.log('DBGROW', JSON.stringify(runtime.snapshot().projects[0]?.sessions[0]?.tools))
    const facts = factsOf(runtime, project.root, 'session-1', 'mcp__db__query')

    // Every figure is the host's own measurement: the definition's serialized
    // size by the rule the budget gate uses, and the session's own numbers.
    expect(facts.reason).toEqual({
      kind: 'budget',
      chars: schemaChars(schema),
      budget: 0,
      used: 0,
    })
    // The name really is one this session's row hides, and the figure is this
    // definition's own — not the whole mounted surface's.
    const tools = runtime.snapshot().projects[0]?.sessions[0]?.tools
    expect(tools?.deferred).toContain('mcp__db__query')
    expect(facts.reason?.chars).toBeLessThan(tools?.surfaceChars ?? 0)
    expect(facts.reason?.used).toBe(tools?.visibleChars)
  })

  it('refuses an unknown tool with a not-found outcome', async () => {
    const project = makeProject({ db: { command: 'npx' } })
    const { runtime } = await mount(project, new Map([['mcp__db__query', QUERY_SCHEMA]]))

    const outcome = runtime.toolFactsOf(project.root, 'session-1', 'mcp__db__nope')

    expect(outcome).toEqual({
      ok: false,
      code: 'not-found',
      message: `mcp__db__nope is not mounted in ${project.root}`,
    })
  })

  it('refuses a session this project does not have', async () => {
    const project = makeProject({ db: { command: 'npx' } })
    const { runtime } = await mount(project, new Map([['mcp__db__query', QUERY_SCHEMA]]))

    const outcome = runtime.toolFactsOf(project.root, 'session-2', 'mcp__db__query')

    expect(outcome).toMatchObject({ ok: false, code: 'not-found' })
    expect(outcome.ok ? '' : outcome.message).toContain('session-2')
  })

  it('refuses a tool read under another project root', async () => {
    const project = makeProject({ db: { command: 'npx' } })
    const other = makeProject({ db: { command: 'npx' } })
    const { runtime } = await mount(project, new Map([['mcp__db__query', QUERY_SCHEMA]]))

    const outcome = runtime.toolFactsOf(other.root, 'session-1', 'mcp__db__query')

    expect(outcome).toMatchObject({ ok: false, code: 'not-found' })
  })
})

describe('GET tool — the route', () => {
  const handler = createRouteHandler(service().service)

  it('answers 200 with the record, no-store, and the envelope `send` already sets', async () => {
    const served = service({
      toolFacts: () => ({
        ok: true,
        value: { name: 'mcp__db__query', description: 'Reads rows.', fields: [] },
      }),
    })
    const captured = await call(
      createRouteHandler(served.service),
      `${ROUTE_PREFIX}/tool?projectRoot=/tmp/repo&sessionId=session-1&name=mcp__db__query`,
    )

    expect(captured.status).toBe(200)
    expect(captured.headers['cache-control']).toBe('no-store')
    expect(captured.headers['content-type']).toBe('application/json')
    expect(captured.body).toEqual({
      ok: true,
      value: { name: 'mcp__db__query', description: 'Reads rows.', fields: [] },
    })
  })

  it('maps a not-found outcome to 404 with the service\'s own message', async () => {
    const served = service({
      toolFacts: () => ({ ok: false, code: 'not-found', message: 'nope is not mounted here' }),
    })
    const captured = await call(
      createRouteHandler(served.service),
      `${ROUTE_PREFIX}/tool?projectRoot=/tmp/repo&sessionId=session-1&name=nope`,
    )

    expect(captured.status).toBe(404)
    expect(captured.body).toEqual({
      ok: false,
      error: { code: 'not-found', message: 'nope is not mounted here' },
    })
  })

  it('refuses a request missing any one of the three names', async () => {
    for (const query of [
      '',
      '?projectRoot=&sessionId=session-1&name=mcp__db__query',
      '?projectRoot=/tmp/repo&name=mcp__db__query',
      '?projectRoot=/tmp/repo&sessionId=&name=mcp__db__query',
      '?projectRoot=/tmp/repo&sessionId=session-1',
      '?projectRoot=/tmp/repo&sessionId=session-1&name=',
    ]) {
      const captured = await call(handler, `${ROUTE_PREFIX}/tool${query}`)

      expect(captured.status, query).toBe(400)
      expect(captured.body, query).toMatchObject({ ok: false, error: { code: 'bad-request' } })
      expect(captured.body?.error?.message, query).toMatch(/needs a (projectRoot|sessionId|name)$/)
    }
  })

  it('answers the real runtime end to end for an opened row', async () => {
    const project = makeProject({ db: { command: 'npx' } })
    const { runtime } = await mount(project, new Map([['mcp__db__query', QUERY_SCHEMA]]))
    const served = service({
      toolFacts: (projectRoot, sessionId, name) => runtime.toolFactsOf(projectRoot, sessionId, name),
    })
    const query = `projectRoot=${encodeURIComponent(project.root)}&sessionId=session-1&name=mcp__db__query`

    const captured = await call(createRouteHandler(served.service), `${ROUTE_PREFIX}/tool?${query}`)

    expect(captured.status).toBe(200)
    expect(captured.body?.value?.name).toBe('mcp__db__query')
    expect(captured.body?.value?.fields.map((field) => field.name)).toEqual([
      'table',
      'where',
      'rows',
      'timeoutMs',
      'hint',
    ])
  })
})
