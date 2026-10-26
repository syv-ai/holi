import { useEditorState, type Editor } from "@tiptap/react"

export type RichTextBlockType =
  "paragraph" | "heading-1" | "heading-2" | "heading-3"

type RichTextAlign = "left" | "center" | "right" | "justify"

const RICH_TEXT_ALIGNS = [
  "left",
  "center",
  "right",
  "justify",
] as const satisfies readonly RichTextAlign[]

export interface RichTextSnapshot {
  editable: boolean
  blockType: RichTextBlockType
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  code: boolean
  bulletList: boolean
  orderedList: boolean
  taskList: boolean
  blockquote: boolean
  codeBlock: boolean
  align: RichTextAlign
  highlight: string | null
  link: string | null
  canUndo: boolean
  canRedo: boolean
  /** Code blocks refuse marks and inline code excludes the rest, so they step aside. */
  canFormat: boolean
  /** Inline code stays toggleable while active, so it can be turned off. */
  canCode: boolean
  /** A heading is refused inside list and task items. */
  canHeading: boolean
}

const IDLE_SNAPSHOT: RichTextSnapshot = {
  editable: false,
  blockType: "paragraph",
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  code: false,
  bulletList: false,
  orderedList: false,
  taskList: false,
  blockquote: false,
  codeBlock: false,
  align: "left",
  highlight: null,
  link: null,
  canUndo: false,
  canRedo: false,
  canFormat: false,
  canCode: false,
  canHeading: false,
}

function readBlockType(editor: Editor): RichTextBlockType {
  if (editor.isActive("heading", { level: 1 })) return "heading-1"
  if (editor.isActive("heading", { level: 2 })) return "heading-2"
  if (editor.isActive("heading", { level: 3 })) return "heading-3"
  return "paragraph"
}

function readSnapshot(editor: Editor | null): RichTextSnapshot {
  if (!editor) return IDLE_SNAPSHOT

  const editable = editor.isEditable
  const highlight = editor.isActive("highlight")
    ? (editor.getAttributes("highlight").color ?? "yellow")
    : null
  const link = editor.isActive("link")
    ? (editor.getAttributes("link").href ?? null)
    : null

  return {
    editable,
    blockType: readBlockType(editor),
    bold: editor.isActive("bold"),
    italic: editor.isActive("italic"),
    underline: editor.isActive("underline"),
    strike: editor.isActive("strike"),
    code: editor.isActive("code"),
    bulletList: editor.isActive("bulletList"),
    orderedList: editor.isActive("orderedList"),
    taskList: editor.isActive("taskList"),
    blockquote: editor.isActive("blockquote"),
    codeBlock: editor.isActive("codeBlock"),
    align:
      RICH_TEXT_ALIGNS.find((align) => editor.isActive({ textAlign: align })) ??
      "left",
    highlight,
    link,
    canUndo: editable && editor.can().undo(),
    canRedo: editable && editor.can().redo(),
    canFormat: editable && editor.can().toggleBold(),
    canCode: editable && editor.can().toggleCode(),
    canHeading: editable && editor.can().setHeading({ level: 1 }),
  }
}

// Tiptap's snapshot keeps a null editor until the first transaction after mount,
// so every selector falls back to the instance it was handed.
export function useRichTextSelector<T>(
  editor: Editor | null,
  select: (editor: Editor | null) => T
) {
  return useEditorState({
    editor,
    selector: ({ editor: current }) => select(current ?? editor),
  }) as T
}

/** One formatting snapshot per transaction, compared deeply, for the toolbar. */
export function useRichTextState(editor: Editor | null) {
  return useRichTextSelector(editor, readSnapshot)
}
