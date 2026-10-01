/** PDF's renderer side (docs/features/pdf.md). */
import type { RendererPlugin } from '@/plugin-api'
import { PDF_INFO } from '../info'

export const pdfRenderer: RendererPlugin = { info: PDF_INFO }
