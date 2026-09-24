/**
 * The plugin's own event ring, and its only owner.
 *
 * The Logs tab of the sidebar panel answers "what happened to this project's
 * servers" from the plugin's own lifecycle events — mounting, `is up`, stall,
 * unmount, failure — and from nothing else. The DSH log is deliberately not a
 * source: no foreign line can be attributed to one project, and attribution is
 * exactly what the tab promises (contract C1, decision 2 of the review).
 *
 * The ring is per project root and bounded by {@link LOG_RING_LIMIT}, the oldest
 * event evicted first. It is written from the single runtime point that already
 * writes the matching lifecycle line to the DSH log, so both readers see the
 * same facts and there is no second write path to keep in sync. The newest
 * {@link LOG_PAGE_SIZE} events travel inside the snapshot the tab is drawn from;
 * {@link page} is what "show older" asks for the rest.
 *
 * Nothing here touches the disk, and the clock belongs to the caller. A module
 * map rather than runtime state on purpose: the route handler ({@link module:dsh-project-mcp/ui})
 * answers `GET logs` without a runtime, and the panel and the runtime must read
 * one buffer. {@link record} never throws — a ring write must not fail the pass
 * that reported the event.
 *
 * @module dsh-project-mcp/logs
 */

import type { LogEvent } from './types.ts'

/** Events one project's ring holds; the oldest is evicted past it. */
export const LOG_RING_LIMIT = 200

/** Events one page carries: the snapshot's tail, and {@link page}'s default window. */
export const LOG_PAGE_SIZE = 50

/**
 * One ring per project root, oldest event first.
 *
 * Kept per root because two projects of one host are two histories; the history
 * lives exactly as long as the process, since the panel's `Clear` is client-side
 * and there is no `Clear` route (contract C1).
 */
const rings = new Map<string, LogEvent[]>()

/**
 * Add one event to its project's ring.
 *
 * Called from the runtime points that write the lifecycle line to the DSH log,
 * in addition to it. An event identical to one already held is dropped, so a
 * repeated pass can never make the tab show the same line twice. Total: a
 * malformed event or a ring bug is swallowed rather than thrown into the pass
 * that reported it.
 * @param event - the event to record; `message` is folded onto one line.
 */
export function record(event: LogEvent): void {
  try {
    if (typeof event.projectRoot !== 'string' || event.projectRoot === '') return
    const ring = ringOf(event.projectRoot)
    if (ring.some((existing) => sameEvent(existing, event))) return
    ring.push({ ...event, message: oneLine(event.message) })
    if (ring.length > LOG_RING_LIMIT) ring.splice(0, ring.length - LOG_RING_LIMIT)
  } catch {
    // Nothing a ring write can raise is worth failing the pass for.
  }
}

/**
 * The newest events of one project, oldest first.
 *
 * This is what a snapshot carries, and it hands out a copy: a reader that kept
 * the array could otherwise watch it change under a later pass.
 * @param projectRoot - project whose ring is read.
 * @param limit - how many of the newest events to return; clamped to
 * `1…{@link LOG_RING_LIMIT}`, {@link LOG_PAGE_SIZE} when omitted.
 * @returns the events, oldest first; empty for a project with no history.
 */
export function latest(projectRoot: string, limit: number = LOG_PAGE_SIZE): LogEvent[] {
  const ring = rings.get(projectRoot)
  if (ring === undefined) return []
  const size = clampLimit(limit)
  return ring.slice(Math.max(0, ring.length - size))
}

/**
 * One page of a project's history, for "show older".
 *
 * Without `before` the page is the newest `limit` events — the same window a
 * snapshot carries, which is what the tab asks for on a refresh. With `before`
 * it is the newest `limit` events strictly older than that instant: the cursor
 * is the `at` of the oldest event already on screen, so consecutive pages do
 * not overlap.
 * @param input - the project to read, and the optional window.
 * @param input.projectRoot - project whose ring is read.
 * @param input.before - exclusive cursor in epoch ms; `at < before` only.
 * @param input.limit - page size; clamped to `1…{@link LOG_RING_LIMIT}`,
 * {@link LOG_PAGE_SIZE} when omitted.
 * @returns the page, the ring's total size, and whether older events remain
 * beyond the page — `more` is true when the window had to cut the history short.
 */
export function page(input: { projectRoot: string; before?: number; limit?: number }): {
  events: LogEvent[]
  total: number
  more: boolean
} {
  const ring = rings.get(input.projectRoot) ?? []
  const older = input.before === undefined ? ring : ring.filter((event) => event.at < (input.before as number))
  const events = older.slice(Math.max(0, older.length - clampLimit(input.limit)))
  return { events, total: ring.length, more: older.length > events.length }
}

/**
 * How many events one project's ring holds right now.
 * @param projectRoot - project whose ring is read.
 * @returns the count, `0` for a project with no history.
 */
export function countOf(projectRoot: string): number {
  return rings.get(projectRoot)?.length ?? 0
}

/**
 * How many events of one project's ring belong to one session.
 *
 * Events the lifecycle line itself attributes to a session — `mounting`, `is up`,
 * a stall — are counted here; a project-level event (a shared instance's unmount)
 * carries no session and is counted by no session.
 * @param projectRoot - project whose ring is read.
 * @param sessionId - agent (session) id to count.
 * @returns the count, `0` for a session that produced nothing.
 */
export function countForSession(projectRoot: string, sessionId: string): number {
  return (rings.get(projectRoot) ?? []).filter((event) => event.sessionId === sessionId).length
}

/**
 * Drop one project's history, or every project's, for tests.
 *
 * Not a route: the panel's `Clear` is client-side (contract C1), so nothing in
 * the product calls this — a test that asserts on a ring starts from no history.
 * @param projectRoot - project to forget; omitted forgets every project.
 */
export function clear(projectRoot?: string): void {
  if (projectRoot === undefined) rings.clear()
  else rings.delete(projectRoot)
}

/** The ring of one root, created empty on first use. */
function ringOf(projectRoot: string): LogEvent[] {
  const existing = rings.get(projectRoot)
  if (existing !== undefined) return existing
  const ring: LogEvent[] = []
  rings.set(projectRoot, ring)
  return ring
}

/**
 * Whether two events are the same event, field by field. The project is the ring
 * they share, so it is the one field not compared here.
 */
function sameEvent(left: LogEvent, right: LogEvent): boolean {
  return (
    left.at === right.at &&
    left.level === right.level &&
    left.sessionId === right.sessionId &&
    left.server === right.server &&
    left.message === right.message &&
    left.detail === right.detail
  )
}

/**
 * Fold a message onto one line, as {@link LogEvent.message} promises: the tab
 * renders a row per event, and a newline inside one would break the column.
 */
function oneLine(message: string): string {
  return message.replace(/\s*\n\s*/g, ' ').trim()
}

/**
 * A page size clamped to what the ring can serve: a caller cannot ask for more
 * than {@link LOG_RING_LIMIT} events, and a zero or a negative size is raised to
 * the one event every page is at least worth.
 */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return LOG_PAGE_SIZE
  return Math.min(LOG_RING_LIMIT, Math.max(1, Math.trunc(limit)))
}
