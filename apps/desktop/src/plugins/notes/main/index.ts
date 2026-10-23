/**
 * Notes' main side (docs/features/vault-apps.md): it seeds the `Notes.app`
 * bundle and nothing else. The app runs on the vault apps plugin.
 */
import type { MainPlugin } from '../../../main/plugin-api'
import { NOTES_INFO } from '../info'
import { notesSeed } from './seed'

export const notesMain: MainPlugin = { info: NOTES_INFO, seed: notesSeed }
