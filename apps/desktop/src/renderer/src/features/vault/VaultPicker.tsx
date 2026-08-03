/**
 * The vault switcher — a dropdown menu, not a native `<select>`.
 *
 * A native select cannot hold an action row, and "add a vault" belongs *in* the
 * list of vaults, not as a separate `+` button beside it: switching and adding
 * are the same gesture (open the list, pick where to go). So this is the `Menu`
 * primitive (Radix dropdown) — a trigger showing the current vault, and a menu
 * of vaults with "Add vault…" pinned to the bottom. Radix supplies open/close,
 * outside-click, Escape, and focus management.
 */
import { Check, ChevronDown, Plus } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
} from '@/primitives'

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
  const active = vaults.find((v) => v.remote === activeRemote)

  return (
    <DropdownMenu>
      <Tooltip content="switch vault">
        <DropdownMenuTrigger
          data-vault-picker
          className="flex min-w-0 flex-1 items-center gap-1 px-2 py-1 text-sm font-bold text-foreground outline-none hover:text-muted-foreground"
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {active?.name ?? (vaults.length ? 'select vault' : 'no vaults')}
          </span>
          <ChevronDown size={18} strokeWidth={2.5} className="shrink-0" />
        </DropdownMenuTrigger>
      </Tooltip>

      <DropdownMenuContent
        align="start"
        className="min-w-(--radix-dropdown-menu-trigger-width)"
      >
        {vaults.length === 0 && (
          <DropdownMenuItem disabled>no vaults yet</DropdownMenuItem>
        )}
        {vaults.map((v) => (
          <DropdownMenuItem
            key={v.remote}
            data-vault-option={v.remote}
            className={v.remote === activeRemote ? 'text-foreground' : undefined}
            onSelect={() => {
              if (v.remote !== activeRemote) onSelect(v.remote)
            }}
          >
            <span className="flex w-3 shrink-0 justify-center text-primary">
              {v.remote === activeRemote && <Check size={14} strokeWidth={3} />}
            </span>
            <Tooltip content={v.remote} side="right">
              <span className="truncate">{v.name}</span>
            </Tooltip>
          </DropdownMenuItem>
        ))}
        {/* Pinned to the bottom: adding a vault is part of the same menu, not a
            separate control competing with the switcher. */}
        <DropdownMenuSeparator />
        <DropdownMenuItem data-vault-add onSelect={onAddVault}>
          <Plus size={14} className="w-3 shrink-0" />
          <span>Add vault…</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
