import { useEffect, useRef } from 'react'
import { Button } from '@/primitives'
import { cn } from '@/lib/cn'
import { matchHotkey } from '@/lib/hotkey'

/**
 * The chrome bar every workspace panel shares: a fixed-height (h-11) row with a
 * bottom border, a leading region (`children` — a title, or a rich composition
 * like the agent's status line), and a right-aligned cluster of icon controls.
 *
 * Controls are DATA, not hand-rolled buttons — a `HeaderAction` carries its icon,
 * label, optional keyboard shortcut, and handler. That is what keeps every panel
 * (including the agent drawer, which used to hand-roll its own bar) speaking one
 * vocabulary. A `hotkey` is both SHOWN in the tooltip and BOUND while the header
 * is mounted, so a panel owns its controls and their shortcuts in one place —
 * e.g. the agent drawer's ⌘J lives here, not in a detached Shell listener.
 *
 * Domain-agnostic → composites/. Width/height-of-row is fixed for alignment with
 * the nav/editor/panel bars it shares the Resizable row with; override via
 * `className` for the odd case (a modal title bar).
 */
export interface HeaderAction {
  icon: React.ReactNode
  /** Accessible name + tooltip base. */
  label: string
  /** Glyph shortcut (e.g. `⌘J`) — shown in the tooltip AND bound while mounted. */
  hotkey?: string
  onSelect: () => void
  /** Omit the control entirely without disturbing the others' order. */
  hidden?: boolean
}

export function PanelHeader({
  children,
  actions,
  close,
  className,
}: {
  children: React.ReactNode
  /** Right-aligned controls, in order. */
  actions?: HeaderAction[]
  /** The trailing control (rendered last); typically a close/hide. */
  close?: HeaderAction
  className?: string
}): React.JSX.Element {
  const controls = [...(actions ?? []), ...(close ? [close] : [])].filter((a) => !a.hidden)

  // Bind every control's hotkey while mounted. One stable window listener reads
  // the freshest controls through a ref, so changing handlers/visibility never
  // re-subscribes and a panel's shortcut works even while it is display:none.
  const controlsRef = useRef(controls)
  controlsRef.current = controls
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      for (const a of controlsRef.current) {
        if (a.hotkey && matchHotkey(e, a.hotkey)) {
          e.preventDefault()
          a.onSelect()
          return
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <header
      data-slot="panel-header"
      className={cn(
        'flex h-11 shrink-0 items-center gap-2 border-b border-border px-3 text-xs',
        className,
      )}
    >
      {children}
      {controls.length > 0 && (
        <div className="ml-auto flex items-center gap-1">
          {controls.map((a, i) => (
            <Button
              key={i}
              variant="ghost"
              size="icon-xs"
              onClick={a.onSelect}
              title={a.hotkey ? `${a.label} (${a.hotkey})` : a.label}
              aria-label={a.label}
            >
              {a.icon}
            </Button>
          ))}
        </div>
      )}
    </header>
  )
}
