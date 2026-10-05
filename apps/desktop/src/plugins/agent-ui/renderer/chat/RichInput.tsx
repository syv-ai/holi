/**
 * The composer's text field: a plain text box in which each attachment is an
 * **icon chip** standing where its marker is (`attachments.ts`), instead of
 * the marker's characters. The chip is one unit: the caret steps over it and
 * one Backspace deletes it, which removes the file.
 *
 * It is a `contenteditable`, because a text box cannot draw an icon inside its
 * text. The value it speaks is still a plain string with the markers in it, so
 * the draft, the send and the tests do not know a chip from a marker. The DOM
 * is the source while typing and is rebuilt from the value only when the value
 * was changed from outside (cleared by a send, restored by a refused one), so
 * the caret is never moved under a typist.
 */
import { useEffect, useImperativeHandle, useRef, useState } from 'react'
import { cn } from '@/plugin-api'
import { markerLabel, markerIsImage } from '../../../agent/renderer/chat/attachments'

/** What the chat can do to the field. */
export interface RichInputHandle {
  focus(): void
  /** The text as the draft has it, markers and all, read from the field. */
  getText(): string
  /** Put an attachment's chip at the caret, or at the end when the field has
   *  not the focus, spaced from the words round it. */
  insertMarker(marker: string): void
}

/** Lucide's `image` and `file-text`, as markup: a chip is DOM, not React. */
const ICONS = {
  image:
    '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
}

/** The chip for a marker: its icon and its name, not editable. */
function makeChip(marker: string): HTMLElement {
  const chip = document.createElement('span')
  chip.contentEditable = 'false'
  chip.dataset['marker'] = marker
  chip.dataset['chatChip'] = markerIsImage(marker) ? 'image' : 'file'
  chip.className =
    'mx-0.5 inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 align-baseline text-xs text-foreground select-none'
  chip.innerHTML =
    `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true">${markerIsImage(marker) ? ICONS.image : ICONS.file}</svg>`
  const label = document.createElement('span')
  label.textContent = markerLabel(marker)
  chip.append(label)
  return chip
}

/** The field's content as a string: text, line breaks, and each chip's marker. */
function serialize(root: HTMLElement): string {
  let out = ''
  const walk = (node: Node, first: boolean): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? ''
    } else if (node instanceof HTMLElement) {
      if (node.dataset['marker'] !== undefined) out += node.dataset['marker']
      else if (node.tagName === 'BR') out += '\n'
      else {
        // A block a browser made for a new line.
        const block = node.tagName === 'DIV' || node.tagName === 'P'
        if (block && !first) out += '\n'
        node.childNodes.forEach((child, i) => walk(child, i === 0))
      }
    }
  }
  root.childNodes.forEach((child, i) => walk(child, i === 0))
  // A lone <br> keeps an empty line open in some browsers: it is no text.
  return root.childNodes.length === 1 && root.firstChild?.nodeName === 'BR' ? '' : out
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Rebuild the field from a value: text, with a chip for each known marker. */
function fill(root: HTMLElement, value: string, markers: readonly string[]): void {
  root.replaceChildren()
  const known = [...markers].sort((a, b) => b.length - a.length)
  const parts =
    known.length === 0 ? [value] : value.split(new RegExp(`(${known.map(escapeRe).join('|')})`))
  for (const part of parts) {
    if (part === '') continue
    if (known.includes(part)) root.append(makeChip(part))
    else root.append(document.createTextNode(part))
  }
}

/** Put the caret at the end of the field. */
function caretToEnd(root: HTMLElement): void {
  const range = document.createRange()
  range.selectNodeContents(root)
  range.collapse(false)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

export function RichInput({
  value,
  markers,
  onChange,
  onEnter,
  onPasteText,
  handle,
  disabled = false,
  placeholder,
  label,
  className,
}: {
  value: string
  /** The attachments' markers: the ones drawn as chips. */
  markers: readonly string[]
  onChange: (value: string) => void
  /** Enter, without Shift and not mid-composition. */
  onEnter: () => void
  /** A paste with no files in it: its text goes in as plain text. Claude Code
   *  has no use for another program's formatting. */
  onPasteText?: (event: React.ClipboardEvent) => boolean
  handle: React.Ref<RichInputHandle>
  disabled?: boolean
  placeholder: string
  label: string
  className?: string
}): React.JSX.Element {
  const root = useRef<HTMLDivElement | null>(null)
  /** What the field last said, so an echo of it is not taken for a change. */
  const said = useRef('')
  /** Backspace on the empty field clears the placeholder, as it would text;
   *  typing or leaving the field brings it back. */
  const [bare, setBare] = useState(false)
  const markersRef = useRef(markers)
  markersRef.current = markers

  const emit = (): void => {
    const el = root.current
    if (el === null) return
    const text = serialize(el)
    if (text === said.current) return
    said.current = text
    onChange(text)
  }

  // The value changed from outside (a send cleared it, a refusal restored it):
  // draw it. A value the field said itself is already on screen.
  useEffect(() => {
    const el = root.current
    if (el === null || value === said.current) return
    fill(el, value, markers)
    said.current = value
    if (document.activeElement === el) caretToEnd(el)
  }, [value, markers])

  useImperativeHandle(
    handle,
    () => ({
      focus: () => root.current?.focus(),
      getText: () => (root.current === null ? '' : serialize(root.current)),
      insertMarker: (marker) => {
        const el = root.current
        if (el === null) return
        const inside =
          document.activeElement === el &&
          window.getSelection()?.rangeCount === 1 &&
          el.contains(window.getSelection()!.getRangeAt(0).commonAncestorContainer)
        if (!inside) {
          el.focus()
          caretToEnd(el)
        }
        const range = window.getSelection()!.getRangeAt(0)
        const before = range.startContainer.textContent?.slice(0, range.startOffset) ?? ''
        const lead = before === '' || /\s$/.test(before) ? '' : ' '
        // A space after, whatever follows: it gives the caret a text node to
        // stand in, and Claude Code reads a path up to the next space.
        const nodes = [
          ...(lead === '' ? [] : [document.createTextNode(lead)]),
          makeChip(marker),
          document.createTextNode(' '),
        ]
        range.deleteContents()
        const frag = document.createDocumentFragment()
        for (const node of nodes) frag.append(node)
        range.insertNode(frag)
        range.setStartAfter(nodes[nodes.length - 1]!)
        range.collapse(true)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        emit()
      },
    }),
    // `emit` reads only refs and the stable `onChange` of the render it is in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onChange],
  )

  return (
    <div
      ref={root}
      role="textbox"
      aria-multiline="true"
      aria-label={label}
      aria-disabled={disabled || undefined}
      contentEditable={!disabled}
      suppressContentEditableWarning
      spellCheck
      data-placeholder={placeholder}
      data-empty={value === '' && !bare ? '' : undefined}
      className={cn(
        'w-full overflow-y-auto whitespace-pre-wrap break-words outline-none',
        'data-[empty]:before:pointer-events-none data-[empty]:before:text-muted-foreground data-[empty]:before:content-[attr(data-placeholder)]',
        className,
      )}
      onInput={() => {
        setBare(false)
        emit()
      }}
      onBlur={() => setBare(false)}
      onPaste={(event) => {
        if (onPasteText?.(event) === true) return
        // Text only, so another program's styling never lands in the field.
        const text = event.clipboardData.getData('text/plain')
        if (text === '') return
        event.preventDefault()
        if (typeof document.execCommand === 'function')
          document.execCommand('insertText', false, text)
        else {
          const range = window.getSelection()?.getRangeAt(0)
          range?.deleteContents()
          range?.insertNode(document.createTextNode(text))
          range?.collapse(false)
        }
        emit()
      }}
      onKeyDown={(event) => {
        if ((event.key === 'Backspace' || event.key === 'Delete') && value === '') setBare(true)
        if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
        event.preventDefault()
        if (!event.shiftKey) return onEnter()
        // Shift+Enter is a new line.
        if (typeof document.execCommand === 'function') {
          document.execCommand('insertLineBreak')
        } else {
          const range = window.getSelection()?.getRangeAt(0)
          range?.deleteContents()
          range?.insertNode(document.createElement('br'))
          range?.collapse(false)
        }
        emit()
      }}
    />
  )
}
