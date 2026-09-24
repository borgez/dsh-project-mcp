/**
 * Write half of the entry editor: every decision one save makes, plus the
 * atomic document write those decisions guard.
 *
 * The host and the browser half agree on the outcome through the contract
 * (`docs/design/contracts/write-path.md`): a save replaces `mcpServers[<server>]`
 * wholesale, keeps every other key of the document, normalizes the formatting
 * (two spaces, trailing newline) and never writes a value the editor could not
 * see. Everything here is pure except {@link writeDocument}, so the rules are
 * testable without a filesystem.
 *
 * @module dsh-project-mcp/write
 */

import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { DEFAULT_LOCAL_FILES } from './discovery.ts'
import { hasReference } from './parse.ts'
import type { EntryField, EntrySnapshot, WriteScope } from './types.ts'

/** Characters of the SHA-256 digest published as a document revision. */
const REVISION_LENGTH = 16

/**
 * Key names whose literal value is treated as a credential. The document is the
 * only place such a value exists, so the host shows the key and withholds the
 * value; a save keeps whatever the document declares for it.
 */
const SECRET_KEY_PATTERN =
  /(?:^|[^a-z0-9])(?:password|passwd|secret|token|credential|credentials|apikey|api[_-]?key|private[_-]?key|access[_-]?key|auth)/i

/**
 * Keys the editor presents, whatever the transport.
 */
const COMMON_KEYS = ['type', 'transport', 'enabled', 'disabled', 'connectTimeoutMs'] as const

/** Keys that belong to one transport alone; the other section is not modelled. */
const SECTION_KEYS: Record<'stdio' | 'streamable-http', readonly string[]> = {
  stdio: ['command', 'args', 'cwd', 'env'],
  'streamable-http': ['url', 'headers'],
}

/** Every presented key, whichever transport an entry declares. */
const PRESENTED_KEYS = new Set([...COMMON_KEYS, ...SECTION_KEYS.stdio, ...SECTION_KEYS['streamable-http']])

/**
 * Opaque content revision of one document.
 *
 * A save carries the revision the editor was built from, so a document changed
 * underneath the form is refused instead of merged. The value is a prefix of a
 * SHA-256 digest: stable for identical bytes, different for any change, and
 * carrying nothing about the content.
 * @param text - exact document bytes as read from disk.
 * @returns a short hexadecimal digest of the content.
 */
export function documentRevision(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, REVISION_LENGTH)
}

/** How one declaring document may be written, and why not when it may not. */
export interface WriteScopeInfo {
  /** Tier of the declaring document. */
  readonly scope: WriteScope
  /** One line saying why a write is unavailable, when one is. */
  readonly reason?: string
  /**
   * Stable wire code of `reason` (`projectMcp.host` namespace), for
   * client-side translation; the prose `reason` keeps its byte-identical
   * English and stays the fallback.
   */
  readonly blockedCode?: string
  /** Flat params of {@link blockedCode}. */
  readonly blockedParams?: Record<string, string>
}

/**
 * Which tier one declaring document belongs to.
 *
 * The two lists are the deployment's own: `projectDocuments` — the project
 * documents it reads (`localFiles`) — are always writable, and `globalDocuments`
 * — the ones its `globalFiles` names — are writable only with an explicit
 * per-write consent and a deployment that enables `allowGlobalWrite`. Anything
 * else (a profile document, a bundled one, an in-memory pseudo-path) is never
 * written.
 * @param document - absolute path of the declaring document.
 * @param projectRoot - project root the row belongs to.
 * @param options - the deployment's document lists and the `allowGlobalWrite` switch.
 * @returns the tier plus the blocking sentence, when there is one.
 */
export function writeScopeFor(
  document: string,
  projectRoot: string,
  options: {
    projectDocuments?: readonly string[]
    globalDocuments?: readonly string[]
    allowGlobalWrite?: boolean
  } = {},
): WriteScopeInfo {
  const target = resolve(document)
  const projectDocuments = (options.projectDocuments ?? DEFAULT_LOCAL_FILES).map((path) =>
    resolve(projectRoot, path),
  )
  if (projectDocuments.includes(target)) return { scope: 'project' }
  const globalDocuments = (options.globalDocuments ?? []).map((path) => resolve(path))
  if (!globalDocuments.includes(target)) {
    const writable = [...projectDocuments, ...globalDocuments]
    // The prose is the fallback and never changes by a character; the code
    // and its flat params are the additive companions the client translates
    // (`projectMcp.host` namespace).
    const notConfigured = writable.length === 0
    return {
      scope: 'readonly',
      reason: notConfigured
        ? `${document} is not a document this deployment reads, and it configures none to write`
        : `${document} is not one of this deployment's MCP documents; only ${writable.join(', ')} can be written`,
      blockedCode: notConfigured ? 'write.blocked.notConfigured' : 'write.blocked.notWritable',
      blockedParams: notConfigured ? { document } : { document, writable: writable.join(', ') },
    }
  }
  if (options.allowGlobalWrite === true) return { scope: 'global' }
  return {
    scope: 'global',
    reason: `writing the global tier is disabled by this deployment (allowGlobalWrite: false); ${document} stays read-only here`,
    blockedCode: 'write.blocked.globalDisabled',
    blockedParams: { document },
  }
}

/** Raw `env`/`headers` keys whose declared value is answered outside the document. */
export interface CredentialKeys {
  /** Keys of the entry's `env` object. */
  readonly env?: ReadonlySet<string>
  /** Keys of the entry's `headers` object. */
  readonly headers?: ReadonlySet<string>
}

/** Mutable local view of {@link EntrySnapshot}, so the builder can assign fields. */
interface MutableEntry {
  transport: 'stdio' | 'streamable-http'
  command?: string
  args?: string[]
  cwd?: string
  env?: EntryField[]
  url?: string
  headers?: EntryField[]
  enabled?: boolean
  connectTimeoutMs?: number
  extra?: Record<string, unknown>
}

/**
 * Parse one declared entry into the body the editor is given.
 *
 * Every field is what the document declares: a resolved default (the project
 * root folded into `cwd`, for example) is never copied in, because a save
 * replaces the declaration, not the runtime config. A `env`/`headers` value is
 * handed over only when the document really holds it as a literal and the key
 * is not credential-shaped — otherwise the key is published with `masked` (and
 * `fromCredentials` when the project `.env` or the credentials file answered it)
 * and the value stays on the host.
 * @param declared - raw `mcpServers[<server>]` value as parsed from the document.
 * @param transport - transport of the parsed config, which decides the shape used.
 * @param credentials - key names per section that are answered outside the document.
 * @returns the entry body for the snapshot.
 */
export function buildEntrySnapshot(
  declared: unknown,
  transport: 'stdio' | 'streamable-http',
  credentials: CredentialKeys = {},
): EntrySnapshot {
  const record = isRecord(declared) ? declared : {}
  const snapshot: MutableEntry = { transport }
  if (transport === 'stdio') {
    if (typeof record.command === 'string') snapshot.command = record.command
    const args = record.args
    if (Array.isArray(args) && args.every((item) => typeof item === 'string')) {
      snapshot.args = [...(args as string[])]
    }
    if (typeof record.cwd === 'string') snapshot.cwd = record.cwd
    const env = entryFields(record.env, credentials.env)
    if (env !== undefined) snapshot.env = env
  } else {
    if (typeof record.url === 'string') snapshot.url = visibleUrl(record.url)
    const headers = entryFields(record.headers, credentials.headers)
    if (headers !== undefined) snapshot.headers = headers
  }
  if (record.enabled === false || record.disabled === true) snapshot.enabled = false
  if (typeof record.connectTimeoutMs === 'number') {
    snapshot.connectTimeoutMs = record.connectTimeoutMs
  }
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    // A key of the other transport is neither shown nor carried in `extra`:
    // {@link entryToDeclaration} keeps it from the declaration itself, so a
    // value the editor never saw cannot travel through the payload.
    if (PRESENTED_KEYS.has(key)) continue
    extra[key] = value
  }
  if (Object.keys(extra).length > 0) snapshot.extra = extra
  return snapshot
}

/**
 * Build the JSON object a save writes for one server.
 *
 * The declaration starts from the raw document entry, so keys the editor never
 * showed survive verbatim — including the other transport's section, which the
 * editor of the declared transport does not model and a switch drops on
 * purpose. `type`/`transport` keeps its declared spelling while the transport is
 * unchanged. `env`/`headers` follow the contract's three-way rule per key: a
 * masked key submitted without a `value` keeps the declared one, a key with a
 * `value` writes that value, and a declared key the submission omits is removed.
 * A key marked `fromCredentials` never writes the submitted value: the declared
 * text (usually a `${input:NAME}` reference) stays exactly as it is, so a
 * resolved secret can never reach the document.
 * @param entry - the entry body the panel submitted.
 * @param declared - raw `mcpServers[<server>]` value as parsed from the document.
 * @returns the declaration object to write in its place.
 */
export function entryToDeclaration(entry: EntrySnapshot, declared: unknown): Record<string, unknown> {
  const base: Record<string, unknown> = isRecord(declared) ? { ...declared } : {}
  const declaredUrl = typeof base.url === 'string' ? base.url : undefined
  const declaredEnv = stringRecord(base.env) ?? {}
  const declaredHeaders = stringRecord(base.headers) ?? {}
  const declaredTypeKey =
    typeof base.type === 'string' ? 'type' : typeof base.transport === 'string' ? 'transport' : undefined
  const declaredTypeValue = declaredTypeKey === undefined ? undefined : base[declaredTypeKey]
  const declaredType = declaredTransport(base)
  const sameTransport = declaredType === entry.transport

  for (const key of COMMON_KEYS) delete base[key]
  for (const key of SECTION_KEYS[entry.transport]) delete base[key]
  // A switched transport drops the other transport's keys with it; an unchanged
  // one keeps them, because the editor of this transport never modelled them.
  if (!sameTransport) {
    for (const key of [...SECTION_KEYS.stdio, ...SECTION_KEYS['streamable-http']]) delete base[key]
  }

  if (entry.extra !== undefined) {
    for (const [key, value] of Object.entries(entry.extra)) {
      if (PRESENTED_KEYS.has(key)) continue
      base[key] = value
    }
  }
  // `type`/`transport` is a presented key, but its declared spelling is kept
  // while the transport is unchanged (`sse`, for example, would otherwise be
  // rewritten as `streamable-http`).
  if (declaredTypeKey !== undefined && sameTransport) base[declaredTypeKey] = declaredTypeValue

  if (entry.transport === 'stdio') {
    if (entry.command !== undefined) base.command = entry.command
    if (entry.args !== undefined) base.args = [...entry.args]
    if (entry.cwd !== undefined) base.cwd = entry.cwd
    if (entry.env !== undefined) base.env = fieldsToRecord(entry.env, declaredEnv)
  } else {
    if (entry.url !== undefined) base.url = urlToWrite(entry.url, declaredUrl)
    if (entry.headers !== undefined) base.headers = fieldsToRecord(entry.headers, declaredHeaders)
  }
  if (entry.enabled === false) base.enabled = false
  if (entry.connectTimeoutMs !== undefined) base.connectTimeoutMs = entry.connectTimeoutMs
  return base
}

/**
 * A refusal {@link applyEntry} throws: the English message, byte-identical to
 * what the site threw before codes existed, plus the `projectMcp.host` wire
 * code and its flat params beside it (F-48). The save path catches it and
 * reuses the companions as its own `messageCode`/`messageParams`, so the
 * client translates the refusal instead of wrapping raw English.
 */
export class WriteDocError extends Error {
  constructor(
    message: string,
    /** The dotted wire code, into the client's `projectMcp.host` namespace. */
    readonly code: string,
    /** Flat params of the code, when it has any. */
    readonly params?: Record<string, string>,
  ) {
    super(message)
    this.name = 'WriteDocError'
  }
}

/**
 * Replace one entry in a document's text.
 *
 * Only `mcpServers[server]` changes: the rest of the server map and every other
 * key of the document are serialized back as they were, with two-space
 * indentation and a trailing newline.
 * @param documentText - current document bytes.
 * @param server - key inside `mcpServers` to replace.
 * @param declaration - object to write in its place.
 * @returns the full new document text.
 * @throws {@link WriteDocError} when the text is not valid JSON or holds no
 *   `mcpServers` object.
 */
export function applyEntry(
  documentText: string,
  server: string,
  declaration: Record<string, unknown>,
): string {
  let root: unknown
  try {
    root = JSON.parse(documentText) as unknown
  } catch (error) {
    throw new WriteDocError(`the document is not valid JSON: ${errorText(error)}`, 'write.doc.invalidJson', {
      error: errorText(error),
    })
  }
  if (!isRecord(root)) throw new WriteDocError('the document is not a JSON object', 'write.doc.notObject')
  const servers = root.mcpServers
  if (!isRecord(servers)) throw new WriteDocError('the document has no "mcpServers" object', 'write.doc.noMcpServers')
  const next = { ...servers, [server]: declaration }
  return `${JSON.stringify({ ...root, mcpServers: next }, null, 2)}\n`
}

/**
 * Write one document so that a failure at any step leaves it exactly as it was.
 *
 * Order: a `<document>.bak` copy of the current bytes first, then the new text
 * into a temporary file in the same directory, then a `rename` over the
 * document. The `rename` is the only operation that touches the original path,
 * so a failure while copying or while writing the temporary file cannot leave
 * half a document behind; a failed write drops the temporary file and rethrows.
 * @param document - absolute path of the document to replace.
 * @param text - the full new content.
 * @throws when the backup, the temporary write or the rename fails.
 */
export function writeDocument(document: string, text: string): void {
  copyFileSync(document, `${document}.bak`)
  const temporary = join(dirname(document), `.${basename(document)}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, text, 'utf8')
    renameSync(temporary, document)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temporary file was never created, or is already gone.
    }
    throw error
  }
}

/**
 * URL as the editor sees it: a query string or fragment can carry a credential
 * (`?token=…`), so it is dropped from the panel. A save that leaves the visible
 * URL untouched keeps the declared one, query included.
 * @param url - declared or submitted endpoint.
 * @returns the endpoint without its query string or fragment.
 */
export function visibleUrl(url: string): string {
  const index = url.search(/[?#]/)
  return index === -1 ? url : url.slice(0, index)
}

/** The URL a declaration writes: keep the declared query when unchanged. */
function urlToWrite(submitted: string, declaredUrl: string | undefined): string {
  if (declaredUrl !== undefined && visibleUrl(declaredUrl) === submitted) return declaredUrl
  return submitted
}

/** The three-way rule of one `env`/`headers` section, applied to one record. */
function fieldsToRecord(
  fields: readonly EntryField[],
  declared: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const field of fields) {
    const declaredValue = declared[field.key]
    if (field.fromCredentials === true) {
      // Never write an externally answered value: the declared text stays.
      if (declaredValue !== undefined) result[field.key] = declaredValue
      continue
    }
    if (field.value !== undefined) {
      result[field.key] = field.value
      continue
    }
    // No value at all: a masked key keeps what the document declares, so an
    // editor that cannot see a secret can never erase or replace it. A shape
    // with neither `value` nor `masked` has nothing to contribute either, and
    // is kept for the same reason — removal is expressed by omitting the key.
    if (declaredValue !== undefined) result[field.key] = declaredValue
  }
  return result
}

/** One `env`/`headers` section as entry fields, values masked where needed. */
function entryFields(
  record: unknown,
  credentials: ReadonlySet<string> | undefined,
): EntryField[] | undefined {
  if (!isRecord(record)) return undefined
  const fields: EntryField[] = []
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'string') return undefined
    if (credentials?.has(key) === true) {
      fields.push({ key, masked: true, fromCredentials: true })
      continue
    }
    // A `${...}` reference is resolved on the host and is not a literal the
    // document holds, so its value is withheld as well.
    if (SECRET_KEY_PATTERN.test(key) || hasReference(value)) {
      fields.push({ key, masked: true })
      continue
    }
    fields.push({ key, value })
  }
  return fields
}

/**
 * Transport a declaration names, normalized the way `parse.ts` reads it: an
 * explicit `type`/`transport` wins, otherwise the presence of `url` decides.
 */
function declaredTransport(record: Record<string, unknown>): 'stdio' | 'streamable-http' {
  const raw = record.type ?? record.transport
  if (typeof raw === 'string') {
    const normalized = raw.toLowerCase()
    if (normalized === 'stdio') return 'stdio'
    if (normalized === 'http' || normalized === 'streamable-http' || normalized === 'sse') {
      return 'streamable-http'
    }
  }
  return record.url !== undefined ? 'streamable-http' : 'stdio'
}

/** Flat string map, or `undefined` when the value is not one. */
function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return undefined
    result[key] = item
  }
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
