/**
 * A reader tab's frame around its viewer: a page's shape while the bytes are
 * on their way, the error with Retry if they never come, and the viewer once
 * they are here. A new version of the file is a fresh viewer (`key`), so no
 * viewer has to know how to swap its document.
 */
import type { ReactNode } from 'react'
import { ErrorState } from '@/composites/empty-state'
import { useFileBytes } from './use-file-bytes'

export function ReaderPane({
  path,
  children,
}: {
  path: string
  children: (bytes: Uint8Array<ArrayBuffer>) => ReactNode
}) {
  const file = useFileBytes(path)
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" data-reader={path}>
      {file.state === 'error' ? (
        <ErrorState title="This file didn’t open" message={file.message} onRetry={file.retry} />
      ) : file.state === 'loading' ? (
        <ReaderLoading />
      ) : (
        <div key={file.version} className="flex min-h-0 flex-1 flex-col">
          {children(file.bytes)}
        </div>
      )}
    </div>
  )
}

/** A page's shape where the page will be. */
export function ReaderLoading() {
  return (
    <div role="status" aria-label="Loading file" className="flex min-h-0 flex-1 justify-center p-6">
      <span className="block aspect-3/4 w-full max-w-xl rounded-md motion-shimmer" />
    </div>
  )
}
