import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react'
import { useEffect, useState } from 'react'

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
  const src = resolveSrc(String(node.attrs.src ?? ''), folder)
  const alt = String(node.attrs.alt ?? 'Image')
  useEffect(() => {
    setFailedSrc(null)
    setLoadedSrc(null)
  }, [src])
  const failed = failedSrc === src
  const image = (large: boolean) => (
    <img
      src={src}
      alt={alt}
      className={large ? 'max-h-full max-w-full object-contain' : 'max-w-full'}
      onError={() => setFailedSrc(src)}
      onLoad={() => setLoadedSrc(src)}
    />
  )
  return (
    <NodeViewWrapper as="span" contentEditable={false}>
      <RenderedMediaLightbox
        title={alt}
        preview={
          failed ? (
            <p role="status" className="text-sm">
              Couldn&apos;t load image: {alt}{' '}
              <Button type="button" variant="link" onClick={() => setFailedSrc(null)}>
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
