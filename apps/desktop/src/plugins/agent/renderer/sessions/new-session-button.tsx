/** The Sessions header's + (docs/features/agent-sessions.md, The Agents view). */
import { useAtomValue, useSetAtom } from 'jotai'
import { PlusIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  defaultMissingAtom,
  loadProvidersAtom,
  newSessionProviderAtom,
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
import { Skeleton } from '@/components/ui/skeleton'
import { AgentMark } from '@/composites/marks'

export function NewSessionButton(): React.JSX.Element {
  const providers = useAtomValue(providersAtom)
  const load = useSetAtom(loadProvidersAtom)
  const fallback = useAtomValue(newSessionProviderAtom)
  const missing = useAtomValue(defaultMissingAtom)
  const start = useSetAtom(startViewSessionAtom)
  const [open, setOpen] = useState(false)
  const launching = useRef(false)
  const dismissingOutside = useRef(false)

  const list = providers.kind === 'ready' ? providers.providers : []
  const ordered = list.length
    ? [
        list.find((provider) => provider.id === fallback),
        ...list.filter((p) => p.id !== fallback),
      ].filter((provider): provider is (typeof list)[number] => provider !== undefined)
    : []
  const byDefault = list.find((p) => p.id === fallback)

  useEffect(() => {
    if (open && providers.kind === 'loading') void load()
  }, [open, providers.kind, load])

  const launch = (args: Parameters<typeof start>[0]): void => {
    launching.current = true
    void start(args)
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon-xs" aria-label="New session">
          <PlusIcon aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="right"
        className="min-w-56"
        onInteractOutside={() => {
          dismissingOutside.current = true
        }}
        onCloseAutoFocus={(event) => {
          if (launching.current || dismissingOutside.current) {
            event.preventDefault()
            launching.current = false
            dismissingOutside.current = false
          }
        }}
      >
        <DropdownMenuLabel>
          {missing ? `${fallback} is gone. Start in which agent?` : 'New session'}
        </DropdownMenuLabel>
        {providers.kind === 'error' ? (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault()
              void load()
            }}
          >
            <span role="status">Couldn't list the agents.</span>
            <DropdownMenuShortcut>Retry</DropdownMenuShortcut>
          </DropdownMenuItem>
        ) : providers.kind === 'loading' ? (
          <DropdownMenuItem disabled>
            <Skeleton className="h-4 w-4" aria-hidden="true" />
            <span role="status">Reading the agents…</span>
          </DropdownMenuItem>
        ) : ordered.length === 0 ? (
          <>
            <DropdownMenuItem disabled>
              <span role="status">No agents available.</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault()
                void load()
              }}
            >
              Retry agent list
            </DropdownMenuItem>
          </>
        ) : (
          ordered.map((p) => (
            <DropdownMenuItem
              key={p.id}
              disabled={!p.installed}
              onSelect={() => launch({ provider: p.id })}
            >
              <AgentMark agent={p.id} />
              {p.label}
              <DropdownMenuShortcut>
                {!p.installed ? 'Not installed' : p.id === byDefault?.id ? '⌘N' : ''}
              </DropdownMenuShortcut>
            </DropdownMenuItem>
          ))
        )}
        {list.some((p) => p.resumePicker && p.installed) && <DropdownMenuSeparator />}
        {list
          .filter((p) => p.resumePicker && p.installed)
          .map((p) => (
            <DropdownMenuItem
              key={`resume-${p.id}`}
              onSelect={() => launch({ provider: p.id, resume: 'pick' })}
            >
              <AgentMark agent={p.id} />
              Resume a {p.label} conversation
            </DropdownMenuItem>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
