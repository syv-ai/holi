/**
 * Send to Holi: the agent's rows in a document's Agent menu
 * (`RendererPlugin.documentActions`, docs/features/holis.md). The Holis that
 * take this document first, then every other Holi, then New Holi. Core draws
 * the menu; these rows are the agent's.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Plus } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  Icon,
} from '@/primitives'
import {
  holisAtom,
  newHoliAtom,
  sendableFor,
  sendToHoliAtom,
  type HoliSummary,
} from '../state/holis'
import { PixelMascot } from './PixelMascot'

function HoliItem({ holi, path }: { holi: HoliSummary; path: string }): React.JSX.Element {
  const send = useSetAtom(sendToHoliAtom)
  return (
    <DropdownMenuItem onSelect={() => void send({ holi, path })}>
      <PixelMascot
        name={holi.mascot ?? 'ghost'}
        color={holi.color ?? '#8f8f94'}
        still
        className="size-4"
      />
      <span className="min-w-0 flex-1 truncate">{holi.name}</span>
      {holi.status !== 'approved' && (
        <span className="text-xs text-muted-foreground">
          {holi.status === 'changed' ? 'Changed' : 'New'}
        </span>
      )}
    </DropdownMenuItem>
  )
}

export function DocumentHoliActions({ path }: { path: string }): React.JSX.Element {
  const holis = useAtomValue(holisAtom)
  const newHoli = useSetAtom(newHoliAtom)
  const { takes, rest } = sendableFor(holis, path)
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  return (
    <>
      <DropdownMenuLabel>Send to Holi</DropdownMenuLabel>
      {takes.length === 0 && (
        <DropdownMenuItem disabled>No Holi takes this document</DropdownMenuItem>
      )}
      {takes.map((h) => (
        <HoliItem key={h.id} holi={h} path={path} />
      ))}
      {rest.length > 0 && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>All Holis</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {rest.map((h) => (
              <DropdownMenuItem key={h.id} disabled>
                <PixelMascot
                  name={h.mascot ?? 'ghost'}
                  color={h.color ?? '#8f8f94'}
                  still
                  className="size-4"
                />
                <span className="min-w-0 flex-1 truncate">{h.name}</span>
                <span className="text-xs text-muted-foreground">Takes other documents</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={() => newHoli(folder === '' ? {} : { accepts: `${folder}/**/*.md` })}
      >
        <Icon icon={Plus} size="sm" />
        New Holi…
      </DropdownMenuItem>
    </>
  )
}
