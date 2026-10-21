/**
 * The vault switcher, a dropdown menu rather than a native `<select>`, because a
 * native select cannot hold an action row and "Add vault…" belongs *in* the
 * list: switching and adding are the same gesture.
 *
 * **Switching only.** A vault's way out (Leave, Remove, Delete) lives in
 * Settings, Vault, for the open vault, away from a menu you open to switch.
 */
import { Check, ChevronsUpDown, Plus } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icon,
} from '@/primitives'
import { cn } from '@/lib/cn'

const ownerOf = (remote: string) => remote.split('/')[0] ?? remote

/** A vault's mark: its initial on a square tile, as shadcn's team switcher
 *  marks a team. The open one, in the trigger, carries the accent
 *  (`--brand-gradient`); the list's are monotone. */
function VaultTile({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center font-semibold',
        size === 'md'
          ? 'bg-(image:--brand-gradient) text-white'
          : 'bg-primary text-primary-foreground',
        size === 'md' ? 'size-6 rounded-md text-xs' : 'size-5 rounded text-xs',
      )}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  )
}

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
  const name = active?.name ?? (vaults.length ? 'Select vault' : 'No vaults')

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-vault-picker
        className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-start outline-none motion-respond hover:bg-foreground/[0.04] focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-foreground/[0.06]"
      >
        <VaultTile name={name} />
        <span className="grid min-w-0 flex-1 leading-tight">
          <span className="truncate text-nav font-medium text-foreground">{name}</span>
          <span className="truncate text-xs text-muted-foreground">
            {active ? ownerOf(active.remote) : 'Holi'}
          </span>
        </span>
        <Icon icon={ChevronsUpDown} size="sm" tone="muted" />
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        sideOffset={4}
        className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
      >
        <DropdownMenuLabel className="text-xs text-muted-foreground">Vaults</DropdownMenuLabel>
        {vaults.length === 0 && <DropdownMenuItem disabled>No vaults yet</DropdownMenuItem>}
        {vaults.map((v) => (
          <DropdownMenuItem
            key={v.remote}
            data-vault-option={v.remote}
            className="gap-2 px-2 py-1.5 text-nav"
            onSelect={() => {
              if (v.remote !== activeRemote) onSelect(v.remote)
            }}
          >
            <VaultTile name={v.name} size="sm" />
            <span className="grid min-w-0 flex-1 leading-tight">
              <span className="truncate">{v.name}</span>
              <span className="truncate text-xs text-muted-foreground">{v.remote}</span>
            </span>
            {v.remote === activeRemote && <Icon icon={Check} size="sm" />}
          </DropdownMenuItem>
        ))}
        {/* Pinned to the bottom: adding a vault is part of the same menu, not a
            separate control competing with the switcher. */}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-vault-add
          className="gap-2 px-2 py-1.5 text-nav"
          onSelect={onAddVault}
        >
          <span className="flex size-5 items-center justify-center rounded bg-foreground/[0.06]">
            <Icon icon={Plus} size="sm" />
          </span>
          <span className="text-muted-foreground">Add vault…</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
