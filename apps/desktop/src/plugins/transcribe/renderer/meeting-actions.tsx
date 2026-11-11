/**
 * What a person does to a meeting itself, from the list and from its review:
 * Rename (its title, in place: Enter saves, Escape puts it back; the folder
 * it was filed under keeps its name) and Delete, asked first, which removes
 * its transcript, minutes and topics from this machine and the vault and
 * leaves the tasks made from it. A meeting that records or finishes cannot
 * be deleted.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Ellipsis, Pencil, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { activeRemoteAtom } from '@/plugin-api'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/composites/confirm-dialog'
import { IconButton } from '@/composites/icon-button'
import type { MeetingPhase } from '../shared/meeting'
import { meetingCap } from './meeting-cap'
import { TASKS_NAME } from './names'
import { meetingsAtom, meetingStatesAtom, message, shownMeetingIdAtom } from './state'

interface MeetingRef {
  id: string
  title: string
  phase: MeetingPhase
}

/** A meeting's title open for editing; saves on Enter or leaving it. */
export function TitleEditor({
  meeting,
  className,
  onDone,
}: {
  meeting: MeetingRef
  className?: string
  onDone: () => void
}): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const setList = useSetAtom(meetingsAtom)
  const setStates = useSetAtom(meetingStatesAtom)
  const [draft, setDraft] = useState(meeting.title)
  const [error, setError] = useState<string | null>(null)
  /** Set once Enter or Escape settled it, so the blur after does not. */
  const settled = useRef(false)

  const save = async () => {
    const title = draft.replace(/\s+/g, ' ').trim()
    if (title === '' || title === meeting.title || remote === null) return onDone()
    try {
      const saved = await meetingCap.rename(remote, { meetingId: meeting.id, title })
      setList((list) => list?.map((m) => (m.id === saved.id ? saved : m)) ?? list)
      setStates((all) => {
        const m = all[meeting.id]
        return m === undefined ? all : { ...all, [meeting.id]: { ...m, title: saved.title } }
      })
      onDone()
    } catch (e) {
      settled.current = false
      setError(`The meeting wasn’t renamed: ${message(e)}`)
    }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <Input
        aria-label="Rename meeting"
        className={className}
        autoFocus
        value={draft}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            settled.current = true
            void save()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            settled.current = true
            onDone()
          }
        }}
        onBlur={() => {
          if (!settled.current) void save()
        }}
      />
      {error !== null && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

/** A meeting's menu: Rename and Delete. */
export function MeetingMenu({
  meeting,
  onRename,
}: {
  meeting: MeetingRef
  onRename: () => void
}): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const setList = useSetAtom(meetingsAtom)
  const setStates = useSetAtom(meetingStatesAtom)
  const setShown = useSetAtom(shownMeetingIdAtom)
  const [deleting, setDeleting] = useState(false)
  /** Rename was picked: the title field opens once the menu has closed and
   *  would no longer take focus back from it. */
  const renaming = useRef(false)
  const running = meeting.phase === 'recording' || meeting.phase === 'finishing'

  const remove = async () => {
    if (remote === null) return
    try {
      await meetingCap.delete(remote, { meetingId: meeting.id })
    } catch (e) {
      throw new Error(`The meeting wasn’t deleted: ${message(e)}`)
    }
    setShown((shown) => (shown === meeting.id ? null : shown))
    setList((list) => list?.filter((m) => m.id !== meeting.id) ?? list)
    setStates(({ [meeting.id]: _gone, ...rest }) => rest)
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton label="Meeting actions" size="icon-xs">
            <Ellipsis aria-hidden />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(e) => {
            if (!renaming.current) return
            renaming.current = false
            e.preventDefault()
            onRename()
          }}
        >
          <DropdownMenuItem
            onSelect={() => {
              renaming.current = true
            }}
          >
            <Pencil aria-hidden />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            disabled={running}
            onSelect={() => setDeleting(true)}
          >
            <Trash2 aria-hidden />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete “${meeting.title}”?`}
        description={`Its transcript, minutes and topics are removed from this machine and the vault. ${TASKS_NAME} made from it stay.`}
        confirmLabel="Delete meeting"
        destructive
        onConfirm={remove}
      />
    </>
  )
}
