import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'

import { Button } from '@/components/ui/button'
import { Command, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useShortcutHandlers } from '@/hooks/use-shortcuts'

import { tabSwitch, type TabSwitch, type TabSwitchEvent } from './tab-switch'

/** How the switcher shows one strip entry: its mark and title as the strip
 *  draws them, and what a screen reader says for it. */
export interface SwitcherRow {
  name: string
  content: ReactNode
}

const SwitcherToggle = createContext<{ toggle: () => void; open: boolean } | null>(null)

/** A button inside a `TabSwitcher` that opens its list by a click, pinned,
 *  and closes it again: the strip's tab count. */
export function TabSwitcherButton({ onClick, ...props }: ComponentProps<typeof Button>) {
  const switcher = useContext(SwitcherToggle)
  return (
    <Button
      {...props}
      type="button"
      data-tab-switcher-toggle=""
      aria-haspopup="true"
      aria-expanded={switcher?.open ?? false}
      onClick={(event) => {
        onClick?.(event)
        switcher?.toggle()
      }}
    />
  )
}

/**
 * Hold Control and press Tab (docs/features/tabs-panes.md): the first press
 * opens a list of the strip's entries under the strip, most recently used
 * first, with the one used before this selected; each further Tab moves on
 * (Shift+Tab back), letting go of Control opens the selected entry (or
 * pressing a row opens that one), and Escape or a click outside cancels. The
 * mechanics are `tab-switch.ts`; this listens for the keys and draws the
 * list. Focus never leaves where it was, an editor or a terminal included:
 * ⌃Tab is a `capture` row, so the dispatcher takes it before they see it.
 *
 * The strip's tab count opens the same list by a click (`TabSwitcherButton`,
 * anywhere inside): pinned, it stays open when Control is let go,
 * until a row is pressed, Enter opens the one selected, or it is dismissed.
 */
export function TabSwitcher({
  order,
  active,
  onSelect,
  row,
  children,
}: {
  /** The strip's entries, most recently used first. */
  order: readonly string[]
  active: string | null
  /** Select an entry, as a click on its tab does. */
  onSelect: (id: string) => void
  row: (id: string) => SwitcherRow
  /** The strip, which the list hangs under. */
  children: ReactNode
}) {
  const [state, setState] = useState<TabSwitch>(null)
  const current = useRef<TabSwitch>(null)
  const select = useRef(onSelect)
  select.current = onSelect
  /** The entries as they are now, which a release checks the selection
   *  against. */
  const strip = useRef(order)
  strip.current = order
  const activeRef = useRef(active)
  activeRef.current = active
  const listRef = useRef<HTMLDivElement>(null)

  const send = useRef((event: TabSwitchEvent) => {
    const result = tabSwitch(current.current, event)
    current.current = result.state
    setState(result.state)
    if (result.select !== undefined) select.current(result.select)
  }).current

  // Control is held when a key ran it; from the shortcuts dialog there is
  // no key, and the step lands at once.
  useShortcutHandlers({
    'tab.next': (_, key) =>
      send({ kind: 'step', step: 1, held: key?.ctrlKey === true, order, active }),
    'tab.previous': (_, key) =>
      send({ kind: 'step', step: -1, held: key?.ctrlKey === true, order, active }),
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (current.current === null) return
      const pinned = current.current.pinned === true
      if (e.type === 'keyup' && !e.ctrlKey) {
        send({ kind: 'release', order: strip.current })
      } else if (pinned && e.type === 'keydown' && /^(Enter|ArrowDown|ArrowUp)$/.test(e.key)) {
        // Opened by a click, the list takes the keys a list would: the
        // arrows move the selection, Enter opens it.
        e.preventDefault()
        e.stopPropagation()
        if (e.key === 'Enter') send({ kind: 'commit', order: strip.current })
        else {
          const step = e.key === 'ArrowDown' ? 1 : -1
          send({ kind: 'step', step, held: true, order: strip.current, active: activeRef.current })
        }
      } else if (e.type === 'keydown' && e.key === 'Escape') {
        // Never the focused widget's Escape too: a terminal would interrupt
        // its agent.
        e.preventDefault()
        e.stopPropagation()
        send({ kind: 'cancel' })
      }
    }
    // A Control let go in another window never comes back as a keyup.
    const onBlur = (): void => send({ kind: 'cancel' })
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKey, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKey, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [send])

  // A long list keeps the selected row in sight, once cmdk has marked it.
  useEffect(() => {
    if (state === null) return
    const frame = requestAnimationFrame(() =>
      listRef.current
        ?.querySelector('[data-selected="true"]')
        ?.scrollIntoView({ block: 'nearest' }),
    )
    return () => cancelAnimationFrame(frame)
  }, [state])

  /** A `TabSwitcherButton`'s click: open the list pinned, or close it. */
  const toggle = (): void => {
    if (current.current !== null) send({ kind: 'cancel' })
    else send({ kind: 'open', order: strip.current, active: activeRef.current })
  }

  const rows = state === null ? [] : state.order.map((id) => ({ id, ...row(id) }))
  const selected = state === null ? undefined : rows[state.at]

  return (
    <Popover
      open={state !== null}
      onOpenChange={(open) => {
        if (!open) send({ kind: 'cancel' })
      }}
    >
      <SwitcherToggle.Provider value={{ toggle, open: state !== null }}>
        <PopoverAnchor asChild>{children}</PopoverAnchor>
      </SwitcherToggle.Provider>
      <PopoverContent
        align="center"
        variant="flush"
        className="w-80"
        // A group, not Radix's dialog: it takes no focus, and the shortcut
        // dispatcher holds every key while a dialog is open, the next Tab
        // included.
        role="group"
        aria-label="Switch tab"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        // The count that opened it toggles it: a press there is its own,
        // not a click outside that closes the list for the click to reopen.
        onInteractOutside={(event) => {
          const target = event.target
          if (target instanceof Element && target.closest('[data-tab-switcher-toggle]')) {
            event.preventDefault()
          }
        }}
      >
        {/* The pointer does not move the selection: what is marked is what
            letting go opens. */}
        <Command
          shouldFilter={false}
          disablePointerSelection
          label="Switch tab"
          value={String(state?.at ?? 0)}
        >
          <CommandList ref={listRef} label="Open tabs">
            {rows.map((entry, index) => (
              <CommandItem
                key={entry.id}
                value={String(index)}
                aria-label={entry.name}
                // On pointerdown, not click: Control is still held, and on a
                // Mac a Control-click is a secondary click that never clicks.
                onPointerDown={(event) => {
                  if (event.button !== 0) return
                  event.preventDefault()
                  send({ kind: 'choose', id: entry.id, order: strip.current })
                }}
                onContextMenu={(event) => event.preventDefault()}
              >
                {entry.content}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
      {/* Mounted always, so the first selection is a change it announces. */}
      <span aria-live="polite" className="sr-only">
        {selected?.name ?? ''}
      </span>
    </Popover>
  )
}
