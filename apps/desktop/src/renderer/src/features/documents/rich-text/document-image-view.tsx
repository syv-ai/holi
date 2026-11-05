import type { ReactNodeViewProps } from '@tiptap/react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'

import { RenderedMediaLightbox } from './rendered-media-lightbox'

export function DocumentImageView({
  node,
  folder,
  resolveSrc,
}: ReactNodeViewProps & { folder: string; resolveSrc: (src: string, folder: string) => string }) {
  const [failed, setFailed] = useState(false)
  const src = resolveSrc(String(node.attrs.src ?? ''), folder)
  const alt = String(node.attrs.alt ?? 'Image')
  const image = (large: boolean) => (
    <img
      src={src}
      alt={alt}
      className={large ? 'max-h-screen max-w-full object-contain' : 'max-w-full'}
      onError={() => setFailed(true)}
    />
  )
  if (failed)
    return (
      <p role="status">
        Couldn&apos;t load image: {alt}{' '}
        <Button type="button" variant="link" onClick={() => setFailed(false)}>
          Retry
        </Button>
      </p>
    )
  return (
    <span contentEditable={false}>
      <RenderedMediaLightbox title={alt} preview={image(true)}>
        {image(false)}
      </RenderedMediaLightbox>
    </span>
  )
}
