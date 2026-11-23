/**
 * Read all the things' renderer side (docs/features/reader.md): a `.docx`,
 * `.pptx` or `.epub` opens read-only in its viewer.
 */
import { readableDoc } from '@holi/shared'
import type { RendererPlugin } from '@/plugin-api'
import { READER_INFO } from '../info'
import { ReaderView } from './reader-view'

export const readerRenderer: RendererPlugin = {
  info: READER_INFO,
  claims: [{ match: (path) => readableDoc(path) !== null, view: ReaderView }],
}
