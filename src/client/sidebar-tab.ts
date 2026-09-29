/**
 * The plugin's tab in DSH's **own** right sidebar, and the settings it carries.
 *
 * The panel used to be a tab of `dsh-better-sidebar`, a third-party registry
 * that re-exports DSH's right sidebar with its own descriptor API (and with its
 * own builtin tabs, its own `+` menu and its own side card settings). This module
 * speaks to the shipped surface directly, so the plugin depends on nothing
 * outside the harness:
 *
 * - the type itself goes into `sidebarRightTabs` (stage one: what the type *is* —
 *   its id, its kind, and one guide entry, which is the only way a user can open
 *   a page type at all);
 * - its body and its chip title go into the keyed `sidebar.right.pane.tab` /
 *   `sidebar.right.pane.tab.title` seats under that same id, which is what the
 *   sidebar dispatches on for every tab of the kind;
 * - the chip's actions menu gains one row (`sidebar.right.tab.menu.item`) that
 *   opens the plugin's settings, and the settings themselves render as an entry
 *   of the frame-wide `shell.overlay` layer — because a menu item that acts must
 *   dismiss the menu it was pressed in, and the popup cannot live inside the row
 *   that opened it. One store drives both halves.
 *
 * The DSH client packages are provided by the web shell and are not dependencies
 * of this package, so each of those contracts is **mirrored structurally** here —
 * the choice `./settings.ts` and `./tab-locale.ts` already make for
 * `settings.section` and the locale service. Nothing in this module imports a
 * `@deepseek-ai/dsh-client-*` package; the slot keys and the service name are
 * the only names it needs from the checkout, and they are dialled as strings.
 *
 * What the port changes for a user: the tab is listed by the shell's own guide
 * page instead of the sidebar's `+` menu, and the side card's plugin settings
 * page is gone — the poll interval and the per-project release panel now sit
 * behind the row this module adds to the tab's actions menu.
 *
 * @module dsh-project-mcp/client/sidebar-tab
 */

import { createElement as h, useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { PACKAGE_NAME, TAB_ID } from '../shared.ts'
import { hostTranslate } from './locales/host.ts'
import { tabTranslate, useTabTranslate } from './tab-locale.ts'
import type { TabLocale } from './tab-locale.ts'
import type { RefreshStore, Translate } from './view.ts'

/** Type discriminator of the panel's page: what `openTab` names and what the sidebar dispatches on. */
export const TAB_KIND = 'project-mcp'

/** Keyed seat a tab type registers its body under. */
export const TAB_SLOT = 'sidebar.right.pane.tab'

/** Keyed seat the same type registers its chip title under. */
export const TAB_TITLE_SLOT = 'sidebar.right.pane.tab.title'

/** List seat a tab type adds its own entries to: the actions menu of the chip. */
export const TAB_MENU_SLOT = 'sidebar.right.tab.menu.item'

/** Frame-wide floating layer the settings popup renders into. */
export const SETTINGS_DIALOG_SLOT = 'shell.overlay'

/** Registration id of the actions-menu row, unique within that menu. */
export const TAB_MENU_ID = `${PACKAGE_NAME}:settings`

/** Position of the row among the menu's entries, after the kit's own close item. */
export const TAB_MENU_ORDER = 60

/** Registration id of the settings popup in the floating layer. */
export const SETTINGS_DIALOG_ID = `${PACKAGE_NAME}:settings-dialog`

/** Position of the popup among the layer's entries, after the toast stack. */
export const SETTINGS_DIALOG_ORDER = 61

/** Identity of the type's guide entry: the box the guide page offers to open a tab. */
export const TAB_GUIDE_ENTRY_ID = 'servers'

/** Position of the guide entry among every registered type's entries; the tab's own descriptor order. */
export const TAB_GUIDE_ORDER = 55

/**
 * One box the guide page offers, contributed by the type it opens.
 *
 * `title` and `description` are thunks read on every render, so a language
 * switch needs no re-registration — the rule the old descriptor's own copy
 * followed. A guide that lists too many entries drops descriptions and shows
 * titles alone, so the title has to stand on its own.
 */
export interface SidebarRightGuideEntry {
  readonly id: string
  readonly order: number
  readonly title: () => string
  readonly description?: (() => string) | undefined
}

/**
 * Stage one of a tab type: what it is, and nothing per-tab.
 *
 * `patterns` is omitted on purpose — the panel is a *page* type, opened by kind
 * (from the guide page, or from another surface's `openTab`), not a viewer that
 * claims an address. `multiple` is omitted too: one project panel per pane is
 * what `single: true` meant in the sidebar the tab came from.
 */
export interface SidebarRightTabDefinition {
  readonly id: string
  readonly kind: string
  /** Defaults to `extension` in the shipped registry: a type from outside the product. */
  readonly priority?: 'extension' | 'builtin' | 'fallback' | undefined
  /** Chip text captured when a tab opens. */
  readonly title: (address: string) => string
  readonly guide?: readonly SidebarRightGuideEntry[] | undefined
}

/** The registry service (stage one), as a registrant uses it. */
export interface SidebarRightTabsService {
  /** Register one type; the returned disposer removes it and is idempotent. */
  register(definition: SidebarRightTabDefinition): () => void
}

/** Live tab information the framework binds for a body: the presentation and the record. */
export interface SidebarTabInfo {
  readonly tab: {
    /** Only a tab on screen is visible: a docked body requires expansion and selection, a float survives a collapse. */
    readonly visible: boolean
  }
}

/**
 * The framework's own props for a `sidebar.right.pane.tab` body.
 *
 * `sessionId` is the slot's session scope; `useTabInfo` is the slot-owned hook
 * the framework injects (declared as `inject.hooks.tabInfo` in the slot map and
 * delivered flattened under that `use…` name). Both are optional here because a
 * composition — or a test — may hand the body neither, and this module falls
 * back rather than throwing.
 */
export interface SidebarTabFrameworkProps {
  readonly sessionId?: string | undefined
  readonly useTabInfo?: (() => SidebarTabInfo) | undefined
}

/** Owner share of one actions-menu occurrence: the menu's own dismiss seat. */
export interface SidebarTabMenuOwnerProps {
  readonly dismiss?: (() => void) | undefined
}

/**
 * Options one `slots.register` accepts, as far as this module uses them.
 *
 * `key` addresses a keyed seat; `id` and `order` place a list entry.
 */
export interface SidebarTabSlotOptions {
  name: string
  key?: string | undefined
  id?: string | undefined
  order?: number | undefined
}

/** The slot service, as this module's registrants use it. */
export interface SidebarTabSlots {
  inject(slot: string, callback: () => unknown): unknown
  register<Props>(options: SidebarTabSlotOptions, component: (props: Props) => ReactNode): unknown
}

/** The client services the tab's registration needs; each may be absent from a composition. */
export interface SidebarTabServices {
  effect(execute: () => unknown, label?: string): unknown
  slots: SidebarTabSlots
  sidebarRightTabs: SidebarRightTabsService
}

/** The tab body's props: the framework's own, plus the seats this module binds. */
export interface SidebarTabBodyProps {
  /** The session the tab belongs to — the panel shows that session's project only. */
  sessionId: string | undefined
  /** Whether the tab is on screen; an off-screen panel stops polling. */
  visible: boolean
  /** The poll interval, followed live so a change in the settings popup reaches the panel. */
  refreshMs: number
  t: Translate
  hostT: Translate
}

/** The settings popup's content, with the seats it needs. */
export interface SidebarSettingsProps {
  refreshMs: number
  /** Write a new interval; the popup's own row is the only writer. */
  onRefreshMs: (value: number) => void
  onClose: () => void
  t: Translate
  hostT: Translate
}

/**
 * Whether the settings popup is on screen, and how the menu row reaches it.
 *
 * The row and the popup are not in one tree: an actions-menu item that acts must
 * dismiss the menu, so the row cannot render the popup itself — it opens this
 * store, the menu closes, and the popup's own entry in the floating layer renders
 * from the same value. It is a store rather than a state setter because exactly
 * one side opens and the other subscribes.
 */
export interface SettingsDialogStore {
  isOpen(): boolean
  open(): void
  close(): void
  subscribe(listener: () => void): () => void
}

/**
 * Build a {@link SettingsDialogStore}, closed.
 * @returns the store the menu row and the popup share.
 */
export function createSettingsDialogStore(): SettingsDialogStore {
  let open = false
  const listeners = new Set<() => void>()
  const publish = (next: boolean): void => {
    if (next === open) return
    open = next
    for (const listener of listeners) listener()
  }
  return {
    isOpen: () => open,
    open: () => publish(true),
    close: () => publish(false),
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** Run one render when `open` flips, so a closed popup draws nothing at all. */
function useSettingsOpen(store: SettingsDialogStore): boolean {
  const [open, setOpen] = useState(() => store.isOpen())
  useEffect(() => store.subscribe(() => setOpen(store.isOpen())), [store])
  return open
}

/** Follow the interval store so both the body and the popup re-render on a change. */
function useRefreshMs(store: RefreshStore): number {
  const [value, setValue] = useState(() => store.get())
  useEffect(() => store.subscribe(() => setValue(store.get())), [store])
  return value
}

/** Copy the type publishes to the guide page; overridable so the design stand can name its picture. */
export interface SidebarTabCopy {
  title: () => string
  description: () => string
}

/** What {@link registerSidebarTab} wires up; the product and the design stand differ only here. */
export interface RegisterSidebarTabOptions {
  /** The shell's locale service, when the composition has one. */
  locale: TabLocale | undefined
  /** The poll interval shared by the body and the popup. */
  refresh: RefreshStore
  /** The tab body. */
  body: (props: SidebarTabBodyProps) => ReactNode
  /** The popup's content. */
  settings: (props: SidebarSettingsProps) => ReactNode
  /** The guide page's copy for this type; the product's own by default. */
  copy?: SidebarTabCopy | undefined
}

/** Nothing on screen when no tab information arrives: the frame renders every entry, hidden or not. */
const ALWAYS_VISIBLE: SidebarTabInfo = { tab: { visible: true } }

function useAlwaysVisible(): SidebarTabInfo {
  return ALWAYS_VISIBLE
}

/**
 * Register the panel as a tab type of DSH's own right sidebar.
 *
 * Five registrations, all disposed with the fiber: the type in the registry, its
 * body and its chip title under their keyed seats, the settings row in the chip's
 * actions menu, and the settings popup in the frame-wide floating layer. A
 * composition that lacks any of the services keeps the surfaces it has — the
 * settings page, the toasts and the host half never depend on this module.
 * @param services - the injected `slots` registry, the right-sidebar tab registry, and `effect`.
 * @param options - the two surfaces to draw, the interval they share, and the guide copy.
 */
export function registerSidebarTab(
  services: SidebarTabServices,
  options: RegisterSidebarTabOptions,
): void {
  const t = tabTranslate(options.locale)
  const copy: SidebarTabCopy = options.copy ?? {
    title: () => t('tab'),
    description: () => t('tabDescription'),
  }
  const store = createSettingsDialogStore()

  services.effect(
    () =>
      services.sidebarRightTabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        title: () => copy.title(),
        guide: [
          {
            id: TAB_GUIDE_ENTRY_ID,
            order: TAB_GUIDE_ORDER,
            title: () => copy.title(),
            description: () => copy.description(),
          },
        ],
      }),
    'dsh-project-mcp: sidebar tab type',
  )

  services.slots.inject(TAB_SLOT, () =>
    services.slots.register({ name: TAB_SLOT, key: TAB_ID }, (props: SidebarTabFrameworkProps) =>
      h(TabBody, { framework: props, locale: options.locale, refresh: options.refresh, body: options.body }),
    ),
  )

  // The chip's title is re-read here on every render, which is what makes the
  // tab's own label follow a language switch. The registry's `title` thunk above
  // only covers the moment a tab opens: a record keeps the text it was minted
  // with until this seat overrides it.
  services.slots.inject(TAB_TITLE_SLOT, () =>
    services.slots.register({ name: TAB_TITLE_SLOT, key: TAB_ID }, () => h(TabChipTitle, { copy })),
  )

  services.slots.inject(TAB_MENU_SLOT, () =>
    services.slots.register(
      { name: TAB_MENU_SLOT, id: TAB_MENU_ID, order: TAB_MENU_ORDER },
      (props: SidebarTabMenuOwnerProps) =>
        h(MenuRow, { locale: options.locale, store, dismiss: props.dismiss }),
    ),
  )

  services.slots.inject(SETTINGS_DIALOG_SLOT, () =>
    services.slots.register(
      { name: SETTINGS_DIALOG_SLOT, id: SETTINGS_DIALOG_ID, order: SETTINGS_DIALOG_ORDER },
      () =>
        h(SettingsDialog, {
          locale: options.locale,
          store,
          refresh: options.refresh,
          settings: options.settings,
        }),
    ),
  )
}

/**
 * The tab body: the framework's props, the two translate seats and the live
 * interval, handed to the surface the entry supplied.
 * @param props - the framework's share plus the registration's own options.
 * @returns the panel element tree.
 */
export function TabBody(props: {
  framework: SidebarTabFrameworkProps
  locale: TabLocale | undefined
  refresh: RefreshStore
  body: (props: SidebarTabBodyProps) => ReactNode
}): ReactNode {
  const t = useTabTranslate(props.locale)
  const hostT = hostTranslate(props.locale)
  const refreshMs = useRefreshMs(props.refresh)
  // Called unconditionally — the framework injects this hook for the seat. A
  // composition that somehow hands none is drawn as an on-screen tab rather than
  // as an error: `visible` only paces the panel's own polling.
  const info = (props.framework.useTabInfo ?? useAlwaysVisible)()
  // An element, not a bare call: the body is a component of its own, so its
  // hooks belong to its own fiber rather than to this adapter's.
  return h(props.body, {
    sessionId: props.framework.sessionId,
    visible: info.tab.visible,
    refreshMs,
    t,
    hostT,
  })
}

/**
 * The chip's title: the type's own name, read through the entry's copy thunk on
 * every render.
 *
 * The registry captures a title when a tab opens, and a record keeps that text
 * until this seat replaces it — so without this registration an open tab would
 * keep whatever language it was opened in. The component takes nothing from the
 * tab: the panel's label is the same for every occurrence.
 * @param props - the type's copy.
 * @returns the title text.
 */
export function TabChipTitle(props: { copy: SidebarTabCopy }): ReactNode {
  return props.copy.title()
}

/**
 * The row this plugin adds to a tab chip's actions menu.
 *
 * It dismisses the menu first — the contract for an item that acts, and the
 * reason the popup is not drawn here: the menu unmounts on dismiss, so a popup
 * inside the item would go with it. The row reads the plugin's own dictionary and
 * follows the language like every other surface.
 * @param props - the locale seat, the store the popup subscribes to, and the menu's dismiss seat.
 * @returns the menu item.
 */
export function MenuRow(props: {
  locale: TabLocale | undefined
  store: SettingsDialogStore
  dismiss?: (() => void) | undefined
}): ReactNode {
  const t = useTabTranslate(props.locale)
  return h(
    'button',
    {
      type: 'button',
      role: 'menuitem',
      style: STYLE.menuItem,
      onClick: () => {
        props.dismiss?.()
        props.store.open()
      },
    },
    t('settingsMenuItem'),
  )
}

/**
 * The settings popup: the tab's own settings, rendered as an entry of the
 * frame-wide floating layer.
 *
 * Nothing is drawn while the popup is closed, so the layer holds an empty cell
 * and the frame's click-through is untouched. The backdrop is the entry's own
 * element, which is what makes the layer's `pointer-events: auto` rule apply to
 * it.
 * @param props - the locale seat, the open/closed store, the interval and the content.
 * @returns the backdrop with the popup card, or `null` while it is closed.
 */
export function SettingsDialog(props: {
  locale: TabLocale | undefined
  store: SettingsDialogStore
  refresh: RefreshStore
  settings: (props: SidebarSettingsProps) => ReactNode
}): ReactNode {
  const t = useTabTranslate(props.locale)
  const hostT = hostTranslate(props.locale)
  const refreshMs = useRefreshMs(props.refresh)
  const open = useSettingsOpen(props.store)
  if (!open) return null
  const close = (): void => props.store.close()
  return h(
    'div',
    { style: STYLE.backdrop, onClick: close },
    h(
      'div',
      {
        style: STYLE.dialog,
        role: 'dialog',
        'aria-modal': true,
        'aria-label': t('settingsMenuItem'),
        // A press inside the card must not reach the backdrop's close.
        onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
      },
      // An element too: the popup's content is a component with hooks of its
      // own — the panel polls, and a bare call would fold them into this frame.
      h(props.settings, {
        refreshMs,
        onRefreshMs: (value: number) => props.refresh.set(value),
        onClose: close,
        t,
        hostT,
      }),
    ),
  )
}

/**
 * The entries' own style.
 *
 * The popup is deliberately not the panel's `STYLE`: it draws a menu row and a
 * frame-wide card, and neither is part of the tab's surface contract. The tokens
 * are the same alias variables every other surface uses, so the card follows the
 * theme — including the design stand's, which renders the same components.
 */
const STYLE = {
  /**
   * The menu row. The kit's own items are hashed CSS the plugin cannot borrow,
   * so the row is drawn the way the plugin draws every other control: an inline
   * style over the alias tokens, matching the kit's item in size and weight.
   */
  menuItem: {
    display: 'block',
    width: '100%',
    padding: '4px 10px',
    border: 'none',
    borderRadius: 4,
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
  } satisfies CSSProperties,
  /** The layer spans the frame, so the backdrop does too; the card is centred over the whole application. */
  backdrop: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0, 0, 0, 0.4)',
  } satisfies CSSProperties,
  /**
   * The card, which scrolls its own content: the panel lists every project with
   * a live session, and a project with many servers is taller than any window.
   */
  dialog: {
    maxWidth: 'min(560px, 92vw)',
    maxHeight: '80vh',
    overflowY: 'auto',
    borderRadius: 8,
    border: '1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.25))',
    background: 'var(--dsw-alias-bg-layer-2, #1f1f22)',
    color: 'var(--dsw-alias-label-primary, inherit)',
    boxShadow: '0 12px 32px rgba(0, 0, 0, 0.45)',
  } satisfies CSSProperties,
} as const
