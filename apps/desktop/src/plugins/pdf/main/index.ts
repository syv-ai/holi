/**
 * PDF's main side (docs/features/pdf.md): the templates and skills it seeds,
 * the capabilities behind the viewer, Convert to PDF and `holi pdf`, and the
 * Typst engine they render with.
 */
import { join } from 'node:path'
import type { MainPlugin } from '../../../main/plugin-api'
import { PDF_INFO } from '../info'
import { PDF_NAMESPACES, pdfCapabilities } from './capabilities'
import { pdfSeed } from './seed'
import { createSignatureStore } from './signatures'
import { sharedTypst } from './typst-bin'

export const pdfMain: MainPlugin = {
  info: PDF_INFO,
  seed: pdfSeed,
  activateApp(ctx) {
    const typst = sharedTypst(join(ctx.userData, 'typst'))
    const undo = ctx.register(
      PDF_NAMESPACES,
      pdfCapabilities({
        // The viewer's signatures: `userData`, never a vault.
        signatures: createSignatureStore(join(ctx.userData, 'pdf-signatures.json')),
        typst,
      }),
    )
    // Fetched in the background, so the first render or `holi pdf typst`
    // does not wait on a 30 MB download.
    void typst()
    return undo
  },
}
