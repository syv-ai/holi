import { atom, useAtomValue } from "jotai"
import { useMemo } from "react"

import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar"
import type { SidebarApp } from "@/plugin-api"
import { runningPluginsAtom } from "@/state/plugins"

/** Every running plugin's apps (Mail, Calendar), in their order. */
export function useSidebarApps(): readonly SidebarApp[] {
  const plugins = useAtomValue(runningPluginsAtom)
  return useMemo(
    () =>
      plugins
        .flatMap((plugin) => plugin.sidebarApps ?? [])
        .sort((a, b) => a.order - b.order),
    [plugins]
  )
}

const LISTED = atom(true)

/** One app's row: hidden while its `visible` says no (no account, say). */
export function SidebarAppItem({
  app,
  active,
  collapsed,
  onSelect,
  className,
}: {
  app: SidebarApp
  active: boolean
  collapsed: boolean
  onSelect: (id: string) => void
  className?: string
}) {
  const visible = useAtomValue(app.visible ?? LISTED)
  if (!visible) return null
  const Icon = app.icon
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        tooltip={collapsed ? app.label : undefined}
        isActive={active}
        aria-current={active ? "page" : undefined}
        onClick={() => onSelect(app.id)}
        className={className}
      >
        <Icon aria-hidden={true} />
        <span>{app.label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}
