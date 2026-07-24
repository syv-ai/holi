/** A self-contained right-click popover (no menu library). Positioned at the
 *  cursor; closes on outside-click, another context-menu, or Escape. Items are
 *  provided by the caller so the menu itself stays dumb. */
import { useEffect } from 'react'

export interface MenuItem {
  label: string
  onSelect: () => void
  kbd?: string
  danger?: boolean
}

export function TreeContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number
  y: number
  items: (MenuItem | 'separator')[]
  onClose: () => void
}) {
  useEffect(() => {
    // Dismiss on `mousedown` anywhere (and Escape). A right-click's mousedown
    // fires BEFORE its contextmenu — which is when this menu mounts — so this
    // synchronously-registered listener never sees the gesture that opened the
    // menu, yet a right-click elsewhere closes this one before opening the next.
    // (Listening for `click`/`contextmenu` would let the opening event, still
    // propagating to window, close the menu instantly.) mousedown inside the menu
    // is stopped on the container below so item clicks still land.
    const close = () => onClose()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', esc)
    }
  }, [onClose])

  return (
    <div
      className="fixed z-50 w-56 rounded-lg border border-neutral-700 bg-neutral-900 p-1 text-xs shadow-xl"
      style={{ left: x, top: y }}
      // Stop mousedown inside the menu from reaching the window dismiss listener,
      // which would unmount the menu before an item's click could land.
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((it, i) =>
        it === 'separator' ? (
          <div key={i} className="my-1 h-px bg-neutral-800" />
        ) : (
          <button
            key={i}
            className={`flex w-full items-center justify-between rounded px-2 py-1 text-left hover:bg-neutral-800 ${
              it.danger ? 'text-red-300' : 'text-neutral-200'
            }`}
            onClick={() => {
              it.onSelect()
              onClose()
            }}
          >
            <span>{it.label}</span>
            {it.kbd && <span className="text-neutral-500">{it.kbd}</span>}
          </button>
        ),
      )}
    </div>
  )
}
