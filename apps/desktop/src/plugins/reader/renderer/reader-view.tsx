/**
 * A reader tab: the file's bytes, then the viewer for its format. Each viewer
 * is its own lazy chunk, so opening a Word file never loads the PowerPoint or
 * EPUB renderer, and the app's main chunk carries none of them.
 */
import { lazy, Suspense } from 'react'
import { readableDoc } from '@holi/shared'
import { ReaderLoading, ReaderPane } from './reader-pane'

const DocxView = lazy(() => import('./docx-view').then((m) => ({ default: m.DocxView })))
const PptxView = lazy(() => import('./pptx-view').then((m) => ({ default: m.PptxView })))
const EpubView = lazy(() => import('./epub-view').then((m) => ({ default: m.EpubView })))

const VIEWS = { docx: DocxView, pptx: PptxView, epub: EpubView } as const

export function ReaderView({ path }: { path: string }) {
  const format = readableDoc(path)
  if (format === null) return null
  const View = VIEWS[format]
  const name = path.slice(path.lastIndexOf('/') + 1)
  return (
    <ReaderPane path={path}>
      {(bytes) => (
        <Suspense fallback={<ReaderLoading />}>
          <View bytes={bytes} name={name} path={path} />
        </Suspense>
      )}
    </ReaderPane>
  )
}
