/**
 * Project-MCP guidance: the pure section builder (server order, the flat
 * deferred-names line, on-demand paragraph, hard length cap, `~`-collapsed
 * project label) and the agent-scope wiring the runtime installs.
 *
 * The contract under test is deliberately narrow. The text is deterministic for
 * equal input, it never names an absolute path, it only calls a tool
 * "on demand" when the session really defers it, and the section lives exactly
 * as long as the scope that owns the mounts.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { SEARCH_TOOL_NAME } from '../src/activation.ts'
import {
  DEFAULT_GUIDANCE_ENABLED,
  GUIDANCE_SECTION_NAME,
  MAX_GUIDANCE_CHARS,
  MAX_GUIDANCE_MOST_USED,
  MAX_GUIDANCE_SERVERS,
  MAX_GUIDANCE_HIDDEN_NAMES,
  buildGuidance,
  installGuidance,
  projectLabel,
} from '../src/guidance.ts'
import type {
  GuidanceContextLike,
  GuidancePromptScopeLike,
  GuidanceSectionLike,
  GuidanceServer,
} from '../src/guidance.ts'
import {
  ProjectMcpRuntime,
  type AgentEventLike,
  type AgentLike,
  type AgentScopeLike,
  type RuntimeConfig,
} from '../src/runtime.ts'
import { UsageStore } from '../src/usage.ts'
import { chainSchemas, fakeScopes } from './helpers/scopes.ts'
import type { FakeScopes } from './helpers/scopes.ts'

const created: string[] = []
const AT = Date.UTC(2024, 4, 6, 7, 8, 9)

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** One server row with the boring fields filled in. */
function server(name: string, overrides: Partial<GuidanceServer> = {}): GuidanceServer {
  return { name, status: 'active', transport: 'stdio', ...overrides }
}

function textOf(section: GuidanceSectionLike | undefined): string {
  if (section === undefined) throw new Error('the guidance section was not registered')
  return typeof section.text === 'function' ? section.text() : section.text
}

describe('buildGuidance', () => {
  it('says nothing when there is nothing worth saying', () => {
    expect(buildGuidance({})).toBe('')
    expect(buildGuidance({ project: 'project1' })).toBe('')
    expect(buildGuidance({ servers: [server('  ')] })).toBe('')
  })

  it('names the project and every mounted server in one bullet', () => {
    const text = buildGuidance({
      project: 'project1',
      servers: [
        server('tglider', {
          tools: ['search', 'outline'],
          purpose: 'code intelligence',
        }),
      ],
      offered: [],
      deferred: ['search', 'outline'],
      activationEnabled: true,
    })

    expect(text.startsWith('## Project MCP servers\n')).toBe(true)
    expect(text).toContain('Project `project1` mounts 1 MCP server(s) in this session.')
    expect(text).toContain('- tglider (stdio, active) — code intelligence')
    expect(text).toContain('On demand right now: outline, search')
    expect(text).toContain(`\`${SEARCH_TOOL_NAME}\``)
    expect(text).toContain('callable from the next step')
  })

  it('uses code-unit name order, so equal content yields equal text', () => {
    const first = buildGuidance({ project: 'p', servers: [server('beta'), server('alpha')] })
    const second = buildGuidance({ project: 'p', servers: [server('alpha'), server('beta')] })

    expect(first).toBe(second)
    expect(first.indexOf('- alpha')).toBeLessThan(first.indexOf('- beta'))
  })

  it('keeps the first of two same-named servers instead of duplicating the bullet', () => {
    const text = buildGuidance({
      servers: [server('memory', { purpose: 'first' }), server('memory', { purpose: 'second' })],
    })

    expect(text).toContain('mounts 1 MCP server(s)')
    expect(text).toContain('— first')
    expect(text).not.toContain('— second')
  })

  it('lists the deferred surface as one flat names line, sorted and truncated', () => {
    // Zero-padded so the code-unit sort order is the natural one.
    const tools = Array.from({ length: 14 }, (_, index) => `n${String(index).padStart(2, '0')}`)
    const deferred = buildGuidance({
      servers: [server('memory', { tools })],
      offered: [],
      deferred: tools,
    })

    expect(MAX_GUIDANCE_HIDDEN_NAMES).toBe(12)
    expect(deferred).toContain(
      `On demand right now: ${tools.slice(0, 12).join(', ')} +2 more`,
    )
    // The direct-call contract is named next to the list.
    expect(deferred).toContain('`mcp__<server>__<tool>`')

    // A tool that is offered directly is never presented as on demand, and
    // with nothing deferred there is no names line at all.
    const offered = buildGuidance({
      servers: [server('memory', { tools: ['store'] })],
      offered: ['store'],
      deferred: ['store'],
    })
    expect(offered).toContain('- memory (stdio, active)')
    expect(offered).not.toContain('On demand right now')
    expect(offered).not.toContain('on demand')
  })

  it('describes the on-demand surface, including how to bring a tool back', () => {
    const text = buildGuidance({
      servers: [server('memory', { tools: ['recall', 'store'] })],
      offered: ['recall'],
      deferred: ['store'],
    })

    expect(text).toContain('1 of 2 MCP tool(s) are offered directly')
    expect(text).toContain('the other 1')
    expect(text).toContain(`\`${SEARCH_TOOL_NAME}\``)
  })

  it('tells the model to search once and report the gap instead of guessing', () => {
    const text = buildGuidance({
      servers: [server('memory', { tools: ['recall', 'store'] })],
      offered: ['recall'],
      deferred: ['store'],
    })

    // The anti-loop hint: one honest search, then the absence of a match is
    // the answer — never an invented name. The invitation names keywords, not
    // a description: the matcher scores every query word on its own (F-53).
    expect(text).toContain('with a keyword or a tool name (several words are matched one by one)')
    expect(text).toContain('Search once with the best keywords you have')
    expect(text).toContain('report the gap instead of rephrasing the search or guessing a name')
  })

  it('names the counter-seeded hot tools at session start, most-called first', () => {
    const text = buildGuidance({
      servers: [server('memory', { tools: ['recall', 'store'] })],
      offered: ['recall', 'store'],
      mostUsed: ['store', 'recall'],
    })

    expect(text).toContain(
      "Most used in this project's sessions, offered from the first step on: store, recall",
    )
    expect(text).toContain('call them directly, no search needed')
  })

  it('keeps the hot-tools line rank-ordered, deduped and sampled', () => {
    const mostUsed = ['t5', 't1', 't5', 't2', ' t3 ', 't4', 't6']
    const text = buildGuidance({
      servers: [server('memory')],
      offered: mostUsed,
      mostUsed,
    })

    expect(MAX_GUIDANCE_MOST_USED).toBe(4)
    // Insertion order is the rank order: no re-sorting, blanks and repeats out.
    expect(text).toContain('t5, t1, t2, t3 +2 more')
  })

  it('drops the hot-tools line when activation is off or the baseline is empty', () => {
    const disabled = buildGuidance({
      servers: [server('memory')],
      offered: ['recall'],
      mostUsed: ['recall'],
      activationEnabled: false,
    })
    expect(disabled).not.toContain('Most used')

    const empty = buildGuidance({
      servers: [server('memory')],
      offered: ['recall'],
      mostUsed: [],
    })
    expect(empty).not.toContain('Most used')
  })

  it('drops the on-demand story when activation is off, keeping the mounts', () => {
    const text = buildGuidance({
      servers: [server('memory', { tools: ['recall'] })],
      offered: [],
      deferred: ['recall'],
      activationEnabled: false,
    })

    expect(text).toContain('- memory (stdio, active)')
    expect(text).not.toContain(SEARCH_TOOL_NAME)
    expect(text).not.toContain('on demand')
    expect(text).not.toContain('On demand right now')
    expect(DEFAULT_GUIDANCE_ENABLED).toBe(true)
  })

  it('describes a mount without a transport, and a blank label neutrally', () => {
    const text = buildGuidance({
      servers: [{ name: 'memory', status: 'error' }],
    })

    expect(text).toContain('- memory (error)')
    expect(text).toContain('Project `this project`')
  })

  it('summarizes the servers it does not list', () => {
    const many = Array.from({ length: MAX_GUIDANCE_SERVERS + 2 }, (_, index) => server(`s${index}`))
    const text = buildGuidance({ servers: many })

    expect(text).toContain(`- … and 2 more server(s)`)
    expect(text).not.toContain(`- s${MAX_GUIDANCE_SERVERS}`)
  })

  it('never exceeds the hard cap, keeping the on-demand paragraph', () => {
    const servers = Array.from({ length: 30 }, (_, index) =>
      server(`server-${String(index).padStart(2, '0')}`, {
        tools: Array.from({ length: 30 }, (_, tool) => `tool_${tool}`),
        purpose: 'a purpose long enough to crowd the section '.repeat(4),
      }),
    )
    const deferred = servers.flatMap((entry) => entry.tools ?? [])

    const text = buildGuidance({ project: 'project1', servers, deferred, offered: [] })

    expect(text.length).toBeLessThanOrEqual(MAX_GUIDANCE_CHARS)
    expect(text).toContain(`\`${SEARCH_TOOL_NAME}\``)
    expect(text).toContain('On demand right now')
    // 900 deferred entries dedupe to the 30 distinct names: 12 shown + 18 more.
    expect(text).toContain('+18 more')
    expect(text).toContain('more server(s)')
    // Deterministic: the same crowded input renders the same bytes again.
    expect(buildGuidance({ project: 'project1', servers, deferred, offered: [] })).toBe(text)
  })
})

describe('projectLabel', () => {
  it('collapses a home directory and never returns an absolute path', () => {
    // Placeholder account on purpose: fixtures must not carry a real one.
    expect(projectLabel('/home/dev/work/project1', '/home/dev')).toBe('~/work/project1')
    expect(projectLabel('/home/dev', '/home/dev')).toBe('~')
    expect(projectLabel('/home/dev/work/project1/')).toBe('project1')
    expect(projectLabel('/srv/example-service')).toBe('example-service')
    expect(projectLabel('/', '/home/dev')).toBe('this project')
    expect(projectLabel('')).toBe('this project')
  })
})

/** One section registry that sorts the way the harness does. */
class FakeSystemPrompt {
  readonly sections = new Map<string, GuidanceSectionLike>()
  readonly orderNames: string[] = []

  section(section: GuidanceSectionLike): () => void {
    this.sections.set(section.name, section)
    return () => {
      this.sections.delete(section.name)
    }
  }

  getSectionOrder(name: string): number {
    this.orderNames.push(name)
    return name === 'MCP_SERVERS' ? 3100 : -1
  }

  /** Names in the documented section order: explicit order, then code-unit name. */
  ordered(): string[] {
    return [...this.sections.values()]
      .sort(
        (left, right) =>
          left.order - right.order || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
      )
      .map((section) => section.name)
  }
}

/** Agent-scoped context double for the guidance wiring alone. */
class FakeGuidanceCtx {
  readonly systemPrompt = new FakeSystemPrompt()
  readonly injections: string[][] = []
  private readonly releases: (() => void)[] = []

  inject(
    deps: readonly string[],
    callback: (inner: GuidancePromptScopeLike) => unknown,
  ): () => void {
    this.injections.push([...deps])
    const before = new Set(this.systemPrompt.sections.keys())
    const returned = callback({ systemPrompt: this.systemPrompt })
    const owned = typeof returned === 'function' ? (returned as () => void) : undefined
    const release = () => {
      owned?.()
      for (const name of [...this.systemPrompt.sections.keys()]) {
        if (!before.has(name)) this.systemPrompt.sections.delete(name)
      }
    }
    this.releases.push(release)
    return release
  }

  disposeInjected(): void {
    for (const release of this.releases.splice(0)) release()
  }
}

describe('installGuidance', () => {
  it('registers the section through the injected prompt service at the MCP_SERVERS order', () => {
    const ctx = new FakeGuidanceCtx()
    const dispose = installGuidance({
      ctx: ctx as unknown as GuidanceContextLike,
      text: () => 'live text',
    })

    expect(ctx.injections).toEqual([['systemPrompt']])
    expect(ctx.systemPrompt.orderNames).toEqual(['MCP_SERVERS'])
    const section = ctx.systemPrompt.sections.get(GUIDANCE_SECTION_NAME)
    expect(section?.order).toBe(3100)
    expect(section?.interpolate).toBe(false)
    expect(textOf(section)).toBe('live text')

    dispose()
    expect(ctx.systemPrompt.sections.size).toBe(0)
    // Idempotent, and a pure stub loses the section on injection disposal too.
    dispose()
  })

  it('reads the text at each assembly, so later state changes are reflected', () => {
    const ctx = new FakeGuidanceCtx()
    let value = 'first'
    installGuidance({ ctx: ctx as unknown as GuidanceContextLike, text: () => value })

    const section = ctx.systemPrompt.sections.get(GUIDANCE_SECTION_NAME)
    expect(textOf(section)).toBe('first')
    value = 'second'
    expect(textOf(section)).toBe('second')
  })

  it('sorts before every per-server mcp:<server> section at the same order', () => {
    const ctx = new FakeGuidanceCtx()
    installGuidance({ ctx: ctx as unknown as GuidanceContextLike, text: () => '' })
    // What mcp-client and mcp-resources publish in the real scope.
    ctx.systemPrompt.sections.set('mcp:alpha', { name: 'mcp:alpha', order: 3100, text: '' })
    ctx.systemPrompt.sections.set('mcp:beta', { name: 'mcp:beta', order: 3100, text: '' })
    ctx.systemPrompt.sections.set('mcp-resource-servers', {
      name: 'mcp-resource-servers',
      order: 3100,
      text: '',
    })

    expect(GUIDANCE_SECTION_NAME < 'mcp:alpha').toBe(true)
    const order = ctx.systemPrompt.ordered()
    expect(order.slice(0, 2)).toEqual(['mcp-project-guidance', 'mcp-resource-servers'])
    for (const perServer of ['mcp:alpha', 'mcp:beta']) {
      expect(order.indexOf(GUIDANCE_SECTION_NAME)).toBeLessThan(order.indexOf(perServer))
    }
  })

  it('contains a failing registration and disposes cleanly', () => {
    const errors: unknown[] = []
    const failing = {
      inject: (
        _deps: readonly string[],
        callback: (inner: GuidancePromptScopeLike) => unknown,
      ): unknown =>
        callback({
          systemPrompt: {
            section: () => {
              throw new Error('duplicate section')
            },
            getSectionOrder: () => 3100,
          },
        }),
    }
    const dispose = installGuidance({
      ctx: failing as unknown as GuidanceContextLike,
      text: () => 'x',
      onError: (error) => errors.push(error),
    })

    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain('duplicate section')
    dispose()
  })
})

/** Project with a `.dsh/mcp.json`, plus a nested session directory. */
function makeProject(servers: Record<string, unknown>): { root: string; session: string } {
  const root = mkdtempSync(join(tmpdir(), 'project-mcp-guidance-'))
  created.push(root)
  mkdirSync(join(root, '.dsh'), { recursive: true })
  mkdirSync(join(root, 'src', 'nested'), { recursive: true })
  writeFileSync(join(root, '.dsh', 'mcp.json'), JSON.stringify({ mcpServers: servers }))
  return { root, session: join(root, 'src', 'nested') }
}

function rewrite(root: string, servers: Record<string, unknown>): void {
  writeFileSync(join(root, '.dsh', 'mcp.json'), JSON.stringify({ mcpServers: servers }))
}

/** Agent-scoped context double: mounts fake mcp-client fibers and holds sections. */
class FakeAgentCtx {
  readonly mounts: { name: string; disposed: boolean }[] = []
  readonly systemPrompt = new FakeSystemPrompt()
  readonly registered = new Set<string>()
  readonly injections: string[][] = []
  private readonly mcpNames = new Set<string>()
  private readonly listeners = new Map<string, unknown[]>()
  private readonly releases: (() => void)[] = []

  plugin(_plugin: unknown, config: { serverName: string }): unknown {
    const record = { name: config.serverName, disposed: false }
    this.mounts.push(record)
    const owner = this
    return {
      await: async (): Promise<void> => {
        owner.mcpNames.add(`mcp__${config.serverName}__tool`)
      },
      dispose: async (): Promise<void> => {
        record.disposed = true
        for (const name of [...owner.mcpNames]) {
          if (name.startsWith(`mcp__${config.serverName}__`)) owner.mcpNames.delete(name)
        }
      },
    }
  }

  schemas(): { name: string; description: string; parameters: Record<string, unknown> }[] {
    return [...this.mcpNames].map((name) => ({
      name,
      description: `tool ${name}`,
      parameters: {},
    }))
  }

  on(name: string, listener: unknown): () => void {
    const list = this.listeners.get(name) ?? []
    list.push(listener)
    this.listeners.set(name, list)
    return () => {
      const index = list.indexOf(listener)
      if (index >= 0) list.splice(index, 1)
    }
  }

  get tools(): { register: (definition: { name: string }) => () => void } {
    return {
      register: (definition) => {
        this.registered.add(definition.name)
        return () => {
          this.registered.delete(definition.name)
        }
      },
    }
  }

  inject(
    deps: readonly string[],
    callback: (inner: GuidancePromptScopeLike) => unknown,
  ): () => void {
    this.injections.push([...deps])
    const before = new Set(this.systemPrompt.sections.keys())
    const returned = callback({ systemPrompt: this.systemPrompt })
    const owned = typeof returned === 'function' ? (returned as () => void) : undefined
    const release = () => {
      owned?.()
      for (const name of [...this.systemPrompt.sections.keys()]) {
        if (!before.has(name)) this.systemPrompt.sections.delete(name)
      }
    }
    this.releases.push(release)
    return release
  }

  disposeAll(): void {
    for (const mount of this.mounts) mount.disposed = true
    this.mcpNames.clear()
    // Listeners and registrations are deliberately NOT cleared here, so the
    // runtime has to release them explicitly for them to disappear.
  }
}

type ScopeHandler = (event: AgentEventLike, next: () => Promise<unknown>) => unknown

/** Scope double that can deliver the agent-plane notifications the runtime listens to. */
class FakeScope implements AgentScopeLike {
  private readonly handlers = new Map<string, ScopeHandler[]>()

  constructor(private readonly agents_: AgentLike[]) {}

  get agents() {
    return { list: () => [...this.agents_] }
  }

  on(name: string, handler: ScopeHandler): () => void {
    const list = this.handlers.get(name) ?? []
    list.push(handler)
    this.handlers.set(name, list)
    return () => undefined
  }

  effect(): () => void {
    return () => undefined
  }

  emit(name: string, event: AgentEventLike): void {
    for (const handler of this.handlers.get(name) ?? []) void handler(event, async () => undefined)
  }
}

/**
 * Scope doubles: one per session, one for the project its servers are shared
 * in. `tools.schemas(agent)` resolves the session's chain, so the section this
 * runtime registers names the mounts the session can actually see.
 */
function scopesFor(): FakeScopes<FakeAgentCtx> {
  return fakeScopes<FakeAgentCtx>(
    () => new FakeAgentCtx(),
    (key) => (key as AgentLike).ctx as unknown as FakeAgentCtx,
    (ctx) => ctx.disposeAll(),
  )
}

function fakeHost(scopes: FakeScopes<FakeAgentCtx>): Context {
  const host = {
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    tools: {
      schemas: (agent: AgentLike) => chainSchemas(scopes.chainOf(agent), (ctx) => ctx.schemas()),
    },
    get: () => undefined,
  }
  return host as unknown as Context
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

function runtimeFor(
  overrides: Partial<RuntimeConfig> = {},
  options: { usage?: UsageStore } = {},
): ProjectMcpRuntime {
  const scopes = scopesFor()
  return new ProjectMcpRuntime(fakeHost(scopes), config(overrides), {
    plugin: { name: 'fake-mcp', inject: ['tools'], apply: () => undefined },
    createScope: scopes.createScope,
    ...(options.usage === undefined ? {} : { usage: options.usage }),
  })
}

function fakeAgent(id: string, cwd: string, ctx: FakeAgentCtx): AgentLike {
  return { id, session: { header: { cwd } }, ctx: ctx as unknown as Context }
}

describe('runtime guidance wiring', () => {
  it('registers a live section that describes the session project without an absolute path', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const runtime = runtimeFor()
    const ctx = new FakeAgentCtx()
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session, ctx)]))
    await runtime.syncNow()

    expect(ctx.injections).toEqual([['systemPrompt']])
    const section = ctx.systemPrompt.sections.get(GUIDANCE_SECTION_NAME)
    expect(section?.order).toBe(3100)

    const text = textOf(section)
    expect(text).toContain('- alpha (stdio, active)')
    expect(text).toContain('On demand right now: tool')
    expect(text).toContain(SEARCH_TOOL_NAME)
    // Privacy: the label is the directory name, never the absolute project root.
    expect(text).toContain(basename(project.root))
    expect(text).not.toContain(project.root)

    await runtime.disposeAll()
  })

  it('names the counter-seeded baseline in the live section at session start', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const usageFile = join(mkdtempSync(join(tmpdir(), 'project-mcp-guidance-')), 'usage.json')
    created.push(usageFile.slice(0, usageFile.lastIndexOf('/')))
    const store = new UsageStore({ file: usageFile, flushMs: 60_000 })
    for (let index = 0; index < 2; index += 1) {
      store.record({
        projectRoot: project.root,
        serverName: 'alpha',
        tool: 'tool',
        isError: false,
        at: AT + index,
        sessionId: 'session-one',
      })
    }
    const runtime = runtimeFor({ activationMinCalls: 2 }, { usage: store })
    const ctx = new FakeAgentCtx()
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session, ctx)]))
    await runtime.syncNow()

    const text = textOf(ctx.systemPrompt.sections.get(GUIDANCE_SECTION_NAME))
    expect(text).toContain(
      "Most used in this project's sessions, offered from the first step on: tool",
    )

    await runtime.disposeAll()
    store.dispose()
  })

  it('reflects the mounted set a later rescan changed, without re-registering', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const runtime = runtimeFor()
    const ctx = new FakeAgentCtx()
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session, ctx)]))
    await runtime.syncNow()
    expect(textOf(ctx.systemPrompt.sections.get(GUIDANCE_SECTION_NAME))).toContain(
      'mounts 1 MCP server(s)',
    )

    rewrite(project.root, { alpha: { command: 'npx' }, beta: { command: 'npx' } })
    await runtime.syncNow()

    expect(ctx.injections).toEqual([['systemPrompt']])
    const text = textOf(ctx.systemPrompt.sections.get(GUIDANCE_SECTION_NAME))
    expect(text).toContain('mounts 2 MCP server(s)')
    expect(text).toContain('- beta (stdio, active)')

    await runtime.disposeAll()
  })

  it('drops the section with the session scope and installs a fresh one on the next mount', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const runtime = runtimeFor()
    const ctx = new FakeAgentCtx()
    const agent = fakeAgent('session-1', project.session, ctx)
    const scope = new FakeScope([agent])
    runtime.attach(scope)
    await runtime.syncNow()
    expect(ctx.systemPrompt.sections.has(GUIDANCE_SECTION_NAME)).toBe(true)

    await runtime.release('session-1')
    expect(ctx.systemPrompt.sections.has(GUIDANCE_SECTION_NAME)).toBe(false)

    scope.emit('agent/status', { agent, status: 'running' })
    await runtime.syncNow()
    expect(ctx.systemPrompt.sections.has(GUIDANCE_SECTION_NAME)).toBe(true)

    await runtime.disposeAll()
    expect(ctx.systemPrompt.sections.has(GUIDANCE_SECTION_NAME)).toBe(false)
  })

  it('registers no section at all when guidance is disabled', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const runtime = runtimeFor({ guidanceEnabled: false })
    const ctx = new FakeAgentCtx()
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session, ctx)]))
    await runtime.syncNow()

    expect(ctx.systemPrompt.sections.size).toBe(0)
    expect(ctx.injections).toEqual([])
    // Guidance is presentation only: activation keeps working without it.
    expect(ctx.registered.has(SEARCH_TOOL_NAME)).toBe(true)

    await runtime.disposeAll()
  })

  it('keeps the section but drops the on-demand paragraph when activation is disabled', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const runtime = runtimeFor({ activationEnabled: false })
    const ctx = new FakeAgentCtx()
    runtime.attach(new FakeScope([fakeAgent('session-1', project.session, ctx)]))
    await runtime.syncNow()

    const text = textOf(ctx.systemPrompt.sections.get(GUIDANCE_SECTION_NAME))
    expect(text).toContain('- alpha (stdio, active)')
    expect(text).not.toContain(SEARCH_TOOL_NAME)
    expect(text).not.toContain('On demand right now')

    await runtime.disposeAll()
  })
})
