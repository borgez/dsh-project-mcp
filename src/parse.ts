/**
 * MCP document parsing for `dsh-project-mcp`.
 *
 * Reads Kimi Code / Claude-style documents (`{ "mcpServers": { ... } }`) and
 * converts every entry into an `@deepseek-ai/dsh-mcp-client` config. The module
 * is intentionally free of Cordis and of ambient process state: environment,
 * project dotenv values, plugin-level `inputs` and credential values are
 * injected through {@link ResolveContext}, so the whole conversion is
 * unit-testable.
 *
 * Error policy: a broken row never blocks the document. It becomes an entry
 * with `error` set, which the runtime surfaces as an `error` row.
 *
 * @module dsh-project-mcp/parse
 */

import { readFileSync } from 'node:fs'
import type { Config as McpClientConfig } from '@deepseek-ai/dsh-mcp-client'

/**
 * `serverName` accepted by mcp-client; anything else cannot own a tool
 * namespace (`mcp__<serverName>__<rawName>`).
 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Whole-string `${NAME}` / `${input:NAME}` reference. */
const WHOLE_REF_PATTERN = /^\$\{(.+)\}$/

/** Any `${...}` reference inside a longer string. */
const INLINE_REF_PATTERN = /\$\{([^}]+)\}/g

/** The same grammar, read through `matchAll` where every reference is needed. */
const REFERENCE_PATTERN = /\$\{([^}]+)\}/g

/** Prefix selecting the interactive-input namespace of a reference. */
const INPUT_PREFIX = 'input:'

/** Maximum length of a generated `serverName`. */
const MAX_SERVER_NAME_LENGTH = 32

/** Severity of a parse diagnostic. */
export type IssueLevel = 'error' | 'warning'

/** One diagnostic produced while reading a document. */
export interface ParseIssue {
  /** Absolute path of the document (or a pseudo-path for in-memory input). */
  source: string
  /** Server key the diagnostic belongs to, when it is entry-scoped. */
  server?: string
  /** Whether the entry is unusable (`error`) or merely notable (`warning`). */
  level: IssueLevel
  /** Human-readable description. */
  message: string
  /**
   * Stable wire code of `message` (`projectMcp.host` namespace), for
   * client-side translation. Additive: `message` keeps its byte-identical
   * English and stays the fallback, and behavioural matches key on this field
   * — never on the prose, which the client may have translated.
   */
  code?: string
  /** Flat params of {@link ParseIssue.code}, stringified at emission. */
  params?: Record<string, string>
}

/** One parsed `mcpServers` entry: exactly one of `config` / `error` is set. */
export interface ParsedEntry {
  /** Key in `mcpServers` (or the sanitized form of it). */
  name: string
  /** `false` only for an explicit `enabled: false` / `disabled: true`. */
  enabled: boolean
  /** Absolute path of the document the entry came from. */
  source: string
  /** mcp-client config, ready to mount. */
  config?: McpClientConfig
  /** Why the entry cannot be mounted. */
  error?: string
  /**
   * Stable wire code of `error` (`projectMcp.host` namespace) — the path by
   * which a parse failure becomes a translated `row.detail` on the client.
   */
  errorCode?: string
  /** Flat params of {@link ParsedEntry.errorCode}, stringified at emission. */
  errorParams?: Record<string, string>
}

/** External values needed to expand `${...}` references. */
export interface ResolveContext {
  /** Ambient environment (`process.env`). */
  env: Record<string, string | undefined>
  /** Project-local dotenv values (`<project>/.env`, then `<project>/.dsh/.env`). */
  dotenv: Record<string, string>
  /** Plugin-level `inputs` config: explicit `${input:NAME}` values. */
  inputs: Record<string, string>
  /** Values read from the DSH credentials file. */
  secrets: Record<string, string>
  /**
   * Identity of the three value sources above, so a caller that caches whole
   * parsed documents can tell "the same values answered this parse" from "the
   * files moved". Opaque here: the parser never reads it.
   */
  stamp?: string
  /** Project root used as the default `cwd` of stdio servers. */
  projectRoot: string
  /** Timeout applied to every generated config. */
  toolCallTimeoutMs: number
  /** Whether a failed initial connection should reject the mount. */
  failOnStartupError: boolean
}

/** Result of parsing one document. */
export interface ParsedDocument {
  /** Entries in document order. */
  entries: ParsedEntry[]
  /** Diagnostics for the document itself and for individual entries. */
  issues: ParseIssue[]
  /** `false` when the file could not be read or held no server map. */
  ok: boolean
}

type Resolution =
  | { ok: true; value: string }
  | { ok: false; message: string; code: string; params?: Record<string, string> }

/** Expand every `${...}` reference inside `value`. */
export function expandValue(value: string, ctx: ResolveContext): Resolution {
  const whole = WHOLE_REF_PATTERN.exec(value)
  if (whole !== null) return resolveRef(whole[1] as string, ctx)
  let failure: Extract<Resolution, { ok: false }> | undefined
  const replaced = value.replace(INLINE_REF_PATTERN, (match, ref: string) => {
    const resolved = resolveRef(ref, ctx)
    if (resolved.ok) return resolved.value
    failure ??= resolved
    return match
  })
  if (failure !== undefined) return failure
  return { ok: true, value: replaced }
}

/**
 * Whether `value` contains at least one `${...}` reference.
 *
 * A value written as a reference does not live in the declaring document, so
 * an editor is shown the key without it and a save keeps the declared text
 * instead of substituting the resolved value.
 * @param value - declared string value.
 * @returns `true` when the value carries a reference.
 */
export function hasReference(value: string): boolean {
  return /\$\{[^}]+\}/.test(value)
}

/**
 * Whether any `${...}` reference of `value` is answered from outside the
 * process — by the project's `.env` or by the credentials file.
 *
 * Provenance only, mirroring {@link resolveRef}'s own fallback order (plugin
 * inputs, then the project dotenv values, then `process.env`, then credentials):
 * a value whose reference falls through to one of the two external maps is
 * marked `fromCredentials` in a snapshot — the flag the editor reads as "do not
 * write the resolved value back" — and stays as declared.
 * @param value - declared string value.
 * @param ctx - same resolve context the mount path uses.
 * @returns `true` when at least one reference was answered externally.
 */
export function referencesCredentials(value: string, ctx: ResolveContext): boolean {
  for (const match of value.matchAll(REFERENCE_PATTERN)) {
    const ref = match[1]?.trim() ?? ''
    const isInput = ref.startsWith(INPUT_PREFIX)
    const key = (isInput ? ref.slice(INPUT_PREFIX.length) : ref).trim()
    if (key === '') continue
    if (isInput && firstSet(ctx.inputs[key]) !== undefined) continue
    if (firstSet(ctx.dotenv[key]) !== undefined) return true
    if (firstSet(ctx.env[key]) !== undefined) continue
    if (firstSet(ctx.secrets[key]) !== undefined) return true
  }
  return false
}

/**
 * Resolve one `${...}` reference.
 *
 * `${input:NAME}` is answered by the plugin's own `inputs`, then by the same
 * chain a plain `${NAME}` uses, so a project can keep using the prefix its
 * `mcp.json` already carries. The chain is project-local first: the project's
 * dotenv documents, then the ambient environment, then the global credentials
 * file. An empty string counts as unset at every step.
 */
function resolveRef(ref: string, ctx: ResolveContext): Resolution {
  const name = ref.trim()
  if (name.startsWith(INPUT_PREFIX)) {
    const key = name.slice(INPUT_PREFIX.length).trim()
    if (key === '') return { ok: false, message: 'empty ${input:} reference', code: 'parse.ref.empty' }
    const explicit = firstSet(ctx.inputs[key])
    if (explicit !== undefined) return { ok: true, value: explicit }
    const value = projectValue(ctx, key)
    if (value === undefined) {
      return {
        ok: false,
        message: `input "${key}" is not set (looked in plugin inputs, the project .env, the environment, and the credentials file)`,
        code: 'parse.ref.inputUnset',
        params: { key },
      }
    }
    return { ok: true, value }
  }
  const value = projectValue(ctx, name)
  if (value === undefined) {
    return {
      ok: false,
      message: `variable "${name}" is not set (looked in the project .env, the environment, and the credentials file)`,
      code: 'parse.ref.varUnset',
      params: { name },
    }
  }
  return { ok: true, value }
}

/** Project dotenv → ambient environment → credentials, for one key. */
function projectValue(ctx: ResolveContext, key: string): string | undefined {
  return firstSet(ctx.dotenv[key], ctx.env[key], ctx.secrets[key])
}

/** The first non-empty value, or `undefined` when every source was unset. */
function firstSet(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

/** Sanitize an arbitrary `mcpServers` key into a valid `serverName`. */
export function slugifyServerName(name: string): string {
  const slug = name
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.slice(0, MAX_SERVER_NAME_LENGTH)
}

/**
 * Parse the text of one MCP document.
 * @param text - raw file content.
 * @param source - absolute path used for diagnostics and for entry `source`.
 * @param ctx - values used to expand references and to fill config defaults.
 * @returns parsed entries plus diagnostics; `ok` reports whether a server map was found.
 */
export function parseDocument(text: string, source: string, ctx: ResolveContext): ParsedDocument {
  const issues: ParseIssue[] = []
  let data: unknown
  try {
    data = JSON.parse(text) as unknown
  } catch (error) {
    return {
      entries: [],
      issues: [
        {
          source,
          level: 'error',
          message: `invalid JSON: ${errorText(error)}`,
          code: 'parse.json.invalid',
          params: { error: errorText(error) },
        },
      ],
      ok: false,
    }
  }
  const servers = extractServerMap(data)
  if (servers === null) {
    return {
      entries: [],
      issues: [
        {
          source,
          level: 'error',
          message: 'expected an object with an "mcpServers" object',
          code: 'parse.doc.notObject',
        },
      ],
      ok: false,
    }
  }
  const entries: ParsedEntry[] = []
  const seen = new Set<string>()
  for (const [key, raw] of Object.entries(servers)) {
    const name = sanitizeName(key, source, issues)
    if (name === undefined) continue
    if (seen.has(name)) {
      const message = `serverName "${name}" is declared twice in this document`
      const code = 'parse.server.duplicateName'
      const params = { name }
      issues.push({ source, server: name, level: 'error', message, code, params })
      entries.push({ name, enabled: false, source, error: message, errorCode: code, errorParams: params })
      continue
    }
    seen.add(name)
    entries.push(toEntry(name, raw, source, ctx, issues))
  }
  return { entries, issues, ok: true }
}

/** Read and parse one document; a missing file yields `undefined`. */
export function parseDocumentFile(path: string, ctx: ResolveContext): ParsedDocument | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  return parseDocument(text, path, ctx)
}

/**
 * Extract a `name -> entry` map from a document: `mcpServers`, `servers`, or a
 * bare flat map whose values all look like server entries.
 * @param data - parsed document (or any JSON value).
 * @returns the server map, or `null` when the value holds none.
 */
export function extractServerMap(data: unknown): Record<string, unknown> | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const record = data as Record<string, unknown>
  for (const key of ['mcpServers', 'servers'] as const) {
    const container = record[key]
    if (container !== null && typeof container === 'object' && !Array.isArray(container)) {
      return container as Record<string, unknown>
    }
  }
  const values = Object.values(record)
  if (values.length === 0) return null
  const looksFlat = values.every(
    (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  )
  return looksFlat ? record : null
}

/**
 * Bring a `mcpServers` key into the `serverName` alphabet, or reject it when
 * nothing usable remains. A rename is a warning, not an error: the entry stays
 * mountable and only its tool namespace changes.
 */
function sanitizeName(key: string, source: string, issues: ParseIssue[]): string | undefined {
  if (SERVER_NAME_PATTERN.test(key)) return key
  const slug = slugifyServerName(key)
  if (slug === '') {
    issues.push({
      source,
      server: key,
      level: 'error',
      message: `"${key}" cannot be converted into a valid serverName (${String(SERVER_NAME_PATTERN)})`,
      code: 'parse.server.badName',
      params: { key, pattern: String(SERVER_NAME_PATTERN) },
    })
    return undefined
  }
  issues.push({
    source,
    server: slug,
    level: 'warning',
    message: `serverName "${key}" is not a valid mcp-client name; using "${slug}"`,
    code: 'parse.server.renamedName',
    params: { key, slug },
  })
  return slug
}

function toEntry(
  name: string,
  raw: unknown,
  source: string,
  ctx: ResolveContext,
  issues: ParseIssue[],
): ParsedEntry {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail(name, source, issues, 'entry must be an object', 'parse.entry.notObject')
  }
  const record = raw as Record<string, unknown>
  const enabled = record.enabled !== false && record.disabled !== true

  const declared = record.type ?? record.transport
  if (declared !== undefined && typeof declared !== 'string') {
    return fail(name, source, issues, '"type" must be a string', 'parse.entry.badType')
  }
  const normalized = declared === undefined ? undefined : declared.toLowerCase()
  if (
    normalized !== undefined
    && !['stdio', 'http', 'streamable-http', 'sse'].includes(normalized)
  ) {
    return fail(name, source, issues, '"type" must be one of "stdio", "http", "streamable-http" or "sse"', 'parse.entry.typeUnknown')
  }
  const hasUrl = record.url !== undefined
  const useHttp = normalized === undefined ? hasUrl : normalized !== 'stdio'
  return useHttp
    ? buildHttpEntry(name, record, source, ctx, issues, enabled)
    : buildStdioEntry(name, record, source, ctx, issues, enabled)
}

function buildStdioEntry(
  name: string,
  record: Record<string, unknown>,
  source: string,
  ctx: ResolveContext,
  issues: ParseIssue[],
  enabled: boolean,
): ParsedEntry {
  const command = record.command
  if (typeof command !== 'string' || command === '') {
    return fail(name, source, issues, 'stdio servers require a "command"', 'parse.entry.noCommand')
  }
  const args = stringArray(record.args)
  if (args === undefined) return fail(name, source, issues, '"args" must be an array of strings', 'parse.entry.badArgs')
  const env = stringRecord(record.env)
  if (env === undefined) return fail(name, source, issues, '"env" must be an object of strings', 'parse.entry.badEnv')
  if (record.cwd !== undefined && typeof record.cwd !== 'string') {
    return fail(name, source, issues, '"cwd" must be a string', 'parse.entry.badCwd')
  }

  const expandedCommand = expandValue(command, ctx)
  if (!expandedCommand.ok) return fail(name, source, issues, expandedCommand.message, expandedCommand.code, expandedCommand.params)
  const expandedArgs = expandAll(args, ctx)
  if (!expandedArgs.ok) return fail(name, source, issues, expandedArgs.message, expandedArgs.code, expandedArgs.params)
  const expandedEnv = expandRecord(env, ctx)
  if (!expandedEnv.ok) return fail(name, source, issues, expandedEnv.message, expandedEnv.code, expandedEnv.params)
  const expandedCwd = expandValue(
    typeof record.cwd === 'string' && record.cwd !== '' ? record.cwd : ctx.projectRoot,
    ctx,
  )
  if (!expandedCwd.ok) return fail(name, source, issues, expandedCwd.message, expandedCwd.code, expandedCwd.params)

  return {
    name,
    enabled,
    source,
    config: {
      transport: 'stdio',
      serverName: name,
      command: expandedCommand.value,
      args: expandedArgs.value,
      env: expandedEnv.value,
      cwd: expandedCwd.value,
      toolCallTimeoutMs: ctx.toolCallTimeoutMs,
      failOnStartupError: ctx.failOnStartupError,
    },
  }
}

function buildHttpEntry(
  name: string,
  record: Record<string, unknown>,
  source: string,
  ctx: ResolveContext,
  issues: ParseIssue[],
  enabled: boolean,
): ParsedEntry {
  const url = record.url
  if (typeof url !== 'string' || url === '') {
    return fail(name, source, issues, 'http servers require a "url"', 'parse.entry.noUrl')
  }
  const headers = stringRecord(record.headers)
  if (headers === undefined) {
    return fail(name, source, issues, '"headers" must be an object of strings', 'parse.entry.badHeaders')
  }
  const expandedUrl = expandValue(url, ctx)
  if (!expandedUrl.ok) return fail(name, source, issues, expandedUrl.message, expandedUrl.code, expandedUrl.params)
  const expandedHeaders = expandRecord(headers, ctx)
  if (!expandedHeaders.ok) return fail(name, source, issues, expandedHeaders.message, expandedHeaders.code, expandedHeaders.params)
  return {
    name,
    enabled,
    source,
    config: {
      transport: 'streamable-http',
      serverName: name,
      url: expandedUrl.value,
      headers: expandedHeaders.value,
      toolCallTimeoutMs: ctx.toolCallTimeoutMs,
      failOnStartupError: ctx.failOnStartupError,
    },
  }
}

function fail(
  name: string,
  source: string,
  issues: ParseIssue[],
  message: string,
  code: string,
  params?: Record<string, string>,
): ParsedEntry {
  issues.push({
    source,
    server: name,
    level: 'error',
    message,
    code,
    ...(params === undefined ? {} : { params }),
  })
  return {
    name,
    enabled: false,
    source,
    error: message,
    errorCode: code,
    ...(params === undefined ? {} : { errorParams: params }),
  }
}

function expandAll(values: string[], ctx: ResolveContext): { ok: true; value: string[] } | Extract<Resolution, { ok: false }> {
  const result: string[] = []
  for (const value of values) {
    const expanded = expandValue(value, ctx)
    if (!expanded.ok) return expanded
    result.push(expanded.value)
  }
  return { ok: true, value: result }
}

function expandRecord(
  record: Record<string, string>,
  ctx: ResolveContext,
): { ok: true; value: Record<string, string> } | Extract<Resolution, { ok: false }> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    const expanded = expandValue(value, ctx)
    if (!expanded.ok) {
      return {
        ok: false,
        message: `${key}: ${expanded.message}`,
        // `{name}` deliberately carries the inner failure's English prose: the wrapper
        // covers three inner shapes (varUnset / inputUnset / empty ref) whose sentences
        // and params differ and collide with the flat `{key}` grammar, so no single
        // translated template can fill back byte-identically. Accepted partial
        // translation — F-48 ledger Ruling 4; only the wrapper punctuation localizes.
        code: 'parse.ref.failedInKey',
        params: { key, name: expanded.message },
      }
    }
    result[key] = expanded.value
  }
  return { ok: true, value: result }
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return undefined
    result.push(item)
  }
  return result
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== 'string') return undefined
    result[key] = item
  }
  return result
}

/**
 * Merge per-document entry lists in priority order; a later document overrides
 * an earlier entry with the same `serverName`, keeping the position where that
 * name first appeared.
 * @param groups - entry lists from lowest to highest priority.
 * @returns merged entries plus the names that were overridden.
 */
export function mergeEntries(groups: ParsedEntry[][]): { entries: ParsedEntry[]; overridden: string[] } {
  const merged = new Map<string, ParsedEntry>()
  const overridden: string[] = []
  for (const group of groups) {
    for (const entry of group) {
      if (merged.has(entry.name)) overridden.push(entry.name)
      merged.set(entry.name, entry)
    }
  }
  return { entries: [...merged.values()], overridden }
}

/** Parse a YAML-ish credentials file into a flat string map. */
export function parseCredentials(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*?)\s*$/.exec(line)
    if (match === null) continue
    const value = (match[2] as string).replace(/^(['"])(.*)\1$/, '$2')
    if (value === '') continue
    result[match[1] as string] = value
  }
  return result
}

/**
 * Parse a dotenv document into a flat string map.
 *
 * The subset a project needs next to its `mcp.json`: one `KEY=value` per line,
 * an optional `export `, single or double quotes, and `#` comments — on their
 * own line, or after whitespace on a value line. Double quotes understand the
 * usual escapes (`\n`, `\r`, `\t`, `\"`, `\\`); single quotes stay literal. An
 * empty value is skipped, exactly as {@link parseCredentials} skips one, so
 * `${NAME}` sees "unset" either way.
 * @param text - dotenv document contents.
 * @returns the values it declares, in first-wins order of the map.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (match === null) continue
    const key = match[1] as string
    const value = unquoteEnvValue(match[2] as string)
    if (value === '') continue
    result[key] = value
  }
  return result
}

/** One dotenv value: unquoted (with an optional trailing comment), or quoted. */
function unquoteEnvValue(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) return raw.slice(1, -1)
  const comment = raw.indexOf(' #')
  return (comment === -1 ? raw : raw.slice(0, comment)).trim()
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
