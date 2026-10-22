"use client"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  FileTextIcon,
  PlusIcon,
  XIcon,
  EllipsisVerticalIcon,
} from "lucide-react"

export type HeaderTab = { id: string; title: string }

export function SiteHeader({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onCloseAllTabs,
}: {
  tabs: HeaderTab[]
  activeTabId: string | null
  onSelectTab: (id: string) => void
  onCloseTab: (id: string) => void
  onNewTab: () => void
  onCloseAllTabs: () => void
}) {
  return (
    // A row, not a landmark: the title band holds it on desktop and the
    // mobile column's header on phones.
    <div
      data-slot="site-header"
      className="flex h-full min-w-0 flex-1 items-center gap-2 px-2"
    >
      <Tabs
        value={activeTabId ?? ""}
        onValueChange={onSelectTab}
        className="min-w-0 flex-1 items-center gap-1 data-horizontal:flex-row"
      >
        {tabs.length > 0 ? (
          <TabsList
            variant="line"
            className="min-w-0 justify-start overflow-x-auto group-data-horizontal/tabs:h-9"
          >
            {tabs.map((tab) => (
              // The close button is the trigger's sibling: a button cannot
              // hold another button.
              <div key={tab.id} className="group/tab relative flex h-full">
                <TabsTrigger
                  value={tab.id}
                  className="hover:bg-foreground/5 group-data-[variant=line]/tabs-list:data-active:bg-foreground/8 dark:group-data-[variant=line]/tabs-list:data-active:bg-foreground/8 w-56 flex-none justify-start gap-2 rounded-md px-3 pe-8 after:hidden"
                >
                  <FileTextIcon aria-hidden="true" />
                  <span className="truncate">{tab.title}</span>
                </TabsTrigger>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Close ${tab.title}`}
                  onClick={() => onCloseTab(tab.id)}
                  className="absolute end-1.5 top-1/2 -translate-y-1/2 opacity-0 group-hover/tab:opacity-100 group-has-data-active/tab:opacity-100 focus-visible:opacity-100"
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

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Tab options">
            <EllipsisVerticalIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem
            disabled={tabs.length === 0}
            onSelect={onCloseAllTabs}
          >
            <XIcon aria-hidden="true" />
            Close all tabs
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
