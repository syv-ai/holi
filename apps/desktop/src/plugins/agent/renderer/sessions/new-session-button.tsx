/**
 * The Sessions header's + (docs/features/agent-sessions.md, The Agents view).
 * A click, Enter or Space starts a session in this machine's default agent at
 * once. Hovering it, or ↓ on it, opens the other ways in: a session in each
 * agent, and Resume for an agent Holi runs itself (its own picker of earlier
 * conversations). An agent not on this machine is listed, but off.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { PlusIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  loadProvidersAtom,
  newSessionProviderAtom,
  providerLabel,
  providersAtom,
} from '../state/providers'
import { startViewSessionAtom } from '../state/session-view'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { AgentMark } from '@/composites/marks'

/** How long the pointer rests on the + before the menu opens, and how long
 *  it may be off both before it closes: crossing the gap is not leaving. */
const OPEN_DELAY_MS = 250
const CLOSE_DELAY_MS = 200

export function NewSessionButton(): React.JSX.Element {
  const providers = useAtomValue(providersAtom)
  const load = useSetAtom(loadProvidersAtom)
  const fallback = useAtomValue(newSessionProviderAtom)
  const start = useSetAtom(startViewSessionAtom)
  const [open, setOpen] = useState(false)
  const timer = useRef<number | null>(null)

  const list = providers.kind === 'ready' ? providers.providers : []
  const byDefault = list.find((p) => p.id === fallback)

  const later = (fn: () => void, ms: number): void => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      timer.current = null
      fn()
    }, ms)
  }
  const stay = (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => stay, [])

  useEffect(() => {
    if (open && providers.kind !== 'ready') void load()
  }, [open, providers.kind, load])

  const startDefault = (): void => {
    setOpen(false)
    void start({})
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger
        asChild
        onPointerDown={(e) => e.preventDefault()}
        onPointerEnter={() => later(() => setOpen(true), OPEN_DELAY_MS)}
        onPointerLeave={() => later(() => setOpen(false), CLOSE_DELAY_MS)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            startDefault()
          }
        }}
        onClick={startDefault}
      >
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`New ${providerLabel(fallback)} session`}
        >
          <PlusIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="right"
        className="min-w-56"
        onPointerEnter={stay}
        onPointerLeave={() => later(() => setOpen(false), CLOSE_DELAY_MS)}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DropdownMenuLabel>New session</DropdownMenuLabel>
        {providers.kind === 'error' ? (
          <DropdownMenuItem onSelect={() => void load()}>
            Couldn't list the agents. Retry
          </DropdownMenuItem>
        ) : providers.kind === 'loading' ? (
          <DropdownMenuItem disabled>Reading the agents…</DropdownMenuItem>
        ) : (
          list.map((p) => (
            <DropdownMenuItem
              key={p.id}
              disabled={!p.installed}
              onSelect={() => void start({ provider: p.id })}
            >
              <AgentMark agent={p.id} />
              {p.label}
              <DropdownMenuShortcut>
                {!p.installed ? 'Not installed' : p.id === byDefault?.id ? '⌘N' : ''}
              </DropdownMenuShortcut>
            </DropdownMenuItem>
          ))
        )}
        {list.some((p) => !p.background && p.installed) && <DropdownMenuSeparator />}
        {list
          .filter((p) => !p.background && p.installed)
          .map((p) => (
            <DropdownMenuItem
              key={`resume-${p.id}`}
              onSelect={() => void start({ provider: p.id, resume: 'pick' })}
            >
              <AgentMark agent={p.id} />
              Resume a {p.label} conversation
            </DropdownMenuItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
