"use client"

import { Badge } from "@/components/reui/badge"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useSidebar } from "@/components/ui/sidebar"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { MODELS } from "./data"
import { PlusIcon, XIcon, Share2Icon, DownloadIcon, PencilIcon, BookmarkIcon, ChevronDownIcon, EllipsisVerticalIcon, Trash2Icon } from "lucide-react"

const THREAD_ACTIONS = [
  {
    id: "share",
    label: "Share chat",
    icon: (
      <Share2Icon aria-hidden="true" />
    ),
  },
  {
    id: "export",
    label: "Export transcript",
    icon: (
      <DownloadIcon aria-hidden="true" />
    ),
  },
  {
    id: "rename",
    label: "Rename",
    icon: (
      <PencilIcon aria-hidden="true" />
    ),
  },
]

export type HeaderTab = { id: string; title: string }

export function SiteHeader({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab,
  modelId,
  memoryOn,
  onModelChange,
  onToggleMemory,
}: {
  tabs: HeaderTab[]
  activeTabId: string | null
  onSelectTab: (id: string) => void
  onCloseTab: (id: string) => void
  onNewTab: () => void
  modelId: string
  memoryOn: boolean
  onModelChange: (id: string) => void
  onToggleMemory: () => void
}) {
  const activeModel = MODELS.find((model) => model.id === modelId) ?? MODELS[0]!
  // Collapsed, the header starts beside the rail, under macOS's window buttons.
  const { state } = useSidebar()

  return (
    // Sits above the content column, not over it: the column below owns the
    // scroll, so z-10 keeps the fade masking its top edge.
    <header
      data-slot="site-header"
      data-sidebar={state}
      className="app-drag bg-background after:from-background relative z-10 flex h-12 shrink-0 items-center gap-2 px-3 after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-6 after:bg-gradient-to-b after:to-transparent sm:px-4 md:h-14"
    >
      <Tabs
        value={activeTabId ?? ""}
        onValueChange={onSelectTab}
        className="min-w-0 flex-1 items-center gap-1 data-horizontal:flex-row"
      >
        {tabs.length > 0 ? (
          <TabsList className="min-w-0 justify-start overflow-x-auto">
            {tabs.map((tab) => (
              // The close button is the trigger's sibling: a button cannot
              // hold another button.
              <div key={tab.id} className="group/tab relative flex h-full">
                <TabsTrigger value={tab.id} className="max-w-48 flex-none pe-7">
                  <span className="truncate">{tab.title}</span>
                </TabsTrigger>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Close ${tab.title}`}
                  onClick={() => onCloseTab(tab.id)}
                  className="absolute end-0.5 top-1/2 -translate-y-1/2 opacity-0 group-hover/tab:opacity-100 group-has-data-active/tab:opacity-100 focus-visible:opacity-100"
                >
                  <XIcon aria-hidden="true" />
                </Button>
              </div>
            ))}
          </TabsList>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="New tab"
              onClick={onNewTab}
            >
              <PlusIcon aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>New tab</TooltipContent>
        </Tooltip>
      </Tabs>

      {/* A filled variant, not a tint: the primary token reads as the
          foreground here, so colour alone would not show the state. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={memoryOn ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label="Chat memory"
            aria-pressed={memoryOn}
            onClick={onToggleMemory}
            className="hidden sm:inline-flex"
          >
            <BookmarkIcon aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {memoryOn ? "Memory on for this chat" : "Memory off for this chat"}
        </TooltipContent>
      </Tooltip>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5">
            <span className="max-w-28 truncate sm:max-w-none">
              {activeModel.name}
            </span>
            <ChevronDownIcon data-icon="inline-end" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
              Model
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuRadioGroup
            value={modelId}
            onValueChange={(value) => value && onModelChange(value)}
          >
            {MODELS.map((model) => (
              <DropdownMenuRadioItem
                key={model.id}
                value={model.id}
                className="items-start gap-2 py-1.5"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-sm/5 font-medium">
                      {model.name}
                    </span>
                    {model.recommended ? (
                      <Badge variant="primary-light">Default</Badge>
                    ) : null}
                  </span>
                  <span className="text-muted-foreground truncate text-[11px]/4">
                    {model.provider}
                    <span
                      aria-hidden="true"
                      className="bg-muted-foreground/40 mx-1.5 inline-block size-1 rounded-full align-middle"
                    />
                    <span className="tabular-nums">{model.context}</span>{" "}
                    context
                    <span
                      aria-hidden="true"
                      className="bg-muted-foreground/40 mx-1.5 inline-block size-1 rounded-full align-middle"
                    />
                    {model.capability}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>

          <DropdownMenuSeparator />

          <div className="text-muted-foreground flex items-center justify-between gap-2 px-1.5 py-1 text-[11px]">
            <span>Switching keeps this chat</span>
            <a href="#models" className="underline underline-offset-4">
              Compare
            </a>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Chat options">
            <EllipsisVerticalIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {/* Phones have no room for the memory button, so it lives here;
              a toggle sets a value in place, so the menu outlives the click. */}
          <DropdownMenuGroup className="sm:hidden">
            <DropdownMenuCheckboxItem
              checked={memoryOn}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={onToggleMemory}
            >
              <BookmarkIcon aria-hidden="true" />
              Chat memory
            </DropdownMenuCheckboxItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator className="sm:hidden" />
          <DropdownMenuGroup>
            <DropdownMenuLabel>This chat</DropdownMenuLabel>
            {THREAD_ACTIONS.map((action) => (
              <DropdownMenuItem key={action.id}>
                {action.icon}
                {action.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive">
            <Trash2Icon aria-hidden="true" />
            Delete chat
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  )
}