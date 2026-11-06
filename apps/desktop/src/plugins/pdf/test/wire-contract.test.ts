/**
 * What other plugins ask of the PDF plugin (`@holi/shared`'s `plugin-wire.ts`):
 * the render's answer fits the shape the meeting review types its client with.
 */
import { expectTypeOf, test } from 'vitest'
import type { RenderedPdf } from '@holi/shared'
import type { PdfCapabilities } from '../main/capabilities'

test('pdf.render answers what Export minutes reads', () => {
  type Rendered = Awaited<ReturnType<PdfCapabilities['pdf.render']['run']>>
  expectTypeOf<Rendered>().toExtend<RenderedPdf>()
})
