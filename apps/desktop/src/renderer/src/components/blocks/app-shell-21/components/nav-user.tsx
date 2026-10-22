// Who is signed in and which vault is open (ReUI app-shell-21's account menu,
// wired to Holi): the block's organizations are this machine's vaults, and
// picking one switches to it, asking first when leaving would stop something.
import { useAtomValue, useSetAtom } from "jotai"
import {
  CheckIcon,
  ExternalLinkIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  MoreHorizontalIcon,
  PaletteIcon,
  PlusIcon,
  SunIcon,
} from "lucide-react"
import type { ColorScheme } from "@holi/shared"
import { cn } from "@/lib/cn"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { colorSchemeAtom, writeColorSchemeAtom } from "@/state/color-scheme"
import { sessionAtom, signOutAtom } from "@/state/session"
import { switchVaultAtom } from "@/state/vault-switch"
import { activeRemoteAtom, vaultsAtom } from "@/state/vaults"

// ── Vault Logos ──

/** The block's three workspace gradients; a vault gets one by its remote. */
const GRADIENTS = [
  ["#6366f1", "#8b5cf6", "#ec4899"],
  ["#0ea5e9", "#06b6d4", "#10b981"],
  ["#f97316", "#f59e0b", "#84cc16"],
]

function gradientFor(remote: string) {
  let hash = 0
  for (const char of remote) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return GRADIENTS[Math.abs(hash) % GRADIENTS.length]!
}

function VaultLogo({
  remote,
  className,
}: {
  remote: string
  className?: string
}) {
  const [from, via, to] = gradientFor(remote)
  const id = `vault-logo-${remote.replace(/[^a-z0-9]/gi, "-")}`
  return (
    <svg
      viewBox="0 0 28 28"
      fill="none"
      width="100%"
      height="100%"
      className={cn("shrink-0", className)}
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id={id}
          x1="0"
          y1="0"
          x2="28"
          y2="28"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor={from} />
          <stop offset="50%" stopColor={via} />
          <stop offset="100%" stopColor={to} />
        </linearGradient>
      </defs>
      <circle cx="14" cy="14" r="14" fill={`url(#${id})`} />
    </svg>
  )
}

// ── Theme Toggle ──

const THEMES = [
  { value: "light", label: "Light", icon: <SunIcon aria-hidden="true" /> },
  { value: "dark", label: "Dark", icon: <MoonIcon aria-hidden="true" /> },
  {
    value: "system",
    label: "System",
    icon: <MonitorIcon aria-hidden="true" />,
  },
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
      spacing={0}
      size="sm"
      aria-label="Theme"
    >
      {THEMES.map(({ value, label, icon }) => (
        <ToggleGroupItem key={value} value={value} aria-label={label}>
          {icon}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

// ── Menu ──

function WorkspaceMenuContent({ onAddVault }: { onAddVault: () => void }) {
  const vaults = useAtomValue(vaultsAtom)
  const active = useAtomValue(activeRemoteAtom)
  const session = useAtomValue(sessionAtom)
  const switchVault = useSetAtom(switchVaultAtom)
  const signOut = useSetAtom(signOutAtom)

  return (
    <DropdownMenuContent side="right" align="end" sideOffset={8} className="w-60">
      <DropdownMenuGroup>
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
          Vaults
        </DropdownMenuLabel>
        {vaults.map((vault) => (
          <DropdownMenuItem
            key={vault.remote}
            onClick={() => switchVault(vault.remote)}
          >
            <VaultLogo remote={vault.remote} className="size-5!" />
            <span className="flex-1 truncate text-sm font-medium">
              {vault.name}
            </span>
            {vault.remote === active && (
              <CheckIcon
                className="ml-auto shrink-0 opacity-60"
                aria-hidden="true"
              />
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onClick={onAddVault}>
          <PlusIcon aria-hidden="true" className="mx-0.5" />
          Add Vault
        </DropdownMenuItem>
      </DropdownMenuGroup>

      <DropdownMenuSeparator />

      <DropdownMenuGroup>
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
          Account
        </DropdownMenuLabel>
        {session ? (
          <DropdownMenuItem
            onClick={() =>
              void window.holi.openExternal(
                `https://github.com/${session.login}`
              )
            }
          >
            <ExternalLinkIcon aria-hidden="true" />
            GitHub Profile
          </DropdownMenuItem>
        ) : null}
        {/* The swatches set a value in place, so the menu outlives the click. */}
        <DropdownMenuItem
          onSelect={(event) => event.preventDefault()}
          className="cursor-default focus:bg-transparent!"
        >
          <PaletteIcon aria-hidden="true" />
          Theme
          <div className="ml-auto">
            <ThemeSegmentedToggle />
          </div>
        </DropdownMenuItem>
      </DropdownMenuGroup>

      <DropdownMenuSeparator />

      <DropdownMenuGroup>
        <DropdownMenuItem onClick={() => void signOut()}>
          <LogOutIcon aria-hidden="true" />
          Sign Out
        </DropdownMenuItem>
      </DropdownMenuGroup>
    </DropdownMenuContent>
  )
}

export function NavUser({
  collapsed = false,
  onAddVault,
}: {
  collapsed?: boolean
  onAddVault: () => void
}) {
  const session = useAtomValue(sessionAtom)
  const vaults = useAtomValue(vaultsAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const vault = vaults.find((v) => v.remote === remote)
  if (!session) return null
  const name = session.name ?? session.login
  const initials = name
    .split(/\s+/)
    .map((part) => part.charAt(0))
    .join("")
    .slice(0, 2)
    .toUpperCase()

  // Rail mode: the avatar is the whole control, and the menu is unchanged.
  if (collapsed) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Account and vault menu"
            className="size-8 shrink-0 rounded-full"
          >
            <Avatar className="size-7">
              <AvatarImage src={session.avatarUrl} alt="" />
              <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <WorkspaceMenuContent onAddVault={onAddVault} />
      </DropdownMenu>
    )
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            className="border-border bg-background hover:bg-accent h-auto rounded-lg border py-1.5 ps-1.5 pe-1.5"
            asChild
          >
            <SidebarMenuButton aria-label="Open account and vault menu">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <Avatar className="size-8 shrink-0 in-data-[state=collapsed]:size-6!">
                  <AvatarImage src={session.avatarUrl} alt={name} />
                  <AvatarFallback className="text-[10px] font-semibold">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px] leading-4 font-medium">
                    {name}
                  </span>
                  {/* leading-none on the text so the mark and label centre on
                    the same axis instead of sitting on a baseline. */}
                  {vault ? (
                    <span className="flex min-w-0 items-center gap-1 leading-none">
                      <VaultLogo remote={vault.remote} className="block size-3!" />
                      <span className="text-muted-foreground truncate text-[11px] leading-none">
                        {vault.name}
                      </span>
                    </span>
                  ) : null}
                </div>
              </div>
              <MoreHorizontalIcon
                className="mr-1 ml-auto size-4 shrink-0 opacity-50"
                aria-hidden="true"
              />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <WorkspaceMenuContent onAddVault={onAddVault} />
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
