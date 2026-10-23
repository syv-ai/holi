import type { ReactNode } from "react"
import { useAtomValue, useSetAtom } from "jotai"
import type { ColorScheme, WindowGlass } from "@holi/shared"

import { colorSchemeAtom, writeColorSchemeAtom } from "@/state/color-scheme"
import { windowGlassAtom, writeWindowGlassAtom } from "@/state/window-glass"
import { sessionAtom, signOutAtom } from "@/state/session"

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
  useSidebar,
} from "@/components/ui/sidebar"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  SunIcon,
  MoonIcon,
  MonitorIcon,
  UserIcon,
  SlidersHorizontalIcon,
  SettingsIcon,
  KeyboardIcon,
  PaletteIcon,
  BlendIcon,
  SquareDashedIcon,
  SquareIcon,
  LogOutIcon,
  BugIcon,
  HelpCircleIcon,
  MoreHorizontalIcon,
} from "lucide-react"

// ── Theme Toggle ──

const THEMES: { value: ColorScheme; label: string; icon: ReactNode }[] = [
  {
    value: "light",
    label: "Light",
    icon: <SunIcon aria-hidden="true" />,
  },
  {
    value: "dark",
    label: "Dark",
    icon: <MoonIcon aria-hidden="true" />,
  },
  {
    value: "system",
    label: "System",
    icon: <MonitorIcon aria-hidden="true" />,
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

// ── Transparency Toggle ──

const GLASSES: { value: WindowGlass; label: string; icon: ReactNode }[] = [
  {
    value: "clear",
    label: "Clear",
    icon: <SquareDashedIcon aria-hidden="true" />,
  },
  {
    value: "frosted",
    label: "Frosted",
    icon: <BlendIcon aria-hidden="true" />,
  },
  { value: "solid", label: "Solid", icon: <SquareIcon aria-hidden="true" /> },
]

function GlassSegmentedToggle() {
  const current = useAtomValue(windowGlassAtom)
  const setGlass = useSetAtom(writeWindowGlassAtom)

  return (
    <ToggleGroup
      type="single"
      value={current}
      onValueChange={(value) => value && void setGlass(value as WindowGlass)}
      variant="outline"
      spacing={0}
      size="sm"
      aria-label="Transparency"
    >
      {GLASSES.map(({ value, label, icon }) => (
        <ToggleGroupItem key={value} value={value} aria-label={label}>
          {icon}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

/** The window is glass only on a Mac, so only there is there anything to set.
 *  Read at render: `main.tsx` stamps the platform after the modules load. */
function isMac() {
  return document.documentElement.dataset.platform === "mac"
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
        {isMac() ? (
          <DropdownMenuItem
            onSelect={(event) => event.preventDefault()}
            className="cursor-default focus:bg-transparent!"
          >
            <BlendIcon aria-hidden="true" />
            Transparency
            <div className="ml-auto">
              <GlassSegmentedToggle />
            </div>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuGroup>

      <DropdownMenuSeparator />

      <DropdownMenuGroup>
        <DropdownMenuItem
          onSelect={() =>
            void window.holi.openExternal(
              "https://github.com/syv-ai/holi/issues/new"
            )
          }
        >
          <BugIcon aria-hidden="true" />
          File issue
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() =>
            void window.holi.openExternal(
              "https://github.com/syv-ai/holi/tree/main/docs"
            )
          }
        >
          <HelpCircleIcon aria-hidden="true" />
          Help
        </DropdownMenuItem>
      </DropdownMenuGroup>

      <DropdownMenuSeparator />

      <DropdownMenuGroup>
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOutIcon aria-hidden="true" />
          Sign out
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
              <AvatarFallback className="text-xs">{initials}</AvatarFallback>
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
            className="hover:bg-foreground/5 h-auto rounded-lg bg-transparent py-1.5 ps-1.5 pe-1.5"
            asChild
          >
            <SidebarMenuButton aria-label="Open account menu">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <Avatar className="size-8 shrink-0">
                  <AvatarImage src={viewer?.avatarUrl} alt="" />
                  <AvatarFallback className="text-xs font-semibold">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium">{name}</span>
                  <span className="text-muted-foreground truncate text-xs">
                    @{viewer?.login}
                  </span>
                </div>
              </div>
              <MoreHorizontalIcon
                className="mr-1 ml-auto size-4 shrink-0 opacity-50"
                aria-hidden="true"
              />
            </SidebarMenuButton>
          </DropdownMenuTrigger>

          <AccountMenuContent isMobile={isMobile} />
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
