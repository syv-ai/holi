/**
 * Who is signed in, and which vault is open (app-shell-21's account menu): the
 * avatar and name over the open vault, and one menu holding the vault picker,
 * the theme and sign-out. The block's organizations are Holi's vaults; picking
 * one switches to it, asking first when leaving would stop something.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import {
  CheckIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  MoreHorizontalIcon,
  PaletteIcon,
  PlusIcon,
  SunIcon,
} from 'lucide-react'
import type { ColorScheme } from '@holi/shared'
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icon,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  ToggleGroup,
  ToggleGroupItem,
} from '@/primitives'
import { colorSchemeAtom, writeColorSchemeAtom } from '@/state/color-scheme'
import { sessionAtom, signOutAtom } from '@/state/session'
import { switchVaultAtom } from '@/state/vault-switch'
import { activeRemoteAtom, vaultsAtom } from '@/state/vaults'

const THEMES: { value: ColorScheme; label: string; icon: typeof SunIcon }[] = [
  { value: 'light', label: 'Light', icon: SunIcon },
  { value: 'dark', label: 'Dark', icon: MoonIcon },
  { value: 'system', label: 'System', icon: MonitorIcon },
]

function ThemeSegmentedToggle() {
  const scheme = useAtomValue(colorSchemeAtom)
  const writeScheme = useSetAtom(writeColorSchemeAtom)
  return (
    <ToggleGroup
      type="single"
      value={scheme}
      // A theme is always set, so pressing the active one again changes nothing.
      onValueChange={(value) => value && void writeScheme(value as ColorScheme)}
      variant="outline"
      size="sm"
      aria-label="Theme"
    >
      {THEMES.map(({ value, label, icon: Glyph }) => (
        <ToggleGroupItem key={value} value={value} aria-label={label}>
          <Icon icon={Glyph} />
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

/** A vault's mark: its name's first letter on a quiet tile. */
function VaultMark({ name, className }: { name: string; className?: string }) {
  return (
    <Avatar className={className}>
      <AvatarFallback className="rounded-md border border-border bg-background text-xs font-medium text-foreground">
        {name.charAt(0).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  )
}

function AccountMenuContent({ onAddVault }: { onAddVault: () => void }) {
  const vaults = useAtomValue(vaultsAtom)
  const active = useAtomValue(activeRemoteAtom)
  const switchVault = useSetAtom(switchVaultAtom)
  const signOut = useSetAtom(signOutAtom)
  return (
    <DropdownMenuContent side="right" align="end" sideOffset={8} className="w-64">
      <DropdownMenuGroup>
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Vaults
        </DropdownMenuLabel>
        {vaults.map((vault) => (
          <DropdownMenuItem key={vault.remote} onSelect={() => switchVault(vault.remote)}>
            <VaultMark name={vault.name} className="size-5" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium">{vault.name}</span>
              <span className="truncate text-xs text-muted-foreground">{vault.remote}</span>
            </span>
            {vault.remote === active && (
              <Icon icon={CheckIcon} className="ms-auto shrink-0 opacity-60" />
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onSelect={onAddVault}>
          <Icon icon={PlusIcon} />
          Add vault…
        </DropdownMenuItem>
      </DropdownMenuGroup>

      <DropdownMenuSeparator />

      <DropdownMenuGroup>
        {/* The swatches set a value in place, so the menu outlives the click. */}
        <DropdownMenuItem
          onSelect={(event) => event.preventDefault()}
          className="cursor-default focus:bg-transparent"
        >
          <Icon icon={PaletteIcon} />
          Theme
          <div className="ms-auto">
            <ThemeSegmentedToggle />
          </div>
        </DropdownMenuItem>
      </DropdownMenuGroup>

      <DropdownMenuSeparator />

      <DropdownMenuItem onSelect={() => void signOut()}>
        <Icon icon={LogOutIcon} />
        Sign out
      </DropdownMenuItem>
    </DropdownMenuContent>
  )
}

export function NavUser({
  collapsed = false,
  onAddVault,
}: {
  collapsed?: boolean
  onAddVault: () => void
}): React.JSX.Element | null {
  const session = useAtomValue(sessionAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const vault = useAtomValue(vaultsAtom).find((v) => v.remote === remote)
  if (!session) return null
  const name = session.name ?? session.login
  const initials = name.charAt(0).toUpperCase()

  // Rail mode: the avatar is the whole control, and the menu is unchanged.
  if (collapsed) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            aria-label="Account and vaults"
            className="size-8 justify-center rounded-full p-0"
          >
            <Avatar className="size-7">
              <AvatarImage src={session.avatarUrl} alt="" />
              <AvatarFallback className="text-xs">{initials}</AvatarFallback>
            </Avatar>
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <AccountMenuContent onAddVault={onAddVault} />
      </DropdownMenu>
    )
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              aria-label="Account and vaults"
              className="h-auto rounded-lg border border-border bg-background p-1.5 hover:bg-accent"
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <Avatar className="size-8 shrink-0">
                  <AvatarImage src={session.avatarUrl} alt={name} />
                  <AvatarFallback className="text-xs font-semibold">{initials}</AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-sm leading-4 font-medium">{name}</span>
                  <span className="truncate text-xs leading-none text-muted-foreground">
                    {vault?.name ?? remote ?? 'No vault open'}
                  </span>
                </div>
              </div>
              <Icon icon={MoreHorizontalIcon} className="ms-auto me-1 size-4 shrink-0 opacity-50" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <AccountMenuContent onAddVault={onAddVault} />
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
