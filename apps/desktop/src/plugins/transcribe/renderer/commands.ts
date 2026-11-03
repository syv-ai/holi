/**
 * Start meeting and Stop meeting, in the command menu and as commands. Start
 * records with the picked profile, both audio sources and no title, and
 * brings the Meetings tab forward; with no profile yet it only opens the tab,
 * where one is made.
 */
import { atom, type Getter, type Setter } from 'jotai'
import { AudioLines, Square } from 'lucide-react'
import { openSurfaceAtom, type Command, type CommandMenuEntry } from '@/plugin-api'
import { recorderAtom, startRecordingAtom, stopRecordingAtom } from './recorder'
import { MEETINGS_SURFACE, selectedProfileIdAtom } from './state'

function startMeeting(get: Getter, set: Setter): void {
  set(openSurfaceAtom, MEETINGS_SURFACE)
  const profileId = get(selectedProfileIdAtom)
  if (profileId === null) return
  void set(startRecordingAtom, { profileId, title: '', microphone: true, system: true })
}

function stopMeeting(_get: Getter, set: Setter): void {
  void set(stopRecordingAtom)
}

const idle = (get: Getter) => get(recorderAtom).phase === 'idle'
const recording = (get: Getter) => get(recorderAtom).phase === 'recording'

export const MEETING_COMMANDS: readonly Command[] = [
  { id: 'meeting.start', label: 'Start meeting', when: idle, run: startMeeting },
  { id: 'meeting.stop', label: 'Stop meeting', when: recording, run: stopMeeting },
]

/** Meetings under Go to: the way to the tab, since the nav is not drawn. */
const goToMeetings = (get: Getter): CommandMenuEntry => ({
  id: 'open',
  label: 'Meetings',
  group: 'go',
  icon: AudioLines,
  keywords: ['transcribe', 'minutes', 'captions', 'record'],
  ...(recording(get) ? { detail: 'Recording' } : {}),
})

export const meetingMenuEntriesAtom = atom((get): readonly CommandMenuEntry[] => [
  goToMeetings(get),
  ...actionEntries(get),
])

const actionEntries = (get: Getter): readonly CommandMenuEntry[] =>
  idle(get)
    ? [
        {
          id: 'start',
          label: 'Start meeting',
          group: 'action',
          icon: AudioLines,
          keywords: ['record', 'transcribe', 'call', 'minutes'],
        },
      ]
    : recording(get)
      ? [
          {
            id: 'stop',
            label: 'Stop meeting',
            group: 'action',
            icon: Square,
            keywords: ['record', 'transcribe', 'call', 'end'],
          },
        ]
      : []

export const runMeetingMenuEntryAtom = atom(null, (get, set, id: string): void => {
  if (id === 'open') set(openSurfaceAtom, MEETINGS_SURFACE)
  if (id === 'start') startMeeting(get, set)
  if (id === 'stop') stopMeeting(get, set)
})
