/**
 * The resolver that turns a host payload `{ code, params, message }` into the
 * sentence a person reads, and the byte-identity contract between the `en`
 * table of `projectMcp.host` and the prose the host emits.
 *
 * The bound namespace is faked the way the harness's locale service behaves:
 * a hit answers the template with `{name}` params substituted, a miss echoes
 * the key — which is the signal {@link resolveHost} reads to fall back to the
 * payload's own English `message`. A raw code on screen is the defect this
 * spec exists to make impossible.
 *
 * @module tests/host-resolve
 */

import { describe, expect, it } from 'vitest'
import { NS_HOST, en, hostTranslate, resolveHost, ru, zh } from '../src/client/locales/host.ts'
import type { Translate } from '../src/client/view.ts'
import { parseDocument, type ParseIssue, type ParsedEntry, type ResolveContext } from '../src/parse.ts'
import { writeScopeFor } from '../src/write.ts'

/**
 * A bound namespace, as the harness answers one: the template with its params
 * on a hit, the key itself on a miss.
 */
function boundNamespace(table: Record<string, string>): Translate {
  return (key, params) => {
    const template = table[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
      name in params ? String(params[name]) : whole,
    )
  }
}

/** A namespace that knows one channel's codes in Russian, nothing else. */
const bound = boundNamespace({
  'write.blocked.notWritable':
    '{document} не входит в MCP-документы этого развёрнутого экземпляра; записать можно только {writable}',
  unmounting: 'снятие — {reason} (запросов: {ran})',
  'unmount.reason.sessionIdle': 'сессия простаивает',
})

describe('resolveHost', () => {
  it('translates a known code and substitutes its params', () => {
    const text = resolveHost(
      bound,
      'write.blocked.notWritable',
      { document: '/etc/mcp.json', writable: '/repo/.dsh/mcp.json' },
      'the English sentence',
    )
    expect(text).toBe(
      '/etc/mcp.json не входит в MCP-документы этого развёрнутого экземпляра; записать можно только /repo/.dsh/mcp.json',
    )
  })

  it('answers the payload message for a code the namespace does not know, never the raw code', () => {
    // Version skew: a client older than the host meets a code its dictionaries
    // lack. The harness can only echo the key, so the payload's own English
    // message is what the screen shows.
    expect(resolveHost(bound, 'write.blocked.future', undefined, 'the English sentence')).toBe(
      'the English sentence',
    )
    // A malformed payload (no message at all) is the one case the code itself
    // survives — the documented last resort, not a normal path.
    expect(resolveHost(bound, 'write.blocked.future', undefined, undefined)).toBe('write.blocked.future')
  })

  it('answers the message when the payload carries no code at all', () => {
    // An old host: prose fields only. The client renders exactly what it did
    // before codes existed.
    expect(resolveHost(bound, undefined, undefined, 'the English sentence')).toBe('the English sentence')
    expect(resolveHost(bound, undefined, undefined, undefined)).toBe('')
  })

  it('resolves a *Code param through the namespace and substitutes it under the plain name', () => {
    const text = resolveHost(
      bound,
      'unmounting',
      { reasonCode: 'unmount.reason.sessionIdle', ran: '3' },
      'unmounting — the session went idle (requests: 3)',
    )
    expect(text).toBe('снятие — сессия простаивает (запросов: 3)')
  })

  it('falls back to the message when a *Code param names a code the namespace does not know', () => {
    // Version skew one level down: a host newer than the client emits a
    // sub-code this client's dictionaries lack. Resolving it echoes the raw
    // sub-code, and substituting that echo would put the code on screen inside
    // an otherwise translated sentence — so the whole lookup is a miss and the
    // payload's English message answers instead.
    const text = resolveHost(
      bound,
      'unmounting',
      { reasonCode: 'unmount.reason.future', ran: '3' },
      'unmounting — a reason this client predates (requests: 3)',
    )
    expect(text).toBe('unmounting — a reason this client predates (requests: 3)')
    expect(text).not.toContain('unmount.reason.future')
  })

  it('keeps a placeholder verbatim when its param is missing', () => {
    const text = resolveHost(
      bound,
      'write.blocked.notWritable',
      { document: '/etc/mcp.json' },
      'the English sentence',
    )
    expect(text).toBe(
      '/etc/mcp.json не входит в MCP-документы этого развёрнутого экземпляра; записать можно только {writable}',
    )
  })
})

describe('hostTranslate', () => {
  it('binds the host namespace and lets a hit through', () => {
    const locale = { bind: (namespace: string) => (namespace === NS_HOST ? bound : boundNamespace({})) }
    const seat = hostTranslate(locale)
    expect(
      resolveHost(seat, 'write.blocked.notWritable', { document: '/d', writable: '/w' }, 'fallback'),
    ).toBe('/d не входит в MCP-документы этого развёрнутого экземпляра; записать можно только /w')
  })

  it('echoes without a locale service, so the resolver falls back to the message', () => {
    // A composition without a locale service must still boot, and its screen
    // shows the payload's English, not the code.
    const seat = hostTranslate(undefined)
    expect(seat('write.blocked.notWritable')).toBe('write.blocked.notWritable')
    expect(
      resolveHost(seat, 'write.blocked.notWritable', { document: '/d' }, 'the English sentence'),
    ).toBe('the English sentence')
  })

  it('echoes when the service refuses the namespace', () => {
    const locale = {
      bind: (): Translate => {
        throw new Error('unknown namespace')
      },
    }
    const seat = hostTranslate(locale)
    expect(resolveHost(seat, 'write.blocked.notWritable', undefined, 'the English sentence')).toBe(
      'the English sentence',
    )
  })
})

describe('the wire contract of the first channel', () => {
  /** Substitute the way the harness seat does, for the byte-identity check. */
  const fill = (template: string, params: Record<string, string>): string =>
    template.replace(/\{(\w+)\}/g, (whole, name: string) => params[name] ?? whole)

  it('emits the three codes with params, beside byte-identical prose', () => {
    const none = writeScopeFor('/repo/.dsh/mcp.json', '/repo', { projectDocuments: [], globalDocuments: [] })
    expect(none.blockedCode).toBe('write.blocked.notConfigured')
    expect(none.blockedParams).toEqual({ document: '/repo/.dsh/mcp.json' })
    expect(fill(en['write.blocked.notConfigured'], none.blockedParams ?? {})).toBe(none.reason)

    const foreign = writeScopeFor('/opt/dsh/profiles/web/mcp.json', '/repo', {})
    expect(foreign.blockedCode).toBe('write.blocked.notWritable')
    expect(foreign.blockedParams).toEqual({
      document: '/opt/dsh/profiles/web/mcp.json',
      writable: '/repo/.dsh/mcp.json',
    })
    expect(fill(en['write.blocked.notWritable'], foreign.blockedParams ?? {})).toBe(foreign.reason)

    const global = writeScopeFor('/home/dev/.dsh/mcp.json', '/repo', {
      globalDocuments: ['/home/dev/.dsh/mcp.json'],
      allowGlobalWrite: false,
    })
    expect(global.blockedCode).toBe('write.blocked.globalDisabled')
    expect(global.blockedParams).toEqual({ document: '/home/dev/.dsh/mcp.json' })
    expect(fill(en['write.blocked.globalDisabled'], global.blockedParams ?? {})).toBe(global.reason)
  })

  it('ships all three languages for every code the first channel emits', () => {
    for (const code of ['write.blocked.notConfigured', 'write.blocked.notWritable', 'write.blocked.globalDisabled'] as const) {
      expect(zh[code].trim()).not.toBe('')
      expect(ru[code].trim()).not.toBe('')
    }
  })
})

/**
 * The same contract for the parse channel (Task 2): every diagnostic
 * `parseDocument` produces carries a code the `en` table fills back to the
 * byte-identical `message`, and the multi-document merge warning the runtime
 * emits is the one the client's code comparison keys on.
 */
describe('the wire contract of the parse channel', () => {
  /** Substitute the way the harness seat does, for the byte-identity check. */
  const fill = (template: string, params: Record<string, string>): string =>
    template.replace(/\{(\w+)\}/g, (whole, name: string) => params[name] ?? whole)

  const context: ResolveContext = {
    env: {},
    dotenv: {},
    inputs: {},
    secrets: {},
    projectRoot: '/proj',
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
  }

  const document = (servers: Record<string, unknown>) =>
    parseDocument(JSON.stringify({ mcpServers: servers }), '/proj/.dsh/mcp.json', context)

  /** Every malformed input, one per emission the vocabulary names. */
  function everyDiagnostic(): { issues: ParseIssue[]; entries: ParsedEntry[] } {
    const issues: ParseIssue[] = []
    const entries: ParsedEntry[] = []
    const collect = (parsed: { issues: ParseIssue[]; entries: ParsedEntry[] }) => {
      issues.push(...parsed.issues)
      entries.push(...parsed.entries)
    }
    collect(parseDocument('{ not json', '/proj/.dsh/mcp.json', context))
    collect(parseDocument('[1,2,3]', '/proj/.dsh/mcp.json', context))
    collect(document({ 'a b': { command: 'npx' }, 'a-b': { command: 'npx' } }))
    collect(document({ '***': { command: 'npx' } }))
    collect(document({ 'Community.Mcp.DotNet': { command: 'dnx' } }))
    collect(document({ one: 42 }))
    collect(document({ one: { type: 42 } }))
    collect(document({ one: { type: 'carrier-pigeon', command: 'x' } }))
    collect(document({ one: {} }))
    collect(document({ one: { command: 'x', args: 'nope' } }))
    collect(document({ one: { command: 'x', env: [1] } }))
    collect(document({ one: { command: 'x', cwd: 42 } }))
    collect(document({ one: { type: 'http' } }))
    collect(document({ one: { url: 'http://x', headers: 'no' } }))
    collect(document({ one: { command: '${input:}' } }))
    collect(document({ one: { command: '${input:NOPE}' } }))
    collect(document({ one: { command: '${NOPE}' } }))
    collect(document({ one: { command: 'uvx', env: { X: '${NOPE}' } } }))
    return { issues, entries }
  }

  it('codes all 18 parse-emitted diagnostics, each en template filling back to the message', () => {
    const { issues, entries } = everyDiagnostic()
    const byCode = new Map<string, { params: Record<string, string> | undefined; message: string }>()
    for (const issue of issues) {
      expect(issue.code, `uncoded issue: ${issue.message}`).toBeDefined()
      byCode.set(issue.code ?? '', { params: issue.params, message: issue.message })
    }
    expect([...byCode.keys()].sort()).toEqual(
      [
        'parse.doc.notObject',
        'parse.entry.badArgs',
        'parse.entry.badCwd',
        'parse.entry.badEnv',
        'parse.entry.badHeaders',
        'parse.entry.badType',
        'parse.entry.noCommand',
        'parse.entry.notObject',
        'parse.entry.noUrl',
        'parse.entry.typeUnknown',
        'parse.json.invalid',
        'parse.ref.empty',
        'parse.ref.failedInKey',
        'parse.ref.inputUnset',
        'parse.ref.varUnset',
        'parse.server.badName',
        'parse.server.duplicateName',
        'parse.server.renamedName',
      ].sort(),
    )
    for (const [code, { params, message }] of byCode) {
      expect(fill(en[code as keyof typeof en], params ?? {}), code).toBe(message)
    }
    // The entry path (error → row.detail) carries the same pair.
    for (const entry of entries) {
      if (entry.error === undefined) continue
      expect(entry.errorCode, `uncoded entry error: ${entry.error}`).toBeDefined()
      expect(fill(en[entry.errorCode as keyof typeof en], entry.errorParams ?? {})).toBe(entry.error)
    }
  })

  it('keys the multi-document merge warning on the code the client compares', () => {
    // The literal lives in src/runtime.ts (the merge pass); settings.ts used to
    // string-match its prose and now compares `issue.code` against this code.
    const code = 'parse.server.multiDocument'
    expect(fill(en[code], { name: 'tglider' })).toBe(
      'serverName "tglider" was declared in more than one document; the highest-priority definition wins',
    )
  })

  it('ships all three languages for every code the parse channel emits', () => {
    const codes = Object.keys(en).filter((key) => key.startsWith('parse.')) as (keyof typeof en)[]
    // The 18 parseDocument emissions plus the runtime's multi-document warning.
    expect(codes).toHaveLength(19)
    for (const code of codes) {
      expect(zh[code].trim()).not.toBe('')
      expect(ru[code].trim()).not.toBe('')
    }
  })
})

/**
 * The same contract for the lifecycle channel (Task 3): every event and row
 * detail the runtime publishes carries a code whose `en` template fills back
 * to the byte-identical prose — the composite mount failure and stall details
 * included, one code whose template carries the newlines.
 */
describe('the wire contract of the lifecycle channel', () => {
  /** Substitute the way the harness seat does, for the byte-identity check. */
  const fill = (template: string, params: Record<string, string>): string =>
    template.replace(/\{(\w+)\}/g, (whole, name: string) => params[name] ?? whole)

  /**
   * Fill with the two-level convention applied: a `*Code` param resolves
   * through the `en` table first and substitutes under the plain name, exactly
   * as {@link resolveHost} does with the bound seat.
   */
  const fillLifecycle = (code: keyof typeof en, params: Record<string, string>): string => {
    const resolved: Record<string, string> = {}
    for (const [name, value] of Object.entries(params)) {
      if (name.endsWith('Code')) resolved[name.slice(0, -'Code'.length)] = en[value as keyof typeof en]
      else resolved[name] = value
    }
    return fill(en[code], resolved)
  }

  it('codes every lifecycle message, each en template filling back to the emission prose', () => {
    const cases: [keyof typeof en, Record<string, string>, string][] = [
      [
        'mount.starting',
        { sessionId: 'session-1', trigger: 'operator', sharingCode: 'mount.sharingShared' },
        'mounting for session session-1 (trigger: operator; one shared instance for every session of this project)',
      ],
      [
        'mount.starting',
        { sessionId: 'session-1', trigger: 'turn', sharingCode: 'mount.sharingForwarded' },
        "mounting for session session-1 (trigger: turn; one shared instance for this project, forwarded into this session's own layer)",
      ],
      ['mount.failed', { error: 'boom' }, 'mount failed — boom'],
      [
        'mount.failedDetail',
        { name: 'alpha', error: 'boom', endpoint: 'stdio npx explode', source: '/p/.dsh/mcp.json' },
        'alpha: mount failed — boom\nendpoint: stdio npx explode\ndeclared in: /p/.dsh/mcp.json',
      ],
      [
        'mount.up',
        { sessionId: 'session-1', elapsed: '812ms' },
        'is up — tools visible to session session-1 after 812ms',
      ],
      ['mount.stalled', { elapsed: '4m 27s' }, 'no tool appeared in 4m 27s'],
      [
        'mount.stalledDetail',
        { name: 'beta', elapsed: '4m 27s', endpoint: 'stdio npx', source: '/p/.dsh/mcp.json' },
        'beta: no tool appeared in 4m 27s\nendpoint: stdio npx\ndeclared in: /p/.dsh/mcp.json',
      ],
      [
        'unmounting',
        { reasonCode: 'unmount.reason.sessionIdle', ran: '1m 2s' },
        'unmounting — the session went idle (it ran for 1m 2s)',
      ],
      [
        'idle.lazy',
        {},
        'not mounted yet — this session has not started a turn (lazy mounting is on)',
      ],
      ['idle.disabled', {}, 'declared with enabled: false'],
      [
        'idle.releasedInactive',
        { seconds: '60.0s', count: '2' },
        'released after 60.0s without activity — 2 server(s) stopped; the next turn mounts them again',
      ],
      [
        'idle.releasedRequest',
        { count: '1' },
        'released on request — 1 server(s) stopped; the next turn mounts them again',
      ],
    ]
    for (const [code, params, prose] of cases) expect(fillLifecycle(code, params), code).toBe(prose)
  })

  it('pins the twelve unmount reasons to their emission literals', () => {
    const reasons: [keyof typeof en, string][] = [
      ['unmount.reason.operatorRetry', 'an operator retry replaces it'],
      ['unmount.reason.unloading', 'the plugin is unloading'],
      ['unmount.reason.sessionGone', 'the session went away'],
      ['unmount.reason.sessionUnlisted', 'the registry no longer lists the session'],
      ['unmount.reason.sessionMoved', 'the session moved to another project'],
      ['unmount.reason.sessionIdle', 'the session went idle'],
      ['unmount.reason.operatorReleased', 'an operator released it'],
      ['unmount.reason.profileShown', 'this project shows the profile-level copy instead'],
      ['unmount.reason.undeclared', 'the documents no longer declare it'],
      ['unmount.reason.nameChanged', 'its local name changed'],
      ['unmount.reason.declarationChanged', 'its declaration changed'],
      ['unmount.reason.nothingMountable', 'nothing it declares is mountable any more'],
    ]
    for (const [code, literal] of reasons) expect(en[code], code).toBe(literal)
  })

  it('ships all three languages for every code the lifecycle channel emits', () => {
    const codes = Object.keys(en).filter((key) =>
      /^(mount\.|unmounting$|unmount\.reason\.|idle\.)/.test(key),
    ) as (keyof typeof en)[]
    // mount.* (8) + unmounting (1) + unmount.reason.* (12) + idle.* (4).
    expect(codes).toHaveLength(25)
    for (const code of codes) {
      expect(zh[code].trim()).not.toBe('')
      expect(ru[code].trim()).not.toBe('')
    }
  })
})

/**
 * The same contract for the conflict channel (Task 4): the two shapes of the
 * profile conflict report, the duplicate-document report, the two readings of
 * a shadowed row's `detail`, and the presentation owner's note — each a code
 * whose `en` template fills back to the byte-identical prose the site emits.
 */
describe('the wire contract of the conflict channel', () => {
  /** Substitute the way the harness seat does, for the byte-identity check. */
  const fill = (template: string, params: Record<string, string>): string =>
    template.replace(/\{(\w+)\}/g, (whole, name: string) => params[name] ?? whole)

  /** The tables read as plain records, so a missing code fails the assertion instead of throwing. */
  const tables = { en, zh, ru } as unknown as Record<'en' | 'zh' | 'ru', Record<string, string>>

  it('codes every conflict and presentation message, each en template filling back to the emission prose', () => {
    const cases: [string, Record<string, string>, string][] = [
      [
        'conflict.profile',
        { name: 'alpha' },
        '"alpha" is owned by a profile-level mcp-client instance, so the project entry does not mount under it; remove the profile entry to use the project one everywhere, or let this project\'s copy take the name in this project\'s sessions alone.',
      ],
      [
        'conflict.profileAlias',
        { name: 'alpha', alias: 'p-alpha' },
        '"alpha" is owned by a profile-level mcp-client instance; this project\'s copy mounts as "p-alpha" when chosen beside it, or under the contested name when chosen to shadow it in this project\'s sessions, and does not mount at all while the profile\'s copy is the one shown.',
      ],
      [
        'conflict.documents',
        { name: 'alpha', count: '2', winner: '/repo/.dsh/mcp.json' },
        '"alpha" is declared in 2 documents; /repo/.dsh/mcp.json wins and the other declaration is not mounted.',
      ],
      [
        'conflict.profileDetail',
        { name: 'alpha' },
        'serverName "alpha" is already provided by a profile-level mcp-client instance — remove that entry from the profile to use the project one everywhere, or choose this project\'s copy to let it take the name in this project\'s sessions',
      ],
      [
        'conflict.profileAliasDetail',
        { name: 'alpha', alias: 'p-alpha' },
        'serverName "alpha" is already provided by a profile-level mcp-client instance — choose this project\'s copy to mount it as "p-alpha", or under the contested name to shadow the profile instance here',
      ],
      [
        'present.ownerNote',
        {},
        'a second presentation owner rewrites assembly.tools after this plugin does, so the two never combine in one request: either this plugin shapes only its own mcp__* entries, or the other owner is unmounted.',
      ],
    ]
    for (const [code, params, prose] of cases) {
      expect(tables.en[code], `missing en code: ${code}`).toBeDefined()
      expect(fill(tables.en[code] ?? '', params), code).toBe(prose)
    }
  })

  it('ships all three languages for every code the conflict channel emits', () => {
    const codes = Object.keys(tables.en).filter((key) => /^(conflict\.|present\.)/.test(key))
    expect(codes.sort()).toEqual(
      [
        'conflict.documents',
        'conflict.profile',
        'conflict.profileAlias',
        'conflict.profileAliasDetail',
        'conflict.profileDetail',
        'present.ownerNote',
      ].sort(),
    )
    for (const code of codes) {
      expect(tables.zh[code]?.trim() ?? '', `zh.${code}`).not.toBe('')
      expect(tables.ru[code]?.trim() ?? '', `ru.${code}`).not.toBe('')
    }
  })

  it('translates a coded conflict through the bound seat; an uncoded one keeps its prose', () => {
    const seat = boundNamespace({
      'conflict.documents': '"{name}" объявлен в документах: {count}; побеждает {winner}',
    })
    expect(
      resolveHost(
        seat,
        'conflict.documents',
        { name: 'alpha', count: '2', winner: '/repo/.dsh/mcp.json' },
        '"alpha" is declared in 2 documents; /repo/.dsh/mcp.json wins and the other declaration is not mounted.',
      ),
    ).toBe('"alpha" объявлен в документах: 2; побеждает /repo/.dsh/mcp.json')
    // An old host's conflict carries prose only, and renders exactly that.
    expect(resolveHost(seat, undefined, undefined, 'the English prose')).toBe('the English prose')
  })
})

/**
 * The same contract for the save channel (Task 5): every refusal of
 * `saveEntry` and of the three policy writes, plus the `write.doc.*` trio
 * `applyEntry` throws and the save path reuses — each a code whose `en`
 * template fills back to the byte-identical prose the site emits.
 */
describe('the wire contract of the save channel', () => {
  /** Substitute the way the harness seat does, for the byte-identity check. */
  const fill = (template: string, params: Record<string, string>): string =>
    template.replace(/\{(\w+)\}/g, (whole, name: string) => params[name] ?? whole)

  /** The tables read as plain records, so a missing code fails the assertion instead of throwing. */
  const tables = { en, zh, ru } as unknown as Record<'en' | 'zh' | 'ru', Record<string, string>>

  it('codes every save and policy refusal, each en template filling back to the refusal prose', () => {
    const cases: [string, Record<string, string>, string][] = [
      ['save.noPolicyStore', {}, 'this host has no tool-policy store'],
      ['save.noLiveSession', { projectRoot: '/repo' }, 'no live session in /repo'],
      ['save.unknownMode', { mode: '"strange"' }, 'unknown tool mode "strange"'],
      ['save.unknownChoice', { choice: '"strange"' }, 'unknown conflict choice "strange"'],
      [
        'save.serverNotDeclared',
        { server: 'alpha', projectRoot: '/repo' },
        'server "alpha" is not declared for /repo',
      ],
      [
        'save.noDeclaringDocument',
        { server: 'alpha' },
        'server "alpha" has no declaring document to write',
      ],
      ['save.notWritable', { document: '/repo/.dsh/mcp.json' }, '/repo/.dsh/mcp.json is not writable'],
      [
        'save.needsConsent',
        { document: '/home/dev/.dsh/mcp.json' },
        'writing /home/dev/.dsh/mcp.json needs explicit consent',
      ],
      [
        'save.globalDisabled',
        {},
        'writing the global tier is disabled by this deployment (allowGlobalWrite: false)',
      ],
      [
        'save.declaredElsewhere',
        { server: 'alpha', document: '/repo/.dsh/mcp.json' },
        'server "alpha" is now declared by /repo/.dsh/mcp.json',
      ],
      [
        'save.documentGone',
        { document: '/repo/.dsh/mcp.json' },
        'the declaring document /repo/.dsh/mcp.json is gone',
      ],
      [
        'save.documentChanged',
        { document: '/repo/.dsh/mcp.json' },
        '/repo/.dsh/mcp.json changed since the entry was read; reload it and edit again',
      ],
      [
        'save.invalidJson',
        { document: '/repo/.dsh/mcp.json', error: 'Unexpected token' },
        'the declaring document is not valid JSON: Unexpected token',
      ],
      [
        'save.noMcpServers',
        { document: '/repo/.dsh/mcp.json' },
        '/repo/.dsh/mcp.json does not use an "mcpServers" object, so this editor cannot rewrite it',
      ],
      [
        'save.noLongerDeclared',
        { server: 'alpha', document: '/repo/.dsh/mcp.json' },
        'server "alpha" is no longer declared in /repo/.dsh/mcp.json',
      ],
      ['save.entryNotParsed', { server: 'alpha' }, 'the edited entry "alpha" did not parse'],
      [
        'save.writeFailed',
        { document: '/repo/.dsh/mcp.json', error: 'EACCES' },
        'writing /repo/.dsh/mcp.json failed: EACCES',
      ],
      // The trio applyEntry throws and the save path reuses (write.ts).
      ['write.doc.invalidJson', { error: 'Unexpected token' }, 'the document is not valid JSON: Unexpected token'],
      ['write.doc.notObject', {}, 'the document is not a JSON object'],
      ['write.doc.noMcpServers', {}, 'the document has no "mcpServers" object'],
    ]
    for (const [code, params, prose] of cases) {
      expect(tables.en[code], `missing en code: ${code}`).toBeDefined()
      expect(fill(tables.en[code] ?? '', params), code).toBe(prose)
    }
  })

  it('ships all three languages for every code the save channel emits', () => {
    const codes = Object.keys(tables.en).filter((key) => /^(save\.|write\.doc\.)/.test(key))
    expect(codes.sort()).toEqual(
      [
        'save.declaredElsewhere',
        'save.documentChanged',
        'save.documentGone',
        'save.entryNotParsed',
        'save.globalDisabled',
        'save.invalidJson',
        'save.needsConsent',
        'save.noDeclaringDocument',
        'save.noLiveSession',
        'save.noLongerDeclared',
        'save.noMcpServers',
        'save.noPolicyStore',
        'save.notWritable',
        'save.serverNotDeclared',
        'save.unknownChoice',
        'save.unknownMode',
        'save.writeFailed',
        'write.doc.invalidJson',
        'write.doc.noMcpServers',
        'write.doc.notObject',
      ].sort(),
    )
    for (const code of codes) {
      expect(tables.zh[code]?.trim() ?? '', `zh.${code}`).not.toBe('')
      expect(tables.ru[code]?.trim() ?? '', `ru.${code}`).not.toBe('')
    }
  })
})
