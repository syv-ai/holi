/** One release's notes row on the Updates page. */
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { MarkdownText, openableUrl } from '@/composites/markdown-text'
import { trpc } from '@/lib/trpc'
import { ExternalLinkIcon } from 'lucide-react'
import { SettingsFieldRow } from '../settings-kit'
import { openExternal } from '@/lib/open-external'

type NotesAnswer = Awaited<ReturnType<typeof trpc.updates.notes.query>>

/**
 * One release's notes, from its GitHub release, asked for when first shown
 * and shown formatted but never as HTML (`MarkdownText`). GitHub not
 * answering is asked again on the next opening.
 */
export function ReleaseNotesRow({ version, title }: { version: string; title: string }) {
  const [open, setOpen] = useState(false)
  const [answer, setAnswer] = useState<NotesAnswer | undefined>(undefined)
  useEffect(() => {
    if (!open || answer !== undefined) return
    let live = true
    trpc.updates.notes
      .query({ version })
      .then((found) => live && setAnswer(found))
      .catch(() => live && setAnswer({ kind: 'unreachable' }))
    return () => {
      live = false
    }
  }, [open, answer, version])

  const url = answer?.kind === 'found' ? openableUrl(answer.notes.url) : null
  return (
    <SettingsFieldRow title={title}>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Release notes
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          // Unanswered is asked again when shown again.
          if (!next && answer?.kind === 'unreachable') setAnswer(undefined)
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Holi {version}</DialogTitle>
            <DialogDescription>
              {answer?.kind === 'found' ? answer.notes.name : 'Release notes'}
            </DialogDescription>
          </DialogHeader>
          {answer === undefined ? (
            <div className="flex flex-col gap-2" role="status" aria-label="Loading notes">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
            </div>
          ) : answer.kind === 'unreachable' ? (
            <p className="text-muted-foreground text-sm">
              GitHub did not answer. Close this and try again.
            </p>
          ) : answer.kind === 'none' ? (
            <p className="text-muted-foreground text-sm">GitHub has no notes for this version.</p>
          ) : answer.notes.body.trim() === '' ? (
            <p className="text-muted-foreground text-sm">No notes for this version.</p>
          ) : (
            <MarkdownText
              body={answer.notes.body}
              className="text-muted-foreground max-h-96 overflow-auto text-sm"
            />
          )}
          {url !== null ? (
            <Button
              variant="link"
              size="sm"
              className="self-start"
              onClick={() => openExternal(url)}
            >
              <ExternalLinkIcon data-icon="inline-start" aria-hidden="true" />
              {answer?.kind === 'found' ? answer.notes.name : 'The release'} on GitHub
            </Button>
          ) : null}
        </DialogContent>
      </Dialog>
    </SettingsFieldRow>
  )
}
