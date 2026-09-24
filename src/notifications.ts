/**
 * The plugin's event service: one publication point, and its consumers.
 *
 * A lifecycle fact used to be written three times by the runtime — a line in the
 * DSH log, the same fact into the ring (`src/logs.ts`), and the snapshot
 * announcement the panel watches. Three writes that had to agree. Here they are
 * one: the runtime publishes a {@link PluginEvent} through {@link emitEvent}, and
 * every reader is a subscriber —
 *
 * 1. the ring, subscribed here against {@link module:dsh-project-mcp/logs}
 *    `record`, so the tab and the log are fed by one publication;
 * 2. the DSH log, subscribed by the runtime's own
 *    {@link module:dsh-project-mcp/runtime} wiring through {@link logConsumer},
 *    because only the runtime holds the host `ctx`;
 * 3. anything else a test or a later surface attaches through
 *    {@link subscribeEvent}.
 *
 * Publication is synchronous and total: listeners run in subscription order, a
 * listener that throws is swallowed rather than failing the pass that reported
 * the event, and {@link emitEvent} never throws into its caller. The clock
 * belongs to the caller ({@link PluginEvent.at}), as it does in the ring, so a
 * test can pin an event to a moment.
 *
 * @module dsh-project-mcp/notifications
 */

import { record } from './logs.ts'
import type { LogLevel } from './types.ts'

/**
 * One lifecycle event, as every consumer reads it.
 *
 * The same fields the ring keeps, because the ring is a subscriber — the tab
 * draws exactly the event this service published. The one field with two
 * readers is {@link PluginEvent.level}: the ring colours the row with it, and
 * the DSH log writes the line through the matching level method.
 */
export interface PluginEvent {
  /** When the event happened, epoch ms. */
  readonly at: number
  /** How serious it is, as the Logs tab colours it. */
  readonly level: LogLevel
  /** Project root the event belongs to; the ring is keyed by it. */
  readonly projectRoot: string
  /**
   * Session the event is attributed to. Set exactly when the lifecycle line it
   * mirrors names one — `mounting`, `is up`, a stall — and absent on a
   * project-level event such as a shared instance's unmount.
   */
  readonly sessionId?: string
  /** `serverName` the event is about; absent for an event with no server. */
  readonly server?: string
  /** One line, without the `project-mcp:` prefix the log line carries. */
  readonly message: string
  /** The three facts an error carries — the failure, the endpoint, the document. */
  readonly detail?: string
  /**
   * Wire code of {@link PluginEvent.message} (F-48), into the client's
   * `projectMcp.host` namespace. The prose fields stay byte-identical English
   * and remain the fallback: a consumer that never resolves codes — the DSH
   * log is one — reads exactly what it read before the code existed.
   */
  readonly code?: string
  /**
   * Flat params of {@link PluginEvent.code}; numbers stringify at emission. A
   * param whose name ends in `Code` (`reasonCode`, `sharingCode`) is itself a
   * wire code the client resolves two-level, substituting it under the plain
   * name.
   */
  readonly params?: Record<string, string>
  /** Wire code of {@link PluginEvent.detail}, the same additive companion. */
  readonly detailCode?: string
  /** Flat params of {@link PluginEvent.detailCode}. */
  readonly detailParams?: Record<string, string>
  /**
   * The DSH log line, when it says more than {@link PluginEvent.message}.
   *
   * `message` is what the tab lists one row per event; the line is what an
   * operator reads in the host log, and for two events it names what the row's
   * own columns already carry — the declaring path and the endpoint of a failed
   * mount, the server and the root of a release. The runtime passes the very
   * text the line had before the event existed, so the log is unchanged; absent
   * means `message` is the line.
   */
  readonly line?: string
  /**
   * Severity the DSH log writes this event under, when it differs from
   * {@link PluginEvent.level}.
   *
   * The tab's level is about the row — a release is a warning there, a failed
   * mount is an error — while the host log keeps the level the line always had
   * (`info` for the whole lifecycle except a failure or a stall, which are
   * `warn`). Two readers, two vocabularies: without this field, wiring the log
   * through the event would silently promote `unmounting` to `warn` and
   * `mount failed` to `error` in the operator's log. Absent means the host log
   * follows {@link PluginEvent.level}.
   */
  readonly logLevel?: LogLevel
}

/** One subscriber, told the whole event at publication time. */
export type PluginEventListener = (event: PluginEvent) => void

/**
 * The one level method this module calls on a host logger.
 *
 * Structural on purpose: the runtime's `ctx.logger` satisfies it, and so does a
 * test double with no error method.
 */
export type LoggerMethod = (format: unknown, ...parameters: unknown[]) => void

/**
 * The host logger as this module needs it: the level methods, and nothing else.
 *
 * Deliberately not `LoggerService` — the service has a call signature and a
 * `debug` method this module never uses, so declaring only the three makes a
 * partial double (`{ warn }`) a valid logger.
 */
export interface PluginLoggerLike {
  error?: LoggerMethod
  info?: LoggerMethod
  warn?: LoggerMethod
}

/** Listeners in subscription order; publication walks a copy of it. */
const listeners = new Set<PluginEventListener>()

/**
 * Publish one plugin event to every subscriber, and swallow what they raise.
 *
 * Called from the runtime points that used to write the DSH log and the ring by
 * hand, and the only publication point there is. Listeners run synchronously in
 * subscription order — so a consumer registered first sees the event first —
 * over a snapshot of the set, which keeps a listener that unsubscribes itself
 * (or subscribes another) during the walk from corrupting it.
 * @param event - the event to publish.
 */
export function emitEvent(event: PluginEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event)
    } catch {
      // A consumer's failure is not the reporting pass's failure: the ring
      // already promises the same, and one broken reader must not cost the
      // others the event.
    }
  }
}

/**
 * Subscribe a consumer.
 *
 * The ring is one such consumer, installed here for the life of the module; a
 * host logger and a test are others. Subscribing the same listener twice keeps
 * the one entry it already has, so a wrapper re-registered around the same touch
 * does not make the event arrive twice, and unsubscribing is idempotent:
 * {@link PluginEventListener} is unique in the set, and removing what is absent
 * is a no-op.
 * @param listener - told every event published from now on.
 * @returns the disposer that stops it; safe to call more than once.
 */
export function subscribeEvent(listener: PluginEventListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Whether a listener is subscribed right now.
 *
 * A diagnostic for the subscription itself: the disposer returns nothing, so
 * this is how a caller — a test proving that a disposer detached its listener,
 * or memory after a re-mount — reads the fact without counting a publication.
 * @param listener - the listener to look up.
 * @returns `true` while it is subscribed.
 */
export function isSubscribed(listener: PluginEventListener): boolean {
  return listeners.has(listener)
}

/**
 * The DSH log as a consumer: one line per event, under the plugin's own prefix
 * and level.
 *
 * Returns the listener rather than attaching anything itself: the logger lives
 * on the host context, which only the runtime holds, so the runtime owns the
 * subscription (and drops it when it is disposed). The line is `project-mcp: `
 * plus {@link logText}, so the text a reader has seen does not change; the level
 * method is {@link PluginEvent.logLevel} when the event names one, because that
 * is the level the line has always had, and the tab's own level otherwise — and
 * a partial logger gets the nearest method it has ({@link levelMethod}).
 * @param logger - host logger whose level methods carry the line.
 * @returns the listener to subscribe; detach it with the disposer
 * {@link subscribeEvent} returned.
 */
export function logConsumer(logger: PluginLoggerLike): PluginEventListener {
  return (event) => {
    const method = levelMethod(logger, event.logLevel ?? event.level)
    if (method === undefined) return
    method(`project-mcp: ${logText(event)}`)
  }
}

/**
 * The one line the DSH log writes for an event.
 *
 * An event that named the line it replaces carries it ({@link PluginEvent.line}),
 * so the log is byte-for-byte what it was. The rest compose it: where the
 * lifecycle line named the server in front of the message, the event carries the
 * name as its own field, because the tab draws it as a column and does not repeat
 * it in the message — `mounting`, `is up` and `unmounting` put the name back in
 * here. The stall and the failure already open their message with the name (it is
 * the first line of the row's detail).
 * @param event - the event to render.
 * @returns the line, without the `project-mcp: ` prefix.
 */
function logText(event: PluginEvent): string {
  if (event.line !== undefined) return event.line
  const server = event.server
  if (server !== undefined) {
    if (event.message.startsWith('mounting ')) return `${server}: ${event.message}`
    if (event.message.startsWith('is up — ')) return `${server} ${event.message}`
    if (event.message.startsWith('unmounting — ')) {
      return `unmounting ${server} in ${event.projectRoot} — ${event.message.slice('unmounting — '.length)}`
    }
  }
  return event.message
}

/**
 * The logger method one level writes through; `up` is an info-level success.
 *
 * A partial logger falls back to the levels it does have — `error`, then `warn`,
 * then `info` — rather than losing the line: the harnesses that publish only
 * `warn` are the reason, and a deployment's logger has all three.
 */
function levelMethod(logger: PluginLoggerLike, level: LogLevel): LoggerMethod | undefined {
  if (level === 'warn') return logger.warn ?? logger.info
  if (level === 'error') return logger.error ?? logger.warn ?? logger.info
  return logger.info
}

/**
 * The ring as a consumer, installed once for the module.
 *
 * Subscribed here rather than called by the runtime so the runtime has exactly
 * one write path: it publishes, and the tab and the DSH log both read that one
 * publication. {@link record} stays the ring's only writer, and stays total —
 * it is written to be called from an event the pass must not fail over.
 */
subscribeEvent((event) => {
  record(event)
})
