import { atom, useAtomValue } from 'jotai'
import { useMemo } from 'react'

import { SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import type { SidebarApp } from '@/plugin-api'
import { runningPluginsAtom } from '@/state/plugins'

/** Every running plugin's apps (Mail, Calendar), in their order. */
export function useSidebarApps(): readonly SidebarApp[] {
  const plugins = useAtomValue(runningPluginsAtom)
  return useMemo(
    () => plugins.flatMap((plugin) => plugin.sidebarApps ?? []).sort((a, b) => a.order - b.order),
    [plugins],
  )
}

const LISTED = atom(true)
const NO_UNREAD = atom<number | null>(null)

function appLabel(label: string, unread: number | null): string {
  if (unread === null) return label
  if (unread === 0) return `${label}, no unread threads`
  return `${label}, ${unread} unread ${unread === 1 ? 'thread' : 'threads'}`
}

/** One app's row: hidden while its `visible` says no (no account, say). */
export function SidebarAppItem({
  app,
  active,
  collapsed,
  onSelect,
}: {
  app: SidebarApp
  active: boolean
  collapsed: boolean
  onSelect: (id: string) => void
}) {
  const visible = useAtomValue(app.visible ?? LISTED)
  const unread = useAtomValue(app.unreadAtom ?? NO_UNREAD)
  if (!visible) return null
  const Icon = app.icon
  const label = appLabel(app.label, unread)
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        tooltip={collapsed ? label : undefined}
        isActive={active}
        aria-current={active ? 'page' : undefined}
        aria-label={label}
        onClick={() => onSelect(app.id)}
        variant="fill"
        size={collapsed ? 'rail' : 'default'}
      >
        <Icon aria-hidden={true} />
        <span>{app.label}</span>
      </SidebarMenuButton>
      {unread !== null && unread > 0 ? (
        <SidebarMenuBadge placement={collapsed ? 'rail' : 'menu'} aria-hidden="true">
          {unread}
        </SidebarMenuBadge>
      ) : null}
    </SidebarMenuItem>
  )
}
