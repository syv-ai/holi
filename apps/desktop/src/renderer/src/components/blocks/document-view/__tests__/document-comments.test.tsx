/**
 * A thread's anchor quotes the file's markdown, the editor holds rich text:
 * a selection becomes a quote the file has, and a thread's quote becomes the
 * editor's range over the same words, through formatting, headings, lists
 * and the frontmatter kept aside.
 */
import { anchorAt, type CommentThread } from "@holi/shared"
import { Editor } from "@tiptap/react"
import { afterEach, describe, expect, it } from "vitest"

import { RichTextTable } from "@/components/blocks/rich-text-editor-2/components/rich-text-table"

import {
  DocumentComments,
  placeThreads,
  selectionAnchor,
  setCommentRanges,
  threadsAt,
} from "../document-comments"
import { createDocumentExtensions } from "../document-extensions"

let editor: Editor | null = null
afterEach(() => editor?.destroy())

function open(body: string): Editor {
  editor = new Editor({
    extensions: [
      ...createDocumentExtensions({
        folder: "notes",
        placeholder: "",
        onOpenLink: () => undefined,
      }),
      RichTextTable,
      DocumentComments,
    ],
    content: body,
    contentType: "markdown",
  })
  return editor
}

/** The editor's range over the first `words`. */
function rangeOf(ed: Editor, words: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null
  ed.state.doc.descendants((node, pos) => {
    if (found || !node.isText) return
    const at = node.text!.indexOf(words)
    if (at !== -1) found = { from: pos + at, to: pos + at + words.length }
  })
  if (!found) throw new Error(`no ${words}`)
  return found
}

function thread(id: string, text: string, quote: string): CommentThread {
  const at = text.indexOf(quote)
  return {
    id,
    anchor: anchorAt(text, at, at + quote.length),
    comments: [],
    status: null,
  }
}

describe("selectionAnchor", () => {
  it("quotes plain words as the file has them", () => {
    const ed = open("# Plan\n\nShip the beta on Friday.\n")
    const { from, to } = rangeOf(ed, "the beta")
    ed.commands.setTextSelection({ from, to })
    const anchor = selectionAnchor(ed, "")
    expect(anchor?.quote).toBe("the beta")
    expect(anchor?.line).toBe(3)
    expect(anchor?.prefix.endsWith("Ship ")).toBe(true)
  })

  it("quotes through formatting, so the quote is in the file", () => {
    const body = "Ship **the beta** on Friday.\n"
    const ed = open(body)
    const { from } = rangeOf(ed, "Ship")
    const { to } = rangeOf(ed, " on")
    ed.commands.setTextSelection({ from, to })
    const anchor = selectionAnchor(ed, "")!
    expect(body).toContain(anchor.quote)
    expect(anchor.quote.replace(/\*/g, "")).toBe("Ship the beta on")
  })

  it("counts the frontmatter in the line and the context", () => {
    const head = "---\ntitle: Plan\n---\n\n"
    const ed = open("Ship it.\n")
    const { from, to } = rangeOf(ed, "Ship")
    ed.commands.setTextSelection({ from, to })
    const anchor = selectionAnchor(ed, head)!
    expect(anchor.line).toBe(5)
    expect(anchor.prefix).toBe(head)
  })

  it("is null for an empty selection", () => {
    const ed = open("Ship it.\n")
    expect(selectionAnchor(ed, "")).toBeNull()
  })
})

describe("placeThreads", () => {
  it("places a quote on the editor's range over the same words", () => {
    const body =
      "# Plan\n\nShip **the beta** on Friday.\n\n- one item\n- two items\n"
    const ed = open(body)
    const text = ed.getMarkdown()
    const placed = placeThreads(ed, "", [
      thread("a", text, "the beta"),
      thread("b", text, "Plan"),
      thread("c", text, "two items"),
    ])
    const at = (id: string) => placed.find((p) => p.id === id)!
    const words = (id: string) =>
      ed.state.doc.textBetween(at(id).from, at(id).to)
    expect(words("a")).toBe("the beta")
    expect(words("b")).toBe("Plan")
    expect(words("c")).toBe("two items")
  })

  it("keeps a heading a heading when the quote starts with its #", () => {
    const ed = open("## Goals\n\nText.\n")
    const text = ed.getMarkdown()
    const [placed] = placeThreads(ed, "", [thread("a", text, "## Goals")])
    expect(ed.state.doc.textBetween(placed!.from, placed!.to)).toBe("Goals")
  })

  it("leaves out a detached thread and one in the frontmatter", () => {
    const head = "---\ntitle: Plan\n---\n\n"
    const ed = open("Ship it.\n")
    const text = head + ed.getMarkdown()
    const gone: CommentThread = {
      ...thread("a", text, "Ship"),
      anchor: { quote: "nowhere at all", prefix: "", suffix: "", line: 1 },
    }
    expect(
      placeThreads(ed, head, [gone, thread("b", text, "title: Plan")])
    ).toEqual([])
  })

  it("places overlapping threads independently", () => {
    const ed = open("one two three four\n")
    const text = ed.getMarkdown()
    const placed = placeThreads(ed, "", [
      thread("a", text, "one two three"),
      thread("b", text, "two three four"),
    ])
    const words = (id: string) => {
      const p = placed.find((r) => r.id === id)!
      return ed.state.doc.textBetween(p.from, p.to)
    }
    expect(words("a")).toBe("one two three")
    expect(words("b")).toBe("two three four")
  })

  it("draws the placed passages and says which a position is in", () => {
    const ed = open("one two three\n")
    const text = ed.getMarkdown()
    const ranges = placeThreads(ed, "", [thread("a", text, "two")])
    setCommentRanges(ed, { ranges, active: "a" })
    const { from } = rangeOf(ed, "two")
    expect(threadsAt(ed.state, from)).toEqual(["a"])
    expect(threadsAt(ed.state, from - 2)).toEqual([])
    // An edit before the passage moves the tint with it.
    ed.commands.insertContentAt(1, "zero ")
    expect(threadsAt(ed.state, from + 5)).toEqual(["a"])
  })
})
