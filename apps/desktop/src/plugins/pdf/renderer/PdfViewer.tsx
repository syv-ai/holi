/**
 * A `.pdf` tab. The viewer proper is `PdfDocument`, loaded lazily so
 * embedpdf, its worker and the PDFium wasm are their own chunk; until it
 * arrives the pane shows the file name.
 */
import { lazy, Suspense } from 'react'

const PdfDocument = lazy(() => import('./PdfDocument').then((m) => ({ default: m.PdfDocument })))

export function PdfViewer({ path }: { path: string }) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" data-pdf-viewer={path}>
      <Suspense
        fallback={
          <div className="flex flex-1 items-center justify-center">
            <p className="font-mono text-sm text-muted-foreground">{name}</p>
          </div>
        }
      >
        <PdfDocument path={path} />
      </Suspense>
    </div>
  )
}
