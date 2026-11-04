/**
 * A meeting in the vault's tree (docs/features/meetings.md): a folder ending
 * in `.meeting` is one document, named without its suffix, that opens as the
 * meeting in a tab of the Meetings surface, its path the tab's id: its
 * transcript, topics and minutes, and Stop while it records. The tree's New
 * menu makes one in the folder it was opened on (`meeting.prepare`) and opens
 * it, where Record starts it: nothing records until a person presses it.
 *
 * The transcript, written first, is what makes the folder a meeting
 * (`transcript.local.md`); it is machine-local, so on another machine the
 * folder is an ordinary one with the shared minutes in it.
 */
import { AudioLines } from 'lucide-react'
import type { PathClaim } from '@/plugin-api'
import { MEETING_SUFFIX } from '../shared/meeting'
import { meetingCap } from './meeting-cap'
import { MEETINGS_SURFACE } from './state'

const ENTRY = 'transcript.local.md'

/** What the tree and the tab call a meeting folder: its name, no suffix. */
export function meetingName(path: string): string {
  const name = path.split('/').at(-1) ?? path
  return name.endsWith(MEETING_SUFFIX) ? name.slice(0, -MEETING_SUFFIX.length) : name
}

export const MEETING_CLAIM: PathClaim = {
  match: (path) => path.endsWith(MEETING_SUFFIX),
  folder: { surface: MEETINGS_SURFACE, entry: ENTRY },
  decorate: { icon: AudioLines, name: meetingName, suffix: () => MEETING_SUFFIX },
  create: {
    id: 'meeting',
    label: 'New meeting',
    icon: AudioLines,
    placeholder: 'Meeting title',
    run: ({ remote, parent, name }) =>
      meetingCap.prepare(remote, { folder: parent, title: name }).then(
        ({ path }) => `${path}/${ENTRY}`,
        (e: unknown) => {
          console.warn('[transcribe]', e)
          return null
        },
      ),
  },
}
