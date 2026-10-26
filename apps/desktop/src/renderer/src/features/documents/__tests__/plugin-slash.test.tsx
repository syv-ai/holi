/**
 * A vault app's slash command in the document editor: given the caret's
 * line without the typed "/query" and the note's path, its answer written
 * at the caret as markdown, an agent answer opening the prompt, and a
 * failure leaving the note as it was.
 */
import { Editor } from "@tiptap/react"
import { afterEach, expect, test, vi } from "vitest"

import type { SlashCommand } from "@/plugin-api/types"
import { createDocumentExtensions } from "../document-extensions"
import { pluginSlashItem } from "../plugin-slash"

let editor: Editor | null = null
afterEach(() => editor?.destroy())

/** "Total: /sum" with the caret after it, and the range "/sum" covers. */
function open(): { ed: Editor; range: { from: number; to: number } } {
  const ed = new Editor({
    extensions: createDocumentExtensions({
      folder: "",
      placeholder: "",
      onOpenLink: () => undefined,
    }),
    content: "Total: /sum\n",
    contentType: "markdown",
  })
  editor = ed
  let from = -1
  ed.state.doc.descendants((node, pos) => {
    if (from === -1 && node.isText && node.text!.includes("/sum")) {
      from = pos + node.text!.indexOf("/sum")
    }
  })
  return { ed, range: { from, to: from + 4 } }
}

function command(answer: Awaited<ReturnType<SlashCommand["run"]>>) {
  const run = vi.fn(async () => answer)
  const item = pluginSlashItem(
    { name: "sum", meta: "Budget", run },
    "Notes/Plan.md",
    ask
  )
  return { run, item }
}
const ask = vi.fn()

test("is listed under its app, and writes its answer at the caret", async () => {
  const { ed, range } = open()
  const { run, item } = command({ insert: "**42**" })
  expect(item.group).toBe("Budget")
  expect(item.title).toBe("sum")
  item.run(ed, range)
  expect(run).toHaveBeenCalledWith({
    text: "",
    line: "Total: ",
    path: "Notes/Plan.md",
  })
  await vi.waitFor(() => expect(ed.getMarkdown()).toContain("Total: **42**"))
  expect(ed.getMarkdown()).not.toContain("/sum")
})

test("an agent answer opens the prompt with its instruction", async () => {
  const { ed, range } = open()
  const { item } = command({ agent: "Sum the table above" })
  item.run(ed, range)
  await vi.waitFor(() =>
    expect(ask).toHaveBeenCalledWith(range.from, "Sum the table above")
  )
})

test("a command that fails leaves the note without the typed command", async () => {
  const { ed, range } = open()
  const run = vi.fn(async () => {
    throw new Error("took longer than 10 s")
  })
  const item = pluginSlashItem({ name: "sum", run }, "Notes/Plan.md", ask)
  item.run(ed, range)
  await vi.waitFor(() => expect(run).toHaveBeenCalled())
  expect(ed.getMarkdown().trim()).toBe("Total:")
})
