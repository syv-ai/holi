import { useEffect, useRef, type ReactNode } from 'react'
import type { Editor } from '@tiptap/react'

import { Button } from '@/components/ui/button'
import { RichTextToolbar } from './rich-text-toolbar'

/** Hover- and keyboard-reachable actions shared by rendered media node views. */
export function RenderedMediaToolbar({
  children,
  editor,
}: {
  children: ReactNode
  editor: Editor
}) {
  const toolbarRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const { dom } = editor.view
    const handleShortcut = (event: KeyboardEvent) => {
      const toolbar = toolbarRef.current
      if (!event.altKey || event.key !== 'F10' || !toolbar?.isConnected) return
      const item = toolbar.querySelector<HTMLElement>('[data-toolbar-item]:not([disabled])')
      if (!item) return
      event.preventDefault()
      item.focus()
    }
    dom.addEventListener('keydown', handleShortcut)
    return () => dom.removeEventListener('keydown', handleShortcut)
  }, [editor])

  return (
    <div
      ref={toolbarRef}
      className="absolute -top-10 right-0 z-10 overflow-hidden rounded-xl bg-card p-1 text-sm text-card-foreground opacity-0 ring-1 ring-foreground/10 motion-respond group-hover/media:opacity-100 group-focus-within/media:opacity-100"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !event.currentTarget.contains(event.target as Node)) return
        event.preventDefault()
        editor.commands.focus()
      }}
    >
      <RichTextToolbar aria-label="Rendered media" aria-keyshortcuts="Alt+F10">
        {children}
      </RichTextToolbar>
    </div>
  )
}

export function RenderedMediaAction(props: React.ComponentProps<typeof Button>) {
  return <Button type="button" variant="ghost" size="xs" data-toolbar-item="" {...props} />
}
