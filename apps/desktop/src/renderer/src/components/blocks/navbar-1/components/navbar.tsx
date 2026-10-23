import type { ReactNode } from "react"

import { Tabs } from "@/components/ui/tabs"

import type { Crumb, TabItem } from "./data"
import { NavbarCollaborators } from "./navbar-collaborators"
import { NavbarProject } from "./navbar-project"
import { NavbarTabs } from "./navbar-tabs"

// ── Navbar (two-row header + tab content panels) ──

export type NavbarProps = {
  crumbs: Crumb[]
  title: string
  /** Beside the title: the project's status. */
  status?: ReactNode
  /** Right of the title row. */
  actions?: ReactNode
  tabs: TabItem[]
  value: string
  onValueChange: (value: string) => void
  people: readonly string[]
  onCreate: () => void
  createLabel: string
  /** The tab panels (`TabsContent`). */
  children: ReactNode
}

export function Navbar({
  crumbs,
  title,
  status,
  actions,
  tabs,
  value,
  onValueChange,
  people,
  onCreate,
  createLabel,
  children,
}: NavbarProps) {
  return (
    <Tabs
      value={value}
      onValueChange={onValueChange}
      className="flex min-h-0 flex-1 flex-col gap-0"
    >
      <header className="border-border bg-background flex w-full shrink-0 flex-col gap-3 border-b px-4 pt-3 lg:px-6">
        {/* Row 1: project title + breadcrumb | header actions */}
        <div className="flex items-center justify-between gap-2">
          <NavbarProject crumbs={crumbs} title={title} status={status} />
          <div className="flex shrink-0 items-center gap-1">{actions}</div>
        </div>
        {/* Row 2: tabs | collaborators */}
        <div className="flex min-h-9 items-center justify-between">
          <NavbarTabs
            items={tabs}
            value={value}
            onValueChange={onValueChange}
          />
          <NavbarCollaborators
            people={people}
            onCreate={onCreate}
            createLabel={createLabel}
          />
        </div>
      </header>

      {children}
    </Tabs>
  )
}
