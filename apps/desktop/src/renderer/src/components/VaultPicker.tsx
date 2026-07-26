/**
 * The vault switcher — a custom dropdown, not a native `<select>`.
 *
 * A native select cannot hold an action row, and "add a vault" belongs *in* the
 * list of vaults, not as a separate `+` button beside it: switching and adding
 * are the same gesture (open the list, pick where to go). So this is a small
 * popover primitive — a trigger showing the current vault, and a menu of vaults
 * with "Add vault…" pinned to the bottom.
 *
 * Closes on outside-click and Escape. Deliberately minimal — no keyboard arrow
 * navigation yet; the list is short and click-driven.
 */
import { ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

export function VaultPicker({
  vaults,
  activeRemote,
  onSelect,
  onAddVault,
}: {
  vaults: { remote: string; name: string }[]
  activeRemote: string | null
  onSelect: (remote: string) => void
  onAddVault: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const active = vaults.find((v) => v.remote === activeRemote)

  return (
    <div ref={ref} className="relative min-w-0 flex-1">
      <button
        type="button"
        data-vault-picker
        title="switch vault"
        className="flex w-full items-center gap-1 px-2 py-1 text-sm font-bold text-neutral-100 hover:text-neutral-300"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="truncate">
          {active?.name ?? (vaults.length ? 'select vault' : 'no vaults')}
        </span>
        <ChevronDown size={18} strokeWidth={2.5} className="shrink-0" />
      </button>

      {open && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded border border-neutral-800 bg-neutral-900 shadow-xl">
          <ul className="max-h-64 overflow-y-auto py-1">
            {vaults.length === 0 && (
              <li className="px-2 py-1 text-xs text-neutral-500">no vaults yet</li>
            )}
            {vaults.map((v) => (
              <li key={v.remote}>
                <button
                  type="button"
                  data-vault-option={v.remote}
                  className={`flex w-full items-center gap-2 px-2 py-1 text-left text-sm hover:bg-neutral-800 ${
                    v.remote === activeRemote ? 'text-neutral-100' : 'text-neutral-300'
                  }`}
                  onClick={() => {
                    setOpen(false)
                    if (v.remote !== activeRemote) onSelect(v.remote)
                  }}
                >
                  <span className="w-3 shrink-0 text-sky-400">
                    {v.remote === activeRemote ? '✓' : ''}
                  </span>
                  <span className="truncate" title={v.remote}>
                    {v.name}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {/* Pinned to the bottom: adding a vault is part of the same menu, not a
              separate control competing with the switcher. */}
          <button
            type="button"
            data-vault-add
            className="flex w-full items-center gap-2 border-t border-neutral-800 px-2 py-1.5 text-left text-sm text-neutral-300 hover:bg-neutral-800"
            onClick={() => {
              setOpen(false)
              onAddVault()
            }}
          >
            <span className="w-3 shrink-0 text-center text-neutral-400">+</span>
            <span>Add vault…</span>
          </button>
        </div>
      )}
    </div>
  )
}
