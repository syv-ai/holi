/**
 * The comment field under a PDF comment, as a field that wraps (D103).
 *
 * The viewer's own is a one-line `<input>`, which no CSS can make wrap, and
 * its comment sidebar is not a component Holi can replace. So this textarea is
 * portalled into the viewer's row beside its input, which is hidden, and feeds
 * it: every change is written into the input and announced with the `input`
 * event its component listens for, and sending clicks the viewer's own send
 * button. What sending means (a first comment on a mark, or a reply) stays
 * the library's decision, made by its code; this only types for it.
 *
 * The input is one line, so a line break becomes a space: the comment would
 * lose it anyway, and it is shown with its whitespace collapsed. Enter sends,
 * as it did; the field grows with its text (`field-sizing`, in
 * `PDF_COMMENT_FIELD_CSS`, because Tailwind does not reach into the shadow
 * root). Selecting a comment focuses the viewer's input; the focus is passed
 * on here.
 */
import { useEffect, useRef, useState } from 'react'
import { singleLine } from '@/lib/pdf-viewer-config'
import { Textarea } from '@/primitives'

export function PdfCommentField({
  input,
  send,
}: {
  input: HTMLInputElement
  send: HTMLButtonElement
}) {
  const [text, setText] = useState('')
  const fieldRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const takeFocus = () => fieldRef.current?.focus()
    // Sent by Enter or by the button: either way the viewer cleared its field.
    const sent = () => setText('')
    input.addEventListener('focus', takeFocus)
    send.addEventListener('click', sent)
    if (input.matches(':focus')) takeFocus()
    return () => {
      input.removeEventListener('focus', takeFocus)
      send.removeEventListener('click', sent)
    }
  }, [input, send])

  return (
    <Textarea
      ref={fieldRef}
      className="holi-comment-field"
      rows={1}
      placeholder={input.placeholder}
      value={text}
      onChange={(event) => {
        const next = singleLine(event.target.value)
        setText(next)
        input.value = next
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
        event.preventDefault()
        // Disabled while the viewer holds no text, and a disabled button's
        // click does nothing, so a blank comment is never sent.
        if (!send.disabled) send.click()
      }}
    />
  )
}
