// ReUI block: @reui/navbar-1 (`npx shadcn@latest view @reui/navbar-1` shows the published source)
import type { ReactNode } from 'react'

import { Tabs } from '@/components/ui/tabs'

import { PeopleStack } from '@/composites/person-avatar'
import { NavbarTabs, type TabItem } from './navbar-tabs'

// ── Navbar project (title + status) ──

function NavbarProject({ title, status }: { title: string; status?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <h1 className="truncate text-lg font-semibold tracking-tight">{title}</h1>
      {status}
    </div>
  )
}

// ── Navbar (title row over a tab row, then the tab content panels) ──

export type NavbarProps = {
  title: string
  /** Beside the title: the project's status. */
  status?: ReactNode
  /** Right of the title row, after the people. */
  actions?: ReactNode
  tabs: TabItem[]
  value: string
  onValueChange: (value: string) => void
  people: readonly string[]
  /** The tab panels (`TabsContent`). */
  children: ReactNode
}

export function Navbar({
  title,
  status,
  actions,
  tabs,
  value,
  onValueChange,
  people,
  children,
}: NavbarProps) {
  return (
    <Tabs value={value} onValueChange={onValueChange} className="min-h-0 flex-1">
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="border-border flex w-full shrink-0 flex-col gap-3 border-b px-4 pt-4 lg:px-6">
          {/* Row 1: title + status | people + actions */}
          <div className="flex min-h-8 items-center justify-between gap-2">
            <NavbarProject title={title} status={status} />
            <div className="flex shrink-0 items-center gap-2">
              <PeopleStack logins={people} max={4} />
              {actions}
            </div>
          </div>
          {/* Row 2: the tabs, on the header's bottom edge */}
          <div className="flex h-9 items-end">
            <NavbarTabs items={tabs} value={value} onValueChange={onValueChange} />
          </div>
        </header>

        {children}
      </div>
    </Tabs>
  )
}
