/**
 * Send to Holi: the Holis plugin's rows in a document's Agent menu
 * (`RendererPlugin.documentActions`, docs/features/holis.md). The Holis that
 * take this document first, then every other Holi, then New Holi, which opens
 * the wizard with the document's folder as what it takes. Core draws the menu; these rows
 * are the plugin's.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Plus } from 'lucide-react'
import { holisAtom, holiWizardAtom, sendableFor, sendToHoliAtom, type HoliSummary } from './state'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'
import { PixelPersona } from '@/composites/pixel-persona/pixel-persona'
import { DEFAULT_HOLI_COLOUR } from '@holi/shared'

function HoliItem({ holi, path }: { holi: HoliSummary; path: string }): React.JSX.Element {
  const send = useSetAtom(sendToHoliAtom)
  return (
    <DropdownMenuItem onSelect={() => void send({ holi, path })}>
      <PixelPersona
        name={holi.mascot ?? 'strategist'}
        color={holi.color ?? DEFAULT_HOLI_COLOUR}
        still
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
  const wizard = useSetAtom(holiWizardAtom)
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
                <PixelPersona
                  name={h.mascot ?? 'strategist'}
                  color={h.color ?? DEFAULT_HOLI_COLOUR}
                  still
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
        onSelect={() =>
          wizard({
            mode: 'create',
            ...(folder === '' ? {} : { draft: { accepts: [`${folder}/**/*.md`] } }),
          })
        }
      >
        <Plus className="size-3.5" />
        New Holi…
      </DropdownMenuItem>
    </>
  )
}
