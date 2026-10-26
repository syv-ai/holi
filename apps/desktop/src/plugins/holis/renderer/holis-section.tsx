/**
 * The Holis' section of the Agents sidebar (docs/features/holis.md), after
 * MonoCode's `MonoRailSection` and `MonoIntro` (MIT, Copyright (c) 2026 Nick;
 * see NOTICE.md): a "Holis" label with its +, then one row per Holi, its pixel
 * persona with a status dot. With none yet, an intro card that says what a Holi
 * is and makes the first one. Making one, and reading how they work, is the
 * wizard (`wizard/holi-wizard.tsx`).
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { CircleHelp, Ellipsis, Plus } from 'lucide-react'
import { appModeAtom, cn, openPathAtom, useTabDrag } from '@/plugin-api'
import { DEFAULT_HOLI_COLOUR, HOLI_COLOURS, HOLI_MASCOTS } from '@holi/shared'
import { HoliDialogs } from './holi-dialogs'
import {
  holiSettingsAtom,
  holiWizardAtom,
  holiStateAtom,
  holisAtom,
  holisLoadedAtom,
  HOLIS_OWNER,
  loadHolisAtom,
  openHoliAtom,
  selectedHoliAtom,
  type HoliSummary,
} from './state'
import { PixelPersona } from '@/composites/pixel-persona/pixel-persona'
import { SectionLabel } from '@/composites/section-label'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { IconButton } from '@/composites/icon-button'
import { Skeleton } from '@/components/ui/skeleton'

/** The chrome row (`docs/ui-system.md`, Rules): one fill scale on the
 *  foreground, `text-nav`. */
const ROW =
  'w-full min-w-0 justify-start text-nav font-medium text-muted-foreground hover:bg-foreground/5 hover:text-foreground aria-[current=page]:bg-foreground/10 aria-[current=page]:text-foreground'

function HoliRow({ holi }: { holi: HoliSummary }): React.JSX.Element {
  const selected = useAtomValue(selectedHoliAtom)
  const open = useSetAtom(openHoliAtom)
  const settings = useSetAtom(holiSettingsAtom)
  const setMode = useSetAtom(appModeAtom)
  const openPath = useSetAtom(openPathAtom)
  const state = useAtomValue(holiStateAtom)[holi.id] ?? 'idle'
  // The row drags as the Holi's tab, onto the content or the strip.
  const tabDrag = useTabDrag()
  const current = selected === holi.id
  const broken = holi.status === 'invalid'
  const label = broken
    ? 'Invalid'
    : holi.status === 'changed'
      ? 'Changed'
      : holi.status === 'new'
        ? 'New'
        : ''
  return (
    <div className="group/holi relative">
      <Button
        variant="ghost"
        className={ROW}
        aria-current={current ? 'page' : undefined}
        data-holi-row={holi.id}
        aria-label={`${holi.name}${state === 'needs-you' ? ', needs you' : state === 'working' ? ', working' : ''}`}
        onClick={() => open(holi.id)}
        {...tabDrag({ kind: 'session', owner: HOLIS_OWNER, id: holi.id })}
      >
        <span className="relative flex size-5 shrink-0 items-center justify-center">
          {broken ? (
            <PixelPersona
              name={holi.mascot ?? 'strategist'}
              color={DEFAULT_HOLI_COLOUR}
              still
              muted
            />
          ) : (
            <PixelPersona
              name={holi.mascot ?? 'strategist'}
              color={holi.color ?? DEFAULT_HOLI_COLOUR}
              status={state}
            />
          )}
          <span
            aria-hidden="true"
            className={cn(
              'absolute -end-0.5 -top-0.5 size-1.75 rounded-full ring-2 ring-sidebar',
              state === 'needs-you'
                ? 'bg-amber-600 dark:bg-amber-400'
                : state === 'working'
                  ? 'motion-pulse bg-foreground'
                  : holi.status === 'approved'
                    ? 'bg-emerald-600 dark:bg-emerald-400'
                    : 'bg-muted-foreground/50',
            )}
          />
        </span>
        <span
          className={cn(
            'min-w-0 flex-1 truncate pe-5 text-start',
            broken && 'text-muted-foreground',
          )}
        >
          {holi.name}
        </span>
        {label !== '' && (
          <span className="shrink-0 text-xs font-normal text-muted-foreground group-focus-within/holi:invisible group-hover/holi:invisible">
            {label}
          </span>
        )}
      </Button>
      <span className="absolute end-1 top-1 opacity-0 focus-within:opacity-100 group-hover/holi:opacity-100 has-data-[state=open]:opacity-100">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label={`${holi.name} options`} size="icon-xs">
              <Ellipsis />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => open(holi.id)}>Open</DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                open(holi.id)
                settings({ id: holi.id, section: 'general' })
              }}
            >
              Settings…
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                setMode('documents')
                void openPath(holi.path)
              }}
            >
              Edit its file
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </div>
  )
}

/** With no Holis yet: what one is, every face it could have, and a button
 *  that starts making the first (after MonoCode's `MonoIntroCard`). */
function MeetHolis(): React.JSX.Element {
  const wizard = useSetAtom(holiWizardAtom)
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-foreground/[0.03] p-2.5">
      <p className="text-nav font-medium text-foreground">Meet Holis</p>
      <div aria-hidden="true" className="flex items-center gap-1">
        {HOLI_MASCOTS.slice(0, 7).map((m, i) => (
          <PixelPersona key={m} name={m} color={HOLI_COLOURS[i % HOLI_COLOURS.length]!} still />
        ))}
      </div>
      <p className="text-xs text-pretty text-muted-foreground">
        Agents of this vault with a soul and a memory. Send one a document, or give one an
        automation to carry out.
      </p>
      <Button size="sm" className="w-full" onClick={() => wizard({ mode: 'create' })}>
        Create Holi
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="w-full"
        onClick={() => wizard({ mode: 'learn' })}
      >
        How Holis work
      </Button>
    </div>
  )
}

export function HolisSection(): React.JSX.Element {
  const holis = useAtomValue(holisAtom)
  const loaded = useAtomValue(holisLoadedAtom)
  const reload = useSetAtom(loadHolisAtom)
  const wizard = useSetAtom(holiWizardAtom)
  return (
    <section aria-label="Holis" className="flex flex-col gap-px">
      <div className="flex items-center justify-between pe-1">
        <SectionLabel>Holis</SectionLabel>
        {holis.length > 0 && (
          <div className="flex items-center gap-0.5">
            <IconButton
              label="How Holis work"
              size="icon-xs"
              onClick={() => wizard({ mode: 'learn' })}
            >
              <CircleHelp />
            </IconButton>
            <IconButton label="New Holi" size="icon-xs" onClick={() => wizard({ mode: 'create' })}>
              <Plus />
            </IconButton>
          </div>
        )}
      </div>
      {loaded === 'loading' && holis.length === 0 ? (
        <div role="status" aria-label="Loading Holis" className="flex flex-col gap-1 px-2">
          <Skeleton className="h-6" />
          <Skeleton className="h-6" />
        </div>
      ) : loaded === 'error' ? (
        <div role="alert" className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
          Could not read the Holis.
          <Button size="xs" variant="secondary" onClick={() => void reload()}>
            Retry
          </Button>
        </div>
      ) : holis.length === 0 ? (
        <MeetHolis />
      ) : (
        holis.map((h) => <HoliRow key={h.id} holi={h} />)
      )}
      <HoliDialogs />
    </section>
  )
}
