import type { ComponentProps, ComponentType, ReactNode, SVGProps } from 'react'
import { SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'

/**
 * A place in a sidebar's top group (Board, Apps, Inbox, Automations): the
 * sidebar's menu button, so a row in the Agents tab reads exactly as one in
 * Documents, and a count drawn as the menu's badge. The count is read out
 * after the row's name (`countLabel`), not as a bare number.
 */
export function SidebarNavItem({
  icon: Icon,
  label,
  current = false,
  count = 0,
  countLabel,
  children,
  className,
  ...props
}: Omit<ComponentProps<typeof SidebarMenuButton>, 'isActive' | 'children'> & {
  icon: ComponentType<SVGProps<SVGSVGElement>>
  label: string
  current?: boolean
  count?: number
  /** What the count means, read after the name: "open tasks". */
  countLabel?: string
  /** Anything the row adds after its name, such as a shortcut. */
  children?: ReactNode
}): React.JSX.Element {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        {...props}
        isActive={current}
        aria-current={current ? 'page' : undefined}
        // The name first, as it reads on screen, then what the badge counts.
        aria-label={
          count > 0 && countLabel !== undefined ? `${label}, ${count} ${countLabel}` : undefined
        }
        variant="fill"
        className={className}
      >
        <Icon aria-hidden="true" />
        <span>{label}</span>
        {children}
      </SidebarMenuButton>
      {count > 0 ? <SidebarMenuBadge aria-hidden="true">{count}</SidebarMenuBadge> : null}
    </SidebarMenuItem>
  )
}
