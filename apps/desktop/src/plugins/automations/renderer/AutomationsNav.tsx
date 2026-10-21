/**
 * Automations' row in the Agents sidebar's top group (`AgentsSlot.nav`),
 * under the Inbox, after MonoCode's rail link: it opens the view, and counts
 * the automations active on this machine.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Zap } from 'lucide-react'
import { Button, Icon } from '@/primitives'
import { automationsAtom, openAutomationAtom, selectAutomationAtom } from './state'

const ROW =
  'h-7 w-full min-w-0 justify-start gap-2 rounded-lg px-2 text-nav font-medium text-muted-foreground motion-respond hover:bg-foreground/[0.04] hover:text-foreground active:bg-foreground/[0.07] aria-[current=page]:bg-foreground/[0.06] aria-[current=page]:text-foreground'

export function AutomationsNav(): React.JSX.Element {
  const open = useAtomValue(openAutomationAtom)
  const select = useSetAtom(selectAutomationAtom)
  const active = useAtomValue(automationsAtom).filter((a) => a.status === 'on').length
  return (
    <Button
      variant="ghost"
      className={ROW}
      aria-current={open !== null ? 'page' : undefined}
      onClick={() => select('list')}
    >
      <Icon icon={Zap} size="sm" />
      <span className="min-w-0 flex-1 truncate text-start">Automations</span>
      {active > 0 && <span className="text-xs text-muted-foreground tabular-nums">{active}</span>}
    </Button>
  )
}
