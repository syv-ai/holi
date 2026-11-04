/**
 * Who carries an automation out: Claude Code as it is, or one of the vault's
 * Holis, with its soul and memory. After MonoCode's `SearchableProjectPicker`
 * (MIT, Copyright (c) 2026 Nick; see ../../holis/NOTICE.md): a quiet trigger
 * with the face and name, and a searchable list with a check on the current
 * one. The project is the vault the view is in, so the picker is the Holi's.
 *
 * The Holis come from the Holis plugin's own list (`holis.list`), asked by
 * name: a plugin cannot import another's. With Holis off there is only Claude.
 */
import { useAtomValue } from 'jotai'
import { AstroidIcon, Check, ChevronDown } from 'lucide-react'
import { useEffect, useState } from 'react'
import { activeRemoteAtom, cn, useHasCapability } from '@/plugin-api'
import { DEFAULT_HOLI_COLOUR, type PickableHoli } from '@holi/shared'
import { holisCap } from './holis-cap'
import { PixelPersona } from '@/composites/pixel-persona/pixel-persona'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/** The vault's Holis, while the Holis plugin runs; `[]` otherwise. */
function useHolis(): PickableHoli[] {
  const remote = useAtomValue(activeRemoteAtom)
  const has = useHasCapability('holis.list')
  const [list, setList] = useState<PickableHoli[]>([])
  useEffect(() => {
    if (remote === null || !has) {
      setList([])
      return
    }
    let gone = false
    void holisCap.list(remote).then(
      (all) => {
        if (!gone) setList(all.filter((h) => h.status !== 'invalid'))
      },
      () => {},
    )
    return () => {
      gone = true
    }
  }, [remote, has])
  return list
}

function Face({ holi, className }: { holi?: PickableHoli; className?: string }) {
  return holi === undefined ? (
    <AstroidIcon className={cn('size-3.5', className)} aria-hidden="true" />
  ) : (
    <PixelPersona
      name={holi.mascot ?? 'strategist'}
      color={holi.color ?? DEFAULT_HOLI_COLOUR}
      still
      className={className}
    />
  )
}

export function HoliPicker({
  value,
  onChange,
}: {
  /** The Holi's id, or undefined for Claude Code as it is. */
  value: string | undefined
  onChange: (holi: string | undefined) => void
}): React.JSX.Element {
  const list = useHolis()
  const [open, setOpen] = useState(false)
  const current = list.find((h) => h.id === value)
  const label = value === undefined ? 'Claude' : (current?.name ?? value)

  const pick = (id: string | undefined) => {
    onChange(id)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          aria-label={`Carried out by ${label}`}
          className="text-muted-foreground data-[state=open]:bg-accent"
        >
          <Face {...(current === undefined ? {} : { holi: current })} />
          <span className="font-medium text-foreground">{label}</span>
          <ChevronDown
            className={cn('size-3.5', cn('size-3 motion-respond', open && 'rotate-180'))}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <Command>
          <CommandInput placeholder="Search Holis…" />
          <CommandList>
            <CommandEmpty>No Holi by that name.</CommandEmpty>
            <CommandGroup>
              <CommandItem value="claude" onSelect={() => pick(undefined)}>
                <span className="flex size-4 items-center justify-center">
                  {value === undefined ? <Check className="size-3.5" /> : <Face />}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">Claude</span>
                  <span className="truncate text-xs text-muted-foreground">
                    Claude Code as it is, no soul or memory
                  </span>
                </span>
              </CommandItem>
              {list.map((h) => (
                <CommandItem key={h.id} value={`${h.name} ${h.id}`} onSelect={() => pick(h.id)}>
                  <span className="flex size-4 items-center justify-center">
                    {h.id === value ? <Check className="size-3.5" /> : <Face holi={h} />}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{h.name}</span>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      .holi/holis/{h.id}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
