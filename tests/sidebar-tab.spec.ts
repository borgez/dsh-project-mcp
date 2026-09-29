/**
 * The native right-sidebar contract (`src/client/sidebar-tab.ts`).
 *
 * The entry wiring is driven end to end by `tests/client-entry.spec.ts`; this
 * spec drives the pieces that wiring cannot see from the outside: the store the
 * actions-menu row and the popup share, and the chrome the floating layer's entry
 * draws (a closed popup renders nothing at all, an open one renders a backdrop
 * and a card, and a press inside the card must not reach the backdrop's close).
 *
 * React is mocked at the module boundary, as in `tests/design.spec.ts`, so the
 * element trees are plain objects and no renderer is needed. That has one
 * consequence worth stating: `useEffect` never runs here, so the store's
 * subscribe/unsubscribe path is driven directly rather than through a hook.
 */

import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import {
  MenuRow,
  SettingsDialog,
  createSettingsDialogStore,
} from '../src/client/sidebar-tab.ts'
import { createRefreshStore, fallbackTranslate } from '../src/client/view.ts'
import type { SidebarSettingsProps } from '../src/client/sidebar-tab.ts'

vi.mock('react', () => ({
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
    type,
    props: { ...(props as Record<string, unknown>), children },
  }),
  useCallback: (callback: unknown) => callback,
  useState: <T,>(initial: T | (() => T)): [T, (next: T) => void] => [
    typeof initial === 'function' ? (initial as () => T)() : initial,
    () => undefined,
  ],
  useEffect: () => undefined,
}))

/** One element as the mocked `createElement` builds it. */
interface FakeElement {
  type: unknown
  props: Record<string, unknown>
}

/** Every element in a tree, the root included. */
function elementsOf(node: unknown): FakeElement[] {
  if (node === null || node === undefined || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap((child) => elementsOf(child))
  const element = node as FakeElement
  const children = Array.isArray(element.props?.children) ? element.props.children : []
  return [element, ...children.flatMap((child) => elementsOf(child))]
}

/** The content element the popup handed its own children to. */
function contentOf(tree: unknown): FakeElement {
  const host = elementsOf(tree).find((element) => element.type !== 'div' && typeof element.type === 'function')
  if (host === undefined) throw new Error('the popup drew no content')
  return host
}

describe('createSettingsDialogStore', () => {
  it('starts closed and publishes only when the value actually flips', () => {
    const store = createSettingsDialogStore()
    const seen: boolean[] = []
    store.subscribe(() => seen.push(store.isOpen()))

    expect(store.isOpen()).toBe(false)
    store.close()
    expect(seen).toEqual([])
    store.open()
    store.open()
    expect(seen).toEqual([true])
    store.close()
    store.close()
    expect(seen).toEqual([true, false])
    expect(store.isOpen()).toBe(false)
  })

  it('stops notifying a listener that unsubscribed', () => {
    const store = createSettingsDialogStore()
    let calls = 0
    const stop = store.subscribe(() => {
      calls += 1
    })

    store.open()
    expect(calls).toBe(1)
    stop()
    store.close()
    expect(calls).toBe(1)
  })
})

describe('MenuRow', () => {
  it('dismisses the menu before it opens the popup', () => {
    const store = createSettingsDialogStore()
    const order: string[] = []
    const element = MenuRow({
      locale: undefined,
      store: { ...store, open: () => { order.push('open'); store.open() } },
      dismiss: () => order.push('dismiss'),
    }) as unknown as FakeElement

    expect(element.props.role).toBe('menuitem')
    ;(element.props.onClick as () => void)()
    // The kit's contract: an item that acts closes the menu it was pressed in,
    // and the popup lives outside it, so the order is what makes it survive.
    expect(order).toEqual(['dismiss', 'open'])
    expect(store.isOpen()).toBe(true)
  })

  it('opens without a dismiss seat', () => {
    const store = createSettingsDialogStore()
    const element = MenuRow({ locale: undefined, store }) as unknown as FakeElement

    expect(() => {
      ;(element.props.onClick as () => void)()
    }).not.toThrow()
    expect(store.isOpen()).toBe(true)
  })
})

describe('SettingsDialog', () => {
  // The content seat, as the product's own adapter is: a component of the popup
  // props that renders the panel. The cast is the mock's, not the contract's.
  const settings = ((props: SidebarSettingsProps): FakeElement => ({
    type: 'panel',
    props: props as unknown as Record<string, unknown>,
  })) as unknown as (props: SidebarSettingsProps) => ReactNode

  it('draws nothing at all while the popup is closed', () => {
    const store = createSettingsDialogStore()

    expect(SettingsDialog({ locale: undefined, store, refresh: createRefreshStore(), settings })).toBeNull()
  })

  it('draws the backdrop, the card and the content once it is open', () => {
    const store = createSettingsDialogStore()
    store.open()

    const backdrop = SettingsDialog({
      locale: undefined,
      store,
      refresh: createRefreshStore(),
      settings,
    }) as unknown as FakeElement

    expect(backdrop.type).toBe('div')
    const card = elementsOf(backdrop).find((element) => element.props.role === 'dialog')
    expect(card).toBeDefined()
    expect(card?.props['aria-modal']).toBe(true)
    // The label is the row's own copy, so the popup is named like the press that
    // opened it — in the shell's language, through the same seat.
    expect(card?.props['aria-label']).toBe(fallbackTranslate('settingsMenuItem'))
    expect(contentOf(backdrop).props.refreshMs).toBe(5_000)

    // A press outside closes; one inside the card is swallowed before it can.
    const event = { stopPropagation: vi.fn() }
    ;(card?.props.onClick as (event: unknown) => void)(event)
    expect(event.stopPropagation).toHaveBeenCalledTimes(1)
    expect(store.isOpen()).toBe(true)
    ;(backdrop.props.onClick as () => void)()
    expect(store.isOpen()).toBe(false)
  })

  it('hands the content the live interval, the store’s writer and a close seat', () => {
    const storage = {
      values: {} as Record<string, string>,
      getItem(key: string): string | null {
        return this.values[key] ?? null
      },
      setItem(key: string, value: string): void {
        this.values[key] = value
      },
    }
    const refresh = createRefreshStore(storage)
    const store = createSettingsDialogStore()
    store.open()

    const backdrop = SettingsDialog({ locale: undefined, store, refresh, settings }) as unknown as FakeElement
    const content = contentOf(backdrop)

    expect(content.props.refreshMs).toBe(5_000)
    ;(content.props.onRefreshMs as (value: number) => void)(15_000)
    expect(refresh.get()).toBe(15_000)
    expect(storage.values['dsh-project-mcp:servers:refreshMs']).toBe('15000')
    // The writer and the body read one store, so the interval a press sets is the
    // interval the panel polls on.
    expect(contentOf(SettingsDialog({ locale: undefined, store, refresh, settings }) as unknown as FakeElement).props.refreshMs).toBe(15_000)
    ;(content.props.onClose as () => void)()
    expect(store.isOpen()).toBe(false)
  })
})
