import { useEffect, useRef, useState, type ReactNode } from 'react'

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

/**
 * Hold Control and press Tab (docs/features/tabs-panes.md): the first press
 * opens a list of the strip's entries under the strip with the next one
 * selected, each further Tab moves on (Shift+Tab back), letting go of
 * Control opens the selected entry, and Escape or a click outside cancels.
 * The mechanics are `tab-switch.ts`; this listens for the keys and draws the
 * list. Focus never leaves where it was, an editor or a terminal included:
 * ⌃Tab is a `capture` row, so the dispatcher takes it before they see it.
 */
export function TabSwitcher({
  order,
  active,
  onSelect,
  row,
  children,
}: {
  /** The strip's entries, in order. */
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
  /** Whether Control is down, from the last key event: run from the
   *  shortcuts list it is not, and the step selects at once. */
  const held = useRef(false)
  const select = useRef(onSelect)
  select.current = onSelect
  const listRef = useRef<HTMLDivElement>(null)

  const send = useRef((event: TabSwitchEvent) => {
    const result = tabSwitch(current.current, event)
    current.current = result.state
    setState(result.state)
    if (result.select !== undefined) select.current(result.select)
  }).current

  useShortcutHandlers({
    'tab.next': () => send({ kind: 'step', step: 1, held: held.current, order, active }),
    'tab.previous': () => send({ kind: 'step', step: -1, held: held.current, order, active }),
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      held.current = e.ctrlKey
      if (current.current === null) return
      if (e.type === 'keyup' && !e.ctrlKey) {
        send({ kind: 'release' })
      } else if (e.type === 'keydown' && e.key === 'Escape') {
        // Never the focused widget's Escape too: a terminal would interrupt
        // its agent.
        e.preventDefault()
        e.stopPropagation()
        send({ kind: 'cancel' })
      }
    }
    // A Control let go in another window never comes back as a keyup.
    const onBlur = (): void => {
      held.current = false
      send({ kind: 'cancel' })
    }
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

  const rows = state === null ? [] : state.order.map((id) => ({ id, ...row(id) }))
  const selected = state === null ? undefined : rows[state.at]

  return (
    <Popover
      open={state !== null}
      onOpenChange={(open) => {
        if (!open) send({ kind: 'cancel' })
      }}
    >
      <PopoverAnchor asChild>{children}</PopoverAnchor>
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
      >
        <Command shouldFilter={false} label="Switch tab" value={String(state?.at ?? 0)}>
          <CommandList ref={listRef} label="Open tabs">
            {rows.map((entry, index) => (
              <CommandItem
                key={entry.id}
                value={String(index)}
                aria-label={entry.name}
                onSelect={() => send({ kind: 'choose', id: entry.id })}
              >
                {entry.content}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
        <span aria-live="polite" className="sr-only">
          {selected?.name}
        </span>
      </PopoverContent>
    </Popover>
  )
}
