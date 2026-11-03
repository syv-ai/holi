/**
 * The syv.ai speech key in the Meetings tab (docs/features/meetings.md): the
 * notice when none is set, the fix where a meeting waits on its key, and the
 * dialog the header's menu opens to replace, test or remove it.
 *
 * The key goes to main and never comes back: the window knows whether one is
 * set and where it came from (this machine or the vault's `.env.local`).
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { KeyRound, TriangleAlert } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { activeRemoteAtom } from '@/plugin-api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import type { MeetingBlock } from '../shared/meeting'
import { meetingCap } from './meeting-cap'
import {
  loadSpeechKeyAtom,
  meetingStatesAtom,
  message,
  shownMeetingIdAtom,
  speechKeyAtom,
} from './state'

const NOTE = 'Stored encrypted on this Mac, never in the vault or git.'

/** A password field and Save: the key goes to main, then the window asks
 *  again whether one is set. */
function SpeechKeyForm({ onSaved }: { onSaved?: () => void }): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const reload = useSetAtom(loadSpeechKeyAtom)
  const id = useId()
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canSave = !busy && key.trim() !== '' && remote !== null

  const save = async () => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    try {
      await meetingCap['key.set'](remote, { key })
      setKey('')
      await reload()
      onSaved?.()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Field data-invalid={error !== null || undefined}>
      <FieldLabel htmlFor={id}>syv.ai speech key</FieldLabel>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="password"
          placeholder="hv_…"
          value={key}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error !== null || undefined}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void save()
            }
          }}
        />
        <Button size="sm" disabled={!canSave} onClick={() => void save()}>
          {busy && <Spinner />}
          Save
        </Button>
      </div>
      <FieldDescription>{NOTE}</FieldDescription>
      {error !== null && <FieldError>{error}</FieldError>}
    </Field>
  )
}

/** Above Record when no key is set, unless the meeting shown already says
 *  so with its own fix. Recording still works: the audio waits for a key. */
export function SpeechKeyNotice(): React.JSX.Element | null {
  const status = useAtomValue(speechKeyAtom)
  const shown = useAtomValue(shownMeetingIdAtom)
  const states = useAtomValue(meetingStatesAtom)
  if (status?.set !== false) return null
  if (shown !== null && states[shown]?.blocked !== undefined) return null
  return (
    <Alert variant="warning" aria-label="Speech key">
      <KeyRound aria-hidden />
      <AlertTitle>Add your syv.ai speech key to transcribe</AlertTitle>
      <AlertDescription>
        <span>
          You can record without one: the audio is kept and transcribed once a key is saved.
        </span>
        <SpeechKeyForm />
      </AlertDescription>
    </Alert>
  )
}

const BLOCKED: Record<MeetingBlock, { title: string; text: string }> = {
  'no-key': {
    title: 'Transcription is waiting for a speech key',
    text: 'The audio is kept. It is transcribed as soon as a key is saved.',
  },
  'bad-key': {
    title: 'syv.ai refused the speech key',
    text: 'The audio is kept. Save a working key and it is transcribed.',
  },
}

/** Under the header of a meeting that waits on its key. */
export function SpeechKeyBlocked({ reason }: { reason: MeetingBlock }): React.JSX.Element {
  return (
    <Alert variant="warning" aria-label="Speech key">
      <TriangleAlert aria-hidden />
      <AlertTitle>{BLOCKED[reason].title}</AlertTitle>
      <AlertDescription>
        <span>{BLOCKED[reason].text}</span>
        <SpeechKeyForm />
      </AlertDescription>
    </Alert>
  )
}

const TESTED = {
  ok: 'syv.ai accepts the key.',
  invalid: 'syv.ai refused the key.',
  unreachable: 'syv.ai could not be reached. Try again in a moment.',
} as const

/** The header menu's Speech key: whether a key is set and where from, never
 *  the key, with a field to replace it, a test and, for this Mac's, Remove. */
export function SpeechKeyDialog({
  open,
  onOpenChange: setOpen,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const status = useAtomValue(speechKeyAtom)
  const reload = useSetAtom(loadSpeechKeyAtom)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  // Asked again each time it opens: the key may have changed elsewhere.
  useEffect(() => {
    if (!open) return
    setSaid(null)
    void reload()
  }, [open, reload])

  const act = async (run: (remote: string) => Promise<string | null>) => {
    if (remote === null) return
    setBusy(true)
    try {
      setSaid(await run(remote))
    } catch (e) {
      setSaid(message(e))
    } finally {
      setBusy(false)
    }
  }

  const where =
    status === null
      ? 'Holi could not say whether a key is set.'
      : status.source === 'app'
        ? 'A key is set on this Mac.'
        : status.source === 'vault'
          ? 'The key comes from SYV_API_KEY in the vault’s .env.local. A key saved here takes its place.'
          : 'No key is set.'

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Speech key</DialogTitle>
          <DialogDescription>
            Meetings are transcribed by syv.ai with your key. It is yours, not the vault’s, so it is
            kept on this Mac only.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {status?.set === true ? (
              <Badge variant="success-light">Set</Badge>
            ) : (
              <Badge variant="warning-light">Not set</Badge>
            )}
            <span>{where}</span>
          </div>
          <SpeechKeyForm onSaved={() => setSaid('Saved.')} />
          {said !== null && (
            <p role="status" className="text-sm text-muted-foreground">
              {said}
            </p>
          )}
        </div>
        <DialogFooter>
          {status?.source === 'app' && (
            <Button
              variant="ghost"
              className="sm:me-auto"
              disabled={busy}
              onClick={() =>
                void act(async (r) => {
                  await meetingCap['key.clear'](r)
                  await reload()
                  return 'Removed from this Mac.'
                })
              }
            >
              Remove
            </Button>
          )}
          <Button
            variant="outline"
            disabled={busy || status?.set !== true}
            onClick={() => void act(async (r) => TESTED[(await meetingCap['key.test'](r)).result])}
          >
            {busy && <Spinner />}
            Test key
          </Button>
          <Button onClick={() => setOpen(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
