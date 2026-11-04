/**
 * Transcribe's renderer side: the Meetings tab (live captions, the topics
 * and minutes, the tasks sent from them), its nav item, a meeting as a
 * folder the vault's tree opens and its New menu makes (`meeting-claim.ts`),
 * Start and Stop meeting in the command menu, a status-bar item while a
 * meeting records, and the meetings kept in step with main while the vault
 * is open.
 */
import { atom } from 'jotai'
import { AudioLines } from 'lucide-react'
import type { RendererPlugin } from '@/plugin-api'
import { TRANSCRIBE_INFO } from '../info'
import { MEETING_COMMANDS, meetingMenuEntriesAtom, runMeetingMenuEntryAtom } from './commands'
import { MEETING_CLAIM, meetingName } from './meeting-claim'
import { MeetingsSurface } from './meetings-surface'
import { RecordingStatusItem } from './recording-status-item'
import { discardRecordingAtom, recorderAtom, recordingAtom, stopRecordingAtom } from './recorder'
import { MEETINGS_SURFACE, meetingsVault, transcribeEvents } from './state'

export const transcribeRenderer: RendererPlugin = {
  info: TRANSCRIBE_INFO,
  events: {
    ...transcribeEvents,
    // Main is going (Holi quits, or the plugin is turned off): the recording
    // hands over its last audio before main's capabilities do.
    'stop-recording': ({ remote }, store) => {
      if (store.get(recorderAtom).remote === remote) void store.set(stopRecordingAtom)
    },
    // Its folder was deleted from the vault: so was the meeting, and what it
    // records goes nowhere.
    'meeting-removed': ({ remote, payload }, store) => {
      const id = (payload as { meetingId?: unknown } | null)?.meetingId
      if (store.get(recorderAtom).remote === remote && typeof id === 'string') {
        void store.set(discardRecordingAtom, id)
      }
    },
  },
  claims: [MEETING_CLAIM],
  surfaces: [
    {
      kind: MEETINGS_SURFACE,
      label: (id) => (id === undefined ? 'Meetings' : meetingName(id)),
      icon: AudioLines,
      render: MeetingsSurface,
    },
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
