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
import { SiClaude } from '@icons-pack/react-simple-icons'
import { useAtomValue } from 'jotai'
import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useState } from 'react'
import { PixelPersona } from '@/composites'
import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Icon,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/primitives'
import { activeRemoteAtom, capClient, cn, useHasCapability, type UiCapability } from '@/plugin-api'

/** What the picker needs of a Holi, by shape. */
export interface PickableHoli {
  id: string
  name: string
  mascot?: string
  color?: string
  status: string
  description?: string
}

const holis = capClient<{ 'holis.list': UiCapability<void, PickableHoli[]> }>('holis')

/** The vault's Holis, while the Holis plugin runs; `[]` otherwise. */
export function useHolis(): PickableHoli[] {
  const remote = useAtomValue(activeRemoteAtom)
  const has = useHasCapability('holis.list')
  const [list, setList] = useState<PickableHoli[]>([])
  useEffect(() => {
    if (remote === null || !has) {
      setList([])
      return
    }
    let gone = false
    void holis.list(remote).then(
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
    <Icon
      icon={SiClaude}
      size="sm"
      className={cn('text-orange-500 dark:text-orange-400', className)}
      aria-hidden="true"
    />
  ) : (
    <PixelPersona
      name={holi.mascot ?? 'strategist'}
      color={holi.color ?? '#8f8f94'}
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
          className="gap-1.5 text-muted-foreground data-[state=open]:bg-accent"
        >
          <Face {...(current === undefined ? {} : { holi: current })} />
          <span className="font-medium text-foreground">{label}</span>
          <Icon
            icon={ChevronDown}
            size="sm"
            className={cn('size-3 motion-respond', open && 'rotate-180')}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <CommandInput placeholder="Search Holis…" />
          <CommandList>
            <CommandEmpty>No Holi by that name.</CommandEmpty>
            <CommandGroup>
              <CommandItem value="claude" onSelect={() => pick(undefined)}>
                <span className="flex size-4 items-center justify-center">
                  {value === undefined ? <Icon icon={Check} size="sm" /> : <Face />}
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
                    {h.id === value ? <Icon icon={Check} size="sm" /> : <Face holi={h} />}
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
