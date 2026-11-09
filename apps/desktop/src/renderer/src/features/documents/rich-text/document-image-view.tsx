import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

import { RenderedMediaLightbox } from './rendered-media-lightbox'

export function DocumentImageView({
  node,
  folder,
  resolveSrc,
}: ReactNodeViewProps & { folder: string; resolveSrc: (src: string, folder: string) => string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null)
  const [retryVersion, setRetryVersion] = useState(0)
  const src = resolveSrc(String(node.attrs.src ?? ''), folder)
  const alt = String(node.attrs.alt ?? '')
  const title = alt.trim() || 'Image'
  const failed = failedSrc === src
  const image = (large: boolean) => (
    <img
      key={`${src}:${retryVersion}:${large}`}
      src={src}
      alt={alt}
      data-drag-handle={large ? undefined : ''}
      className={large ? 'max-h-full max-w-full object-contain' : undefined}
      onError={() => setFailedSrc(src)}
      onLoad={() => setLoadedSrc(src)}
    />
  )
  return (
    <NodeViewWrapper as="span" contentEditable={false}>
      <RenderedMediaLightbox
        title={title}
        preview={
          failed ? (
            <p role="status" className="text-sm">
              Couldn&apos;t load image: {alt}{' '}
              <Button
                type="button"
                variant="link"
                onClick={() => {
                  setFailedSrc(null)
                  setLoadedSrc(null)
                  setRetryVersion((version) => version + 1)
                }}
              >
                Retry
              </Button>
            </p>
          ) : (
            <div className="relative flex min-h-24 min-w-0 items-center justify-center">
              {image(true)}
              {loadedSrc !== src ? (
                <Skeleton aria-label="Loading image" className="absolute inset-0" />
              ) : null}
            </div>
          )
        }
      >
        {image(false)}
      </RenderedMediaLightbox>
    </NodeViewWrapper>
  )
}
