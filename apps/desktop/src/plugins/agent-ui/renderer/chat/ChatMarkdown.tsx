/**
 * An assistant message as prose. The markdown is Claude's, so the HTML it
 * becomes is sanitised before it reaches the page, and a link in it opens in
 * the browser rather than navigating the app's own window.
 */
import DOMPurify from 'dompurify'
import { Marked } from 'marked'
import { useMemo } from 'react'
import './chat.css'

/** An instance, not the module-level `marked`, whose options are global to
 *  the bundle. */
const markdown = new Marked({ gfm: true, breaks: false })

export function renderChatMarkdown(text: string): string {
  return DOMPurify.sanitize(markdown.parse(text, { async: false }))
}

export function ChatMarkdown({ text }: { text: string }): React.JSX.Element {
  const html = useMemo(() => renderChatMarkdown(text), [text])
  return (
    <div
      className="agent-chat-md"
      onClick={(event) => {
        const link = event.target instanceof Element ? event.target.closest('a') : null
        if (link === null) return
        event.preventDefault()
        const href = link.getAttribute('href') ?? ''
        if (/^https?:\/\//.test(href)) void window.holi.openExternal(href)
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
