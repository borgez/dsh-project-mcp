/**
 * `dsh-project-mcp`, frame-wide toasts: one banner per MCP server that comes
 * up, fails, or is released — announced wherever the user is, rather than only
 * inside the sidebar tab's «Logs» mode.
 *
 * The seat is `shell.overlay` (`kind: 'list'`, `scope: 'root'`), DSH's
 * frame-wide floating layer: additive, owned by no feature, and click-through
 * until an entry opts into pointer events. Its catalog names a toast stack as
 * one of the things that belong there, so this module adds an entry **beside**
 * the shipped ones and declares no slot of its own. The composer dock that
 * F-05 removed is not coming back: nothing here paints into a surface this
 * plugin does not own.
 *
 * The source is the host's status channel, `GET /project-mcp/events` (see
 * `createEventStream` in `src/ui.ts`), the same stream the sidebar panel falls
 * back from polling to. A toast is not a second source of truth: every frame
 * carries the whole snapshot, and this module only diffs the picture it already
 * had for {@link ServerRow.status} transitions, so a missed frame costs one
 * banner rather than a wrong one.
 *
 * What a toast cannot say: a **stall** is not a lifecycle transition in the
 * snapshot — the row stays `connecting` and only its `detail` wording changes —
 * so stalls stay in the «Logs» tab and in the DSH log instead of becoming
 * banners.
 *
 * A draft carries dictionary keys and parameters, never a finished sentence:
 * the stack resolves them at render through the tab's translate seat
 * (`useTabTranslate`), so a language switch repaints the banners already on
 * screen instead of freezing the language of whatever the store holds (F-47).
 *
 * @module dsh-project-mcp/client/toasts
 */

import { createElement as h, useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { ROUTE_ACTIONS, ROUTE_PREFIX } from '../shared.ts'
import type { McpSnapshot, ServerRow, SnapshotChange } from '../types.ts'
import type { UiKey } from './locales/ui.ts'
import { hostTranslate, resolveHost } from './locales/host.ts'
import { useTabTranslate } from './tab-locale.ts'
import type { TabLocale } from './tab-locale.ts'
import { STATUS_COLOR, STATUS_HINT, basename, translateOf } from './view.ts'
import type { Translate } from './view.ts'

/** Slot the stack registers into: DSH's frame-wide floating layer. */
export const TOASTS_SLOT = 'shell.overlay'

/** Registration id, unique among the layer's entries, and the cell it owns. */
export const TOASTS_ID = 'dsh-project-mcp:toasts'

/** Position among the layer's entries, ascending. */
export const TOASTS_ORDER = 60

/** Full-opacity hold before a banner starts to fade, matching DSH's own toast. */
export const TOAST_HOLD_MS = 3_000

/** Fade duration, matching the `transition` the banner carries. */
export const TOAST_FADE_MS = 1_000

/**
 * Banners kept on screen at once.
 *
 * A pass can start every server of a project in one go, and a stack taller than
 * the window is a stack nobody reads: the newest {@link MAX_TOASTS} are kept
 * and older ones drop, the same way a notification centre ages out its tail.
 */
export const MAX_TOASTS = 3

/** Which lifecycle moment a banner reports. */
export type ToastLevel =
  /** The server reached `active`: mounted, its tools are visible. */
  | 'up'
  /** The server landed in `error`: the entry or its mount failed. */
  | 'error'
  /** An active server went back to `idle`: its mounts were dropped. */
  | 'released'

/** One banner before the store stamps it with an identity. */
export interface ToastDraft {
  readonly level: ToastLevel
  /** `serverName` the transition belongs to. */
  readonly server: string
  /** Basename of the project root, so a banner fits on one line. */
  readonly project: string
  /**
   * Dictionary key of the one line — what happened to the server — resolved
   * through the seat at render, so a stored banner follows a language switch.
   */
  readonly textKey: UiKey
  /** Parameters of that line (`{server}`). */
  readonly textParams?: Record<string, unknown> | undefined
  /**
   * Dictionary key of the fact the quieter line explains — a status hint —
   * with the project woven around it (`toastDetail`). Absent, the quieter line
   * is just {@link ToastDraft.detail}, a language-neutral string.
   */
  readonly detailKey?: UiKey | undefined
  /**
   * The host's own fact sentence, shown instead of the keyed hint when the row
   * carries one; when {@link ToastDraft.detailKey} is absent, the whole
   * quieter line (the project basename).
   */
  readonly detail?: string | undefined
  /**
   * Wire companions of {@link ToastDraft.detail} (F-48): the row's
   * `detailCode`/`detailParams`, carried through so the quieter line resolves
   * through the host namespace at render and falls back to the prose when the
   * code is absent or unknown.
   */
  readonly detailCode?: string | undefined
  /** Flat params of {@link ToastDraft.detailCode}. */
  readonly detailParams?: Record<string, string> | undefined
}

/** One banner on screen. */
export interface Toast extends ToastDraft {
  /** Identity the store mints; also the React key and the dismiss handle. */
  readonly id: number
}

/**
 * The stack's own state.
 *
 * A plain observable rather than React state, because the writer is the status
 * channel and the reader is the slot entry: they are not in one component tree,
 * and only the store has to survive the slot re-registering.
 */
export interface ToastStore {
  /** Current banners, newest first. */
  getSnapshot(): readonly Toast[]
  /** Listen for changes; returns the unsubscribe. */
  subscribe(listener: () => void): () => void
  /** Add one banner, dropping the tail beyond the limit. */
  push(draft: ToastDraft): void
  /** Retire one banner; an unknown id is a no-op. */
  dismiss(id: number): void
}

/**
 * Build one stack's store.
 * @param limit - banners kept at once; defaults to {@link MAX_TOASTS}.
 * @returns the store the entry renders from.
 */
export function createToastStore(limit: number = MAX_TOASTS): ToastStore {
  let toasts: readonly Toast[] = []
  let minted = 0
  const listeners = new Set<() => void>()
  /** Publish one new array: the snapshot identity is what React compares. */
  const publish = (next: readonly Toast[]): void => {
    toasts = next
    for (const listener of [...listeners]) listener()
  }
  return {
    getSnapshot: () => toasts,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    push(draft) {
      minted += 1
      publish([{ ...draft, id: minted }, ...toasts].slice(0, Math.max(0, limit)))
    },
    dismiss(id) {
      const next = toasts.filter((toast) => toast.id !== id)
      if (next.length !== toasts.length) publish(next)
    },
  }
}

/** Identity of one row across frames: a server name is unique per project. */
function keyOf(row: ServerRow): string {
  return `${row.projectRoot}\u0000${row.name}`
}

/**
 * Every row of one picture, keyed by project and server.
 * @param snapshot - a picture.
 * @returns the keyed rows.
 */
function rowsOf(snapshot: McpSnapshot): Map<string, ServerRow> {
  const rows = new Map<string, ServerRow>()
  for (const project of snapshot.projects) {
    for (const row of project.rows) rows.set(keyOf(row), row)
  }
  return rows
}

/** The banner one row's new state earns, when it earns one. */
function transitionToast(was: ServerRow | undefined, row: ServerRow): ToastDraft | undefined {
  const project = basename(row.projectRoot)
  if (row.status === 'active') {
    return {
      level: 'up',
      server: row.name,
      project,
      textKey: 'toastUp',
      textParams: { server: row.name },
      detail: project,
    }
  }
  if (row.status === 'error') {
    return {
      level: 'error',
      server: row.name,
      project,
      textKey: 'toastFailed',
      textParams: { server: row.name },
      detailKey: STATUS_HINT.error,
      detail: row.detail,
      ...(row.detailCode === undefined ? {} : { detailCode: row.detailCode }),
      ...(row.detailParams === undefined ? {} : { detailParams: row.detailParams }),
    }
  }
  // Only an active server *loses* mounts; `idle` reached from `connecting` or
  // `disabled` is a picture of a server that never came up, not a release.
  if (row.status === 'idle' && was?.status === 'active') {
    return {
      level: 'released',
      server: row.name,
      project,
      textKey: 'toastReleased',
      textParams: { server: row.name },
      detailKey: STATUS_HINT.idle,
    }
  }
  return undefined
}

/**
 * The banners two consecutive pictures earn.
 *
 * Read from status alone, and only when the status actually changed: a rescan
 * that re-derives the same rows announces nothing, and a row that moves between
 * two non-terminal states (`idle → connecting` on the next turn's lazy mount)
 * is not a lifecycle moment worth a banner.
 * @param previous - the picture already applied; `undefined` makes `next` the baseline.
 * @param next - the picture a `change` frame just delivered.
 * @returns banners, oldest transition first; empty for a baseline or a quiet frame.
 */
export function serverTransitions(previous: McpSnapshot | undefined, next: McpSnapshot): ToastDraft[] {
  if (previous === undefined) return []
  const before = rowsOf(previous)
  const drafts: ToastDraft[] = []
  for (const [key, row] of rowsOf(next)) {
    const was = before.get(key)
    if (was?.status === row.status) continue
    const draft = transitionToast(was, row)
    if (draft !== undefined) drafts.push(draft)
  }
  return drafts
}

/**
 * Read one frame's payload.
 *
 * A frame this plugin cannot read is dropped, not guessed at: the stream is
 * whole-picture, so the next frame is a complete answer, and a half-parsed
 * snapshot would produce phantom transitions.
 * @param data - `MessageEvent.data` of a `hello`/`change` frame.
 * @returns the change, or `undefined` when the payload is not one.
 */
export function parseChange(data: unknown): SnapshotChange | undefined {
  if (typeof data !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const { revision, snapshot } = parsed as { revision?: unknown; snapshot?: unknown }
  if (typeof revision !== 'number') return undefined
  if (snapshot === null || typeof snapshot !== 'object') return undefined
  if (!Array.isArray((snapshot as { projects?: unknown }).projects)) return undefined
  return { revision, snapshot: snapshot as McpSnapshot }
}

/** The part of `EventSource` this module uses, so a test can hand it a stand-in. */
export interface FollowSource {
  addEventListener(type: string, listener: (event: Event) => void): void
  close(): void
}

/**
 * How the channel is opened.
 *
 * A seam for tests: the channel is the one thing in this module that talks to
 * the browser, so a test hands it a stand-in rather than patching a global, and
 * the default is the only place that reaches for `EventSource`.
 */
export type OpenSource = (url: string) => FollowSource | undefined

/** Open the status channel, or nothing in an environment without `EventSource`. */
function defaultOpen(url: string): FollowSource | undefined {
  return typeof EventSource === 'undefined' ? undefined : new EventSource(url)
}

/**
 * Follow the host's status channel and raise one banner per transition.
 *
 * The stream carries two frame kinds: `hello` is the picture as it is — on
 * open and on every reconnect the browser's `EventSource` performs — and
 * `change` is one announced change. `hello` only resets the baseline, so a page
 * load, a dropped connection and a late join never read as twenty servers
 * starting at once. A frame whose revision is not newer than the last applied
 * one is repeated or replayed, and is ignored for the same reason.
 * @param store - the stack to push banners into.
 * @param open - channel factory; defaults to a real `EventSource`.
 * @returns the disposer that closes the channel.
 */
export function followServers(store: ToastStore, open: OpenSource = defaultOpen): () => void {
  const source = open(`${ROUTE_PREFIX}/${ROUTE_ACTIONS.events}`)
  if (source === undefined) return () => undefined
  let previous: McpSnapshot | undefined
  let revision = Number.NEGATIVE_INFINITY
  /** Apply one frame's picture; `raise` is false for the baseline `hello`. */
  const apply = (event: Event, raise: boolean): void => {
    const change = parseChange((event as MessageEvent).data)
    if (change === undefined || change.revision <= revision) return
    if (raise) {
      for (const draft of serverTransitions(previous, change.snapshot)) store.push(draft)
    }
    previous = change.snapshot
    revision = change.revision
  }
  source.addEventListener('hello', (event) => apply(event, false))
  source.addEventListener('change', (event) => apply(event, true))
  return () => source.close()
}

/** The slot service, as this registrant uses it; mirrored structurally, not imported. */
export interface ToastSlots {
  inject(slot: string, callback: () => unknown): unknown
  register<Props>(
    options: { name: string; id: string; order: number },
    component: (props: Props) => ReactNode,
  ): () => void
}

/**
 * The one client service the stack needs.
 *
 * It is optional in a composition — a shell without the floating layer simply
 * has no banners — which is why registration goes through `ctx.inject` rather
 * than a module-level `inject` list: a composition without `slots` must keep
 * the sidebar tab and the settings page, and must not leave this entry pending.
 * The locale service is the tab's own seat: with it, a language switch repaints
 * the banners on screen; without it, the stack renders its English fallback.
 */
export interface ToastsServices {
  slots: ToastSlots
  /** The shell's locale service, when the composition has one. */
  locale?: TabLocale | undefined
}

/**
 * Contribute the stack to the frame's floating layer.
 *
 * `slots.register` throws on a duplicate list id, so the entry and the channel
 * are installed behind one disposer and that disposer is returned to
 * `slots.inject`: a second run — the layer's declaration collapsing and coming
 * back, or an HMR reload — tears the first activation down before the second
 * registers, instead of throwing away the whole entry or following the channel
 * twice.
 * @param services - the injected `slots` service, and the locale seat.
 */
export function registerToasts(services: ToastsServices): void {
  const store = createToastStore()
  /** The live activation, so a repeat of the injection can never leave two. */
  let stop: (() => void) | undefined
  services.slots.inject(TOASTS_SLOT, () => {
    stop?.()
    const entry = services.slots.register({ name: TOASTS_SLOT, id: TOASTS_ID, order: TOASTS_ORDER }, () =>
      h(ToastStack, { store, locale: services.locale }),
    )
    const channel = followServers(store)
    stop = () => {
      channel()
      entry()
      stop = undefined
    }
    return stop
  })
}

/** The tones a banner's dot takes, from the panel's own status palette. */
const LEVEL_COLOR: Record<ToastLevel, string> = {
  up: STATUS_COLOR.active,
  error: STATUS_COLOR.error,
  released: STATUS_COLOR.idle,
}

/**
 * The stack's own styles.
 *
 * The banner mirrors DSH's shipped `Toast` (`ui-primitives`): the same alias
 * variables, radius, padding and type, so a banner reads as a shell surface
 * rather than a plugin's own invention. The difference is placement — that
 * toast portals to the body and centers itself on the viewport, while this one
 * is an entry of the floating layer, which spans the frame and already sits
 * above every column.
 */
const STYLE = {
  stack: {
    position: 'absolute',
    top: 12,
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    // Same bound as one banner: the frame's center is where a long failure
    // sentence would otherwise size itself against half the window.
    maxWidth: 'min(640px, calc(100vw - 48px))',
    // Announcements never intercept clicks: the layer is click-through until an
    // entry opts in, and this entry opts back out for its whole subtree.
    pointerEvents: 'none',
  } satisfies CSSProperties,
  banner: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: 'max-content',
    maxWidth: 'min(640px, calc(100vw - 48px))',
    padding: '12px 16px',
    borderRadius: 14,
    background: 'var(--dsw-alias-button-contrast-fill, rgba(20, 22, 26, 0.92))',
    color: 'var(--dsw-alias-label-primary-inverted, #fff)',
    fontSize: 14,
    lineHeight: '22px',
    boxShadow: 'var(--dsw-shadow-lv3, 0 8px 24px rgba(0, 0, 0, 0.28))',
    transition: `opacity ${TOAST_FADE_MS}ms ease`,
  } satisfies CSSProperties,
  /** The tail of a banner's life: it is already retired, only the fade is left. */
  fading: { opacity: 0 } satisfies CSSProperties,
  dot: {
    flex: 'none',
    width: 8,
    height: 8,
    borderRadius: 999,
  } satisfies CSSProperties,
  body: { minWidth: 0 } satisfies CSSProperties,
  detail: { opacity: 0.75, fontSize: 12, lineHeight: '18px' } satisfies CSSProperties,
} as const

/** Read one banner off the store and follow it while the entry is mounted. */
function useToasts(store: ToastStore): readonly Toast[] {
  const [toasts, setToasts] = useState<readonly Toast[]>(store.getSnapshot())
  useEffect(() => store.subscribe(() => setToasts(store.getSnapshot())), [store])
  return toasts
}

/**
 * The stack the floating layer renders.
 *
 * Nothing is rendered while there is nothing to say, so the layer holds no
 * empty box between banners. The live-region role is on the stack rather than
 * on a banner, because a banner mounts and unmounts on its own timer. The
 * translate seat is bound here: drafts carry keys, and `useTabTranslate`
 * re-reads them when the shell's language changes, so the banners on screen
 * repaint without the store re-deriving anything.
 * @param props.store - the stack's state.
 * @param props.locale - the shell's locale service, when there is one.
 * @returns the banners, newest first, or `null`.
 */
export function ToastStack(props: { store: ToastStore; locale?: TabLocale | undefined }): ReactNode {
  const toasts = useToasts(props.store)
  const t = useTabTranslate(props.locale)
  // The host namespace beside the UI one: a banner whose row carried a coded
  // detail (F-48) resolves it through this seat, and the repaint still rides
  // on `t`'s re-bind.
  const hostT = hostTranslate(props.locale)
  if (toasts.length === 0) return null
  return h(
    'div',
    { style: STYLE.stack, role: 'status', 'aria-live': 'polite' },
    toasts.map((toast) => h(ToastRow, { key: toast.id, toast, store: props.store, t, hostT })),
  )
}

/**
 * The quieter line of one banner, resolved through the seat at render time.
 *
 * A keyed fact is a status hint the project is woven around (`toastDetail`);
 * the host's own detail sentence wins over the hint when the row carries one;
 * a draft with no key at all shows its language-neutral line as it is. A coded
 * detail (F-48) resolves through the host seat first and falls back to its
 * prose when the code is absent or unknown, so an uncoded banner reads exactly
 * as before.
 * @param toast - the banner to read.
 * @param t - the translate seat.
 * @param hostT - the host-namespace seat; the echo seat answers without one.
 * @returns the line, or `undefined` when the banner has none.
 */
function detailLine(toast: ToastDraft, t: Translate, hostT: Translate): string | undefined {
  if (toast.detailKey === undefined) {
    if (toast.detail === undefined && toast.detailCode === undefined) return undefined
    return resolveHost(hostT, toast.detailCode, toast.detailParams, toast.detail)
  }
  const fact =
    toast.detailCode === undefined
      ? toast.detail ?? t(toast.detailKey)
      : resolveHost(hostT, toast.detailCode, toast.detailParams, toast.detail ?? t(toast.detailKey))
  return t('toastDetail', { project: toast.project, detail: fact })
}

/**
 * One banner: full opacity for {@link TOAST_HOLD_MS}, then a fade of
 * {@link TOAST_FADE_MS}, then retired from the store.
 *
 * Two timers rather than one, because the fade is a real transition the user
 * sees; a single timer would drop the banner from full opacity to nothing.
 * @param props.toast - the banner to draw.
 * @param props.store - the stack it belongs to, so it can retire itself.
 * @param props.t - the translate seat the stack bound; the panel's English
 *   fallback answers without one.
 * @returns the banner element.
 */
export function ToastRow(props: {
  toast: Toast
  store: ToastStore
  t?: Translate | undefined
  /** Host-namespace seat for a coded detail (F-48); the echo seat answers without one. */
  hostT?: Translate | undefined
}): ReactNode {
  const [fading, setFading] = useState(false)
  const { store, toast } = props
  const t = translateOf(props.t)
  const detail = detailLine(toast, t, props.hostT ?? hostTranslate(undefined))
  useEffect(() => {
    const hold = setTimeout(() => setFading(true), TOAST_HOLD_MS)
    return () => clearTimeout(hold)
  }, [])
  useEffect(() => {
    if (!fading) return
    const fade = setTimeout(() => store.dismiss(props.toast.id), TOAST_FADE_MS)
    return () => clearTimeout(fade)
  }, [fading, store, props.toast.id])
  return h(
    'div',
    { style: fading ? { ...STYLE.banner, ...STYLE.fading } : STYLE.banner },
    h('span', { style: { ...STYLE.dot, background: LEVEL_COLOR[toast.level] } }),
    h(
      'span',
      { style: STYLE.body },
      h('div', null, t(toast.textKey, toast.textParams)),
      detail === undefined ? null : h('div', { style: STYLE.detail }, detail),
    ),
  )
}
