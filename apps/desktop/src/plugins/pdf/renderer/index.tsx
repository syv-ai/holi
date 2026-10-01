/**
 * PDF's renderer side (docs/features/pdf.md): a `.pdf` opens in the viewer,
 * and a markdown note's row menu offers Convert to PDF.
 */
import { fileKind } from '@holi/shared'
import type { RendererPlugin } from '@/plugin-api'
import { PDF_INFO } from '../info'
import { ConvertToPdf } from './ConvertToPdf'
import { PdfViewer } from './PdfViewer'

export const pdfRenderer: RendererPlugin = {
  info: PDF_INFO,
  claims: [
    { match: (path) => fileKind(path) === 'pdf', view: PdfViewer },
    {
      match: (path) => fileKind(path) === 'markdown',
      rowMenu: [
        {
          label: 'Convert to PDF…',
          run: ({ remote, path, openDialog }) =>
            openDialog({
              id: 'plugin',
              size: 'md',
              render: (close) => <ConvertToPdf remote={remote} path={path} onClose={close} />,
            }),
        },
      ],
    },
  ],
}
