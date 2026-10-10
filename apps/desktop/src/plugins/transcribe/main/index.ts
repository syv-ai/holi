/**
 * Transcribe's main side (docs/features/vault-apps.md): it seeds the
 * `Transcribe.local.app` bundle and nothing else. The app runs on the vault
 * apps plugin, which asks for the microphone and the network.
 */
import type { MainPlugin } from '../../../main/plugin-api'
import { TRANSCRIBE_INFO } from '../info'
import { transcribeSeed } from './seed'

export const transcribeMain: MainPlugin = { info: TRANSCRIBE_INFO, seed: transcribeSeed }
