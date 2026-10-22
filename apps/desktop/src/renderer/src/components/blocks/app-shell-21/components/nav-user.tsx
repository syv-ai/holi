import { type ComponentType } from "react"
import { cn } from "@/lib/cn"
import { useTheme } from "next-themes"

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
  DropdownMenuShortcut,
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
import { ACCOUNT, WORKSPACES, type Workspace } from "./data"
import { SunIcon, MoonIcon, MonitorIcon, CheckIcon, PlusIcon, UserIcon, CreditCardIcon, SettingsIcon, PaletteIcon, LogOutIcon, MoreHorizontalIcon } from "lucide-react"

// ── Workspace Logos ──

function AtlasLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 28 28"
      fill="none"
      width="100%"
      height="100%"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id="sb21-atlas"
          x1="0"
          y1="0"
          x2="28"
          y2="28"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="50%" stopColor="#8b5cf6" />
          <stop offset="100%" stopColor="#ec4899" />
        </linearGradient>
      </defs>
      <circle cx="14" cy="14" r="14" fill="url(#sb21-atlas)" />
    </svg>
  )
}

function RelayLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 28 28"
      fill="none"
      width="100%"
      height="100%"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id="sb21-relay"
          x1="0"
          y1="0"
          x2="28"
          y2="28"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#0ea5e9" />
          <stop offset="50%" stopColor="#06b6d4" />
          <stop offset="100%" stopColor="#10b981" />
        </linearGradient>
      </defs>
      <circle cx="14" cy="14" r="14" fill="url(#sb21-relay)" />
    </svg>
  )
}

function OrbitLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 28 28"
      fill="none"
      width="100%"
      height="100%"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id="sb21-orbit"
          x1="0"
          y1="0"
          x2="28"
          y2="28"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#f97316" />
          <stop offset="50%" stopColor="#f59e0b" />
          <stop offset="100%" stopColor="#84cc16" />
        </linearGradient>
      </defs>
      <circle cx="14" cy="14" r="14" fill="url(#sb21-orbit)" />
    </svg>
  )
}

const WORKSPACE_LOGOS: Record<string, ComponentType<{ className?: string }>> = {
  atlas: AtlasLogo,
  relay: RelayLogo,
  orbit: OrbitLogo,
}

// ── Theme Toggle ──

const THEMES = [
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
  const { theme, setTheme } = useTheme()
  // The menu mounts on open, long after the theme resolves: no hydration gate.
  const currentTheme = theme ?? "system"

  return (
    <ToggleGroup
      type="single"
      value={currentTheme}
      // A theme is always set, so pressing the active one again changes nothing.
      onValueChange={(value) => value && setTheme(value)}
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

// ── Workspace Avatar ──

function WorkspaceAvatar({
  workspace,
  className,
}: {
  workspace: Workspace
  className?: string
}) {
  const LogoComponent = WORKSPACE_LOGOS[workspace.id]

  if (LogoComponent) {
    return <LogoComponent className={cn("shrink-0", className)} />
  }

  return (
    <Avatar className={cn("shrink-0", className)}>
      <AvatarFallback className="bg-background border-border text-foreground border text-sm font-medium">
        {workspace.name.charAt(0).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  )
}

// ── Workspace Item ──

function WorkspaceItem({
  workspace,
  isActive,
  onSelect,
}: {
  workspace: Workspace
  isActive: boolean
  onSelect: (id: string) => void
}) {
  return (
    <DropdownMenuItem onClick={() => onSelect(workspace.id)}>
      <WorkspaceAvatar workspace={workspace} className="size-5!" />
      <span className="flex-1 truncate text-sm font-medium">
        {workspace.name}
      </span>
      {isActive && (
        <CheckIcon className="ml-auto shrink-0 opacity-60" aria-hidden="true" />
      )}
    </DropdownMenuItem>
  )
}

// ── Nav Workspace ──

function WorkspaceMenuContent({
  isMobile,
  activeWorkspaceId,
  onSelectWorkspace,
}: {
  isMobile: boolean
  activeWorkspaceId: string
  onSelectWorkspace: (id: string) => void
}) {
  return (
    <DropdownMenuContent
      side={isMobile ? "top" : "right"}
      align="end"
      sideOffset={8}
      className="w-60"
    >
      <DropdownMenuGroup>
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
          Organizations
        </DropdownMenuLabel>
        {WORKSPACES.map((workspace) => (
          <WorkspaceItem
            key={workspace.id}
            workspace={workspace}
            isActive={activeWorkspaceId === workspace.id}
            onSelect={onSelectWorkspace}
          />
        ))}
        <DropdownMenuItem>
          <PlusIcon aria-hidden="true" className="mx-0.5" />
          New Organization
        </DropdownMenuItem>
      </DropdownMenuGroup>

      <DropdownMenuSeparator />

      <DropdownMenuGroup>
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
          Account
        </DropdownMenuLabel>
        <DropdownMenuItem>
          <UserIcon aria-hidden="true" />
          Profile
          <DropdownMenuShortcut>⇧⌘P</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem>
          <CreditCardIcon aria-hidden="true" />
          Billing
        </DropdownMenuItem>
        <DropdownMenuItem>
          <SettingsIcon aria-hidden="true" />
          Preferences
        </DropdownMenuItem>
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
        <DropdownMenuItem>
          <LogOutIcon aria-hidden="true" />
          Sign Out
          <DropdownMenuShortcut>⇧⌘Q</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuGroup>
    </DropdownMenuContent>
  )
}

export function NavUser({
  collapsed = false,
  activeWorkspaceId,
  onSelectWorkspace,
}: {
  collapsed?: boolean
  activeWorkspaceId: string
  onSelectWorkspace: (id: string) => void
}) {
  const { isMobile } = useSidebar()

  const activeWorkspace =
    WORKSPACES.find((w) => w.id === activeWorkspaceId) ?? WORKSPACES[0]!

  // Rail mode: the avatar is the whole control, and the menu is unchanged.
  if (collapsed) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Account and workspace menu"
            className="size-8 shrink-0 rounded-full"
          >
            <Avatar className="size-7">
              <AvatarImage src={ACCOUNT.avatar} alt="" />
              <AvatarFallback className="text-[10px]">
                {ACCOUNT.initials}
              </AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <WorkspaceMenuContent
          isMobile={isMobile}
          activeWorkspaceId={activeWorkspaceId}
          onSelectWorkspace={onSelectWorkspace}
        />
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
            <SidebarMenuButton aria-label="Open workspace menu">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <Avatar className="size-8 shrink-0 in-data-[state=collapsed]:size-6!">
                  <AvatarImage src={ACCOUNT.avatar} alt={ACCOUNT.name} />
                  <AvatarFallback className="text-[10px] font-semibold">
                    {ACCOUNT.initials}
                  </AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px] leading-4 font-medium">
                    {ACCOUNT.name}
                  </span>
                  {/* leading-none on the text so the mark, dot and labels all
                    centre on the same axis instead of sitting on a baseline. */}
                  <span className="flex min-w-0 items-center gap-1 leading-none">
                    <WorkspaceAvatar
                      workspace={activeWorkspace}
                      className="block size-3!"
                    />
                    <span className="text-muted-foreground truncate text-[11px] leading-none">
                      {activeWorkspace.name}
                    </span>
                    <span
                      aria-hidden="true"
                      className="bg-muted-foreground/40 size-1 shrink-0 rounded-full"
                    />
                    <span className="text-muted-foreground shrink-0 text-[11px] leading-none">
                      {activeWorkspace.tier}
                    </span>
                  </span>
                </div>
              </div>
              <MoreHorizontalIcon className="mr-1 ml-auto size-4 shrink-0 opacity-50" aria-hidden="true" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>

          <WorkspaceMenuContent
            isMobile={isMobile}
            activeWorkspaceId={activeWorkspaceId}
            onSelectWorkspace={onSelectWorkspace}
          />
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}