/**
 * The seam between the two halves of the write path.
 *
 * `src/write.ts` (host) and `src/client/settings.ts` (browser) were written from
 * one contract by two workstreams, so the contract's expensive cases are checked
 * here end to end: the host's `EntrySnapshot` is handed to the browser's draft,
 * the draft's submission is handed back to the host's writer, and the resulting
 * declaration is compared with the document it came from. A field that cannot
 * survive that round trip is a bug in whichever half dropped it, and it is
 * silent — the entry just loses configuration.
 */

import { describe, expect, it } from 'vitest'
import { buildEntrySnapshot, entryToDeclaration } from '../src/write.ts'
import { draftEntry, draftOf } from '../src/client/settings.ts'
import type { ServerRow } from '../src/types.ts'

/** The row the host would publish for one declared entry. */
function rowOf(
  declared: Record<string, unknown>,
  credentials: { env?: string; headers?: string } = {},
): ServerRow {
  const transport = typeof declared.url === 'string' ? 'streamable-http' : 'stdio'
  const entry = buildEntrySnapshot(declared, transport, {
    ...(credentials.env === undefined ? {} : { env: new Set([credentials.env]) }),
    ...(credentials.headers === undefined ? {} : { headers: new Set([credentials.headers]) }),
  })
  return {
    name: 'tglider',
    status: 'active',
    projectRoot: '/repo',
    source: '/repo/.dsh/mcp.json',
    writeScope: 'project',
    documentRevision: 'rev',
    entry,
  }
}

/** What the browser would submit, then what the host would write in its place. */
function roundTrip(
  declared: Record<string, unknown>,
  credentials: { env?: string; headers?: string } = {},
  edit?: (draft: ReturnType<typeof draftOf>) => void,
): Record<string, unknown> {
  const row = rowOf(declared, credentials)
  const draft = draftOf(row)
  if (draft === undefined) throw new Error('the row carried no editable entry')
  edit?.(draft)
  return entryToDeclaration(draftEntry(draft), declared)
}

describe('write-path seam', () => {
  it('keeps a credentials-backed env key the browser never shows', () => {
    const declared = {
      command: 'npx',
      env: { API_TOKEN: '${input:API_TOKEN}', LOG_LEVEL: 'debug' },
    }
    expect(roundTrip(declared, { env: 'API_TOKEN' }).env).toEqual({
      API_TOKEN: '${input:API_TOKEN}',
      LOG_LEVEL: 'debug',
    })
  })

  it('keeps a credentials-backed header the browser never shows', () => {
    const declared = {
      url: 'https://example.test/mcp',
      headers: { Authorization: '${input:GRAPHANA_TOKEN}' },
    }
    expect(roundTrip(declared, { headers: 'Authorization' }).headers).toEqual({
      Authorization: '${input:GRAPHANA_TOKEN}',
    })
  })

  it('keeps a masked literal value the editor did not touch', () => {
    const declared = { command: 'npx', env: { GRAFANA_TOKEN: 'ghp_0123456789' } }
    const next = roundTrip(declared)
    expect(next.env).toEqual({ GRAFANA_TOKEN: 'ghp_0123456789' })
  })

  it('writes a replacement the editor typed, and nothing for the mask', () => {
    const declared = { command: 'npx', env: { GRAFANA_TOKEN: 'old' } }
    const next = roundTrip(declared, undefined, (draft) => {
      const field = draft?.env.find((row) => row.key === 'GRAFANA_TOKEN')
      if (field === undefined) throw new Error('no such env row')
      field.text = 'rotated'
      field.replaced = true
    })
    expect(next.env).toEqual({ GRAFANA_TOKEN: 'rotated' })
  })

  it('removes an env key the editor deleted', () => {
    const declared = { command: 'npx', env: { LOG_LEVEL: 'debug', KEEP: 'yes' } }
    const next = roundTrip(declared, undefined, (draft) => {
      if (draft === undefined) return
      draft.env = draft.env.filter((row) => row.key !== 'LOG_LEVEL')
    })
    expect(next.env).toEqual({ KEEP: 'yes' })
  })

  it('round-trips extra keys without writing a literal `extra` key', () => {
    const declared = {
      command: 'npx',
      env: { LOG_LEVEL: 'debug' },
      startupTimeoutMs: 4_000,
      tags: ['one', 'two'],
    }
    const next = roundTrip(declared)
    expect(next.startupTimeoutMs).toBe(4_000)
    expect(next.tags).toEqual(['one', 'two'])
    expect('extra' in next).toBe(false)
  })

  it('keeps the declared query of an untouched endpoint', () => {
    const declared = { url: 'https://example.test/mcp?token=secret' }
    // The editor only ever sees the endpoint without its credential-bearing query.
    expect(roundTrip(declared).url).toBe('https://example.test/mcp?token=secret')
  })

  it('writes an endpoint the editor actually changed', () => {
    const declared = { url: 'https://example.test/mcp?token=secret' }
    const next = roundTrip(declared, undefined, (draft) => {
      if (draft !== undefined) draft.url = 'https://other.test/mcp'
    })
    expect(next.url).toBe('https://other.test/mcp')
  })
})
