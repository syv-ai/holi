/**
 * A `.pdf` tab. The viewer proper is `PdfDocument`, loaded lazily so
 * embedpdf, its worker and the PDFium wasm are their own chunk; until it
 * arrives the pane shows the file name.
 */
import { lazy, Suspense, useState } from 'react'

const PdfDocument = lazy(() => import('./pdf-document').then((m) => ({ default: m.PdfDocument })))

export function PdfViewer({
  path,
  visible = true,
  focused = visible,
}: {
  path: string
  visible?: boolean
  focused?: boolean
}) {
  const [wasVisible, setWasVisible] = useState(visible)
  if (visible && !wasVisible) setWasVisible(true)
  const mounted = wasVisible || visible
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
        {mounted ? <PdfDocument path={path} visible={visible} focused={focused} /> : null}
      </Suspense>
    </div>
  )
}
