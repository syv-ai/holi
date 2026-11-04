/**
 * Automations' row in the Agents sidebar's top group (`AgentsSlot.nav`),
 * under the Inbox, after MonoCode's rail link: it opens the view, and counts
 * the automations active on this machine. Locked, as In progress, until
 * they are finished (`AUTOMATIONS_READY`).
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Zap } from 'lucide-react'
import { automationsAtom, openAutomationAtom, selectAutomationAtom } from './state'
import { SidebarNavItem } from '@/composites/sidebar-nav-item'
import { AUTOMATIONS_READY } from '../info'

export function AutomationsSection(): React.JSX.Element {
  const open = useAtomValue(openAutomationAtom)
  const select = useSetAtom(selectAutomationAtom)
  const active = useAtomValue(automationsAtom).filter((a) => a.status === 'on').length
  if (!AUTOMATIONS_READY) return <SidebarNavItem icon={Zap} label="Automations" inProgress />
  return (
    <SidebarNavItem
      icon={Zap}
      label="Automations"
      current={open !== null}
      count={active}
      countLabel="on"
      onClick={() => select('list')}
    />
  )
}
