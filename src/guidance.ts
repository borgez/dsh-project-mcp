/**
 * Project-level MCP guidance for the session system prompt.
 *
 * A project can mount a large MCP surface, and with activation on (see
 * `./activation.ts`) most of its tools are not listed in a request at all: they
 * are offered on demand through `mcp_search_tools`. The per-server
 * `mcp:<server>` sections mcp-client publishes say what a server *is*, but
 * nothing tells the model that a tool it cannot see may still be asked for.
 *
 * This module contributes that one short section. {@link buildGuidance} is
 * pure: it turns a plain input object into markdown — or `''` when there is
 * nothing worth saying — with a hard length cap, a deterministic server order
 * and a deterministic truncated tool sample. {@link installGuidance} is the
 * thin scope wiring the runtime installs beside its mount and activation
 * wiring: it registers the section through `ctx.inject(['systemPrompt'], …)`
 * with a stable name whose code-unit order places it ahead of every per-server
 * block, and reads the project's live state at each assembly, so a rescan that
 * changes the mounted set changes the text without re-registering anything.
 *
 * The text never carries an absolute path, an endpoint or any other local
 * machine identifier: the project is named by its `~`-collapsed label
 * ({@link projectLabel}) and the input holds server names, states and tool
 * names only.
 *
 * Like `./activation.ts`, the module describes the prompt surface structurally
 * instead of importing `@deepseek-ai/dsh-system-prompt`: that peer is not
 * installed in every deployment, so the section and the injected scope are
 * declared by the minimal types below.
 *
 * @module dsh-project-mcp/guidance
 */

import { DEFAULT_ACTIVATION_ENABLED, SEARCH_TOOL_NAME } from './activation.ts'
import type { ServerStatus } from './types.ts'

/** `true` unless a deployment turns the guidance section off. */
export const DEFAULT_GUIDANCE_ENABLED = true

/**
 * Section name. At equal orders sections sort by code-unit name, and `-`
 * (0x2D) precedes `:` (0x3A), so this name — exactly like mcp-resources'
 * `mcp-resource-servers` — sorts ahead of every `mcp:<server>` instruction
 * block mcp-client publishes at the same order.
 */
export const GUIDANCE_SECTION_NAME = 'mcp-project-guidance'

/** Hard cap on the section text; {@link buildGuidance} never returns more. */
export const MAX_GUIDANCE_CHARS = 1200

/** Server bullets rendered at most, before the rest is summarized. */
export const MAX_GUIDANCE_SERVERS = 8

/** Tool names sampled in one server bullet before `+N more`. */
export const MAX_GUIDANCE_TOOLS = 4

/** Longest purpose text kept in one server bullet. */
export const MAX_GUIDANCE_PURPOSE = 80

/** One mounted server, as far as the guidance section describes it. */
export interface GuidanceServer {
  /** `serverName` of the mount. */
  readonly name: string
  /** Transport, when the mount has one. */
  readonly transport?: 'stdio' | 'streamable-http'
  /** Live mount state. */
  readonly status: ServerStatus
  /** Tool names the server currently publishes, in any order. */
  readonly tools?: readonly string[]
  /** Optional one-line purpose, shown after the server name. */
  readonly purpose?: string
}

/**
 * Plain input of {@link buildGuidance}. Every field is optional so a caller
 * that predates this feature (or a test) can pass a bare object; the defaults
 * describe "no project, no servers".
 */
export interface GuidanceInput {
  /** `~`-collapsed project label; defaults to `this project`. */
  readonly project?: string
  /** Mounted servers, in any order. */
  readonly servers?: readonly GuidanceServer[]
  /** Tool names offered directly in the request right now. */
  readonly offered?: readonly string[]
  /** Tool names reachable only through `mcp_search_tools` right now. */
  readonly deferred?: readonly string[]
  /** Whether the on-demand search surface is on; defaults to the activation default. */
  readonly activationEnabled?: boolean
}

/**
 * Build the project-MCP guidance section.
 *
 * Deterministic and total: server bullets follow code-unit name order, tool
 * samples are sorted and take only names that are actually deferred, and the
 * result never exceeds {@link MAX_GUIDANCE_CHARS} — when it would, trailing
 * server bullets are replaced by an `and N more server(s)` line, the on-demand
 * paragraph is reserved its room first, and a final cut falls back to the last
 * complete line. Equal input always yields equal output, and `''` means there
 * is nothing worth saying.
 *
 * @param input - project label, mounted servers and the offered/deferred split.
 * @returns markdown for one prompt section, or `''`.
 */
export function buildGuidance(input: GuidanceInput): string {
  const servers = normalizeServers(input.servers ?? [])
  if (servers.length === 0) return ''
  const activationEnabled = input.activationEnabled ?? DEFAULT_ACTIVATION_ENABLED
  const offered = new Set(input.offered ?? [])
  // A tool that is already offered is never presented as on-demand, and with
  // activation off nothing is on demand at all.
  const deferred = new Set(
    activationEnabled ? (input.deferred ?? []).filter((name) => !offered.has(name)) : [],
  )
  const header = [
    '## Project MCP servers',
    '',
    `Project \`${label(input.project)}\` mounts ${servers.length} MCP server(s) in this session.`,
    '',
  ]
  const tail =
    deferred.size === 0
      ? []
      : ['', onDemandParagraph(offered.size, deferred.size)]
  const bullets: string[] = []
  let hidden = 0
  for (const [index, server] of servers.entries()) {
    const remaining = servers.length - index
    const bullet = serverBullet(server, deferred)
    const overflow = remaining > 1 ? [`- … and ${remaining - 1} more server(s)`] : []
    const candidate = [...header, ...bullets, bullet, ...overflow, ...tail].join('\n')
    if (index >= MAX_GUIDANCE_SERVERS || candidate.length > MAX_GUIDANCE_CHARS) {
      hidden = remaining
      break
    }
    bullets.push(bullet)
  }
  if (hidden > 0) bullets.push(`- … and ${hidden} more server(s)`)
  return applyCap([...header, ...bullets, ...tail].join('\n'))
}

/**
 * `~`-collapsed display label for a project root.
 *
 * The session prompt must never carry an absolute path or a local machine
 * identifier, so the label is the home-relative form when the root lives under
 * `home` and the directory name otherwise. `home` is passed in rather than read
 * from the environment, which keeps the helper pure and testable.
 *
 * @param projectRoot - absolute project root, or any path-shaped string.
 * @param home - home directory to collapse to `~`, when known.
 * @returns a relative `~/…` label, the directory name, or `this project`.
 */
export function projectLabel(projectRoot: string, home?: string): string {
  const root = stripSeparators(projectRoot)
  if (root === '') return 'this project'
  if (home !== undefined) {
    const base = stripSeparators(home)
    if (base !== '') {
      if (root === base) return '~'
      if (root.startsWith(`${base}/`) || root.startsWith(`${base}\\`)) {
        return `~${root.slice(base.length)}`
      }
    }
  }
  const index = Math.max(root.lastIndexOf('/'), root.lastIndexOf('\\'))
  return index === -1 ? root : root.slice(index + 1)
}

/** The prompt-section fields this module registers (structural view). */
export interface GuidanceSectionLike {
  /** Unique section name. */
  readonly name: string
  /** Numeric sort order. */
  readonly order: number
  /** `false` preserves literal text; this section carries no variables. */
  readonly interpolate?: boolean
  /** Text, or a provider evaluated at each assembly. */
  readonly text: string | (() => string)
}

/** The `systemPrompt` slice the wiring reads (structural view). */
export interface GuidancePromptLike {
  /**
   * Register one ordered section in the calling scope.
   * @param section - the section to register.
   * @returns the registration's effect disposer.
   */
  section(section: GuidanceSectionLike): unknown
  /**
   * Resolve a centrally owned placement.
   * @param name - stable placement name.
   * @returns the numeric sort order.
   */
  getSectionOrder(name: 'MCP_SERVERS'): number
}

/** The injected scope carrying `systemPrompt`. */
export interface GuidancePromptScopeLike {
  /** The prompt registry. */
  readonly systemPrompt: GuidancePromptLike
}

/**
 * The agent-scoped context slice the guidance wiring touches. Described
 * structurally so the wiring is testable without a live harness.
 */
export interface GuidanceContextLike {
  /**
   * Start a callback once the injected services exist; the injected scope owns
   * what the callback registers.
   * @param deps - service names the callback requires.
   * @param callback - receives the injected scope.
   * @returns a disposer for the callback's own fiber, when the runtime gives one.
   */
  inject(deps: readonly string[], callback: (inner: GuidancePromptScopeLike) => unknown): unknown
}

/** Wiring options for {@link installGuidance}. */
export interface GuidanceWiringOptions {
  /** Agent-scoped context; the section lives here. */
  readonly ctx: GuidanceContextLike
  /** Live section text; called at every assembly, so it may read changing state. */
  readonly text: () => string
  /** Section name override; defaults to {@link GUIDANCE_SECTION_NAME}. */
  readonly name?: string
  /** Sink for a contained failure of this plugin's own work. */
  readonly onError?: (error: unknown) => void
}

/**
 * Register the guidance section on one agent scope.
 *
 * The section goes in through `ctx.inject(['systemPrompt'], …)`, so the scope
 * fiber owns it and a scope disposal unregisters it with the real registry.
 * The returned disposer is the explicit path for a host that publishes a plain
 * `systemPrompt` stub — the runtime keeps it and releases it exactly when it
 * releases the scope (idle release and agent disposal), so no section outlives
 * its mounts. It is idempotent.
 *
 * @param options - scope, live text provider and an optional failure sink.
 * @returns the disposer that unregisters everything installed here.
 */
export function installGuidance(options: GuidanceWiringOptions): () => void {
  const disposers: (() => void)[] = []
  const contain = (error: unknown): void => {
    options.onError?.(error)
  }
  try {
    const registered = options.ctx.inject(['systemPrompt'], (inner) => {
      const dispose = inner.systemPrompt.section({
        name: options.name ?? GUIDANCE_SECTION_NAME,
        order: inner.systemPrompt.getSectionOrder('MCP_SERVERS'),
        interpolate: false,
        text: options.text,
      })
      const release = disposerOf(dispose)
      if (release !== undefined) disposers.push(release)
      return dispose
    })
    const release = disposerOf(registered)
    if (release !== undefined) disposers.push(release)
  } catch (error) {
    contain(error)
  }
  return () => {
    // Newest first: the section registration is released before the injected
    // fiber that owns it. `splice` makes a second call a no-op.
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch (error) {
        contain(error)
      }
    }
  }
}

/** Dedupe by name, drop blank names and put the rest in code-unit name order. */
function normalizeServers(servers: readonly GuidanceServer[]): GuidanceServer[] {
  const byName = new Map<string, GuidanceServer>()
  for (const server of servers) {
    const name = server.name.trim()
    if (name === '' || byName.has(name)) continue
    byName.set(name, { ...server, name })
  }
  return [...byName.values()].sort((left, right) => compareNames(left.name, right.name))
}

/** One server bullet: state, optional purpose, and the deferred tool sample. */
function serverBullet(server: GuidanceServer, deferred: ReadonlySet<string>): string {
  const state =
    server.transport === undefined ? server.status : `${server.transport}, ${server.status}`
  const purpose = shorten(server.purpose, MAX_GUIDANCE_PURPOSE)
  const sample = toolSample(server.tools ?? [], deferred)
  return `- ${server.name} (${state})${purpose === '' ? '' : ` — ${purpose}`}${
    sample === '' ? '' : `: ${sample}`
  }`
}

/**
 * The deterministic tool sample of one server: only names that are actually
 * deferred, sorted, truncated to {@link MAX_GUIDANCE_TOOLS} with a `+N more`.
 */
function toolSample(tools: readonly string[], deferred: ReadonlySet<string>): string {
  const names = [...new Set(tools)].filter((name) => deferred.has(name)).sort(compareNames)
  if (names.length === 0) return ''
  const shown = names.slice(0, MAX_GUIDANCE_TOOLS)
  const hidden = names.length - shown.length
  return hidden === 0 ? shown.join(', ') : `${shown.join(', ')} +${hidden} more`
}

/** The paragraph that turns "a tool is missing" into "ask for it". */
function onDemandParagraph(offered: number, deferred: number): string {
  return (
    `${offered} of ${offered + deferred} MCP tool(s) are offered directly; the other ${deferred} ` +
    `are offered on demand — call \`${SEARCH_TOOL_NAME}\` with a short description of what you ` +
    'need, and a tool it activates becomes callable from the next step.'
  )
}

/** Project label, or a neutral fallback for a blank/missing one. */
function label(project: string | undefined): string {
  const value = project?.trim() ?? ''
  return value === '' ? 'this project' : value
}

/** Trim a purpose and bound it, so one server cannot crowd the section. */
function shorten(text: string | undefined, max: number): string {
  const value = text?.trim() ?? ''
  if (value.length <= max) return value
  return `${value.slice(0, max - 1).replace(/\s+$/, '')}…`
}

/** Final guard: cut at the last complete line and add an ellipsis. */
function applyCap(text: string): string {
  if (text.length <= MAX_GUIDANCE_CHARS) return text
  const head = text.slice(0, MAX_GUIDANCE_CHARS - 1)
  const cut = head.lastIndexOf('\n')
  const body = (cut === -1 ? head : head.slice(0, cut)).replace(/\s+$/, '')
  return `${body}…`
}

/** Remove trailing path separators; a bare root collapses to an empty string. */
function stripSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '')
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Read a disposer from either a function or an object with `dispose()`. */
function disposerOf(value: unknown): (() => void) | undefined {
  if (typeof value === 'function') return value as () => void
  if (typeof value === 'object' && value !== null) {
    const target = value as { dispose?: unknown }
    if (typeof target.dispose === 'function') {
      const dispose = target.dispose as () => void
      return () => {
        dispose.call(target)
      }
    }
  }
  return undefined
}
