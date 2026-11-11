/** What Transcribe is, for both of its sides. */
import type { PluginInfo } from '@holi/shared'

/** Off by default: it asks to record the microphone and the meeting's sound,
 *  and to send the audio to a transcription service, which a vault should
 *  choose. It runs a meeting's scribe and the tasks sent from it as agent
 *  sessions, and makes a task file of each, so it stands on the agent and
 *  tasks. */
export const TRANSCRIBE_INFO: PluginInfo = {
  id: 'transcribe',
  label: 'Transcribe',
  default: false,
  requires: ['agent', 'tasks'],
  description:
    'A Meetings tab: records a meeting (your microphone and the meeting’s sound), captions it live with syv.ai, groups it into topics with minutes, and sends a topic to Claude or a Holi as a task.',
  whenOff:
    'The Meetings tab goes. Meetings already recorded stay on this machine, with their transcripts and minutes in the vault.',
}
