import type { ReactNode } from "react"

// ── Navbar project (title + status) ──

export function NavbarProject({
  title,
  status,
}: {
  title: string
  status?: ReactNode
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <h1 className="truncate text-lg font-semibold tracking-tight">{title}</h1>
      {status}
    </div>
  )
}
