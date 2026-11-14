/**
 * Export minutes: a small menu of the forms they can leave in. A markdown
 * file, written by main where the save sheet says (`meeting.export`); and a
 * PDF, through the PDF plugin's own render (`pdf.render`, its plain
 * template), offered only while that plugin is on. Each opens the save sheet
 * beside the minutes, so the file lands in the vault unless the person picks
 * elsewhere; one in the vault then opens in a tab.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState } from 'react'
import { ChevronDown, Download } from 'lucide-react'
import { toast } from 'sonner'
import { activeRemoteAtom, openPathAtom, useHasCapability } from '@/plugin-api'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { MeetingState } from '../shared/meeting'
import { useMeetingsDisplayed } from './displayed'
import { meetingCap } from './meeting-cap'
import { pdfCap } from './pdf-cap'
import { message } from './state'

export function ExportMinutes({
  meeting,
  disabled,
}: {
  meeting: MeetingState
  disabled: boolean
}): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const openPath = useSetAtom(openPathAtom)
  const pdf = useHasCapability('pdf.render')
  const source = meeting.minutesPath
  const displayed = useMeetingsDisplayed()
  const [menuOpen, setMenuOpen] = useState(false)
  useEffect(() => {
    if (!displayed) setMenuOpen(false)
  }, [displayed])

  const saveAs = async (extension: 'md' | 'pdf') => {
    if (remote === null || source === undefined) return
    try {
      const out = await window.holi.showSaveDialog({
        remote,
        path: source,
        extension,
        filterName: extension === 'md' ? 'Markdown' : 'PDF',
      })
      if (out === null) return
      if (extension === 'md') {
        const { vaultPath } = await meetingCap.export(remote, { meetingId: meeting.id, out })
        if (vaultPath !== null) openPath(vaultPath)
        toast(`Minutes saved to ${vaultPath ?? out}`)
        return
      }
      const { pdfPath, vaultPath, warnings } = await pdfCap.render(remote, {
        path: source,
        template: 'plain',
        out,
      })
      if (vaultPath !== null) openPath(vaultPath)
      else await window.holi.openPath(pdfPath)
      toast(
        warnings.length === 0
          ? `Minutes saved as ${vaultPath ?? pdfPath}`
          : `Minutes saved, with ${warnings.length} note${warnings.length === 1 ? '' : 's'}: ${warnings.join('; ')}`,
      )
    } catch (e) {
      toast(`The minutes didn’t export: ${message(e)}`)
    }
  }

  return (
    <DropdownMenu
      open={displayed && menuOpen}
      onOpenChange={(next) => setMenuOpen(displayed && next)}
    >
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="secondary" disabled={disabled}>
          <Download aria-hidden />
          Export minutes
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => void saveAs('md')}>Markdown file…</DropdownMenuItem>
        {pdf && <DropdownMenuItem onSelect={() => void saveAs('pdf')}>PDF…</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
