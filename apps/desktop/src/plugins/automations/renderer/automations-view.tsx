/**
 * The Automations view (docs/features/scheduled-agents.md), after MonoCode's
 * `AutomationsView` (MIT, Copyright (c) 2026 Nick; see ../../holis/NOTICE.md):
 * the vault's automations in a column, each a card with its trigger, name,
 * who carries it out and when it last ran, its Active state on the right;
 * beside them the one open in the editor, or a new one.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Clock, Plus, Search, Zap } from 'lucide-react'
import { useState } from 'react'
import { IconStackEmpty } from '@/components/reui/icon-stack-empty'
import { cn } from '@/plugin-api'
import { AutomationEditor, useInitialDraft } from './automation-editor'
import {
  automationsAtom,
  automationsLoadedAtom,
  loadAutomationsAtom,
  selectAutomationAtom,
  type ScheduleSummary,
} from './state'
import { EmptyState } from '@/composites/empty-state'
import { Badge } from '@/components/reui/badge'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/composites/icon-button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Skeleton } from '@/components/ui/skeleton'

const lastFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })

function Card({ a, current }: { a: ScheduleSummary; current: boolean }): React.JSX.Element {
  const select = useSetAtom(selectAutomationAtom)
  return (
    <Button
      variant="ghost"
      className={cn(
        'h-auto w-full text-start font-normal hover:bg-foreground/5',
        current && 'bg-foreground/10',
      )}
      aria-current={current ? 'page' : undefined}
      onClick={() => select(a.path)}
    >
      <span className="flex w-full min-w-0 flex-col gap-1 py-1">
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="size-3" />
          <span className="min-w-0 flex-1 truncate">{a.error ?? a.when ?? ''}</span>
          <Badge variant={a.status === 'on' ? 'primary-light' : 'outline'}>
            {a.status === 'on'
              ? 'Active'
              : a.status === 'changed'
                ? 'Changed'
                : a.status === 'invalid'
                  ? 'Invalid'
                  : 'Off'}
          </Badge>
        </span>
        <span className="truncate text-sm font-semibold text-foreground">{a.name}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">{a.holiName ?? a.holi ?? 'Claude'}</span>
          {a.lastRun !== undefined && <span>· {lastFormat.format(new Date(a.lastRun))}</span>}
        </span>
      </span>
    </Button>
  )
}

function List({ open }: { open: string }): React.JSX.Element {
  const all = useAtomValue(automationsAtom)
  const loaded = useAtomValue(automationsLoadedAtom)
  const reload = useSetAtom(loadAutomationsAtom)
  const select = useSetAtom(selectAutomationAtom)
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const shown = all.filter((a) => q === '' || a.name.toLowerCase().includes(q))
  return (
    <aside aria-label="Automations" className="flex w-72 shrink-0 flex-col border-e border-divider">
      <div className="flex shrink-0 items-center gap-1 border-b border-divider p-2">
        <InputGroup>
          <InputGroupAddon>
            <Search className="size-3.5 text-muted-foreground" />
          </InputGroupAddon>
          <InputGroupInput
            placeholder="Filter automations"
            aria-label="Filter automations"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </InputGroup>
        <IconButton label="New automation" size="icon-xs" onClick={() => select('new')}>
          <Plus />
        </IconButton>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
        {loaded === 'loading' && all.length === 0 ? (
          <div role="status" aria-label="Loading automations" className="flex flex-col gap-1.5">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        ) : loaded === 'error' ? (
          <EmptyState
            role="alert"
            title="Could not read the automations"
            action={{ label: 'Retry', onClick: () => void reload() }}
          />
        ) : shown.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            {all.length === 0 ? 'No automations yet' : 'No matching automations'}
          </p>
        ) : (
          shown.map((a) => <Card key={a.path} a={a} current={a.path === open} />)
        )}
      </div>
    </aside>
  )
}

function Editor({ open }: { open: string }): React.JSX.Element {
  const all = useAtomValue(automationsAtom)
  const select = useSetAtom(selectAutomationAtom)
  const isNew = open === 'new' || open.startsWith('new:')
  const holi = open.startsWith('new:') ? open.slice(4) : undefined
  const summary = isNew ? undefined : all.find((a) => a.path === open)
  const initial = useInitialDraft(summary, holi)
  if (!isNew && summary === undefined) {
    return all.length === 0 ? (
      <IconStackEmpty
        icon={Zap}
        title="Put agent work on a schedule"
        description="An automation runs a prompt as a session at the times you set, on this machine, while the vault is open. A Holi can carry it out, with its soul and memory."
        action={{ label: 'New automation', icon: Plus, onClick: () => select('new') }}
      />
    ) : (
      <IconStackEmpty
        icon={Zap}
        title="Pick an automation"
        description="Or start a new one."
        action={{ label: 'New automation', icon: Plus, onClick: () => select('new') }}
      />
    )
  }
  return (
    <AutomationEditor
      key={summary?.path ?? open}
      initial={initial}
      {...(summary === undefined ? {} : { summary })}
    />
  )
}

export function AutomationsView({ id }: { id: string }): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-automations-view="">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-divider px-4 text-sm">
        <Zap className="size-3.5 text-muted-foreground" />
        <span className="font-medium">Automations</span>
      </div>
      <div className="flex min-h-0 flex-1">
        <List open={id} />
        <Editor open={id} />
      </div>
    </div>
  )
}
