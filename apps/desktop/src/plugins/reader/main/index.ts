/**
 * Read all the things' main side (docs/features/reader.md): nothing but its
 * name. The files are read through core's `files.read` and rendered in the
 * renderer, so there is no capability, seed or claim here.
 */
import type { MainPlugin } from '../../../main/plugin-api'
import { READER_INFO } from '../info'

export const readerMain: MainPlugin = { info: READER_INFO }
