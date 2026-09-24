/**
 * The host's own usage counters, read where a surface shows them.
 *
 * Nothing here is measured, sampled or invented: `ProjectSnapshot.usage`
 * (`src/types.ts:425`) is published by the host half from the tool registry's
 * own events, keyed by server name, and these two readings are the whole of it
 * — how often a tool was called, and how long a server has not been used. A
 * surface that has no record draws no text (the plugin's "no data, no label"
 * rule), which is why both functions answer `undefined` rather than `0` when
 * the host said nothing: an invented zero reads as a fact the host never
 * published.
 *
 * Pure and React-free, so the sidebar tab, the settings page and the pin picker
 * share one reading of the same numbers.
 *
 * @module dsh-project-mcp/client/usage-view
 */

import type { ServerUsage } from '../types.ts'

/**
 * The prefix the registry publishes project MCP tools under.
 *
 * Five characters, underscores included: a name is `mcp__<server>__<tool>`, so
 * the server starts after the prefix, not after `mcp`. The vocabulary lives here
 * rather than in `view.ts` because this module reads the same names and must not
 * import the panel back — a cycle between the panel and its counter reader would
 * make the counter's own module graph depend on the surface that draws it.
 * `view.ts` re-exports both names, so every existing caller keeps its import.
 */
export const MCP_TOOL_PREFIX = 'mcp__'

/** The `__` that closes the server segment of a registry name, and opens the tool's. */
const SEPARATOR = '__'

/**
 * The server part of a registry tool name.
 * @param name - a public registry name, e.g. `mcp__tglider__workspace`.
 * @returns the server name, or undefined when the name is not an MCP one.
 */
export function serverOfToolName(name: string): string | undefined {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return undefined
  const separator = name.indexOf(SEPARATOR, MCP_TOOL_PREFIX.length)
  return separator === -1 ? undefined : name.slice(MCP_TOOL_PREFIX.length, separator)
}

/** One project's counters, as the host published them; `undefined` — the host said nothing. */
export type ProjectUsage = Record<string, ServerUsage> | undefined

/**
 * How often one tool was called, by its public registry name.
 *
 * The name is `mcp__<server>__<tool>` (see `serverOfToolName`), and the counter
 * is keyed by the tool name as the server declared it — everything after the
 * second separator, which is why the split is not `name.split('__')`.
 * @param name - a public registry name, e.g. `mcp__tglider__workspace`.
 * @param usage - the project's counters, when the host published any.
 * @returns the call count, or undefined when the host recorded nothing for it.
 */
export function callsOfToolName(name: string, usage: ProjectUsage): number | undefined {
  const split = splitToolName(name)
  if (split === undefined) return undefined
  return usage?.[split.server]?.tools[split.tool]
}

/**
 * Both readings one tool row may print: the project's counter and this session's.
 *
 * A server is mounted for a project and shared by its sessions, so the two
 * numbers answer different questions and differ exactly when another session of
 * the project called the tool (F-34). `recorded` is the host's mere existence of
 * a record for the name's server, which is what separates "never called" from
 * "not counted at all".
 */
export interface ToolCalls {
  /** `true` when the host published a record for this name's server. */
  recorded: boolean
  /**
   * `true` when the host published this session's own slice of that record.
   *
   * It is the difference between "the host does not split by session yet" and
   * "this session is counted and has never called this tool" — two states whose
   * `session` reading is both `undefined`, and which a row must not print the
   * same way.
   */
  split: boolean
  /** Calls the project counted for this tool, when it counted any. */
  project: number | undefined
  /** Calls this session counted for this tool, when it counted any. */
  session: number | undefined
}

/**
 * Read both counters of one tool, by its public registry name.
 * @param name - a public registry name, e.g. `mcp__tglider__workspace`.
 * @param usage - the project's counters, when the host published any.
 * @param sessionId - the session to read the split for; absent reads the project only.
 * @returns the two readings, and whether the host recorded the server at all.
 */
export function toolCalls(
  name: string,
  usage: ProjectUsage,
  sessionId: string | undefined,
): ToolCalls {
  const split = splitToolName(name)
  const record = split === undefined ? undefined : usage?.[split.server]
  if (split === undefined || record === undefined) {
    return { recorded: false, split: false, project: undefined, session: undefined }
  }
  const own = sessionId === undefined ? undefined : record.sessions?.[sessionId]
  return {
    recorded: true,
    split: own !== undefined,
    project: record.tools[split.tool],
    session: own?.tools[split.tool],
  }
}

/** The server and the declared tool name inside one public registry name. */
function splitToolName(name: string): { server: string; tool: string } | undefined {
  const server = serverOfToolName(name)
  if (server === undefined) return undefined
  // Past `mcp__<server>__`: the tool name as the server declared it, separator
  // included, because a declared name may hold one of its own.
  return { server, tool: name.slice(MCP_TOOL_PREFIX.length + server.length + SEPARATOR.length) }
}

/** How long a server has been unused, in the one unit its row prints. */
export interface IdleSpan {
  /** The largest whole unit the span holds. */
  unit: 'day' | 'hour' | 'minute'
  /** How many of that unit, floored. */
  count: number
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * The span since a server was last used, in its largest whole unit.
 *
 * `≥ 24 h → days`, `≥ 1 h → hours`, otherwise whole minutes (`0` is a real
 * answer: the call just landed). A date the parser does not accept, a missing
 * one, and one in the future are all "nothing to print" — the last one because
 * a host clock ahead of this viewer's is not a negative idle span.
 * @param lastUsedAt - ISO timestamp of the server's most recent call.
 * @param now - epoch milliseconds to measure against.
 * @returns the span, or undefined when there is no usable date.
 */
export function idleOf(lastUsedAt: string | undefined, now: number): IdleSpan | undefined {
  if (lastUsedAt === undefined) return undefined
  const at = Date.parse(lastUsedAt)
  if (!Number.isFinite(at)) return undefined
  const elapsed = now - at
  if (elapsed < 0) return undefined
  if (elapsed >= DAY_MS) return { unit: 'day', count: Math.floor(elapsed / DAY_MS) }
  if (elapsed >= HOUR_MS) return { unit: 'hour', count: Math.floor(elapsed / HOUR_MS) }
  return { unit: 'minute', count: Math.floor(elapsed / MINUTE_MS) }
}

/**
 * The order a list of tool names is drawn in: the most-called first.
 *
 * Sorting follows the figure the row leads with — this session's counter when
 * the host published the split, the project's otherwise — so the list is ordered
 * by the number a reader can see. That cuts both ways: a tool other sessions
 * called 290 times and this one never called leads with `never called`, so it
 * sinks below a tool this session really used, even though the project figure
 * printed beside it is larger. The host's counter is the only frequency there
 * is; a name with no reading of its own is "not measured", not "zero", and it
 * neither outranks a measured name nor loses the order it arrived in (the sort
 * is stable and this comparator returns `0` for a tie), so a list the host
 * already ordered is never reshuffled for no reason.
 * @param usage - the project's counters, as the host published them.
 * @param sessionId - the session whose split leads the ordering; absent reads the project.
 * @returns comparator for `Array.prototype.sort`.
 */
export function byCalls(
  usage: ProjectUsage,
  sessionId?: string,
): (left: string, right: string) => number {
  const count = (name: string): number => {
    const calls = toolCalls(name, usage, sessionId)
    // The lead figure, and only it: a name the session is in the split without
    // is unmeasured, however loud the project total beside it is.
    return (calls.split ? calls.session : calls.project) ?? -1
  }
  return (left, right) => count(right) - count(left)
}
