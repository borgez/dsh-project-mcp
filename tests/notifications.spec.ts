/**
 * The notification service: one publication point for the plugin's lifecycle
 * events, and the consumers that read it.
 *
 * The ring and the DSH log used to be written by the runtime itself, at the same
 * five points but as separate writes that had to agree. Here they are consumers:
 * the ring is subscribed by the service, the log by the runtime's own wiring.
 * What these tests pin is therefore the contract between them — publication
 * order, the ring entry and the log line that follow one event, the disposer
 * that detaches a reader, and the promise that a consumer's failure never
 * reaches the pass that reported the event.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clear as clearLogs, latest } from '../src/logs.ts'
import {
  emitEvent,
  isSubscribed,
  logConsumer,
  subscribeEvent,
} from '../src/notifications.ts'
import type { PluginEvent } from '../src/notifications.ts'
import {
  ProjectMcpRuntime,
  type AgentLike,
  type AgentScopeLike,
  type RuntimeConfig,
} from '../src/runtime.ts'
import { chainSchemas, fakeScopes } from './helpers/scopes.ts'
import type { FakeScopes } from './helpers/scopes.ts'

const ROOT = '/tmp/notifications'
const PROJECT = '/tmp/notifications/project'

const created: string[] = []

/** A scratch project with one declared server, and a nested session directory. */
function makeProject(servers: Record<string, unknown>): { root: string; session: string } {
  const root = mkdtempSync(join(tmpdir(), 'project-mcp-notify-'))
  created.push(root)
  mkdirSync(join(root, '.dsh'), { recursive: true })
  mkdirSync(join(root, 'src', 'nested'), { recursive: true })
  writeFileSync(join(root, '.dsh', 'mcp.json'), JSON.stringify({ mcpServers: servers }))
  return { root, session: join(root, 'src', 'nested') }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Poll until `probe` holds: an activation settles behind the pass that started it. */
async function waitFor(probe: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!probe() && Date.now() < deadline) await sleep(5)
}

/** One event with the fields the test does not name filled in. */
function event(overrides: Partial<PluginEvent> = {}): PluginEvent {
  return {
    at: 1_000,
    level: 'info',
    projectRoot: ROOT,
    message: 'mounting for session session-1 (trigger: the first turn; one instance)',
    ...overrides,
  }
}

/** The `message` of every event the ring holds for a root, oldest first. */
function ringMessages(projectRoot = ROOT): string[] {
  return latest(projectRoot, 200).map((entry) => entry.message)
}

/**
 * The lifecycle lines of a host log, in the order they were written: the five
 * events this suite is about, and nothing a mount double's own wiring reports.
 * @param lines - every line the host logger saw.
 * @returns the lifecycle lines only.
 */
function lifecycleLines(lines: readonly string[]): string[] {
  return lines.filter(
    (line) =>
      line.includes('project-mcp: ') &&
      (/^project-mcp: mounting \S+ for session /.test(line) ||
        line.includes(': unmounting ') ||
        line.includes(': no tool appeared in ') ||
        line.includes(' mount failed — ') ||
        / is up in .+ — its tools are visible to session .+ after /.test(line)),
  )
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('emitEvent', () => {
  beforeEach(() => {
    clearLogs()
  })

  it('feeds the ring, so the tab draws what was published', () => {
    const published = event({ server: 'alpha', sessionId: 'session-1' })
    emitEvent(published)

    const kept = latest(ROOT)[0]
    expect(kept).toMatchObject({
      at: 1_000,
      level: 'info',
      projectRoot: ROOT,
      sessionId: 'session-1',
      server: 'alpha',
      message: published.message,
    })
  })

  it('reaches every subscriber, in subscription order', () => {
    const order: string[] = []
    const stopFirst = subscribeEvent(() => order.push('first'))
    const stopSecond = subscribeEvent(() => order.push('second'))

    try {
      emitEvent(event())
      expect(order).toEqual(['first', 'second'])
    } finally {
      stopFirst()
      stopSecond()
    }
  })

  it('detaches a consumer that unsubscribes, for good', () => {
    const seen: number[] = []
    const listener = (published: PluginEvent): void => {
      seen.push(published.at)
    }
    const stop = subscribeEvent(listener)
    expect(isSubscribed(listener)).toBe(true)

    emitEvent(event({ at: 1 }))
    stop()
    expect(isSubscribed(listener)).toBe(false)
    emitEvent(event({ at: 2 }))

    expect(seen).toEqual([1])
    // The ring kept reading the very same publications: one consumer's disposer
    // is not a publication path of its own.
    expect(ringMessages()).toEqual([event({ at: 1 }).message, event({ at: 2 }).message])
  })

  it('never throws into the pass that reported the event', () => {
    const seen: string[] = []
    const throwing = (): void => {
      throw new Error('a broken consumer')
    }
    const stopThrowing = subscribeEvent(throwing)
    const stopReading = subscribeEvent(() => seen.push('after the broken one'))

    try {
      expect(() => emitEvent(event())).not.toThrow()
      // The consumers after the broken one still got their event.
      expect(seen).toEqual(['after the broken one'])
      // And the ring's own consumer did too.
      expect(ringMessages()).toEqual([event().message])
    } finally {
      stopThrowing()
      stopReading()
    }
  })

  it('holds one entry per listener, however often it is registered', () => {
    const seen: string[] = []
    const listener = (): void => {
      seen.push('called')
    }

    const stopFirst = subscribeEvent(listener)
    const stopSecond = subscribeEvent(listener)
    try {
      emitEvent(event())
      expect(seen).toHaveLength(1)
    } finally {
      // Either disposer detaches the one entry, and a later one is a no-op.
      stopFirst()
      stopSecond()
    }

    expect(isSubscribed(listener)).toBe(false)
    emitEvent(event({ at: 2 }))
    expect(seen).toHaveLength(1)
  })
})

describe('the DSH log consumer', () => {
  beforeEach(() => {
    clearLogs()
  })

  it('writes one line per event, through the method its level names', () => {
    const lines: string[] = []
    const logger = {
      info: (line: unknown) => {
        lines.push(`info: ${String(line)}`)
      },
      warn: (line: unknown) => {
        lines.push(`warn: ${String(line)}`)
      },
      error: (line: unknown) => {
        lines.push(`error: ${String(line)}`)
      },
    }
    const stop = subscribeEvent(logConsumer(logger))

    // The lifecycle events, one line each: the level is what the ring colours
    // the row by, and the text is what the host log said before the event
    // existed. The mounting line names the server in front of the message, the
    // `is up` line names it before its verb, a failed mount's line is the whole
    // detail it carries as `line`, and the stall already opens its message with
    // the name.
    try {
      emitEvent(
        event({
          at: 1,
          server: 'alpha',
          message: 'mounting for session session-1 (trigger: eager; one shared instance)',
        }),
      )
      emitEvent(
        event({
          at: 2,
          level: 'up',
          server: 'alpha',
          message: 'is up — tools visible to session session-1 after 2s',
        }),
      )
      emitEvent(event({ at: 3, level: 'warn', server: 'beta', message: 'no tool appeared in 4m 27s' }))
      emitEvent(
        event({
          at: 4,
          level: 'error',
          server: 'gamma',
          message: 'mount failed — boom',
          detail: 'gamma: mount failed — boom\nendpoint: stdio npx explode',
          line: 'gamma: mount failed — boom\nendpoint: stdio npx explode',
        }),
      )
    } finally {
      stop()
    }

    expect(lines).toEqual([
      'info: project-mcp: alpha: mounting for session session-1 (trigger: eager; one shared instance)',
      'info: project-mcp: alpha is up — tools visible to session session-1 after 2s',
      'warn: project-mcp: no tool appeared in 4m 27s',
      'error: project-mcp: gamma: mount failed — boom\nendpoint: stdio npx explode',
    ])
  })

  it('names the server and the root in the unmounting line, as the tab\'s wording does not', () => {
    const lines: string[] = []
    const stop = subscribeEvent(
      logConsumer({
        info: (line: unknown) => {
          lines.push(String(line))
        },
        warn: (line: unknown) => {
          lines.push(String(line))
        },
      }),
    )

    try {
      emitEvent(
        event({
          at: 5,
          level: 'warn',
          projectRoot: PROJECT,
          server: 'alpha',
          message: 'unmounting — the session went idle (it ran for 1m 2s)',
        }),
      )
    } finally {
      stop()
    }

    expect(lines).toEqual([
      `project-mcp: unmounting alpha in ${PROJECT} — the session went idle (it ran for 1m 2s)`,
    ])
  })

  it('falls back to the levels a partial logger does have, never losing the line', () => {
    const lines: string[] = []
    const stop = subscribeEvent(
      logConsumer({
        info: (line: unknown) => {
          lines.push(`info: ${String(line)}`)
        },
        warn: (line: unknown) => {
          lines.push(`warn: ${String(line)}`)
        },
      }),
    )

    try {
      // `error` is the one method a partial double may omit, so the job goes to
      // `warn` — the line an operator would otherwise never see is kept.
      emitEvent(event({ at: 6, level: 'error', server: 'gamma', message: 'mount failed — boom' }))
    } finally {
      stop()
    }

    expect(lines).toEqual(['warn: project-mcp: mount failed — boom'])
  })
})

/**
 * The runtime's own five events, through the harness the other runtime specs
 * use: a fake host whose logger the test can read, and the real mcp-client
 * contract double.
 */
/**
 * Server names whose mount never settles, by declaration name.
 *
 * The mount lands in the project's own scope double, which the runtime mints
 * itself, so a flag on the session double would never be read: the stall is a
 * property of the declared server, and the names here are unique to this suite.
 */
const stalling = new Set<string>()

class WatchedCtx {
  readonly names = new Set<string>()

  /**
   * The mount double, with the one thing this suite drives past it: a server
   * that never answers, or one that refuses to start. Everything else in
   * `config` is deliberately ignored — nothing here re-implements the
   * declaration rules.
   */
  plugin(_plugin: unknown, config: { serverName: string; command?: string }): unknown {
    const owner = this
    return {
      await: async () => {
        if (stalling.has(config.serverName)) await new Promise<never>(() => undefined)
        if (config.command === 'explode') throw new Error('boom')
        owner.names.add(`mcp__${config.serverName}__tool`)
      },
      dispose: async () => {
        for (const name of [...owner.names]) {
          if (name.startsWith(`mcp__${config.serverName}__`)) owner.names.delete(name)
        }
      },
    }
  }

  schemas(): { name: string }[] {
    return [...this.names].map((name) => ({ name }))
  }

  /** The session wiring the runtime installs on a scope it mints; a no-op here. */
  inject(_names: string[], callback?: (scope: unknown) => void): () => void {
    callback?.(this)
    return () => undefined
  }

  /** Service lookup on a scope, as cordis resolves an injected one. */
  get(name: string): unknown {
    return name === 'systemPrompt' ? this.systemPrompt : undefined
  }

  /** The placement surface the guidance section registers into. */
  readonly systemPrompt = {
    section: () => () => undefined,
    getSectionOrder: () => 3100,
  }

  on(): () => void {
    return () => undefined
  }

  effect(): () => void {
    return () => undefined
  }

  dropBridge(): void {
    // The bridge the runtime's activation wiring installs; nothing to undo here.
  }

  disposeAll(): void {
    this.names.clear()
  }
}

class FakeScope implements AgentScopeLike {
  constructor(private readonly agents_: AgentLike[]) {}

  get agents(): { list: () => AgentLike[] } {
    return { list: () => [...this.agents_] }
  }

  on(): () => void {
    return () => undefined
  }

  effect(): () => void {
    return () => undefined
  }
}

/**
 * A runtime over one session double.
 *
 * The session double is handed to both `fakeScopes` and the agent, so the scope
 * the runtime mints for the session is the very context the mount lands in —
 * the runtime mounts through `scope.ctx.plugin`.
 * @param scopes - the scope doubles of this runtime.
 * @param overrides - config the case changes.
 */
function harness(
  scopes: FakeScopes<WatchedCtx>,
  overrides: Partial<RuntimeConfig> = {},
): {
  runtime: ProjectMcpRuntime
  lines: string[]
  dispose: () => Promise<void>
} {
  const lines: string[] = []
  const host = {
    logger: {
      debug: () => undefined,
      info: (line: unknown) => {
        lines.push(String(line))
      },
      warn: (line: unknown) => {
        lines.push(String(line))
      },
      error: (line: unknown) => {
        lines.push(String(line))
      },
    },
    tools: {
      schemas: (agent: AgentLike) => chainSchemas(scopes.chainOf(agent), (candidate) => candidate.schemas()),
      // The bridge's registry surface: a forwarded name resolves through the
      // declaring scope's own layer, which this double keeps in `names`.
      get: (name: string, scope?: object) => {
        const layers = scope === undefined ? [] : scopes.chainOf(scope)
        return layers
          .flatMap((candidate) => candidate.schemas())
          .find((schema) => schema.name === name)
      },
    },
    get: () => undefined,
  }
  const runtime = new ProjectMcpRuntime(host as unknown as Context, config(overrides), {
    // A plugin the double can mount without a real mcp-client behind it, and the
    // scope factory every other runtime spec consumes, so the mount lands in the
    // double the test can read.
    plugin: { name: 'fake-mcp', inject: ['tools'], apply: () => undefined },
    createScope: scopes.createScope,
  })
  return {
    runtime,
    lines,
    dispose: async () => {
      await runtime.disposeAll()
    },
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

function scopesFor(session: WatchedCtx): FakeScopes<WatchedCtx> {
  return fakeScopes(
    () => new WatchedCtx(),
    () => session,
    (ctx) => ctx.disposeAll(),
  )
}

function fakeAgent(id: string, cwd: string, ctx: WatchedCtx): AgentLike {
  return { id, session: { header: { cwd } }, ctx: ctx as unknown as Context }
}

describe('the runtime publishes and consumes', () => {
  beforeEach(() => {
    clearLogs()
  })

  it("publishes mounting, is up and unmounting through the one service", async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const session = new WatchedCtx()
    const harnessed = harness(scopesFor(session))
    harnessed.runtime.attach(new FakeScope([fakeAgent('session-1', project.session, session)]))

    try {
      await harnessed.runtime.syncNow()
      // The activation settles behind the pass; the `is up` event follows it.
      await waitFor(() => latest(project.root, 200).some((entry) => entry.level === 'up'))

      // Two events, in the order they happened: the mount registered, then its
      // tools became visible.
      expect(latest(project.root, 200).map((entry) => entry.level)).toEqual(['info', 'up'])
      // Only the lifecycle lines: the harness above is a mount double, and the
      // session wiring around it may report its own trouble. The host log keeps
      // the text it had before the events existed (F-21 moved the wiring, not
      // the wording), so the line still names the root, the trigger and the
      // sharing — the tab's own row carries the short form.
      expect(lifecycleLines(harnessed.lines)).toEqual([
        expect.stringContaining(
          `project-mcp: mounting alpha for session session-1 in ${project.root} (trigger: operator`,
        ),
        expect.stringContaining(
          `project-mcp: alpha is up in ${project.root} — its tools are visible to session session-1 after `,
        ),
      ])

      await harnessed.runtime.disposeAll()
      // The release is an event of its own: `unmounting`, and the ring keeps it.
      expect(ringMessages(project.root).some((message) => message.startsWith('unmounting —'))).toBe(true)
      expect(lifecycleLines(harnessed.lines).some((line) => line.includes('project-mcp: unmounting alpha in'))).toBe(true)
    } finally {
      await harnessed.dispose()
    }

    // Nothing this runtime subscribed is left behind: it was its own consumer.
    expect(lifecycleLines(harnessed.lines)).toHaveLength(3)
  })

  it('reports a failed mount as an error event, detail and log line together', async () => {
    const project = makeProject({ gamma: { command: 'explode' } })
    const session = new WatchedCtx()
    const harnessed = harness(scopesFor(session))
    harnessed.runtime.attach(new FakeScope([fakeAgent('session-1', project.session, session)]))

    try {
      await harnessed.runtime.syncNow()
      await waitFor(() => latest(project.root, 200).some((entry) => entry.level === 'error'))

      const failed = latest(project.root, 200).find((entry) => entry.level === 'error')
      expect(failed?.server).toBe('gamma')
      expect(failed?.message).toBe('mount failed — boom')
      expect(failed?.detail).toContain('gamma: mount failed — boom')
      expect(failed?.detail).toContain('endpoint: stdio explode')
      // The log line is the whole detail, as it always was.
      expect(harnessed.lines.some((line) => line.includes('gamma: mount failed — boom\nendpoint: stdio explode'))).toBe(true)
    } finally {
      await harnessed.dispose()
    }
  })

  it('reports a stall once, as a warning event with its three facts', async () => {
    const project = makeProject({ beta: { command: 'npx' } })
    stalling.add('beta')
    const session = new WatchedCtx()
    const harnessed = harness(scopesFor(session), { connectTimeoutMs: 40 })
    harnessed.runtime.attach(new FakeScope([fakeAgent('session-1', project.session, session)]))

    try {
      await harnessed.runtime.syncNow()
      // The connect window is what turns a silent mount into a report; the
      // watchdog re-reads it every pass, so the report has to wait for it.
      await sleep(60)
      await harnessed.runtime.syncNow()
      const stalls = latest(project.root, 200).filter((entry) => entry.message.startsWith('no tool appeared in'))
      expect(stalls).toHaveLength(1)
      expect(stalls[0]?.detail).toContain('beta: no tool appeared in')
      expect(stalls[0]?.detail).toContain('endpoint: stdio npx')
      expect(lifecycleLines(harnessed.lines).filter((line) => line.includes('no tool appeared in'))).toHaveLength(1)
    } finally {
      stalling.delete('beta')
      await harnessed.dispose()
    }
  })

  it('codes the stall event and its three-fact detail (F-48)', async () => {
    const project = makeProject({ beta: { command: 'npx' } })
    stalling.add('beta')
    const session = new WatchedCtx()
    const harnessed = harness(scopesFor(session), { connectTimeoutMs: 40 })
    harnessed.runtime.attach(new FakeScope([fakeAgent('session-1', project.session, session)]))

    try {
      await harnessed.runtime.syncNow()
      await sleep(60)
      await harnessed.runtime.syncNow()
      const stall = latest(project.root, 200).find((entry) => entry.code === 'mount.stalled')
      expect(stall).toBeDefined()
      expect(stall?.sessionId).toBe('session-1')
      expect(stall?.params?.elapsed).toMatch(/^\d/)
      // Byte-identical prose, assembled from the same templates as the codes.
      expect(stall?.message).toBe(`no tool appeared in ${stall?.params?.elapsed ?? ''}`)
      expect(stall?.detailCode).toBe('mount.stalledDetail')
      expect(stall?.detailParams).toMatchObject({ name: 'beta', endpoint: 'stdio npx' })
      expect(stall?.detailParams?.elapsed).toBe(stall?.params?.elapsed)
      expect(stall?.detail).toBe(
        `beta: no tool appeared in ${stall?.params?.elapsed ?? ''}\nendpoint: stdio npx\ndeclared in: ${stall?.detailParams?.source ?? ''}`,
      )
    } finally {
      stalling.delete('beta')
      await harnessed.dispose()
    }
  })

  it('drops its own log subscription when it is disposed, and only once', async () => {
    const project = makeProject({ alpha: { command: 'npx' } })
    const session = new WatchedCtx()
    const harnessed = harness(scopesFor(session))
    harnessed.runtime.attach(new FakeScope([fakeAgent('session-1', project.session, session)]))

    await harnessed.runtime.syncNow()
    await waitFor(() => latest(project.root, 200).some((entry) => entry.level === 'up'))
    await harnessed.runtime.disposeAll()

    const afterDispose = harnessed.lines.length
    // A second disposal is a no-op, and an event published after it no longer
    // reaches a runtime that has nothing left to report.
    await harnessed.runtime.disposeAll()
    expect(harnessed.lines).toHaveLength(afterDispose)

    // Publishing into the service is still the ring's business, not this
    // runtime's: the module keeps the ring, the runtime kept only its log.
    emitEvent(event({ at: 9, projectRoot: project.root, message: 'after the runtime went away' }))
    expect(harnessed.lines).toHaveLength(afterDispose)
    expect(ringMessages(project.root).some((message) => message === 'after the runtime went away')).toBe(true)
  })
})
