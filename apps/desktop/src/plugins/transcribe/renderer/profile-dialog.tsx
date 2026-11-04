/**
 * A meeting profile, edited: what kind of meeting this is, in five plain
 * questions (its name, what we build, what to listen for and leave out, the
 * language) and the words the speech model mishears. Everything a person
 * rarely changes (the repository, extra instructions, the speech and Claude
 * models, speaker numbers, sharing, audio, MCP) is folded under More
 * settings. The labels are a person's words; the fields keep their names
 * (`platform`, `focus`, `ignore`), so a saved profile and what the scribe is told
 * stay as they were.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { ChevronRight, Plus, Trash2, X } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { activeRemoteAtom, cn } from '@/plugin-api'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ConfirmDialog } from '@/composites/confirm-dialog'
import { IconButton } from '@/composites/icon-button'
import type { GlossaryEntry, MeetingProfile } from '../shared/meeting'
import { profileId } from './format'
import { meetingCap } from './meeting-cap'
import { SCRIBE_NAME, TASK_NAME, TASKS_NAME } from './names'
import { message, profilesAtom, selectedProfileIdAtom } from './state'

const ACCURATE = 'syv-transcribe'
const FAST = 'syvai/hviske-v5.3'

/** Claude Code's model aliases; a value the file has that is not one stays. */
const MODELS = [
  { value: 'default', label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
]

function blank(): MeetingProfile {
  return {
    id: '',
    name: '',
    platform: '',
    focus: '',
    ignore: '',
    glossary: [],
    instructions: '',
    language: 'auto',
    shareMinutes: false,
    keepAudio: false,
    asrModel: ACCURATE,
    roomDiarize: false,
  }
}

/** A labelled control with its one line of help under the label. */
function Row({
  label,
  help,
  children,
}: {
  label: string
  help?: string
  children: (id: string) => ReactNode
}): React.JSX.Element {
  const id = useId()
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {children(id)}
      {help !== undefined && <FieldDescription className="text-xs">{help}</FieldDescription>}
    </Field>
  )
}

/** On or off, with its help beside the switch. */
function SwitchRow({
  label,
  help,
  checked,
  onChange,
}: {
  label: string
  help: string
  checked: boolean
  onChange: (on: boolean) => void
}): React.JSX.Element {
  const id = useId()
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription className="text-xs">{help}</FieldDescription>
      </FieldContent>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </Field>
  )
}

function ModelSelect({
  id,
  value,
  onChange,
}: {
  id: string
  value: string | undefined
  onChange: (v: string | undefined) => void
}): React.JSX.Element {
  const known = value === undefined || MODELS.some((m) => m.value === value)
  return (
    <Select
      value={value ?? 'default'}
      onValueChange={(v) => onChange(v === 'default' ? undefined : v)}
    >
      <SelectTrigger id={id} size="sm" className="w-36">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {[...MODELS, ...(known ? [] : [{ value, label: value }])].map((m) => (
          <SelectItem key={m.value} value={m.value}>
            {m.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function GlossaryEditor({
  value,
  onChange,
}: {
  value: readonly GlossaryEntry[]
  onChange: (next: GlossaryEntry[]) => void
}): React.JSX.Element {
  const set = (i: number, entry: GlossaryEntry) =>
    onChange(value.map((e, j) => (j === i ? entry : e)))
  return (
    <div className="flex flex-col gap-2">
      {value.map((entry, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            aria-label={`Term ${i + 1}`}
            placeholder="Claude"
            className="w-40"
            value={entry.term}
            onChange={(e) => set(i, { ...entry, term: e.target.value })}
          />
          <Input
            aria-label={`Heard as ${i + 1}`}
            placeholder="Heard as: klot, klod"
            className="flex-1"
            value={entry.heardAs.join(', ')}
            onChange={(e) => set(i, { ...entry, heardAs: e.target.value.split(/,\s*/) })}
          />
          <IconButton
            label={`Remove ${entry.term || 'term'}`}
            onClick={() => onChange(value.filter((_e, j) => j !== i))}
          >
            <X aria-hidden />
          </IconButton>
        </div>
      ))}
      <Button
        variant="dashed"
        size="xs"
        className="self-start"
        onClick={() => onChange([...value, { term: '', heardAs: [] }])}
      >
        <Plus aria-hidden />
        Add term
      </Button>
    </div>
  )
}

/** Drop empty glossary rows and empty variants before saving. */
function tidy(p: MeetingProfile): MeetingProfile {
  return {
    ...p,
    name: p.name.trim(),
    glossary: p.glossary
      .map((g) => ({
        term: g.term.trim(),
        heardAs: g.heardAs.map((h) => h.trim()).filter((h) => h !== ''),
      }))
      .filter((g) => g.term !== ''),
  }
}

export function ProfileDialog({
  profile,
  onClose,
}: {
  /** The profile to edit; absent makes a new one. */
  profile?: MeetingProfile
  onClose: () => void
}): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const profiles = useAtomValue(profilesAtom) ?? []
  const setProfiles = useSetAtom(profilesAtom)
  const select = useSetAtom(selectedProfileIdAtom)
  const [draft, setDraft] = useState<MeetingProfile>(() => profile ?? blank())
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  // A new profile starts with the five questions; the rest is folded.
  const [more, setMore] = useState(false)
  const edit = <K extends keyof MeetingProfile>(key: K, value: MeetingProfile[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))
  const optional = (key: 'repoPath' | 'mcpConfig', value: string) =>
    setDraft((d) => {
      const { [key]: _gone, ...rest } = d
      return value === '' ? rest : { ...rest, [key]: value }
    })

  const save = async () => {
    if (remote === null) return
    const next = tidy(draft)
    if (next.name === '') return setError('Give the profile a name.')
    if (next.id === '') {
      next.id = profileId(
        next.name,
        profiles.map((p) => p.id),
      )
    }
    setSaving(true)
    setError(null)
    try {
      const saved = await meetingCap['profiles.save'](remote, { profile: next })
      setProfiles((list) => {
        const all = list ?? []
        return all.some((p) => p.id === saved.id)
          ? all.map((p) => (p.id === saved.id ? saved : p))
          : [...all, saved]
      })
      select(saved.id)
      onClose()
    } catch (e) {
      setError(`The profile wasn’t saved: ${message(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (remote === null || profile === undefined) return
    await meetingCap['profiles.delete'](remote, { id: profile.id })
    // Main's list rather than ours less one: with the last one gone, main
    // answers its default profile.
    setProfiles(await meetingCap['profiles.list'](remote))
    onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {profile === undefined ? 'New profile' : `Profile: ${profile.name}`}
          </DialogTitle>
          <DialogDescription>
            Optional: a meeting records with the Default profile. A profile says what kind of
            meeting this is, so its topics and {TASKS_NAME} fit.
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-4 flex max-h-140 flex-col gap-4 overflow-y-auto px-4">
          <Row label="Name">
            {(id) => (
              <Input
                id={id}
                className="max-w-sm"
                placeholder="Product planning"
                value={draft.name}
                onChange={(e) => edit('name', e.target.value)}
              />
            )}
          </Row>
          <Row
            label="What do you build?"
            help={`Optional. Context for the ${TASKS_NAME} you send and for the topics; transcription does not use it.`}
          >
            {(id) => (
              <Textarea
                id={id}
                rows={2}
                placeholder="Holi, an Electron app in TypeScript and React"
                value={draft.platform}
                onChange={(e) => edit('platform', e.target.value)}
              />
            )}
          </Row>
          <Row label="Listen for">
            {(id) => (
              <Textarea
                id={id}
                rows={2}
                placeholder="Changes to the app people ask for or agree on"
                value={draft.focus}
                onChange={(e) => edit('focus', e.target.value)}
              />
            )}
          </Row>
          <Row label="Leave out">
            {(id) => (
              <Textarea
                id={id}
                rows={2}
                placeholder="Budget, hiring, small talk"
                value={draft.ignore}
                onChange={(e) => edit('ignore', e.target.value)}
              />
            )}
          </Row>
          <Row label="Language">
            {(id) => (
              <ToggleGroup
                id={id}
                type="single"
                size="sm"
                variant="outline"
                spacing={0}
                value={draft.language}
                onValueChange={(v) => v !== '' && edit('language', v as MeetingProfile['language'])}
              >
                <ToggleGroupItem value="da">Danish</ToggleGroupItem>
                <ToggleGroupItem value="en">English</ToggleGroupItem>
                <ToggleGroupItem value="auto">Auto</ToggleGroupItem>
              </ToggleGroup>
            )}
          </Row>
          <Field>
            <FieldLabel>Words to spell right</FieldLabel>
            <FieldDescription className="text-xs">
              Names and terms the speech model gets wrong: how to write it, then what it hears.
            </FieldDescription>
            <GlossaryEditor value={draft.glossary} onChange={(g) => edit('glossary', g)} />
          </Field>
          <Collapsible open={more} onOpenChange={setMore}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="xs">
                <ChevronRight
                  aria-hidden
                  className={cn('icon-sm motion-respond', more && 'rotate-90')}
                />
                More settings
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="flex flex-col gap-4 pt-3">
                <Row label="Repository" help="The folder agents work in. Empty: the vault.">
                  {(id) => (
                    <Input
                      id={id}
                      className="font-mono"
                      placeholder="/Users/me/code/app"
                      value={draft.repoPath ?? ''}
                      onChange={(e) => optional('repoPath', e.target.value)}
                    />
                  )}
                </Row>
                <Row
                  label={`Extra instructions for ${SCRIBE_NAME}`}
                  help="Anything else it should do or know."
                >
                  {(id) => (
                    <Textarea
                      id={id}
                      rows={2}
                      value={draft.instructions}
                      onChange={(e) => edit('instructions', e.target.value)}
                    />
                  )}
                </Row>
                <Row
                  label="Speech model"
                  help="Accurate catches more words; Fast puts captions up sooner."
                >
                  {(id) => (
                    <ToggleGroup
                      id={id}
                      type="single"
                      size="sm"
                      variant="outline"
                      spacing={0}
                      value={draft.asrModel ?? ACCURATE}
                      onValueChange={(v) => v !== '' && edit('asrModel', v)}
                    >
                      <ToggleGroupItem value={ACCURATE}>Accurate</ToggleGroupItem>
                      <ToggleGroupItem value={FAST}>Fast</ToggleGroupItem>
                    </ToggleGroup>
                  )}
                </Row>
                <SwitchRow
                  label="In-room speaker numbers"
                  help="One microphone in a room: tell voices apart as Speaker 1, Speaker 2 and so on."
                  checked={draft.roomDiarize === true}
                  onChange={(on) => edit('roomDiarize', on)}
                />
                <SwitchRow
                  label="Share minutes"
                  help="Write the minutes into the vault for everyone; off keeps them on this machine."
                  checked={draft.shareMinutes}
                  onChange={(on) => edit('shareMinutes', on)}
                />
                <SwitchRow
                  label="Keep audio"
                  help="Keep the recording after it is transcribed; off deletes it."
                  checked={draft.keepAudio}
                  onChange={(on) => edit('keepAudio', on)}
                />
                <div className="flex flex-wrap gap-4">
                  <Row label="Assistant model" help={`Writes the topics and minutes.`}>
                    {(id) => (
                      <ModelSelect
                        id={id}
                        value={draft.scribeModel}
                        onChange={(v) =>
                          setDraft(({ scribeModel: _m, ...d }) => ({
                            ...d,
                            ...(v === undefined ? {} : { scribeModel: v }),
                          }))
                        }
                      />
                    )}
                  </Row>
                  <Row label="Build model" help={`Runs a ${TASK_NAME} sent to Claude.`}>
                    {(id) => (
                      <ModelSelect
                        id={id}
                        value={draft.buildModel}
                        onChange={(v) =>
                          setDraft(({ buildModel: _m, ...d }) => ({
                            ...d,
                            ...(v === undefined ? {} : { buildModel: v }),
                          }))
                        }
                      />
                    )}
                  </Row>
                </div>
                <Row
                  label="MCP config"
                  help={`A JSON file of MCP servers ${SCRIBE_NAME} and the agents may use. Empty: none.`}
                >
                  {(id) => (
                    <Input
                      id={id}
                      className="font-mono"
                      placeholder="/Users/me/.config/mcp.json"
                      value={draft.mcpConfig ?? ''}
                      onChange={(e) => optional('mcpConfig', e.target.value)}
                    />
                  )}
                </Row>
              </div>
            </CollapsibleContent>
          </Collapsible>
          {error !== null && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          {profile !== undefined && (
            <Button variant="ghost" className="sm:me-auto" onClick={() => setDeleting(true)}>
              <Trash2 aria-hidden />
              Delete
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={saving} onClick={() => void save()}>
            Save profile
          </Button>
        </DialogFooter>
        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          title={`Delete ${profile?.name ?? 'this profile'}?`}
          description={`Meetings recorded with it keep their minutes and ${TASKS_NAME}.`}
          confirmLabel="Delete"
          destructive
          onConfirm={remove}
        />
      </DialogContent>
    </Dialog>
  )
}
