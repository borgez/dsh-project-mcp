/**
 * Pure decisions of the write path: content revision, entry body for the
 * editor, declaration built from a submission, document serialization, and the
 * `.bak`-then-rename write that has to leave the document untouched on failure.
 */

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyEntry,
  buildEntrySnapshot,
  documentRevision,
  entryToDeclaration,
  visibleUrl,
  WriteDocError,
  writeDocument,
  writeScopeFor,
} from '../src/write.ts'

const created: string[] = []

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'project-mcp-write-'))
  created.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('documentRevision', () => {
  it('is stable for identical bytes and different for any change', () => {
    const first = documentRevision('{"mcpServers":{}}\n')
    expect(first).toBe(documentRevision('{"mcpServers":{}}\n'))
    expect(first).not.toBe(documentRevision('{"mcpServers":{}}\n '))
    expect(first).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('writeScopeFor', () => {
  it('writes the project documents the deployment configures', () => {
    // The shipped default reads and writes one document.
    expect(writeScopeFor('/repo/.dsh/mcp.json', '/repo', {}).scope).toBe('project')
    expect(writeScopeFor('/repo/other.json', '/repo', {}).scope).toBe('readonly')
    // A document the config does not name is never written, however project-like
    // its path looks.
    const foreign = writeScopeFor('/repo/.kimi-code/mcp.json', '/repo', {})
    expect(foreign.scope).toBe('readonly')
    expect(foreign.reason).toContain('/repo/.dsh/mcp.json')
    // Naming it makes it writable, like every other configured document.
    expect(
      writeScopeFor('/repo/.kimi-code/mcp.json', '/repo', {
        projectDocuments: ['.kimi-code/mcp.json', '.dsh/mcp.json'],
      }).scope,
    ).toBe('project')
    // A project-relative spec and its absolute spelling are one document.
    expect(
      writeScopeFor('/repo/config/mcp.json', '/repo', { projectDocuments: ['config/mcp.json'] }).scope,
    ).toBe('project')
  })

  it('says nothing is writable when the deployment configures no document', () => {
    const info = writeScopeFor('/repo/.dsh/mcp.json', '/repo', { projectDocuments: [], globalDocuments: [] })
    expect(info.scope).toBe('readonly')
    expect(info.reason).toContain('configures none to write')
    // The wire companions ride beside the prose, byte-identical English intact.
    expect(info.blockedCode).toBe('write.blocked.notConfigured')
    expect(info.blockedParams).toEqual({ document: '/repo/.dsh/mcp.json' })
  })

  it('gates the global documents on allowGlobalWrite', () => {
    const options = { globalDocuments: ['/home/dev/.dsh/mcp.json'], allowGlobalWrite: false }
    const blocked = writeScopeFor('/home/dev/.dsh/mcp.json', '/repo', options)
    expect(blocked.scope).toBe('global')
    expect(blocked.reason).toContain('allowGlobalWrite')
    expect(blocked.blockedCode).toBe('write.blocked.globalDisabled')
    expect(blocked.blockedParams).toEqual({ document: '/home/dev/.dsh/mcp.json' })

    const allowed = writeScopeFor('/home/dev/.dsh/mcp.json', '/repo', {
      globalDocuments: ['/home/dev/.dsh/mcp.json'],
      allowGlobalWrite: true,
    })
    expect(allowed).toEqual({ scope: 'global' })
  })

  it('keeps a document it does not know readonly, with a reason', () => {
    const info = writeScopeFor('/opt/dsh/profiles/web/mcp.json', '/repo', {})
    expect(info.scope).toBe('readonly')
    expect(info.reason).toContain('/opt/dsh/profiles/web/mcp.json')
    expect(info.blockedCode).toBe('write.blocked.notWritable')
    expect(info.blockedParams).toEqual({
      document: '/opt/dsh/profiles/web/mcp.json',
      writable: '/repo/.dsh/mcp.json',
    })
  })
})

describe('visibleUrl', () => {
  it('drops a query string or fragment that can carry a credential', () => {
    expect(visibleUrl('https://example.test/mcp?token=abc')).toBe('https://example.test/mcp')
    expect(visibleUrl('https://example.test/mcp#frag')).toBe('https://example.test/mcp')
    expect(visibleUrl('https://example.test/mcp')).toBe('https://example.test/mcp')
  })
})

describe('buildEntrySnapshot', () => {
  it('reports what the document declares, with unknown keys kept', () => {
    const snapshot = buildEntrySnapshot(
      {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'example-service'],
        cwd: '/repo',
        env: { PLAIN: 'one' },
        extraField: { keep: true },
      },
      'stdio',
    )

    expect(snapshot).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'example-service'],
      cwd: '/repo',
      env: [{ key: 'PLAIN', value: 'one' }],
      extra: { extraField: { keep: true } },
    })
  })

  it('withholds a credential-shaped literal and a resolved reference', () => {
    const snapshot = buildEntrySnapshot(
      { command: 'npx', env: { API_KEY: 'literal-secret', PLAIN: 'one', FROM_ENV: '${SOME_VAR}' } },
      'stdio',
      { env: new Set(['FROM_ENV']) },
    )

    expect(snapshot.env).toEqual([
      { key: 'API_KEY', masked: true },
      { key: 'PLAIN', value: 'one' },
      { key: 'FROM_ENV', masked: true, fromCredentials: true },
    ])
  })

  it('drops the query of a declared endpoint and keeps a disabled entry disabled', () => {
    const snapshot = buildEntrySnapshot(
      { url: 'https://example.test/mcp?token=abc', headers: { Authorization: 'Bearer abc' }, enabled: false },
      'streamable-http',
    )

    expect(snapshot.url).toBe('https://example.test/mcp')
    expect(snapshot.headers).toEqual([{ key: 'Authorization', masked: true }])
    expect(snapshot.enabled).toBe(false)
  })
})

describe('entryToDeclaration', () => {
  it('keeps a masked key, writes a valued one and removes an omitted one', () => {
    const declaration = entryToDeclaration(
      {
        transport: 'stdio',
        command: 'npx',
        env: [
          { key: 'SECRET', masked: true },
          { key: 'PLAIN', value: 'two' },
        ],
      },
      { command: 'npx', env: { SECRET: 'declared-secret', PLAIN: 'one', GONE: 'old' } },
    )

    expect(declaration).toEqual({
      command: 'npx',
      env: { SECRET: 'declared-secret', PLAIN: 'two' },
    })
  })

  it('never writes a credentials-backed value, even when one is submitted', () => {
    const declaration = entryToDeclaration(
      { transport: 'stdio', command: 'npx', env: [{ key: 'TOKEN', value: 'resolved-secret', fromCredentials: true }] },
      { command: 'npx', env: { TOKEN: '${input:PROJECT_MCP_TOKEN}' } },
    )

    expect(declaration.env).toEqual({ TOKEN: '${input:PROJECT_MCP_TOKEN}' })
  })

  it('keeps the unknown keys and lets the presented fields win over them', () => {
    const declaration = entryToDeclaration(
      {
        transport: 'stdio',
        command: 'npx',
        extra: { timeoutMs: 5, command: 'ignored' },
      },
      { command: 'old', timeoutMs: 1 },
    )

    expect(declaration).toEqual({ timeoutMs: 5, command: 'npx' })
  })

  it('keeps the declared transport spelling while the transport is unchanged', () => {
    const unchanged = entryToDeclaration(
      { transport: 'streamable-http', url: 'https://example.test/mcp' },
      { type: 'sse', url: 'https://example.test/mcp' },
    )
    expect(unchanged).toEqual({ type: 'sse', url: 'https://example.test/mcp' })

    const switched = entryToDeclaration({ transport: 'stdio', command: 'npx' }, { type: 'sse', url: 'https://x/mcp' })
    expect(switched).toEqual({ command: 'npx' })
  })

  it('keeps a credential-bearing query while the visible URL is untouched', () => {
    const untouched = entryToDeclaration(
      { transport: 'streamable-http', url: 'https://example.test/mcp' },
      { url: 'https://example.test/mcp?token=abc' },
    )
    expect(untouched.url).toBe('https://example.test/mcp?token=abc')

    const edited = entryToDeclaration(
      { transport: 'streamable-http', url: 'https://other.test/mcp' },
      { url: 'https://example.test/mcp?token=abc' },
    )
    expect(edited.url).toBe('https://other.test/mcp')
  })

  it('leaves the other transport section of a mixed entry to the document', () => {
    const declared = { command: 'npx', headers: { Authorization: 'Bearer abc' } }
    const snapshot = buildEntrySnapshot(declared, 'stdio')
    expect(snapshot.headers).toBeUndefined()
    expect(snapshot.extra).toBeUndefined()

    const declaration = entryToDeclaration(snapshot, declared)
    expect(declaration).toEqual(declared)

    const switched = entryToDeclaration(
      { transport: 'streamable-http', url: 'https://example.test/mcp' },
      declared,
    )
    expect(switched).toEqual({ url: 'https://example.test/mcp' })
  })
})

describe('applyEntry', () => {
  it('replaces one entry, keeps every other key and normalizes the format', () => {
    const text = applyEntry(
      JSON.stringify({ version: 1, mcpServers: { alpha: { command: 'old' }, beta: { command: 'npx' } } }),
      'alpha',
      { command: 'npx', args: ['-y', 'alpha'] },
    )

    expect(JSON.parse(text)).toEqual({
      version: 1,
      mcpServers: { alpha: { command: 'npx', args: ['-y', 'alpha'] }, beta: { command: 'npx' } },
    })
    expect(text).toContain('\n  "mcpServers"')
    expect(text.endsWith('\n')).toBe(true)
  })

  it('refuses a document without a usable mcpServers object', () => {
    expect(() => applyEntry('not json', 'alpha', {})).toThrow(/not valid JSON/)
    expect(() => applyEntry('[]', 'alpha', {})).toThrow(/not a JSON object/)
    expect(() => applyEntry('{"servers":{}}', 'alpha', {})).toThrow(/mcpServers/)
  })

  it('throws each refusal as a WriteDocError carrying its wire code beside the prose (F-48)', () => {
    // The trio the save path reuses: the message stays the byte-identical
    // English it always was, the code and its flat params ride beside it.
    const invalid = catchOf(() => applyEntry('not json', 'alpha', {}))
    expect(invalid).toBeInstanceOf(WriteDocError)
    expect(invalid.code).toBe('write.doc.invalidJson')
    expect(invalid.message.startsWith('the document is not valid JSON: ')).toBe(true)
    expect(invalid.params).toEqual({ error: invalid.message.slice('the document is not valid JSON: '.length) })

    const notObject = catchOf(() => applyEntry('[]', 'alpha', {}))
    expect(notObject).toBeInstanceOf(WriteDocError)
    expect(notObject.code).toBe('write.doc.notObject')
    expect(notObject.message).toBe('the document is not a JSON object')
    expect(notObject.params).toBeUndefined()

    const noServers = catchOf(() => applyEntry('{"servers":{}}', 'alpha', {}))
    expect(noServers).toBeInstanceOf(WriteDocError)
    expect(noServers.code).toBe('write.doc.noMcpServers')
    expect(noServers.message).toBe('the document has no "mcpServers" object')
    expect(noServers.params).toBeUndefined()
  })
})

/** Run one throwing call and hand the error back typed, for the coded-refusal checks. */
function catchOf(run: () => unknown): WriteDocError {
  try {
    run()
  } catch (error) {
    return error as WriteDocError
  }
  throw new Error('expected the call to throw')
}

describe('writeDocument', () => {
  it('backs the document up first and replaces it without leftovers', () => {
    const root = tmp()
    const document = join(root, 'mcp.json')
    writeFileSync(document, '{"mcpServers":{}}\n')
    writeDocument(document, '{"mcpServers":{"alpha":{}}}\n')

    expect(readFileSync(document, 'utf8')).toBe('{"mcpServers":{"alpha":{}}}\n')
    expect(readFileSync(`${document}.bak`, 'utf8')).toBe('{"mcpServers":{}}\n')
    expect(readdirSync(root).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
  })

  it('leaves the document untouched when the backup cannot be made', () => {
    const root = tmp()
    const document = join(root, 'mcp.json')
    writeFileSync(document, '{"mcpServers":{}}\n')
    mkdirSync(`${document}.bak`)

    expect(() => writeDocument(document, '{"mcpServers":{"alpha":{}}}\n')).toThrow()
    expect(readFileSync(document, 'utf8')).toBe('{"mcpServers":{}}\n')
  })

  // A create-file failure inside the document directory: the first step that
  // needs to create a file fails, and the document must be byte-identical
  // afterwards. Root ignores the directory mode, so the case is skipped where
  // the check cannot be made to fail.
  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'leaves the document untouched when the directory refuses a new file',
    () => {
      const root = tmp()
      const document = join(root, 'mcp.json')
      writeFileSync(document, '{"mcpServers":{}}\n')
      chmodSync(root, 0o500)

      expect(() => writeDocument(document, '{"mcpServers":{"alpha":{}}}\n')).toThrow()
      chmodSync(root, 0o700)
      expect(readFileSync(document, 'utf8')).toBe('{"mcpServers":{}}\n')
    },
  )
})
