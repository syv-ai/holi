/**
 * The PDF plugin's `pdf.render`, asked by name for Export minutes as PDF: the
 * shape comes from `@holi/shared` (`plugin-wire.ts`), and the PDF plugin's
 * test checks its own answer fits it.
 */
import type { RenderedPdf } from '@holi/shared'
import { capClient, type UiCapability } from '@/plugin-api'

export const pdfCap = capClient<{
  'pdf.render': UiCapability<{ path: string; template: string; out: string }, RenderedPdf>
}>('pdf')
