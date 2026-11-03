/**
 * The meetings surface's top row, one line: back to the list while a meeting
 * is shown, the profile the next meeting starts with and a menu for the
 * profiles and the speech key, the title (the recording meeting's own while
 * it records), which audio it records, how a recording meeting is doing
 * (`meeting-status.tsx`) with the reminder that it records, and on the right
 * the level, the timer and Record or Stop. While a meeting records, the
 * choices it started with are fixed. Under the row, only while something is
 * wrong: the notice when no speech key is set, and a recording that failed.
 */
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  ArrowLeft,
  Circle,
  Ellipsis,
  KeyRound,
  MicIcon,
  MonitorSpeaker,
  Plus,
  Settings2,
  Square,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { useNow } from '@/plugin-api'
import { Alert, AlertAction, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { IconButton } from '@/composites/icon-button'
import { clock } from './format'
import { MeetingStatus, RecordingPill } from './meeting-status'
import { ProfileDialog } from './profile-dialog'
import {
  clearRecorderErrorAtom,
  levelAtom,
  recorderAtom,
  startRecordingAtom,
  stopRecordingAtom,
} from './recorder'
import { SpeechKeyDialog, SpeechKeyNotice } from './speech-key'
import { meetingStatesAtom, profilesAtom, selectedProfileIdAtom, shownMeetingIdAtom } from './state'

type Source = 'microphone' | 'system'

const SOURCES: ReadonlyArray<{ value: Source; label: string; icon: typeof MicIcon }> = [
  { value: 'microphone', label: 'Microphone', icon: MicIcon },
  { value: 'system', label: 'Computer audio', icon: MonitorSpeaker },
]

function Timer({ since }: { since: number }): React.JSX.Element {
  const now = useNow(1000)
  return (
    <span className="text-sm tabular-nums" aria-label="Recording time">
      {clock((now - since) / 1000)}
    </span>
  )
}

function LevelMeter(): React.JSX.Element {
  const level = useAtomValue(levelAtom)
  return (
    <Progress
      aria-label="Input level"
      value={Math.round(Math.min(1, level) * 100)}
      className="w-16"
    />
  )
}

export function MeetingHeader(): React.JSX.Element {
  const profiles = useAtomValue(profilesAtom)
  const [profileId, setProfileId] = useAtom(selectedProfileIdAtom)
  const rec = useAtomValue(recorderAtom)
  const start = useSetAtom(startRecordingAtom)
  const stop = useSetAtom(stopRecordingAtom)
  const clearError = useSetAtom(clearRecorderErrorAtom)
  const [shown, setShown] = useAtom(shownMeetingIdAtom)
  const states = useAtomValue(meetingStatesAtom)
  const recording = states[rec.meetingId ?? '']
  // The meeting the person is looking at, else the one recording.
  const watched = (shown === null ? undefined : states[shown]) ?? recording
  const live = watched?.phase === 'recording' ? watched : undefined
  const [title, setTitle] = useState('')
  const [sources, setSources] = useState<Source[]>(['microphone', 'system'])
  const [editing, setEditing] = useState<'new' | 'edit' | null>(null)
  const [keyOpen, setKeyOpen] = useState(false)
  const busy = rec.phase !== 'idle'
  const profile = profiles?.find((p) => p.id === profileId)
  const microphone = sources.includes('microphone')
  const system = sources.includes('system')
  const canRecord = profileId !== null && sources.length > 0

  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-divider px-4 py-2">
      <div className="flex min-w-0 items-center gap-2">
        {shown !== null && (
          <IconButton label="All meetings" onClick={() => setShown(null)}>
            <ArrowLeft aria-hidden />
          </IconButton>
        )}
        <div className="flex shrink-0 items-center gap-1">
          <Select
            value={profileId ?? ''}
            onValueChange={setProfileId}
            disabled={busy || profiles === null || profiles.length === 0}
          >
            <SelectTrigger size="sm" className="w-40" aria-label="Profile">
              <SelectValue placeholder={profiles === null ? 'Loading…' : 'No profile yet'} />
            </SelectTrigger>
            <SelectContent>
              {(profiles ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Profiles and speech key">
                    <Ellipsis aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>Profiles and speech key</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start">
              {profile !== undefined && (
                <DropdownMenuItem onSelect={() => setEditing('edit')}>
                  <Settings2 aria-hidden />
                  Edit profile…
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => setEditing('new')}>
                <Plus aria-hidden />
                New profile…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setKeyOpen(true)}>
                <KeyRound aria-hidden />
                Speech key…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {busy && recording !== undefined ? (
          <h1 className="max-w-sm min-w-24 truncate text-sm font-medium">{recording.title}</h1>
        ) : (
          <Input
            aria-label="Meeting title"
            placeholder="Meeting title"
            className="max-w-sm min-w-24 flex-1"
            value={title}
            disabled={busy}
            onChange={(e) => setTitle(e.target.value)}
          />
        )}
        <ToggleGroup
          type="multiple"
          variant="outline"
          size="sm"
          spacing={0}
          aria-label="Audio to record"
          value={sources}
          disabled={busy}
          onValueChange={(v) => setSources(v as Source[])}
          className="shrink-0"
        >
          {SOURCES.map(({ value, label, icon: Icon }) => (
            <Tooltip key={value}>
              <TooltipTrigger asChild>
                <ToggleGroupItem value={value} aria-label={label}>
                  <Icon aria-hidden />
                </ToggleGroupItem>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          ))}
        </ToggleGroup>
        {live !== undefined && (
          <>
            <MeetingStatus meeting={live} />
            <RecordingPill />
          </>
        )}
        <div className="ms-auto flex shrink-0 items-center gap-2">
          {rec.phase === 'recording' && rec.startedAt !== null && (
            <>
              <LevelMeter />
              <Timer since={rec.startedAt} />
            </>
          )}
          {rec.phase === 'idle' ? (
            <Button
              size="sm"
              disabled={!canRecord}
              onClick={() =>
                profileId !== null && void start({ profileId, title, microphone, system })
              }
            >
              <Circle aria-hidden className="fill-current text-destructive" />
              Record
            </Button>
          ) : (
            <Button
              size="sm"
              variant="destructive"
              disabled={rec.phase !== 'recording'}
              onClick={() => void stop().then(() => setTitle(''))}
            >
              {rec.phase === 'recording' ? <Square aria-hidden /> : <Spinner />}
              {rec.phase === 'starting'
                ? 'Starting…'
                : rec.phase === 'stopping'
                  ? 'Stopping…'
                  : 'Stop'}
            </Button>
          )}
        </div>
      </div>
      <SpeechKeyNotice />
      {rec.error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{rec.error}</AlertDescription>
          <AlertAction>
            <IconButton label="Dismiss" size="icon-xs" onClick={() => clearError()}>
              <X aria-hidden />
            </IconButton>
          </AlertAction>
        </Alert>
      )}
      {editing !== null && (
        <ProfileDialog
          profile={editing === 'edit' ? profile : undefined}
          onClose={() => setEditing(null)}
        />
      )}
      <SpeechKeyDialog open={keyOpen} onOpenChange={setKeyOpen} />
    </div>
  )
}
