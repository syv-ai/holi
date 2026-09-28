/**
 * The vault switcher, a dropdown menu rather than a native `<select>`, because a
 * native select cannot hold an action row and "Add vault…" belongs *in* the
 * list: switching and adding are the same gesture.
 *
 * **Switching only.** A vault's way out (Leave, Remove, Delete; D109) lives in
 * Settings, Vault, for the open vault, away from a menu you open to switch.
 */
import { Check, ChevronDown, Plus } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icon,
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
          className="flex min-w-0 flex-1 items-center gap-1 px-2 py-1 text-sm font-bold text-foreground outline-none"
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {active?.name ?? (vaults.length ? 'select vault' : 'no vaults')}
          </span>
          <Icon icon={ChevronDown} />
        </DropdownMenuTrigger>
      </Tooltip>

      <DropdownMenuContent>
        {vaults.length === 0 && <DropdownMenuItem disabled>no vaults yet</DropdownMenuItem>}
        {vaults.map((v) => (
          <DropdownMenuItem
            key={v.remote}
            data-vault-option={v.remote}
            className={v.remote === activeRemote ? 'text-foreground' : undefined}
            onSelect={() => {
              if (v.remote !== activeRemote) onSelect(v.remote)
            }}
          >
            <span className="flex w-3.5 shrink-0 justify-center">
              {v.remote === activeRemote && <Icon icon={Check} size="sm" className="text-brand" />}
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
          <Icon icon={Plus} size="sm" />
          <span>Add vault…</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
