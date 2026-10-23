/**
 * Transcribe's renderer side: nothing of its own. `Transcribe.local.app` opens
 * through the vault apps plugin like any app folder.
 */
import type { RendererPlugin } from '@/plugin-api'
import { TRANSCRIBE_INFO } from '../info'

export const transcribeRenderer: RendererPlugin = { info: TRANSCRIBE_INFO }
