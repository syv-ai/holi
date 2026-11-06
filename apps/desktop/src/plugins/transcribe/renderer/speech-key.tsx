/**
 * The speech service in the Meetings tab (docs/features/meetings.md): the
 * notice when meetings cannot be transcribed yet, the fix where a meeting
 * waits on its key, and the dialog the header's menu opens to choose the
 * service (syv.ai's, or any that answers `/audio/transcriptions`) and to
 * replace, test or remove its key.
 *
 * The key goes to main and never comes back: the window knows whether one is
 * set and where it came from (this machine or the vault's `.env.local`).
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { KeyRound, TriangleAlert } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { activeRemoteAtom } from '@/plugin-api'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { MeetingBlock, SpeechService } from '../shared/meeting'
import { meetingCap } from './meeting-cap'
import {
  loadSpeechKeyAtom,
  meetingStatesAtom,
  message,
  shownMeetingIdAtom,
  speechKeyAtom,
} from './state'

const NOTE = 'Stored encrypted on this Mac, never in the vault or git.'

/** Whether the service is syv.ai's (`url` null). */
const syv = (s: SpeechService | undefined): boolean => s?.url == null

/** A password field and Save: the key goes to main, then the window asks
 *  again whether one is set. */
function SpeechKeyForm({ onSaved }: { onSaved?: () => void }): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const reload = useSetAtom(loadSpeechKeyAtom)
  const service = useAtomValue(speechKeyAtom)?.service
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
      <FieldLabel htmlFor={id}>{syv(service) ? 'syv.ai speech key' : 'API key'}</FieldLabel>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="password"
          placeholder={syv(service) ? 'hv_…' : 'If the service needs one'}
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

/** Above Record while meetings cannot be transcribed yet (syv.ai's service
 *  with no key), unless the meeting shown already says so with its own fix:
 *  Record opens the speech service instead of recording. */
export function SpeechKeyNotice({ onSetUp }: { onSetUp: () => void }): React.JSX.Element | null {
  const status = useAtomValue(speechKeyAtom)
  const shown = useAtomValue(shownMeetingIdAtom)
  const states = useAtomValue(meetingStatesAtom)
  if (status?.ready !== false) return null
  if (shown !== null && states[shown]?.blocked !== undefined) return null
  return (
    <Alert variant="warning" aria-label="Speech service">
      <KeyRound aria-hidden />
      <AlertTitle>Set up transcription before you record</AlertTitle>
      <AlertDescription>
        Save your syv.ai speech key, or choose another speech service.
      </AlertDescription>
      <AlertAction>
        <Button size="sm" variant="outline" onClick={onSetUp}>
          Set up…
        </Button>
      </AlertAction>
    </Alert>
  )
}

const BLOCKED: Record<MeetingBlock, { title: string; text: string }> = {
  'no-key': {
    title: 'Transcription is waiting for a speech key',
    text: 'The audio is kept. It is transcribed as soon as a key is saved.',
  },
  'bad-key': {
    title: 'The speech service refused the key',
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
  ok: 'The service accepts it.',
  invalid: 'The service refused the key.',
  unreachable:
    'The service could not be reached, or did not answer as a speech service. Check its address and model.',
} as const

/** syv.ai's service, or another one's address and model, saved together. A
 *  key saved here stays with its service: it goes to the new one only when
 *  the box under the toggle is ticked. */
function ServiceForm({ onSaved }: { onSaved: (said: string) => void }): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const status = useAtomValue(speechKeyAtom)
  const setStatus = useSetAtom(speechKeyAtom)
  const urlId = useId()
  const modelId = useId()
  const moveId = useId()
  const [moveKey, setMoveKey] = useState(false)
  const ownKey = status?.source === 'app'
  const [kind, setKind] = useState<'syv' | 'other'>(syv(status?.service) ? 'syv' : 'other')
  const [url, setUrl] = useState(status?.service.url ?? '')
  const [model, setModel] = useState(status?.service.model ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (next: SpeechService) => {
    if (remote === null) return
    setBusy(true)
    setError(null)
    try {
      setStatus(await meetingCap['service.set'](remote, { ...next, moveKey: ownKey && moveKey }))
      onSaved(next.url === null ? 'Meetings are transcribed by syv.ai.' : 'Service saved.')
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        spacing={0}
        aria-label="Speech service"
        value={kind}
        disabled={busy}
        onValueChange={(v) => {
          if (v !== 'syv' && v !== 'other') return
          setKind(v)
          if (v === 'syv' && !syv(status?.service)) void save({ url: null, model: null })
        }}
      >
        <ToggleGroupItem value="syv">syv.ai</ToggleGroupItem>
        <ToggleGroupItem value="other">Another service</ToggleGroupItem>
      </ToggleGroup>
      {ownKey && (
        <Field orientation="horizontal">
          <Checkbox
            id={moveId}
            checked={moveKey}
            disabled={busy}
            onCheckedChange={(next) => setMoveKey(next === true)}
          />
          <FieldLabel htmlFor={moveId}>Move this Mac’s saved key to the new service</FieldLabel>
        </Field>
      )}
      {kind === 'other' && (
        <>
          <Field data-invalid={error !== null || undefined}>
            <FieldLabel htmlFor={urlId}>Address</FieldLabel>
            <Input
              id={urlId}
              placeholder="https://api.example.com/v1"
              spellCheck={false}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <FieldDescription>
              Any service that answers /audio/transcriptions as OpenAI’s does. https, or http on
              this Mac.
            </FieldDescription>
          </Field>
          <Field data-invalid={error !== null || undefined}>
            <FieldLabel htmlFor={modelId}>Model</FieldLabel>
            <div className="flex items-center gap-2">
              <Input
                id={modelId}
                placeholder="whisper-1"
                spellCheck={false}
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
              <Button
                size="sm"
                disabled={busy || url.trim() === '' || model.trim() === ''}
                onClick={() => void save({ url: url.trim(), model: model.trim() })}
              >
                {busy && <Spinner />}
                Save service
              </Button>
            </div>
            {error !== null && <FieldError>{error}</FieldError>}
          </Field>
        </>
      )}
    </div>
  )
}

/** The header menu's Speech service: which service, whether a key is set
 *  and where from, never the key, with a field to replace it, a test and,
 *  for this Mac's, Remove. */
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
          : status.elsewhere
            ? 'The key saved on this Mac is for another speech service, so it is not sent to this one.'
            : syv(status.service)
              ? 'No key is set.'
              : 'No key is set: the service is asked without one.'

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Speech service</DialogTitle>
          <DialogDescription>
            Meetings are transcribed by the service chosen here, with your key. Both are yours, not
            the vault’s, so they are kept on this Mac only.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {status !== null && <ServiceForm key={status.service.url ?? 'syv'} onSaved={setSaid} />}
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {status?.set === true ? (
              <Badge variant="success-light">Key set</Badge>
            ) : status?.ready === true ? (
              <Badge variant="secondary">No key</Badge>
            ) : (
              <Badge variant="warning-light">Key not set</Badge>
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
            disabled={busy || status?.ready !== true}
            onClick={() => void act(async (r) => TESTED[(await meetingCap['key.test'](r)).result])}
          >
            {busy && <Spinner />}
            Test
          </Button>
          <Button onClick={() => setOpen(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
