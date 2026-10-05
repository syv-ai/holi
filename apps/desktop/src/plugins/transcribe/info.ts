/** What Transcribe is, for both of its sides. */
import type { PluginInfo } from '@holi/shared'

/** Off by default: it asks to record the microphone and to send audio to a
 *  transcription service, which a vault should choose. */
export const TRANSCRIBE_INFO: PluginInfo = {
  id: 'transcribe',
  label: 'Transcribe',
  default: false,
  description:
    'Records an online meeting (your microphone and the meeting’s sound) and transcribes it with syv.ai. Adds a Transcribe.local.app folder, kept on this machine.',
  whenOff:
    'The Transcribe.local.app folder stays on this machine as an ordinary app and keeps working while Vault apps is on. Its meetings and API key stay.',
}
