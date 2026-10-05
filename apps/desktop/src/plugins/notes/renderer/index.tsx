/**
 * Notes' renderer side: nothing of its own. `Notes.app` opens through the vault
 * apps plugin like any app folder.
 */
import type { RendererPlugin } from '@/plugin-api'
import { NOTES_INFO } from '../info'

export const notesRenderer: RendererPlugin = { info: NOTES_INFO }
