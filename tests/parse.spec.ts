import { describe, expect, it } from 'vitest'
import {
  mergeEntries,
  parseCredentials,
  parseDocument,
  parseEnvFile,
  referencesCredentials,
  SERVER_NAME_PATTERN,
  slugifyServerName,
  type ParsedEntry,
  type ResolveContext,
} from '../src/parse.ts'

const context: ResolveContext = {
  env: {
    TOKEN: 'token-value',
    PATHY: '/usr/bin',
    EMPTY: '',
    FROM_ENV: 'ambient-value',
    SHARED: 'ambient-value',
  },
  dotenv: { FROM_DOTENV: 'dotenv-value', SHARED: 'dotenv-value', BOTH: 'dotenv-value' },
  inputs: { ROOT: '/tmp/allowed-root', SHARED: 'inputs-value' },
  secrets: { FROM_CREDENTIALS: 'credential-value', BOTH: 'credential-value', FROM_ENV: 'credential-value' },
  stamp: 'sources-1',
  projectRoot: '/proj',
  toolCallTimeoutMs: 60_000,
  failOnStartupError: false,
}

function document(servers: Record<string, unknown>, ctx: ResolveContext = context) {
  return parseDocument(JSON.stringify({ mcpServers: servers }), '/proj/.dsh/mcp.json', ctx)
}

describe('parseDocument', () => {
  it('converts a stdio entry with defaults', () => {
    const { entries, issues, ok } = document({
      rider: { command: 'npx', args: ['-y', 'rider-mcp'] },
    })
    expect(ok).toBe(true)
    expect(issues).toEqual([])
    expect(entries).toHaveLength(1)
    expect(entries[0]?.name).toBe('rider')
    expect(entries[0]?.enabled).toBe(true)
    expect(entries[0]?.config).toEqual({
      transport: 'stdio',
      serverName: 'rider',
      command: 'npx',
      args: ['-y', 'rider-mcp'],
      env: {},
      cwd: '/proj',
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
    })
  })

  it('converts a url entry into streamable-http', () => {
    const { entries } = document({ gitea: { url: 'http://localhost:8080/mcp', headers: { Authorization: 'Bearer x' } } })
    expect(entries[0]?.config).toEqual({
      transport: 'streamable-http',
      serverName: 'gitea',
      url: 'http://localhost:8080/mcp',
      headers: { Authorization: 'Bearer x' },
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
    })
  })

  it('honours an explicit type, cwd and timeout overrides', () => {
    const { entries } = document({
      thing: { type: 'http', command: 'ignored', url: 'https://example.test/mcp' },
      other: { type: 'stdio', command: 'run', cwd: '/elsewhere' },
    })
    expect(entries[0]?.config?.transport).toBe('streamable-http')
    expect(entries[1]?.config?.transport).toBe('stdio')
    expect(entries[1]?.config && 'cwd' in entries[1].config ? entries[1].config.cwd : undefined).toBe('/elsewhere')
  })

  it('expands ${VAR} in env values and ${input:NAME} from inputs or credentials', () => {
    const { entries, issues } = document({
      tracker: {
        command: 'uvx',
        env: {
          TOKEN: '${TOKEN}',
          ROOT: '${input:ROOT}',
          SECRET: '${input:FROM_CREDENTIALS}',
          PATHLIKE: 'prefix-${PATHY}',
        },
      },
    })
    expect(issues).toEqual([])
    expect(entries[0]?.config?.transport === 'stdio' && entries[0].config.env).toEqual({
      TOKEN: 'token-value',
      ROOT: '/tmp/allowed-root',
      SECRET: 'credential-value',
      PATHLIKE: 'prefix-/usr/bin',
    })
  })

  it('reports an unset reference as an entry error without dropping other servers', () => {
    const { entries } = document({
      broken: { command: 'uvx', env: { TOKEN: '${input:NOPE}' } },
      fine: { command: 'npx' },
    })
    expect(entries[0]?.error).toContain('input "NOPE" is not set')
    expect(entries[0]?.config).toBeUndefined()
    expect(entries[1]?.name).toBe('fine')
    expect(entries[1]?.config).toBeDefined()
  })

  it('answers a plain ${NAME} from the project .env and from the credentials file', () => {
    const { entries, issues } = document({
      tracker: {
        command: 'uvx',
        env: { LOCAL: '${FROM_DOTENV}', GLOBAL: '${FROM_CREDENTIALS}', AMBIENT: '${FROM_ENV}' },
      },
    })
    expect(issues).toEqual([])
    expect(entries[0]?.config?.transport === 'stdio' && entries[0].config.env).toEqual({
      LOCAL: 'dotenv-value',
      GLOBAL: 'credential-value',
      AMBIENT: 'ambient-value',
    })
  })

  it('keeps the project .env ahead of the desktop environment and of credentials', () => {
    const { entries } = document({
      order: {
        command: 'uvx',
        env: { PLAIN: '${SHARED}', PREFIXED: '${input:SHARED}', EXTERNAL: '${BOTH}' },
      },
    })
    expect(entries[0]?.config?.transport === 'stdio' && entries[0].config.env).toEqual({
      // The project's own file answers, not the ambient `SHARED` or the
      // credentials `BOTH`; plugin inputs still outrank everything.
      PLAIN: 'dotenv-value',
      PREFIXED: 'inputs-value',
      EXTERNAL: 'dotenv-value',
    })
  })

  it('names the sources it consulted when a plain variable is unset', () => {
    const { entries } = document({ broken: { command: 'uvx', env: { X: '${NOPE}' } } })
    expect(entries[0]?.error).toBe(
      'X: variable "NOPE" is not set (looked in the project .env, the environment, and the credentials file)',
    )
  })

  it('treats an empty value as unset wherever it sits', () => {
    const { entries } = document({ broken: { command: 'uvx', env: { X: '${EMPTY}' } } })
    expect(entries[0]?.error).toContain('variable "EMPTY" is not set')
  })

  it('sanitizes an invalid serverName and keeps the tool namespace usable', () => {
    const { entries, issues } = document({ 'Community.Mcp.DotNet': { command: 'dnx' } })
    expect(entries[0]?.name).toBe('Community-Mcp-DotNet')
    expect(issues[0]?.level).toBe('warning')
  })

  it('keeps an entry declared with enabled: false', () => {
    const { entries } = document({ off: { command: 'npx', enabled: false }, on: { command: 'npx' } })
    expect(entries[0]?.enabled).toBe(false)
    expect(entries[1]?.enabled).toBe(true)
  })

  it('rejects an unusable document but still parses valid siblings', () => {
    const bad = parseDocument('{ not json', '/proj/.dsh/mcp.json', context)
    expect(bad.ok).toBe(false)
    expect(bad.issues[0]?.message).toContain('invalid JSON')

    const noServers = parseDocument('[1,2,3]', '/proj/.dsh/mcp.json', context)
    expect(noServers.ok).toBe(false)

    const broken = document({ bad: { url: 42 }, good: { command: 'npx' } })
    expect(broken.entries[0]?.error).toBe('http servers require a "url"')
    expect(broken.entries[1]?.error).toBeUndefined()
  })

  it('accepts a flat document without the mcpServers container', () => {
    const flat = parseDocument(JSON.stringify({ one: { command: 'npx' } }), '/proj/.dsh/mcp.json', context)
    expect(flat.ok).toBe(true)
    expect(flat.entries[0]?.name).toBe('one')
  })
})

describe('host codes (F-48)', () => {
  it('codes the document-level errors, the message byte-identical to before', () => {
    const bad = parseDocument('{ not json', '/proj/.dsh/mcp.json', context)
    expect(bad.issues[0]?.code).toBe('parse.json.invalid')
    expect(bad.issues[0]?.message).toMatch(/^invalid JSON: /)
    expect(bad.issues[0]?.params).toEqual({
      error: bad.issues[0]?.message.slice('invalid JSON: '.length),
    })

    const noServers = parseDocument('[1,2,3]', '/proj/.dsh/mcp.json', context)
    expect(noServers.issues[0]?.code).toBe('parse.doc.notObject')
    expect(noServers.issues[0]?.message).toBe('expected an object with an "mcpServers" object')
    expect(noServers.issues[0]?.params).toBeUndefined()
  })

  it('codes a duplicated serverName on the issue and on the entry alike', () => {
    // 'a b' slugifies to 'a-b', so the second declaration collides with it.
    const { entries, issues } = document({ 'a b': { command: 'npx' }, 'a-b': { command: 'npx' } })
    const duplicate = issues.find((issue) => issue.level === 'error')
    expect(duplicate?.code).toBe('parse.server.duplicateName')
    expect(duplicate?.params).toEqual({ name: 'a-b' })
    expect(duplicate?.message).toBe('serverName "a-b" is declared twice in this document')
    expect(entries[1]?.error).toBe(duplicate?.message)
    expect(entries[1]?.errorCode).toBe('parse.server.duplicateName')
    expect(entries[1]?.errorParams).toEqual({ name: 'a-b' })
  })

  it('codes the serverName sanitization pair', () => {
    const bad = document({ '***': { command: 'npx' } })
    expect(bad.issues[0]?.code).toBe('parse.server.badName')
    expect(bad.issues[0]?.params).toEqual({ key: '***', pattern: String(SERVER_NAME_PATTERN) })
    expect(bad.issues[0]?.message).toBe(
      `"***" cannot be converted into a valid serverName (${String(SERVER_NAME_PATTERN)})`,
    )

    const renamed = document({ 'Community.Mcp.DotNet': { command: 'dnx' } })
    expect(renamed.issues[0]?.code).toBe('parse.server.renamedName')
    expect(renamed.issues[0]?.params).toEqual({
      key: 'Community.Mcp.DotNet',
      slug: 'Community-Mcp-DotNet',
    })
    expect(renamed.issues[0]?.message).toBe(
      'serverName "Community.Mcp.DotNet" is not a valid mcp-client name; using "Community-Mcp-DotNet"',
    )
  })

  it('codes every entry-shape failure, on the issue and on the entry', () => {
    const cases: [unknown, string, string][] = [
      [42, 'parse.entry.notObject', 'entry must be an object'],
      [{ type: 42 }, 'parse.entry.badType', '"type" must be a string'],
      [
        { type: 'carrier-pigeon', command: 'x' },
        'parse.entry.typeUnknown',
        '"type" must be one of "stdio", "http", "streamable-http" or "sse"',
      ],
      [{}, 'parse.entry.noCommand', 'stdio servers require a "command"'],
      [{ command: 'x', args: 'nope' }, 'parse.entry.badArgs', '"args" must be an array of strings'],
      [{ command: 'x', env: [1] }, 'parse.entry.badEnv', '"env" must be an object of strings'],
      [{ command: 'x', cwd: 42 }, 'parse.entry.badCwd', '"cwd" must be a string'],
      [{ type: 'http' }, 'parse.entry.noUrl', 'http servers require a "url"'],
      [
        { url: 'http://x', headers: 'no' },
        'parse.entry.badHeaders',
        '"headers" must be an object of strings',
      ],
    ]
    for (const [raw, code, message] of cases) {
      const { entries, issues } = document({ one: raw })
      expect(issues[0]?.code, message).toBe(code)
      expect(issues[0]?.params, message).toBeUndefined()
      expect(issues[0]?.message, message).toBe(message)
      expect(entries[0]?.error, message).toBe(message)
      expect(entries[0]?.errorCode, message).toBe(code)
      expect(entries[0]?.errorParams, message).toBeUndefined()
    }
  })

  it('codes an unset reference with the reference codes', () => {
    const empty = document({ one: { command: '${input:}' } })
    expect(empty.entries[0]?.error).toBe('empty ${input:} reference')
    expect(empty.entries[0]?.errorCode).toBe('parse.ref.empty')
    expect(empty.entries[0]?.errorParams).toBeUndefined()

    const input = document({ one: { command: '${input:NOPE}' } })
    expect(input.entries[0]?.error).toBe(
      'input "NOPE" is not set (looked in plugin inputs, the project .env, the environment, and the credentials file)',
    )
    expect(input.entries[0]?.errorCode).toBe('parse.ref.inputUnset')
    expect(input.entries[0]?.errorParams).toEqual({ key: 'NOPE' })

    const variable = document({ one: { command: '${NOPE}' } })
    expect(variable.entries[0]?.error).toBe(
      'variable "NOPE" is not set (looked in the project .env, the environment, and the credentials file)',
    )
    expect(variable.entries[0]?.errorCode).toBe('parse.ref.varUnset')
    expect(variable.entries[0]?.errorParams).toEqual({ name: 'NOPE' })
  })

  it('codes a reference failure inside a record with the record key and the inner message', () => {
    const { entries, issues } = document({ broken: { command: 'uvx', env: { X: '${NOPE}' } } })
    const inner =
      'variable "NOPE" is not set (looked in the project .env, the environment, and the credentials file)'
    expect(entries[0]?.error).toBe(`X: ${inner}`)
    expect(entries[0]?.errorCode).toBe('parse.ref.failedInKey')
    expect(entries[0]?.errorParams).toEqual({ key: 'X', name: inner })
    expect(issues[0]?.code).toBe('parse.ref.failedInKey')
    expect(issues[0]?.params).toEqual({ key: 'X', name: inner })
  })
})

describe('mergeEntries', () => {
  const entry = (name: string, source: string): ParsedEntry => ({ name, enabled: true, source })

  it('lets the later document override by serverName and reports the override', () => {
    const merged = mergeEntries([
      [entry('a', 'low'), entry('b', 'low')],
      [entry('a', 'high')],
    ])
    expect(merged.entries.map((item) => [item.name, item.source])).toEqual([
      ['a', 'high'],
      ['b', 'low'],
    ])
    expect(merged.overridden).toEqual(['a'])
  })
})

describe('slugifyServerName', () => {
  it('produces a valid name and truncates to 32 characters', () => {
    expect(slugifyServerName('Community.Mcp.DotNet')).toBe('Community-Mcp-DotNet')
    expect(slugifyServerName('a'.repeat(40))).toHaveLength(32)
    expect(slugifyServerName('***')).toBe('')
  })
})

describe('parseCredentials', () => {
  it('reads flat key/value pairs and ignores comments', () => {
    const parsed = parseCredentials('# comment\nGITEA_TOKEN: abc123\nQUOTED: "with spaces"\n\n')
    expect(parsed).toEqual({ GITEA_TOKEN: 'abc123', QUOTED: 'with spaces' })
  })
})

describe('parseEnvFile', () => {
  it('reads assignments, `export`, quotes and comments', () => {
    const parsed = parseEnvFile(
      [
        '# a comment line',
        'GITEA_TOKEN=fake-gitea-token-for-tests',
        'export GRAPHQL_URL=https://example.test/graphql',
        'QUOTED="two words"',
        'SINGLE=\'kept $literal\'',
        'TRAILING=value # why',
        'ESCAPED="line\\nbreak"',
        'SPACED =   trimmed   ',
      ].join('\n'),
    )
    expect(parsed).toEqual({
      GITEA_TOKEN: 'fake-gitea-token-for-tests',
      GRAPHQL_URL: 'https://example.test/graphql',
      QUOTED: 'two words',
      SINGLE: 'kept $literal',
      TRAILING: 'value',
      ESCAPED: 'line\nbreak',
      SPACED: 'trimmed',
    })
  })

  it('skips empty values, malformed lines and a `#` that is not a comment', () => {
    const parsed = parseEnvFile(
      ['EMPTY=', 'BLANK=   ', 'NOT A LINE', '=novalue', 'HASH=a#b', 'LOWER_case=ok'].join('\n'),
    )
    // An empty value is "unset" for `${...}` either way, and a `#` glued to a
    // value is part of that value — only whitespace starts a comment.
    expect(parsed).toEqual({ HASH: 'a#b', LOWER_case: 'ok' })
  })

  it('reads an empty document as nothing at all', () => {
    expect(parseEnvFile('')).toEqual({})
  })
})

describe('referencesCredentials', () => {
  it('is true for a reference the project .env or the credentials file answers', () => {
    expect(referencesCredentials('${FROM_DOTENV}', context)).toBe(true)
    expect(referencesCredentials('Bearer ${input:FROM_CREDENTIALS}', context)).toBe(true)
    expect(referencesCredentials('${BOTH}', context)).toBe(true)
  })

  it('is false for the ambient environment, plugin inputs, and unset references', () => {
    expect(referencesCredentials('${FROM_ENV}', context)).toBe(false)
    expect(referencesCredentials('${input:ROOT}', context)).toBe(false)
    expect(referencesCredentials('${NOPE}', context)).toBe(false)
    expect(referencesCredentials('plain text', context)).toBe(false)
    expect(referencesCredentials('${input:}', context)).toBe(false)
  })
})
