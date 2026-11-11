import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react'
import { NodeSelection } from '@tiptap/pm/state'
import { useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { RenderedMediaAction, RenderedMediaToolbar } from './rendered-media-toolbar'
import { displaySrc } from '../media-src'

import { RenderedMediaLightbox } from './rendered-media-lightbox'

export function DocumentImageView({
  node,
  editor,
  getPos,
  folder,
}: ReactNodeViewProps & { folder: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null)
  const [retryVersion, setRetryVersion] = useState(0)
  const [open, setOpen] = useState(false)
  const openButton = useRef<HTMLButtonElement>(null)
  const src = displaySrc(String(node.attrs.src ?? ''), folder)
  const alt = String(node.attrs.alt ?? '')
  const title = alt.trim() || 'Image'
  const failed = failedSrc === src
  const selectImage = () => {
    const position = typeof getPos === 'function' ? getPos() : undefined
    if (typeof position !== 'number' || !editor.isEditable) return
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, position)),
    )
    editor.view.focus()
  }
  const image = (large: boolean) => (
    <img
      key={`${src}:${retryVersion}:${large}`}
      src={src}
      alt={alt}
      data-drag-handle={large ? undefined : ''}
      className={large ? 'max-h-full max-w-full object-contain' : undefined}
      onDoubleClick={(event) => {
        event.preventDefault()
        setOpen(true)
      }}
      onError={() => setFailedSrc(src)}
      onLoad={() => setLoadedSrc(src)}
    />
  )
  return (
    <NodeViewWrapper as="span" contentEditable={false} className="group/media relative">
      {failed ? (
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
        <Button
          type="button"
          variant="ghost"
          size="media"
          aria-label={`Select ${title}`}
          onClick={selectImage}
        >
          {image(false)}
        </Button>
      )}
      <RenderedMediaToolbar editor={editor}>
        <RenderedMediaAction ref={openButton} onClick={() => setOpen(true)}>
          Open larger
        </RenderedMediaAction>
      </RenderedMediaToolbar>
      <RenderedMediaLightbox
        title={title}
        open={open}
        onOpenChange={setOpen}
        restoreFocus={() => openButton.current?.focus()}
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
        {null}
      </RenderedMediaLightbox>
    </NodeViewWrapper>
  )
}
