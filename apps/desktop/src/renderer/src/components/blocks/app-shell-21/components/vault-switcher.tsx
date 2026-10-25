import { useAtomValue, useSetAtom } from "jotai"
import type { VaultEntry } from "@holi/shared"
import { cn } from "@/lib/cn"

import { activeRemoteAtom, vaultsAtom } from "@/state/vaults"
import { switchVaultAtom } from "@/state/vault-switch"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Item, ItemMedia } from "@/components/ui/item"
import { BrandMark } from "@/composites"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

import { CheckIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react"

function getVaultInitials(name: string): string {
  return name.charAt(0).toUpperCase()
}

function HoliLogo({ className }: { className?: string }) {
  return (
    <Item
      className={cn(
        "p-0",
        "bg-primary text-primary-foreground flex size-8 shrink-0 items-center justify-center",
        className
      )}
      aria-hidden="true"
    >
      <ItemMedia variant="icon" className="size-auto">
        {/* Holi's mark alone: the wordmark has no room in a tile. */}
        <BrandMark variant="monogram" className="h-4" />
      </ItemMedia>
    </Item>
  )
}

function SidebarLogo({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "relative flex size-6 shrink-0 items-center justify-center",
        className
      )}
    >
      <HoliLogo className="absolute top-1/2 left-1/2 origin-center -translate-x-1/2 -translate-y-1/2 scale-75" />
    </span>
  )
}

function VaultAvatar({
  vault,
  className,
  size = "default",
}: {
  vault: VaultEntry
  className?: string
  size?: "default" | "sm" | "lg"
}) {
  const initials = getVaultInitials(vault.name)
  return (
    <Avatar size={size} className={cn("size-6! shrink-0", className)}>
      {/* The owner's GitHub avatar, falling back to the initial offline. */}
      <AvatarImage
        src={`https://github.com/${vault.remote.split("/")[0]}.png?size=48`}
        alt=""
        className="rounded-md"
      />
      <AvatarFallback className="bg-primary text-primary-foreground rounded-md text-sm">
        {initials}
      </AvatarFallback>
    </Avatar>
  )
}

function VaultItem({
  vault,
  isActive,
  onSelect,
}: {
  vault: VaultEntry
  isActive: boolean
  onSelect: (remote: string) => void
}) {
  return (
    <DropdownMenuItem onClick={() => onSelect(vault.remote)}>
      <VaultAvatar vault={vault} />
      <div className="flex items-center gap-1">
        <span className="truncate text-sm">{vault.name}</span>
      </div>
      {isActive && (
        <CheckIcon aria-hidden="true" className="ml-auto size-3.5" />
      )}
    </DropdownMenuItem>
  )
}

export function VaultSwitcher({ onAddVault }: { onAddVault: () => void }) {
  const vaults = useAtomValue(vaultsAtom)
  const activeRemote = useAtomValue(activeRemoteAtom)
  // Asks first when leaving would cost something (`state/vault-switch.ts`).
  const switchVault = useSetAtom(switchVaultAtom)
  const active = vaults.find((vault) => vault.remote === activeRemote)

  return (
    <SidebarMenu>
      {/* Sidebar */}
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton className="h-9" aria-label="Switch vault">
              <SidebarLogo />
              <div className="truncate font-semibold">{active?.name}</div>
              <MoreHorizontalIcon
                aria-hidden="true"
                className="ml-auto size-3.5 opacity-60"
              />
            </SidebarMenuButton>
          </DropdownMenuTrigger>

          <DropdownMenuContent side="bottom" align="start" sideOffset={4}>
            <DropdownMenuGroup>
              <DropdownMenuLabel>Vaults</DropdownMenuLabel>
              <DropdownMenuGroup>
                {vaults.map((vault) => (
                  <VaultItem
                    key={vault.remote}
                    vault={vault}
                    isActive={vault.remote === activeRemote}
                    onSelect={switchVault}
                  />
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onAddVault}>
                <PlusIcon aria-hidden="true" className="mx-1 size-4" />
                <div className="flex flex-col items-start">
                  <span className="text-sm">New vault</span>
                  <span className="text-muted-foreground ml-auto text-xs">
                    Start one, or join your team's.
                  </span>
                </div>
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
