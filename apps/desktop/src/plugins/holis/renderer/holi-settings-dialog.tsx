/**
 * A Holi's settings, after MonoCode's `MonoSettingsDialog` and
 * `MonoFilePages` (MIT, Copyright (c) 2026 Nick; see NOTICE.md): a dialog with
 * three sections on its left. A new Holi is set up in the wizard first.
 *
 * - **General**: its face and name, its model, what it may do without asking,
 *   the documents it takes, and removing it. Each saves as it changes, into
 *   `holi.yaml` in place.
 * - **Soul**: `SOUL.md`, its standing instructions, saved on blur over the
 *   text it opened only; a run or a pull that wrote it since offers theirs or
 *   yours.
 * - **Memory**: `MEMORY.md` one fact a row, each editable or forgotten, a new
 *   one added at the top, and how much of it loads into a run.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Settings, Sparkles, StickyNote } from 'lucide-react'
import { useState } from 'react'
import { holiSettingsAtom, holisAtom, type SettingsSection } from './state'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { General } from './holi-settings-general'
import { Soul } from './holi-settings-soul'
import { Memory } from './holi-settings-memory'

const SECTIONS: { id: SettingsSection; label: string; icon: typeof Settings }[] = [
  { id: 'general', label: 'General', icon: Settings },
  { id: 'soul', label: 'Soul', icon: Sparkles },
  { id: 'memory', label: 'Memory', icon: StickyNote },
]

export function HoliSettingsDialog(): React.JSX.Element | null {
  const open = useAtomValue(holiSettingsAtom)
  const setOpen = useSetAtom(holiSettingsAtom)
  const holis = useAtomValue(holisAtom)
  const [error, setError] = useState<string | null>(null)
  const holi = open === null ? undefined : holis.find((h) => h.id === open.id)
  if (open === null || holi === undefined) return null

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (next) return
        setError(null)
        setOpen(null)
      }}
    >
      <DialogContent className="sm:max-w-6xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{holi.name} settings</DialogTitle>
        </DialogHeader>
        <div className="flex h-170 min-h-0 gap-6">
          <nav aria-label="Settings" className="flex w-40 shrink-0 flex-col gap-0.5">
            {SECTIONS.map((s) => (
              <Button
                key={s.id}
                variant="ghost"
                className="justify-start text-nav font-medium text-muted-foreground hover:bg-foreground/5 hover:text-foreground aria-[current=page]:bg-foreground/10 aria-[current=page]:text-foreground"
                aria-current={open.section === s.id ? 'page' : undefined}
                onClick={() => setOpen({ id: holi.id, section: s.id })}
              >
                <s.icon className="size-3.5" />
                {s.label}
              </Button>
            ))}
          </nav>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain pe-1">
            {error !== null && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {open.section === 'general' ? (
              <General holi={holi} onError={setError} />
            ) : open.section === 'soul' ? (
              <Soul holi={holi} onError={setError} />
            ) : (
              <Memory holi={holi} onError={setError} />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
