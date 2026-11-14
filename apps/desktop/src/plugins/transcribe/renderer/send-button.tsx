/**
 * Send a card to an agent: a primary button that sends, and beside it, when
 * the vault has Holis, a picker of who it goes to: the vault's agent, or a
 * Holi. A Holi
 * this machine has not approved is listed, but cannot be picked until it is.
 * The pick is remembered for the next card.
 */
import type { PickableHoli } from '@holi/shared'
import { useAtom } from 'jotai'
import { useState } from 'react'
import { ChevronDown, SendHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { SendTarget } from '../shared/meeting'
import { useAgentName } from './agent-name'
import { sendTargetAtom } from './state'
import { useMeetingsDisplayed } from './displayed'

const valueOf = (t: SendTarget): string => (t.kind === 'holi' ? `holi:${t.id}` : 'agent')

export function SendButton({
  holis,
  busy,
  onSend,
}: {
  holis: readonly PickableHoli[]
  busy: boolean
  onSend: (target: SendTarget) => void
}): React.JSX.Element {
  const [picked, setPicked] = useAtom(sendTargetAtom)
  const agent = useAgentName()
  const displayed = useMeetingsDisplayed()
  const [menuOpen, setMenuOpen] = useState(false)
  // A Holi picked before that is gone, or no longer approved, is the agent again.
  const holi =
    picked.kind === 'holi'
      ? holis.find((h) => h.id === picked.id && h.status === 'approved')
      : undefined
  const target: SendTarget = holi === undefined ? { kind: 'agent' } : picked
  const label = `Send to ${holi === undefined ? agent : holi.name}`
  const send = (
    <Button size="sm" disabled={busy} onClick={() => onSend(target)}>
      <SendHorizontal aria-hidden />
      {label}
    </Button>
  )
  if (holis.length === 0) return send
  return (
    <ButtonGroup>
      {send}
      <DropdownMenu
        open={displayed && menuOpen}
        onOpenChange={(open) => setMenuOpen(displayed && open)}
      >
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" aria-label="Choose who it goes to" disabled={busy}>
            <ChevronDown aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>Send to</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={valueOf(target)}
            onValueChange={(v) =>
              setPicked(v === 'agent' ? { kind: 'agent' } : { kind: 'holi', id: v.slice(5) })
            }
          >
            <DropdownMenuRadioItem value="agent">{agent}</DropdownMenuRadioItem>
            {holis.map((h) => (
              <HoliItem key={h.id} holi={h} />
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  )
}

function HoliItem({ holi }: { holi: PickableHoli }): React.JSX.Element {
  const approved = holi.status === 'approved'
  return (
    <DropdownMenuRadioItem value={`holi:${holi.id}`} disabled={!approved}>
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{holi.name}</span>
        {!approved && (
          <span className="text-xs text-muted-foreground">
            {holi.status === 'changed' ? 'Changed: approve it again' : 'Approve it first'} in Agents
          </span>
        )}
      </span>
    </DropdownMenuRadioItem>
  )
}
