import * as React from "react"
import { useAtomValue } from "jotai"
import { useEffect, useMemo, useRef, useState } from "react"
import { cn } from "@/lib/cn"

import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { runningPluginsAtom } from "@/state/plugins"
import { NEW_THREAD_ID, type ThreadRecord } from "./data"
import { NavUser } from "./nav-user"
import { ReuiMark } from "./reui-mark"
import { BookOpenIcon, StarIcon, HelpCircleIcon, MoreHorizontalIcon, PinOffIcon, Pin, PencilIcon, Share2Icon, ArchiveIcon, Trash2Icon, ChevronDownIcon, PanelLeftIcon, PlusIcon, SearchIcon, FolderIcon, ClockIcon, Settings2Icon, MessageSquareIcon } from "lucide-react"

type SidebarSection = "chats" | "agents"

const SECONDARY_LINKS = [
  {
    id: "docs",
    label: "Docs",
    icon: (
      <BookOpenIcon aria-hidden="true" />
    ),
  },
  {
    id: "whats-new",
    label: "What is new",
    icon: (
      <StarIcon aria-hidden="true" />
    ),
  },
  {
    id: "help",
    label: "Help",
    icon: (
      <HelpCircleIcon aria-hidden="true" />
    ),
  },
]

/**
 * Long titles slide by their overflow on hover; base duration is the leave
 * speed, hover the read speed. The edge fade shows only while text is hidden.
 */
function ThreadTitle({ title }: { title: string }) {
  const viewportRef = useRef<HTMLSpanElement>(null)
  const [overflowing, setOverflowing] = useState(false)

  // The rail resizes on collapse, so remeasure rather than trusting first paint.
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const measure = () =>
      setOverflowing(viewport.scrollWidth > viewport.clientWidth + 1)
    measure()
    const resizeObserver = new ResizeObserver(measure)
    resizeObserver.observe(viewport)
    const text = viewport.firstElementChild
    if (text) resizeObserver.observe(text)
    return () => resizeObserver.disconnect()
  }, [title])

  return (
    <span
      ref={viewportRef}
      data-overflowing={overflowing || undefined}
      className="@container block min-w-0 flex-1 overflow-hidden data-overflowing:[mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent)] group-hover/row:data-overflowing:[mask-image:linear-gradient(to_right,transparent,#000_1.5rem,#000_calc(100%-1.5rem),transparent)]"
    >
      <span className="inline-block max-w-none whitespace-nowrap transition-transform duration-150 ease-linear group-hover/row:[transform:translateX(min(0px,calc(100cqw_-_100%)))] group-hover/row:duration-[2500ms] motion-reduce:transform-none motion-reduce:transition-none">
        {title}
      </span>
    </span>
  )
}

function RailThreadMenu({
  label,
  threads,
  activeId,
  onSelect,
  children,
}: {
  label: string
  threads: ThreadRecord[]
  activeId: string
  onSelect: (id: string) => void
  children: React.ReactNode
}) {
  if (threads.length === 0) return null

  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            tooltip={label}
            aria-label={`${label} chats`}
            className="hover:bg-foreground/5 data-active:bg-foreground/10 data-active:hover:bg-foreground/12 size-8 p-2 [&>span:last-child]:sr-only"
          >
            {children}
            <span>{label}</span>
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="right"
          align="start"
          className="w-64 [&_[data-slot=dropdown-menu-item]]:gap-3 [&_[data-slot=dropdown-menu-item]]:py-2"
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-muted-foreground pb-1 text-xs font-normal">
              {label}
            </DropdownMenuLabel>
            {threads.map((thread) => (
              <DropdownMenuItem
                key={thread.id}
                onClick={() => onSelect(thread.id)}
                className={cn(
                  "group/row",
                  thread.id === activeId && "bg-foreground/10"
                )}
              >
                <ThreadTitle title={thread.title} />
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                  {thread.updatedLabel}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  )
}

function ThreadActions({
  thread,
  onTogglePin,
}: {
  thread: ThreadRecord
  onTogglePin: (id: string) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuAction
          showOnHover
          aria-label={`Actions for ${thread.title}`}
        >
          <MoreHorizontalIcon aria-hidden="true" />
        </SidebarMenuAction>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start" className="w-44">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => onTogglePin(thread.id)}>
            {thread.pinned ? (
              <PinOffIcon aria-hidden="true" />
            ) : (
              <Pin aria-hidden="true" />
            )}
            {thread.pinned ? "Unpin" : "Pin to top"}
          </DropdownMenuItem>
          <DropdownMenuItem>
            <PencilIcon aria-hidden="true" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem>
            <Share2Icon aria-hidden="true" />
            Share link
          </DropdownMenuItem>
          <DropdownMenuItem>
            <ArchiveIcon aria-hidden="true" />
            Archive
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive">
          <Trash2Icon aria-hidden="true" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ThreadRow({
  thread,
  active,
  onSelect,
  onTogglePin,
}: {
  thread: ThreadRecord
  active: boolean
  onSelect: (id: string) => void
  onTogglePin: (id: string) => void
}) {
  return (
    <SidebarMenuItem className="group/row">
      <SidebarMenuButton
        isActive={active}
        onClick={() => onSelect(thread.id)}
        className="hover:bg-foreground/5 data-active:bg-foreground/10 data-active:hover:bg-foreground/12 pe-2 transition-[padding] duration-200 ease-out group-focus-within/menu-item:pe-14 group-hover/menu-item:pe-14 max-md:pe-9"
      >
        <ThreadTitle title={thread.title} />
      </SidebarMenuButton>

      {/* Pin toggles inline; the label and glyph name the action it will take. */}
      <SidebarMenuAction
        showOnHover
        aria-label={
          thread.pinned ? `Unpin ${thread.title}` : `Pin ${thread.title}`
        }
        onClick={() => onTogglePin(thread.id)}
        className="end-7 max-md:hidden"
      >
        {thread.pinned ? (
          <PinOffIcon aria-hidden="true" />
        ) : (
          <Pin aria-hidden="true" />
        )}
      </SidebarMenuAction>

      <ThreadActions thread={thread} onTogglePin={onTogglePin} />
    </SidebarMenuItem>
  )
}

function ThreadGroup({
  label,
  threads,
  activeId,
  defaultOpen = true,
  onSelect,
  onTogglePin,
}: {
  label: string
  threads: ThreadRecord[]
  activeId: string
  defaultOpen?: boolean
  onSelect: (id: string) => void
  onTogglePin: (id: string) => void
}) {
  if (threads.length === 0) return null

  return (
    <Collapsible defaultOpen={defaultOpen}>
      <SidebarGroup className="py-1">
        {/* SidebarGroupLabel is a div, so no native button semantics; the open
            marker rides the trigger, which carries it in both bases. */}
        <CollapsibleTrigger asChild>
          <SidebarGroupLabel className="group/collapsible hover:text-foreground w-full cursor-pointer">
            {label}
            <span className="text-muted-foreground ms-auto text-xs tabular-nums">
              {threads.length}
            </span>
            <ChevronDownIcon className="ms-1 size-4 transition-transform group-data-[state=open]/collapsible:rotate-180" aria-hidden="true" />
          </SidebarGroupLabel>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {threads.map((thread) => (
                <ThreadRow
                  key={thread.id}
                  thread={thread}
                  active={thread.id === activeId}
                  onSelect={onSelect}
                  onTogglePin={onTogglePin}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  )
}

export function ThreadSidebar({
  threads,
  activeId,
  collapsed = false,
  onSelect,
  onNewChat,
  onTogglePin,
  onToggle,
  onOpenSearch,
}: {
  threads: ThreadRecord[]
  activeId: string
  /** Rail mode: the list is closed but the shell keeps its spine. */
  collapsed?: boolean
  onSelect: (id: string) => void
  onNewChat: () => void
  onTogglePin: (id: string) => void
  onToggle: () => void
  onOpenSearch: () => void
}) {
  const [section, setSection] = useState<SidebarSection>("chats")
  const { isMobile } = useSidebar()
  const AgentsSidebar = useAtomValue(runningPluginsAtom).find(
    (plugin) => plugin.agentsMode
  )?.agentsMode?.sidebar

  const { pinned, recent } = useMemo(
    () => ({
      pinned: threads.filter((thread) => thread.pinned),
      recent: threads.filter((thread) => !thread.pinned),
    }),
    [threads]
  )

  const empty = pinned.length + recent.length === 0

  if (collapsed) {
    // Same SidebarMenuButton as the expanded nav, so hover, active and the
    // label transition are the primitive's, not a second implementation.
    return (
      <Sidebar collapsible="none" className="h-full w-full overflow-hidden">
        {/* No bottom inset: the rail rows then start where the expanded nav rows do. */}
        <SidebarHeader className="px-2 pt-2 pb-0">
          <SidebarMenu className="gap-0.5">
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Expand sidebar"
                onClick={onToggle}
                aria-label="Expand sidebar"
                className="hover:bg-foreground/5 data-active:bg-foreground/10 data-active:hover:bg-foreground/12 size-8 p-2 [&>span:last-child]:sr-only"
              >
                <PanelLeftIcon aria-hidden="true" />
                <span>Expand sidebar</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent className="overflow-hidden">
          <SidebarMenu className="gap-0.5 px-2 pt-2">
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="New chat"
                onClick={onNewChat}
                aria-label="New chat"
                className="hover:bg-foreground/5 data-active:bg-foreground/10 data-active:hover:bg-foreground/12 size-8 p-2 [&>span:last-child]:sr-only"
              >
                <PlusIcon aria-hidden="true" />
                <span>New Chat</span>
              </SidebarMenuButton>
            </SidebarMenuItem>

            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Search chats"
                onClick={onOpenSearch}
                aria-label="Search chats"
                className="hover:bg-foreground/5 data-active:bg-foreground/10 data-active:hover:bg-foreground/12 size-8 p-2 [&>span:last-child]:sr-only"
              >
                <SearchIcon aria-hidden="true" />
                <span>Search</span>
              </SidebarMenuButton>
            </SidebarMenuItem>

            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Projects"
                className="hover:bg-foreground/5 data-active:bg-foreground/10 data-active:hover:bg-foreground/12 size-8 p-2 [&>span:last-child]:sr-only"
              >
                <FolderIcon aria-hidden="true" />
                <span>Projects</span>
              </SidebarMenuButton>
            </SidebarMenuItem>

            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Scheduled"
                className="hover:bg-foreground/5 data-active:bg-foreground/10 data-active:hover:bg-foreground/12 size-8 p-2 [&>span:last-child]:sr-only"
              >
                <ClockIcon aria-hidden="true" />
                <span>Scheduled</span>
              </SidebarMenuButton>
            </SidebarMenuItem>

            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Customize"
                className="hover:bg-foreground/5 data-active:bg-foreground/10 data-active:hover:bg-foreground/12 size-8 p-2 [&>span:last-child]:sr-only"
              >
                <Settings2Icon aria-hidden="true" />
                <span>Customize</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>

          <SidebarSeparator className="mx-2 my-1 w-auto" />

          <SidebarMenu className="gap-0.5 px-2">
            <RailThreadMenu
              label="Pinned"
              threads={pinned}
              activeId={activeId}
              onSelect={onSelect}
            >
              <Pin aria-hidden="true" />
            </RailThreadMenu>

            <RailThreadMenu
              label="Recent"
              threads={recent}
              activeId={activeId}
              onSelect={onSelect}
            >
              <MessageSquareIcon aria-hidden="true" />
            </RailThreadMenu>
          </SidebarMenu>
        </SidebarContent>

        <SidebarFooter className="gap-1 px-2 pb-3">
          <SidebarMenu className="gap-0.5">
            {SECONDARY_LINKS.map((link) => (
              <SidebarMenuItem key={link.id}>
                <SidebarMenuButton
                  tooltip={link.label}
                  className="hover:bg-foreground/5 data-active:bg-foreground/10 data-active:hover:bg-foreground/12 size-8 p-2 [&>span:last-child]:sr-only"
                >
                  {link.icon}
                  <span>{link.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
          <NavUser
            collapsed
          />
        </SidebarFooter>
      </Sidebar>
    )
  }

  return (
    <Sidebar collapsible="none" className="h-full w-full">
      <SidebarHeader className="gap-2">
        <div className="flex items-center gap-2 px-1 pt-1">
          <ReuiMark />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">
            ReUI Chat
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Search chats"
            onClick={onOpenSearch}
          >
            <SearchIcon aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={isMobile ? "Close chats" : "Collapse sidebar"}
            onClick={onToggle}
          >
            <PanelLeftIcon aria-hidden="true" />
          </Button>
        </div>
      </SidebarHeader>

      {/* Two equal tabs: the body below switches with them. */}
      <SidebarContent>
        <div className="px-2 py-3">
          <Tabs
            value={section}
            onValueChange={(value) =>
              value && setSection(value as SidebarSection)
            }
          >
            <TabsList className="bg-foreground/5 grid w-full grid-cols-2">
              <TabsTrigger value="chats">Chats</TabsTrigger>
              <TabsTrigger value="agents">Agents</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {section === "chats" ? (
        <>
        <SidebarMenu className="gap-0.5 px-2">
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={activeId === NEW_THREAD_ID}
              onClick={onNewChat}
              className="hover:bg-foreground/5 data-active:bg-foreground/10 data-active:hover:bg-foreground/12"
            >
              <PlusIcon aria-hidden="true" />
              <span>New Chat</span>
            </SidebarMenuButton>
          </SidebarMenuItem>

          <SidebarMenuItem>
            <SidebarMenuButton className="hover:bg-foreground/5 data-active:bg-foreground/10 data-active:hover:bg-foreground/12">
              <FolderIcon aria-hidden="true" />
              <span>Projects</span>
              <SidebarMenuBadge>4</SidebarMenuBadge>
            </SidebarMenuButton>
          </SidebarMenuItem>

          <SidebarMenuItem>
            <SidebarMenuButton className="hover:bg-foreground/5 data-active:bg-foreground/10 data-active:hover:bg-foreground/12">
              <ClockIcon aria-hidden="true" />
              <span>Scheduled</span>
              <SidebarMenuBadge>2</SidebarMenuBadge>
            </SidebarMenuButton>
          </SidebarMenuItem>

          <SidebarMenuItem>
            <SidebarMenuButton className="hover:bg-foreground/5 data-active:bg-foreground/10 data-active:hover:bg-foreground/12">
              <Settings2Icon aria-hidden="true" />
              <span>Customize</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>

        <SidebarSeparator className="mx-0 my-3" />
        </>
        ) : null}

        {section === "agents" ? (
          // The agent plugin's own sidebar: Inbox, Automations, Holis, sessions.
          AgentsSidebar ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <AgentsSidebar />
            </div>
          ) : null
        ) : null}

        {section === "chats" ? (
          <nav aria-label="Chat threads">
            <ThreadGroup
              label="Pinned"
              threads={pinned}
              activeId={activeId}
              onSelect={onSelect}
              onTogglePin={onTogglePin}
            />
            <ThreadGroup
              label="Recent"
              threads={recent}
              activeId={activeId}
              onSelect={onSelect}
              onTogglePin={onTogglePin}
            />
          </nav>
        ) : null}

        {empty && section === "chats" ? (
          <Empty className="border-0 bg-transparent py-8">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SearchIcon aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>No Chats Yet</EmptyTitle>
              <EmptyDescription>
                Start one and it will show up here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
      </SidebarContent>

      <SidebarFooter className="gap-2">
        {/* Secondary links: useful, but never competing with the main nav. */}
        <SidebarMenu className="gap-0.5">
          {SECONDARY_LINKS.map((link) => (
            <SidebarMenuItem key={link.id}>
              <SidebarMenuButton
                size="sm"
                className="text-muted-foreground hover:text-foreground hover:bg-foreground/5 data-active:bg-foreground/10 data-active:hover:bg-foreground/12"
              >
                {link.icon}
                <span>{link.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>

        <NavUser />
      </SidebarFooter>
    </Sidebar>
  )
}