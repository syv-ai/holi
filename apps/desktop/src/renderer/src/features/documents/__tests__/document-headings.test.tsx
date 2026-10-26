/**
 * A document's headings as Holi links name them: the caret's heading is
 * GitHub's anchor, a repeated one suffixed, and a link lands on its heading
 * by anchor or by words.
 */
import { Editor } from "@tiptap/react"
import { afterEach, describe, expect, it } from "vitest"

import { createDocumentExtensions } from "../document-extensions"
import { headingAtCaret, landOnHeading } from "../document-headings"

let editor: Editor | null = null
afterEach(() => editor?.destroy())

const HEAD = "---\ntitle: Plan\n---\n\n"
const BODY =
  "# Plan\n\nIntro.\n\n## Next steps (Q3)\n\nShip it.\n\n## Notes\n\nOne.\n\n## Notes\n\nTwo.\n"

function open(): Editor {
  editor = new Editor({
    extensions: createDocumentExtensions({
      folder: "",
      placeholder: "",
      onOpenLink: () => undefined,
    }),
    content: BODY,
    contentType: "markdown",
  })
  return editor
}

const text = (ed: Editor) => HEAD + ed.getMarkdown()

function caretAt(ed: Editor, words: string) {
  let at = -1
  ed.state.doc.descendants((node, pos) => {
    if (at === -1 && node.isText && node.text!.includes(words)) {
      at = pos + node.text!.indexOf(words)
    }
  })
  ed.commands.setTextSelection(at)
}

describe("headingAtCaret", () => {
  it("is the anchor of the heading the caret is under", () => {
    const ed = open()
    caretAt(ed, "Ship it")
    expect(headingAtCaret(ed, text(ed))).toBe("next-steps-q3")
    caretAt(ed, "Two")
    expect(headingAtCaret(ed, text(ed))).toBe("notes-1")
  })
})

describe("landOnHeading", () => {
  it("lands on a heading by its anchor, or by its words", () => {
    const ed = open()
    expect(landOnHeading(ed, text(ed), "notes-1")).toBe(true)
    expect(ed.state.selection.$from.parent.textContent).toBe("Notes")
    caretAt(ed, "Intro")
    expect(headingAtCaret(ed, text(ed))).toBe("plan")
    expect(landOnHeading(ed, text(ed), "Next steps (Q3)")).toBe(true)
    expect(ed.state.selection.$from.parent.textContent).toBe("Next steps (Q3)")
  })

  it("leaves the caret alone for a heading that is not there", () => {
    const ed = open()
    caretAt(ed, "Intro")
    const before = ed.state.selection.from
    expect(landOnHeading(ed, text(ed), "missing")).toBe(false)
    expect(ed.state.selection.from).toBe(before)
  })
})
