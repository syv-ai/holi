import type { ReactNode } from "react"
import { useAtomValue, useSetAtom } from "jotai"
import type { ColorScheme } from "@holi/shared"

import { colorSchemeAtom, writeColorSchemeAtom } from "@/state/color-scheme"
import { sessionAtom, signOutAtom } from "@/state/session"

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar"
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
  useSidebar,
} from "@/components/ui/sidebar"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group"
import { SunIcon, MoonIcon, MonitorIcon, UserIcon, SlidersHorizontalIcon, SettingsIcon, KeyboardIcon, PaletteIcon, LogOutIcon, MoreHorizontalIcon } from "lucide-react"

// ── Theme Toggle ──

const THEMES: { value: ColorScheme; label: string; icon: ReactNode }[] = [
  {
    value: "light",
    label: "Light",
    icon: (
      <SunIcon aria-hidden="true" />
    ),
  },
  {
    value: "dark",
    label: "Dark",
    icon: (
      <MoonIcon aria-hidden="true" />
    ),
  },
  {
    value: "system",
    label: "System",
    icon: (
      <MonitorIcon aria-hidden="true" />
    ),
  },
]

function ThemeSegmentedToggle() {
  // The vault's machine-local `colorScheme`, which `useColorScheme` stamps on
  // <html> as `data-theme`.
  const currentTheme = useAtomValue(colorSchemeAtom)
  const setTheme = useSetAtom(writeColorSchemeAtom)

  return (
    <ToggleGroup
      type="single"
      value={currentTheme}
      // A theme is always set, so pressing the active one again changes nothing.
      onValueChange={(value) => value && void setTheme(value as ColorScheme)}
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

// ── Account Menu ──

function AccountMenuContent({ isMobile }: { isMobile: boolean }) {
  const signOut = useSetAtom(signOutAtom)

  return (
    <DropdownMenuContent
      side={isMobile ? "top" : "right"}
      align="end"
      sideOffset={8}
      className="w-60"
    >
      <DropdownMenuGroup>
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
          Account
        </DropdownMenuLabel>
        <DropdownMenuItem>
          <UserIcon aria-hidden="true" />
          Profile
        </DropdownMenuItem>
        <DropdownMenuItem>
          <SlidersHorizontalIcon aria-hidden="true" />
          Preferences
        </DropdownMenuItem>
        <DropdownMenuItem>
          <SettingsIcon aria-hidden="true" />
          Settings
        </DropdownMenuItem>
        {/* TODO: open the keyboard shortcuts sheet once there is one. */}
        <DropdownMenuItem>
          <KeyboardIcon aria-hidden="true" />
          Keyboard shortcuts
        </DropdownMenuItem>
      </DropdownMenuGroup>

      <DropdownMenuSeparator />

      <DropdownMenuGroup>
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
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOutIcon aria-hidden="true" />
          Sign Out
        </DropdownMenuItem>
      </DropdownMenuGroup>
    </DropdownMenuContent>
  )
}

export function NavUser({ collapsed = false }: { collapsed?: boolean }) {
  const { isMobile } = useSidebar()
  const viewer = useAtomValue(sessionAtom)
  const name = viewer?.name ?? viewer?.login ?? ""
  const initials = name.slice(0, 2).toUpperCase()

  // Rail mode: the avatar is the whole control, and the menu is unchanged.
  if (collapsed) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Account menu"
            className="size-8 shrink-0 rounded-full"
          >
            <Avatar className="size-7">
              <AvatarImage src={viewer?.avatarUrl} alt="" />
              <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <AccountMenuContent isMobile={isMobile} />
      </DropdownMenu>
    )
  }

  return (
    <SidebarMenu>
      {/* Sidebar */}
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            className="border-border bg-background hover:bg-accent h-auto rounded-lg border py-1.5 ps-1.5 pe-1.5"
            asChild
          >
            <SidebarMenuButton aria-label="Open account menu">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <Avatar className="size-8 shrink-0 in-data-[state=collapsed]:size-6!">
                  <AvatarImage src={viewer?.avatarUrl} alt={name} />
                  <AvatarFallback className="text-[10px] font-semibold">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px] leading-4 font-medium">
                    {name}
                  </span>
                  <span className="text-muted-foreground truncate text-[11px] leading-none">
                    @{viewer?.login}
                  </span>
                </div>
              </div>
              <MoreHorizontalIcon className="mr-1 ml-auto size-4 shrink-0 opacity-50" aria-hidden="true" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>

          <AccountMenuContent isMobile={isMobile} />
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
