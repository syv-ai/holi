/**
 * Transcribe's renderer side: the Meetings tab (live captions, the topics
 * and minutes, the tasks sent from them), its nav item, Start and Stop
 * meeting in the command menu, a status-bar item while a meeting records,
 * and the meetings kept in step with main while the vault is open.
 */
import { atom } from 'jotai'
import { AudioLines } from 'lucide-react'
import type { RendererPlugin } from '@/plugin-api'
import { TRANSCRIBE_INFO } from '../info'
import { MEETING_COMMANDS, meetingMenuEntriesAtom, runMeetingMenuEntryAtom } from './commands'
import { MeetingsSurface } from './meetings-surface'
import { RecordingStatusItem } from './recording-status-item'
import { recordingAtom, stopRecordingAtom } from './recorder'
import { MEETINGS_SURFACE, meetingsVault, transcribeEvents } from './state'

export const transcribeRenderer: RendererPlugin = {
  info: TRANSCRIBE_INFO,
  events: transcribeEvents,
  surfaces: [
    { kind: MEETINGS_SURFACE, label: 'Meetings', icon: AudioLines, render: MeetingsSurface },
  ],
  // After Agenda, before Agents.
  rail: [{ surface: MEETINGS_SURFACE, order: 55, live: recordingAtom }],
  commands: MEETING_COMMANDS,
  commandMenu: { entries: meetingMenuEntriesAtom, run: runMeetingMenuEntryAtom },
  statusItems: [{ id: 'recording', side: 'left', order: 10, Component: RecordingStatusItem }],
  leaveGuard: atom((get) =>
    get(recordingAtom) ? 'A meeting is recording. Leaving this vault stops it.' : null,
  ),
  // Leaving the vault stops its recording: its chunks belong to its meetings.
  vault: (remote, store) => {
    const off = meetingsVault(remote, store)
    return () => {
      void store.set(stopRecordingAtom)
      off()
    }
  },
}
