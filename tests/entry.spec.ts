/**
 * The plugin entry: identity, config schema, `resolveConfig` and `apply`.
 *
 * `apply` is the only host-facing edge of the plugin, so it is driven through a
 * fake Cordis context that behaves the way the real container does at this
 * boundary:
 *
 * - `inject(deps, callback)` runs its callback immediately, as Cordis does once
 *   the dependency is present — the callback is not held pending here, because
 *   what is under test is what the callback *does*;
 * - `effect(fn, label)` runs `fn()` and remembers the disposer it returned, so
 *   the teardown of every block is exercised as well as its registration;
 * - `on(event, handler)` records the listener, so the `tools/result` wrapper
 *   `apply` installs can be driven the way the registry would drive it.
 *
 * The callbacks only touch the host surface they are meant to touch, and no
 * session is ever listed, so a pass over the runtime it builds mounts nothing:
 * no MCP child process is ever started here. A stub plugin would be passed
 * through `RuntimeOptions.plugin` if a mount were needed, but with an empty
 * agent registry none is.
 *
 * @module tests/entry
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  Config,
  SERVICE_NAME,
  apply,
  inject,
  liveValue,
  name,
  resolveConfig,
} from '../src/index.ts'
import type { ProjectMcpService } from '../src/index.ts'
import { ROUTE_PREFIX } from '../src/shared.ts'
import type { RouteHandler, WebServerLike } from '../src/ui.ts'

const created: string[] = []

/** Scratch `$DSH_HOME` for the whole file: the stores are minted per test. */
let scratchHome: string | undefined

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'project-mcp-entry-'))
  created.push(dir)
  return dir
}

/**
 * Point the durable stores at a scratch home for every test in this file: `apply`
 * mints a usage and a policy store on its own, and neither may be written under
 * the real `~/.dsh`. The stub outlives each test, so a store built in the second
 * test still resolves its path from the scratch home.
 */
beforeAll(() => {
  scratchHome = tmp()
  vi.stubEnv('DSH_HOME', scratchHome)
})

afterEach(() => {
  // Keep the scratch home itself; drop only the per-test project directories.
  for (const dir of created.splice(0)) {
    if (dir !== scratchHome) rmSync(dir, { recursive: true, force: true })
  }
})

afterAll(() => {
  vi.unstubAllEnvs()
  if (scratchHome !== undefined) rmSync(scratchHome, { recursive: true, force: true })
})

/** One route registration, kept so a test can assert on what was published. */
interface Registration {
  kind: string
  path: string
  handler: RouteHandler
}

/** The scope double Cordis hands an `inject` callback. */
interface FakeScope {
  agents: { list: () => unknown[] }
  webServer?: WebServerLike
  on: (name: string, handler: unknown) => () => void
  /** Run the callback now, exactly as `ctx.effect` does for a live fiber. */
  effect: (fn: () => unknown, label?: string) => void
  provide: (name: string, value: unknown) => void
}

/** What one `apply` call left behind on its fake host. */
interface FakeHost {
  ctx: Context
  logs: string[]
  provided: Map<string, unknown>
  /** Every `ctx.effect` block, its label and the disposer it returned. */
  effects: { fn: () => unknown; label: string | undefined; disposer: unknown }[]
  /** Listener callbacks, keyed by `ctx.on` event name. */
  listeners: Map<string, ((...args: unknown[]) => undefined)[]>
  /** Routes the web-server block registered, in registration order. */
  registrations: Registration[]
  /** Disposers handed to `webServer.register` per route. */
  registrationDisposers: (() => void)[]
  /** The label of every `scope.effect` the agent scope was asked for. */
  scopeEffects: (string | undefined)[]
  /** Disposals the injected scopes asked for, in order. */
  scopeUnsubscribers: (() => void)[]
  scopeWithWebServer: (webServer: WebServerLike | undefined) => FakeScope
}

/**
 * Host double for `apply`.
 * @param records - a logger's `info` lines, so `apply`'s own messages are read.
 */
function fakeHost(logs: string[]): FakeHost {
  const provided = new Map<string, unknown>()
  const effects: FakeHost['effects'] = []
  const listeners = new Map<string, ((...args: unknown[]) => undefined)[]>()
  const registrations: Registration[] = []
  const registrationDisposers: (() => void)[] = []
  const scopeEffects: (string | undefined)[] = []
  const scopeUnsubscribers: (() => void)[] = []

  /** The `inject` scope: `effect` runs its block, as the live fiber does. */
  const scopeWithWebServer = (webServer: WebServerLike | undefined): FakeScope => {
    const scope: FakeScope = {
      agents: { list: () => [] },
      on: () => () => undefined,
      effect: (fn, label) => {
        scopeEffects.push(label)
        const disposer = fn()
        if (typeof disposer === 'function') scopeUnsubscribers.push(disposer as () => void)
      },
      provide: (serviceName, value) => provided.set(serviceName, value),
    }
    if (webServer !== undefined) scope.webServer = webServer
    return scope
  }

  const ctx = {
    logger: {
      debug: () => undefined,
      info: (message: string) => logs.push(message),
      warn: (message: string) => logs.push(message),
    },
    tools: { schemas: () => [] },
    get: () => undefined,
    inject: (_deps: string[], callback: (scope: FakeScope) => void): void => {
      const wantsWebServer = _deps.includes('webServer')
      const webServer: WebServerLike = {
        register: (route) => {
          registrations.push({ kind: route.kind, path: route.path, handler: route.handler })
          const disposer = () => undefined
          registrationDisposers.push(disposer)
          return disposer
        },
      }
      callback(scopeWithWebServer(wantsWebServer ? webServer : undefined))
    },
    effect: (fn: () => unknown, label?: string): void => {
      effects.push({ fn, label, disposer: fn() })
    },
    on: (event: string, handler: (...args: unknown[]) => undefined): (() => void) => {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => undefined
    },
  }

  return {
    ctx: ctx as unknown as Context,
    logs,
    provided,
    effects,
    listeners,
    registrations,
    registrationDisposers,
    scopeEffects,
    scopeUnsubscribers,
    scopeWithWebServer,
  }
}

describe('project-mcp entry identity', () => {
  it('publishes the loader name and the required service list', () => {
    expect(name).toBe('project-mcp')
    expect(inject).toEqual(['tools'])
    expect(SERVICE_NAME).toBe('projectMcp')
  })

  it('resolves an empty config to the shipped defaults', () => {
    const resolved = resolveConfig({})
    expect(resolved.localFiles).toEqual(['.dsh/mcp.json'])
    expect(resolved.globalFiles).toEqual([])
    expect(resolved.lazy).toBe(true)
    expect(resolved.profileWins).toBe(true)
    expect(resolved.watch).toBe(true)
    expect(resolved.allowGlobalWrite).toBe(false)
    expect(resolved.credentialsFile).not.toBe('')
    expect(resolved.projectMarkers.length).toBeGreaterThan(0)
    expect(resolved.fileMarkers.length).toBeGreaterThan(0)
  })

  it('resolves explicit values verbatim, including the credentials override', () => {
    const resolved = resolveConfig({
      localFiles: ['.kimi-code/mcp.json'],
      globalFiles: ['~/.dsh/mcp.json'],
      inputs: { TOKEN: 'x' },
      projectMarkers: ['marker'],
      fileMarkers: ['suffix'],
      toolCallTimeoutMs: 7,
      credentialsFile: '/custom/credentials.yaml',
      allowGlobalWrite: true,
    })
    expect(resolved).toMatchObject({
      localFiles: ['.kimi-code/mcp.json'],
      globalFiles: ['~/.dsh/mcp.json'],
      inputs: { TOKEN: 'x' },
      projectMarkers: ['marker'],
      fileMarkers: ['suffix'],
      toolCallTimeoutMs: 7,
      credentialsFile: '/custom/credentials.yaml',
      allowGlobalWrite: true,
    })
  })

  it('keeps a document that still carries the old globalFiles switch', () => {
    // The key was a boolean before it was a list. A document that still has the
    // boolean must not fail the entry: `true` keeps the intent that mattered
    // then, `false` reads nothing, and a list is the setting.
    expect(resolveConfig(Config({ globalFiles: true }) as Config).globalFiles).toEqual([
      '$DSH_HOME/mcp.json',
    ])
    expect(resolveConfig(Config({ globalFiles: false }) as Config).globalFiles).toEqual([])
    expect(resolveConfig(Config({ globalFiles: ['~/.dsh/mcp.json'] }) as Config).globalFiles).toEqual([
      '~/.dsh/mcp.json',
    ])
  })

  it('validates through the loader schema and applies its defaults', () => {
    const parsed = Config({})
    expect(parsed.enabled).toBe(true)
    expect(parsed.inputs).toEqual({})
    // A volatile field parses to the host's ref shape: the default lives
    // behind the ref's `get()`, and `resolveConfig` unwraps it the same way.
    expect(liveValue(parsed.lazy)).toBe(true)
    // The defaults the schema hands the loader resolve to the same config.
    expect(resolveConfig(parsed)).toMatchObject({
      localFiles: ['.dsh/mcp.json'],
      activationEnabled: true,
      guidanceEnabled: true,
    })
  })
})

describe('apply', () => {
  it('logs and returns without touching the host when disabled', async () => {
    const host = fakeHost([])
    await apply(host.ctx, { enabled: false })
    expect(host.logs).toEqual(['project-mcp: disabled by configuration'])
    expect(host.effects).toHaveLength(0)
    expect(host.provided.size).toBe(0)
  })

  it('publishes the service, wires the panel routes and teardown blocks', async () => {
    const host = fakeHost([])
    await apply(host.ctx, {})

    // The read-only handle is published under the injected `agents` scope.
    const service = host.provided.get(SERVICE_NAME) as ProjectMcpService | undefined
    expect(service).toBeDefined()
    expect(typeof service?.snapshot).toBe('function')

    // Every lifecycle block ran, and each one returned its disposer. The panel
    // routes are fiber-scoped to the injected `webServer`, so they register on
    // the scope rather than on the plugin's own context.
    expect(host.effects.map((effect) => effect.label)).toEqual([
      'project-mcp: runtime',
      'project-mcp: usage counters',
      'project-mcp: tool policy',
    ])
    for (const effect of host.effects) expect(typeof effect.disposer).toBe('function')
    // `attach` parks the runtime's lifecycle on the injected `agents` scope, and
    // the panel routes are fiber-scoped to the injected `webServer`: both go to
    // a scope rather than to the plugin's own context.
    expect(host.scopeEffects).toEqual(['project-mcp: lifecycle', 'project-mcp: panel routes'])

    // The panel route went out on the web server the scope exposed.
    expect(host.registrations.map((route) => [route.kind, route.path])).toEqual([
      ['prefix', ROUTE_PREFIX],
    ])
    expect(typeof host.registrations[0]?.handler).toBe('function')

    // The volatile-merge listener rides the loader's live-edit event, and the
    // counter listener rides the registry's own result event.
    expect([...host.listeners.keys()]).toEqual(['loader/volatile-update', 'tools/result'])
  })

  it('re-resolves the config when the loader announces a volatile update', async () => {
    const host = fakeHost([])
    await apply(host.ctx, {})
    const handlers = host.listeners.get('loader/volatile-update')
    expect(handlers).toHaveLength(1)
    // An unchanged config merges back without throwing; the merge itself is
    // covered in `tests/runtime.spec.ts` (`applyLiveConfig`).
    expect(() => handlers?.[0]?.([])).not.toThrow()
  })

  it('drives the published service and unwinds every block', async () => {
    const host = fakeHost([])
    await apply(host.ctx, {})
    const service = host.provided.get(SERVICE_NAME) as ProjectMcpService

    // No session is listed, so these passes reconcile nothing and start no
    // server; they only prove the service methods reach the runtime.
    const snapshot = service.snapshot()
    expect(snapshot.projects).toEqual([])
    await service.syncNow()
    service.syncSoon()
    await service.retry()
    await service.release()

    // A row that is not declared is refused, not thrown.
    await expect(
      service.save({
        projectRoot: '/tmp/nowhere',
        server: 'ghost',
        document: '/tmp/nowhere/.dsh/mcp.json',
        revision: 'r1',
        entry: { transport: 'stdio', command: 'npx' },
      }),
    ).resolves.toMatchObject({ ok: false, code: 'not-found' })

    // Durable policy writes never need a live session.
    expect(service.setPolicy({ projectRoot: '/tmp/nowhere', mode: 'direct' })).toBeDefined()
    expect(
      service.setPin({ projectRoot: '/tmp/nowhere', tool: 'mcp__ghost__tool', pinned: true }),
    ).toBeDefined()

    // The status channel tells the listener the picture at once, then stops.
    const seen: unknown[] = []
    const stop = service.subscribe((change) => seen.push(change))
    expect(typeof stop).toBe('function')
    expect(seen).toHaveLength(1)
    stop()

    // Drive the result listener `apply` installed: the wrapper notes the call
    // before the observer sees it, as the registry does for a real result.
    const listener = host.listeners.get('tools/result')?.[0]
    expect(listener).toBeDefined()
    listener?.({ agent: { id: 'session-1' }, name: 'mcp__ghost__tool' }, { isError: false })

    // The route disposer the panel block returned tears the registration down.
    host.scopeUnsubscribers.forEach((dispose) => dispose())
    // Then the plugin's own blocks: runtime, counters and policy all unwind.
    for (const effect of host.effects) (effect.disposer as () => void)()
  })
})
