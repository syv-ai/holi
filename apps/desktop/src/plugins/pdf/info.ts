/** What PDF is, for both of its sides. */
import type { PluginInfo } from '@holi/shared'

export const PDF_INFO: PluginInfo = {
  id: 'pdf',
  label: 'PDF',
  default: true,
  description:
    'Opens PDFs in a tab, with comments and signing, and turns a note into a PDF from a Typst template.',
  whenOff:
    'A PDF opens as a plain file and Convert to PDF goes. The templates in .holi/document-templates stay.',
}
