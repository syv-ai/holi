import { Fragment, type ReactNode } from "react"

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"

import type { Crumb } from "./data"

// ── Navbar project (title + breadcrumb) ──

export function NavbarProject({
  crumbs,
  title,
  status,
}: {
  crumbs: Crumb[]
  title: string
  status?: ReactNode
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Breadcrumb className="min-w-0">
        {/* List */}
        <BreadcrumbList className="flex-nowrap">
          {crumbs.map((crumb) => (
            <Fragment key={crumb.label}>
              <BreadcrumbItem className="text-muted-foreground flex items-center gap-1">
                {crumb.icon}
                <span className="hidden md:inline">{crumb.label}</span>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
            </Fragment>
          ))}
          <BreadcrumbItem className="min-w-0">
            <BreadcrumbPage className="truncate font-medium">
              {title}
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      {status}
    </div>
  )
}
