/**
 * The plugin's event ring: the only owner of the history the Logs tab draws.
 *
 * The tab is fed two ways — the newest page rides in the snapshot, the rest is
 * paged over `GET logs` — so both windows, the eviction that bounds the history
 * and the promise that recording never breaks its caller are pinned here.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  LOG_PAGE_SIZE,
  LOG_RING_LIMIT,
  clear,
  countForSession,
  countOf,
  latest,
  page,
  record,
} from '../src/logs.ts'
import type { LogEvent } from '../src/types.ts'

const ROOT = '/tmp/ring'
const OTHER = '/tmp/other-ring'

function event(at: number, overrides: Partial<LogEvent> = {}): LogEvent {
  return { at, level: 'info', projectRoot: ROOT, message: `event ${at}`, ...overrides }
}

/** `at` values of a page, which is what a window assertion reads. */
function times(events: readonly LogEvent[]): number[] {
  return events.map((entry) => entry.at)
}

describe('the ring', () => {
  beforeEach(() => clear())

  it('keeps the newest events, oldest first, and evicts past the limit', () => {
    for (let at = 1; at <= LOG_RING_LIMIT + 25; at += 1) record(event(at))

    expect(countOf(ROOT)).toBe(LOG_RING_LIMIT)
    const kept = latest(ROOT, LOG_RING_LIMIT)
    expect(times(kept)).toEqual(Array.from({ length: LOG_RING_LIMIT }, (_, index) => index + 26))
  })

  it('hands the newest page by default, and a copy of it', () => {
    for (let at = 1; at <= 120; at += 1) record(event(at))

    const newest = latest(ROOT)
    expect(newest).toHaveLength(LOG_PAGE_SIZE)
    expect(times(newest)).toEqual(Array.from({ length: LOG_PAGE_SIZE }, (_, index) => index + 71))

    // A reader cannot edit the history it was handed.
    newest.push(event(999))
    expect(countOf(ROOT)).toBe(120)
  })

  it('drops an event identical to one already held, field by field', () => {
    const base: LogEvent = {
      at: 5,
      level: 'warn',
      projectRoot: ROOT,
      sessionId: 'session-1',
      server: 'alpha',
      message: 'unmounting — the session went idle',
      detail: 'endpoint: stdio npx',
    }
    record(base)
    record({ ...base })
    expect(countOf(ROOT)).toBe(1)

    // Each field is the difference: the same event for another moment, level,
    // session, server, message or detail is a new event, not a repeat.
    const variants: LogEvent[] = [
      { ...base, at: 6 },
      { ...base, level: 'error' },
      { ...base, sessionId: 'session-2' },
      { ...base, server: 'beta' },
      { ...base, message: 'unmounting — the documents no longer declare it' },
      { ...base, detail: 'endpoint: http://127.0.0.1:1/mcp' },
      { ...base, sessionId: undefined } as unknown as LogEvent,
      { ...base, server: undefined } as unknown as LogEvent,
      { ...base, detail: undefined } as unknown as LogEvent,
    ]
    for (const variant of variants) record(variant)

    expect(countOf(ROOT)).toBe(1 + variants.length)
  })

  it('counts one session separately from the project and from its siblings', () => {
    record(event(1, { sessionId: 'session-1', server: 'alpha' }))
    record(event(2, { sessionId: 'session-1', server: 'beta' }))
    record(event(3, { sessionId: 'session-2', server: 'alpha' }))
    record(event(4, { server: 'alpha' }))

    expect(countForSession(ROOT, 'session-1')).toBe(2)
    expect(countForSession(ROOT, 'session-2')).toBe(1)
    expect(countForSession(ROOT, 'session-3')).toBe(0)
    // A project-level event belongs to no session.
    expect(countOf(ROOT)).toBe(4)
  })

  it('keeps every project its own history', () => {
    record(event(1))
    record(event(2, { projectRoot: OTHER }))

    expect(countOf(ROOT)).toBe(1)
    expect(countOf(OTHER)).toBe(1)
    expect(times(latest(ROOT))).toEqual([1])
    expect(times(latest(OTHER))).toEqual([2])
  })

  it('answers an empty history without inventing one', () => {
    expect(countOf(ROOT)).toBe(0)
    expect(countForSession(ROOT, 'session-1')).toBe(0)
    expect(latest(ROOT)).toEqual([])
    expect(page({ projectRoot: ROOT })).toEqual({ events: [], total: 0, more: false })
  })

  it('folds a message onto one line', () => {
    record(event(1, { message: 'no tool appeared in 4m 27s\nendpoint: stdio npx\n  declared in .dsh/mcp.json' }))

    expect(latest(ROOT)[0]?.message).toBe(
      'no tool appeared in 4m 27s endpoint: stdio npx declared in .dsh/mcp.json',
    )
  })

  it('never throws into the pass that reported the event', () => {
    const malformed = [
      event(1, { projectRoot: undefined } as unknown as Partial<LogEvent>),
      event(2, { projectRoot: '' }),
      event(3, { message: 42 } as unknown as Partial<LogEvent>),
    ]
    for (const broken of malformed) expect(() => record(broken as LogEvent)).not.toThrow()

    // A ring holds only what is a well-formed event for a real project.
    expect(countOf(ROOT)).toBe(0)
  })

  it('forgets one project, or every project', () => {
    record(event(1))
    record(event(2, { projectRoot: OTHER }))

    clear(ROOT)
    expect(countOf(ROOT)).toBe(0)
    expect(countOf(OTHER)).toBe(1)

    clear()
    expect(countOf(OTHER)).toBe(0)
  })
})

describe('page', () => {
  beforeEach(() => clear())

  it('pages the newest window, oldest first, and says more remains', () => {
    for (let at = 1; at <= 120; at += 1) record(event(at))

    const window = page({ projectRoot: ROOT })
    expect(times(window.events)).toEqual(Array.from({ length: LOG_PAGE_SIZE }, (_, index) => index + 71))
    expect(window.total).toBe(120)
    expect(window.more).toBe(true)
  })

  it('reads strictly before the cursor, so consecutive pages do not overlap', () => {
    for (let at = 1; at <= 120; at += 1) record(event(at))

    const window = page({ projectRoot: ROOT, before: 71, limit: 10 })
    expect(times(window.events)).toEqual([61, 62, 63, 64, 65, 66, 67, 68, 69, 70])
    expect(window.more).toBe(true)

    // The oldest page reaches the start of the history: nothing older left.
    const last = page({ projectRoot: ROOT, before: 11, limit: 10 })
    expect(times(last.events)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(last.more).toBe(false)
    expect(last.total).toBe(120)
  })

  it('answers an empty page rather than a failure past the oldest event', () => {
    record(event(7, { level: 'error' }))

    expect(page({ projectRoot: ROOT, before: 7 })).toEqual({ events: [], total: 1, more: false })
    expect(page({ projectRoot: OTHER })).toEqual({ events: [], total: 0, more: false })
  })

  it('clamps the window to what the ring can serve', () => {
    for (let at = 1; at <= 90; at += 1) record(event(at))

    // A size below one is raised to the one event a page is worth...
    expect(times(page({ projectRoot: ROOT, limit: 0 }).events)).toEqual([90])
    expect(times(page({ projectRoot: ROOT, limit: -5 }).events)).toEqual([90])
    // ...a size above the ring is cut to the ring's own bound...
    expect(times(page({ projectRoot: ROOT, limit: LOG_RING_LIMIT * 10 }).events)).toEqual(
      Array.from({ length: 90 }, (_, index) => index + 1),
    )
    // ...and a size that is not a number falls back to the page size.
    expect(page({ projectRoot: ROOT, limit: Number.NaN }).events).toHaveLength(LOG_PAGE_SIZE)
    expect(page({ projectRoot: ROOT, limit: 33.7 }).events).toHaveLength(33)
  })

  it('clamps the window the snapshot asks for the same way', () => {
    for (let at = 1; at <= 60; at += 1) record(event(at))

    expect(latest(ROOT, 0)).toHaveLength(1)
    expect(latest(ROOT, LOG_RING_LIMIT * 10)).toHaveLength(60)
    expect(latest(ROOT, Number.NaN)).toHaveLength(LOG_PAGE_SIZE)
    expect(latest(ROOT, Number.POSITIVE_INFINITY)).toHaveLength(LOG_PAGE_SIZE)
  })

  it('clamps a fractional size down to whole events', () => {
    for (let at = 1; at <= 60; at += 1) record(event(at))

    expect(times(latest(ROOT, 2.9))).toEqual([59, 60])
    expect(times(page({ projectRoot: ROOT, limit: 2.9 }).events)).toEqual([59, 60])
  })
})
