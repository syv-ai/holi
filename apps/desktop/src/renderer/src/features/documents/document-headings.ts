/**
 * A document's headings as Holi links name them (docs/features/holi-links.md):
 * GitHub's anchors, worked out from the file as it is saved
 * (`headingAnchors`), matched in order to the editor's own headings. Only a
 * heading at the top level counts, since only that one is written as an ATX
 * line the anchors see.
 */
import { headingAnchors, headingSlug } from '@holi/shared'
import type { Editor } from '@tiptap/react'

/** The editor's top-level headings, top to bottom, by position. */
function headings(editor: Editor): number[] {
  const at: number[] = []
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name === 'heading') at.push(offset)
  })
  return at
}

/**
 * The anchor of the heading the caret is under: the nearest heading at or
 * above it. Null above the first. `text` is the file as it saves.
 */
export function headingAtCaret(editor: Editor, text: string): string | null {
  const caret = editor.state.selection.from
  const anchors = headingAnchors(text)
  let index = -1
  headings(editor).forEach((pos, i) => {
    if (pos < caret) index = i
  })
  return index === -1 ? null : (anchors[index]?.slug ?? null)
}

/**
 * Put the caret at the start of the heading `heading` names, its anchor or
 * its words (the first heading with those words), and scroll to it. False
 * when no heading matches, and the caret stays where it was.
 */
export function landOnHeading(editor: Editor, text: string, heading: string): boolean {
  const anchors = headingAnchors(text)
  const exact = heading.normalize('NFC').trim()
  const words = headingSlug(heading)
  let index = anchors.findIndex((anchor) => anchor.slug === exact)
  if (index === -1 && words !== '') {
    index = anchors.findIndex((anchor) => anchor.slug === words)
  }
  const pos = index === -1 ? undefined : headings(editor)[index]
  if (pos === undefined) return false
  editor
    .chain()
    .focus()
    .setTextSelection(pos + 1)
    .scrollIntoView()
    .run()
  return true
}
