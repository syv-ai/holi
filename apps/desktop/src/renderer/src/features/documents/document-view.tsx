/**
 * A markdown document, open in ReUI's rich-text editor (`rich-text-editor-2`)
 * and saved back to the file as markdown (`markdown.ts`).
 *
 * The file stays the source of truth. Typing saves after a pause; a change on
 * disk (a pull, the agent) is read back in unless there are local edits not
 * yet saved, which win and are written over it.
 *
 * The agent is part of the page: Space on an empty line asks it to write
 * there, the format bubble's Ask AI rewrites a selection, and the menu's
 * Turn into an Artifact makes a vault app of the document. While a run edits
 * the document the page is locked (nothing in it can be pressed) and the
 * status pill at its foot says what it is doing and offers Stop.
 *
 * A note's comment threads sit in a panel beside the text, their passages
 * tinted in it (`document-comments.ts`): the format bubble's Comment, or
 * ⌘⌥M, starts one on the selection.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import {
  holiLink,
  isHoliLinkable,
  isResolved,
  type CommentAnchor,
} from "@holi/shared"
import { useAtom, useAtomValue, useSetAtom } from "jotai"
import { findNext, findPrev } from "prosemirror-search"
import { EditorContent, useEditor } from "@tiptap/react"
import { FileWarningIcon, SparklesIcon } from "lucide-react"
import { toast } from "sonner"

import { DeleteTableDialog } from "@/features/documents/rich-text/delete-table-dialog"
import { RichTextBlockActions } from "@/features/documents/rich-text/rich-text-block-actions"
import { RichTextBlockGutter } from "@/features/documents/rich-text/rich-text-block-gutter"
import { setRichTextBubble } from "@/features/documents/rich-text/rich-text-bubble-bar"
import { RICH_TEXT_PROSE } from "@/features/documents/rich-text/rich-text-content"
import { RichTextLinkBubble } from "@/features/documents/rich-text/rich-text-link"
import {
  RICH_TEXT_BASIC_SLASH_ITEMS,
  RichTextSlashCommand,
  type RichTextSlashItem,
} from "@/features/documents/rich-text/rich-text-slash-menu"
import { useRichTextSelector } from "@/features/documents/rich-text/rich-text-state"
import {
  RICH_TEXT_TABLE_PROSE,
  RICH_TEXT_TABLE_SLASH_ITEM,
  RichTextTable,
  RichTextTableBubble,
} from "@/features/documents/rich-text/rich-text-table"
import { useIsApplePlatform } from "@/features/documents/rich-text/rich-text-toolbar"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { TooltipProvider } from "@/components/ui/tooltip"
import { cn } from "@/lib/cn"
import { TaskProperties } from "@/features/planning/task-properties"
import { trpc } from "@/lib/trpc"
import {
  addThreadAtom,
  refreshThreadsAtom,
  replyThreadAtom,
  resolveThreadAtom,
  threadsLoadAtom,
} from "@/state/comments"
import { sawText } from "@/state/doc-changes"
import { pendingHeadingAtom } from "@/state/open-document"
import { useViewMemory } from "@/state/view-memory"
import { claimsAtom, pluginSlashCommandsAtom } from "@/state/plugins"
import { editorSelectionAtom } from "@/state/ui-report"
import { activeRemoteAtom, snapshotAtom } from "@/state/vaults"

import { AgentPrompt, AgentStatus } from "./agent-prompt"
import { agentPromptKey, agentPromptPos, onEmptyLine, setAgentPrompt } from "./agent-trigger"
import {
  artifactPathFor,
  folderOf,
  isRunLive,
  locksDocument,
  useDocumentAgent,
} from "./document-agent"
import { CommentsPanel } from "./comments-panel"
import {
  DocumentComments,
  placeThreads,
  selectionAnchor,
  selectionLines,
  setCommentRanges,
  type PlacedRange,
} from "./document-comments"
import { createDocumentExtensions } from "./document-extensions"
import { headingAtCaret, landOnHeading } from "./document-headings"
import { DocumentFindBar, type FindRequest } from "./document-find-bar"
import { pluginSlashItem } from "./plugin-slash"
import { DocumentFormatBubble } from "./document-format-bubble"
import { DocumentHeader, type SaveState } from "./document-header"
import {
  AGENT_MARKER,
  documentTitle,
  joinDocument,
  splitDocument,
} from "./markdown"

// How long typing has to pause before the file is written.
const SAVE_DELAY_MS = 600

// How long a selection holds still before its lines are worked out.
const SELECTION_DELAY_MS = 250

// The block drop line, as the rich-text block draws it.
const DROP_LINE =
  "[&_.prosemirror-dropcursor-block]:text-primary [&_.prosemirror-dropcursor-block]:h-0.5! [&_.prosemirror-dropcursor-block]:-translate-y-[0.5px] [&_.prosemirror-dropcursor-block]:rounded-full"

type Load =
  | { kind: "loading" }
  | { kind: "ready"; head: string; body: string; text: string }
  | { kind: "error"; message: string }

/** The vault path a `[[target]]` names: an exact path, else a markdown
 *  file whose name matches, nearest folder first. */
function resolveLink(
  target: string,
  from: string,
  docs: readonly { path: string }[]
): string | null {
  const wanted = target.toLowerCase().replace(/\.md$/, "")
  const exact = docs.find(
    (doc) => doc.path.toLowerCase().replace(/\.md$/, "") === wanted
  )
  if (exact) return exact.path
  const named = docs.filter(
    (doc) => documentTitle(doc.path).toLowerCase() === wanted
  )
  const folder = folderOf(from)
  return (
    named.find((doc) => folderOf(doc.path) === folder)?.path ??
    named[0]?.path ??
    null
  )
}

export function DocumentView({
  path,
  onOpen,
  onMoved,
}: {
  path: string
  /** Open a vault path in a tab: a linked note, or a finished artifact. */
  onOpen: (path: string) => void
  /** The document moved (a task given another project): follow it. */
  onMoved?: (from: string, to: string) => void
}) {
  const remote = useAtomValue(activeRemoteAtom)
  const docs = useAtomValue(snapshotAtom).docs
  const mtime = docs.find((doc) => doc.path === path)?.updatedAt
  const [load, setLoad] = useState<Load>({ kind: "loading" })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (remote === null) return
    let live = true
    setLoad({ kind: "loading" })
    trpc.notes.read
      .query({ remote, path })
      .then((text) => {
        if (!live) return
        const { head, body } = splitDocument(text)
        setLoad({ kind: "ready", head, body, text })
      })
      .catch((err: unknown) => {
        if (live)
          setLoad({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          })
      })
    return () => {
      live = false
    }
  }, [remote, path, attempt])

  if (load.kind === "loading") return <DocumentSkeleton />
  if (load.kind === "error" || remote === null)
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileWarningIcon />
          </EmptyMedia>
          <EmptyTitle>Couldn’t open {documentTitle(path)}</EmptyTitle>
          <EmptyDescription>
            {load.kind === "error" ? load.message : "No vault is open."}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </Button>
        </EmptyContent>
      </Empty>
    )

  return (
    <DocumentEditor
      key={path}
      path={path}
      remote={remote}
      initial={load}
      mtime={mtime}
      docs={docs}
      onOpen={onOpen}
      onMoved={onMoved}
    />
  )
}

function DocumentEditor({
  path,
  remote,
  initial,
  mtime,
  docs,
  onOpen,
  onMoved,
}: {
  path: string
  remote: string
  initial: { head: string; body: string; text: string }
  mtime: string | undefined
  docs: readonly { path: string }[]
  onOpen: (path: string) => void
  onMoved?: (from: string, to: string) => void
}) {
  const agent = useDocumentAgent(path)
  const locked = locksDocument(agent.run)
  const [saveState, setSaveState] = useState<SaveState>("saved")
  const [linkOpen, setLinkOpen] = useState(false)
  const [deleteTableOpen, setDeleteTableOpen] = useState(false)
  const [fullWidth, setFullWidth] = useState(false)
  const [smallText, setSmallText] = useState(false)
  /** The find bar, open while set; a new request refocuses it. */
  const [find, setFind] = useState<FindRequest | null>(null)
  const apple = useIsApplePlatform()
  /** Whether the agent prompt is open; its line is the editor's to track
   *  (`agentPromptKey`), and it renders into `promptBox` on that line. */
  const [promptOpen, setPromptOpen] = useState(false)
  /** What the ask prompt opens with: an app command's instruction. */
  const [promptInitial, setPromptInitial] = useState("")
  const [promptBox] = useState(() => {
    const box = document.createElement("div")
    box.contentEditable = "false"
    box.className = "my-1"
    return box
  })
  const pageRef = useRef<HTMLDivElement>(null)
  /** The page's scroller, whose place a tab switch keeps. */
  const scrollerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<HTMLDivElement>(null)
  const head = useRef(initial.head)
  /** The file as last read or written: what a change on disk is compared to. */
  const lastText = useRef(initial.text)
  const saveTimer = useRef<number | undefined>(undefined)

  // Callbacks the extensions hold, read through refs so the extensions are
  // made once per document.
  const handlers = useRef({
    openLink: (_target: string) => undefined as void,
    trigger: (_pos: number, _instruction?: string) => undefined as void,
    pressThread: (_id: string) => undefined as void,
    pluginItems: (): readonly RichTextSlashItem[] => [],
  })
  handlers.current.openLink = (target) => {
    const found = resolveLink(target, path, docs)
    if (found) onOpen(found)
  }

  const extensions = useMemo(
    () => [
      ...createDocumentExtensions({
        folder: folderOf(path),
        placeholder: "Type / for commands, or Space to ask AI",
        onOpenLink: (target) => handlers.current.openLink(target),
        onAgentTrigger: (pos) => handlers.current.trigger(pos),
        promptContainer: promptBox,
      }),
      RichTextTable,
      DocumentComments.configure({
        onPress: (id) => handlers.current.pressThread(id),
      }),
      RichTextBlockActions,
      RichTextSlashCommand.configure({
        items: [
          ...RICH_TEXT_BASIC_SLASH_ITEMS,
          RICH_TEXT_TABLE_SLASH_ITEM,
          ASK_AI_SLASH_ITEM((pos) => handlers.current.trigger(pos)),
        ],
        more: () => handlers.current.pluginItems(),
      }),
    ],
    [path, promptBox]
  )

  const editor = useEditor(
    {
      extensions,
      content: initial.body,
      contentType: "markdown",
      immediatelyRender: false,
      editorProps: {
        attributes: {
          role: "textbox",
          "aria-label": `${documentTitle(path)} document`,
          "aria-multiline": "true",
        },
      },
      onUpdate: ({ transaction }) => {
        if (!transaction.docChanged) return
        setSaveState("saving")
        window.clearTimeout(saveTimer.current)
        saveTimer.current = window.setTimeout(() => void save(), SAVE_DELAY_MS)
      },
    },
    [extensions]
  )

  const editable = useRichTextSelector(
    editor,
    (current) => current?.isEditable ?? true
  )

  // The note's comment threads: the panel, and their passages in the text.
  const threadsLoad = useAtomValue(threadsLoadAtom)(path)
  const refreshThreads = useSetAtom(refreshThreadsAtom)
  const addThread = useSetAtom(addThreadAtom)
  const replyThread = useSetAtom(replyThreadAtom)
  const resolveThread = useSetAtom(resolveThreadAtom)
  const [commentsOpen, setCommentsOpen] = useState(false)
  /** The passage a new thread is being written on. */
  const [draft, setDraft] = useState<CommentAnchor | null>(null)
  const [activeThread, setActiveThread] = useState<string | null>(null)
  /** Every thread whose passage was found in the text at the last placing. */
  const [placed, setPlaced] = useState<ReadonlySet<string>>(new Set())
  const threads = threadsLoad.state === "ready" ? threadsLoad.threads : null
  const commentable = threadsLoad.state !== "unavailable"
  const hasSelection = useRichTextSelector(editor, (current) =>
    current ? !current.state.selection.empty : false
  )

  // Read again whenever the vault is: a pull or the agent may have written
  // the sidecar.
  useEffect(() => {
    void refreshThreads(path)
  }, [refreshThreads, path, docs])

  /** Place every thread in the text again and tint the open ones; between
   *  placings the tints follow the edits on their own. */
  const placeRef = useRef(() => undefined as void)
  placeRef.current = () => {
    if (!editor || editor.isDestroyed || threads === null) return
    const ranges: PlacedRange[] = placeThreads(editor, head.current, threads)
    setPlaced(new Set(ranges.map((range) => range.id)))
    const open = new Set(
      threads.filter((t) => !isResolved(t)).map((t) => t.id)
    )
    setCommentRanges(editor, {
      ranges: ranges.filter((range) => open.has(range.id)),
    })
  }
  useEffect(() => placeRef.current(), [editor, threads])
  useEffect(() => {
    if (editor) setCommentRanges(editor, { active: activeThread })
  }, [editor, activeThread])

  // The lines selected, for the agent's per-turn context: worked out once
  // the selection holds still, since it serialises the document. A caret
  // clears what this document reported, never another's.
  const setEditorSelection = useSetAtom(editorSelectionAtom)
  useEffect(() => {
    if (!editor) return
    let timer: number | undefined
    const report = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (editor.isDestroyed) return
        const lines = selectionLines(editor, head.current)
        setEditorSelection((was) => {
          if (lines === null) return was?.path === path ? null : was
          const same =
            was?.path === path &&
            was.lines.startLine === lines.startLine &&
            was.lines.endLine === lines.endLine
          return same ? was : { path, lines }
        })
      }, SELECTION_DELAY_MS)
    }
    editor.on("selectionUpdate", report)
    return () => {
      editor.off("selectionUpdate", report)
      window.clearTimeout(timer)
    }
  }, [editor, path, setEditorSelection])

  // A tab switched back to opens where it was left: the caret and the
  // scroll, kept as they move (`view-memory.ts`). A link to a heading
  // lands on the heading instead.
  const memory = useViewMemory()
  /** What the first claim on this path draws above it: a link's card. */
  const Banner = useAtomValue(claimsAtom).find(
    (claim) => claim.banner !== undefined && claim.match(path)
  )?.banner
  const [pendingHeading, setPendingHeading] = useAtom(pendingHeadingAtom)
  const headingWaiting = pendingHeading?.path === path
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!editor || editor.isDestroyed || remote === null || scroller === null)
      return
    const spot = memory.get(remote, path)
    if (spot !== undefined && !headingWaiting) {
      const size = editor.state.doc.content.size
      const clamp = (at: number) => Math.min(Math.max(at, 1), size - 1)
      try {
        editor.commands.setTextSelection({
          from: clamp(spot.anchor),
          to: clamp(spot.head),
        })
      } catch {
        // A position the text no longer has: the caret stays at the top.
      }
      scroller.scrollTop = spot.scrollTop
      // Again once the page has laid out, should it not have yet.
      requestAnimationFrame(() => {
        scroller.scrollTop = spot.scrollTop
      })
    }
    const noteSelection = () => {
      const { anchor, head } = editor.state.selection
      memory.note(remote, path, { anchor, head })
    }
    const noteScroll = () =>
      memory.note(remote, path, { scrollTop: scroller.scrollTop })
    editor.on("selectionUpdate", noteSelection)
    scroller.addEventListener("scroll", noteScroll, { passive: true })
    return () => {
      editor.off("selectionUpdate", noteSelection)
      scroller.removeEventListener("scroll", noteScroll)
    }
    // Once per editor: a heading arriving later is the effect below's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, remote, path, memory])

  // A Holi link that named a heading lands the caret on it once the
  // document is in the editor.
  useEffect(() => {
    if (!editor || editor.isDestroyed || pendingHeading?.path !== path) return
    landOnHeading(editor, markdown(), pendingHeading.heading)
    setPendingHeading(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, pendingHeading, path])

  const holiLinks = isHoliLinkable(path)
    ? {
        file: () => holiLink({ remote, path }),
        heading: () => {
          if (!editor) return null
          const heading = headingAtCaret(editor, markdown())
          return heading === null ? null : holiLink({ remote, path, heading })
        },
      }
    : null

  handlers.current.pressThread = (id) => {
    setCommentsOpen(true)
    setActiveThread(id)
  }

  /** The panel's thread, its passage scrolled into view. */
  function showThread(id: string) {
    setActiveThread(id)
    const thread = threads?.find((t) => t.id === id)
    if (!editor || !thread) return
    const [range] = placeThreads(editor, head.current, [thread])
    if (!range) return
    const { node } = editor.view.domAtPos(range.from)
    const element = node instanceof Element ? node : node.parentElement
    element?.scrollIntoView({ block: "center" })
  }

  async function commentOnSelection() {
    if (!editor || !commentable) return
    // The anchor quotes the file, so the file has to be what is shown.
    await save()
    const anchor = selectionAnchor(editor, head.current)
    if (anchor === null) {
      toast.error("That passage can’t take a comment", {
        description: "Select text in the note, outside images and raw HTML.",
      })
      return
    }
    setDraft(anchor)
    setActiveThread(null)
    setCommentsOpen(true)
  }

  /** A comment write: said when it fails, and rejected so its text stays. */
  async function commentWrite(what: string, run: () => Promise<unknown>) {
    try {
      await run()
    } catch (err) {
      toast.error(what, {
        description: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  const markdown = () =>
    editor ? joinDocument(head.current, editor.getMarkdown()) : lastText.current

  async function save(): Promise<void> {
    window.clearTimeout(saveTimer.current)
    saveTimer.current = undefined
    if (!editor || editor.isDestroyed) return
    const text = markdown()
    if (text === lastText.current) {
      setSaveState("saved")
      return
    }
    try {
      await trpc.notes.write.mutate({ remote, path, text })
      lastText.current = text
      setSaveState("saved")
      placeRef.current()
    } catch {
      setSaveState("error")
    }
  }

  // Leaving the document writes what is pending, and leaves what it showed
  // for its tab to be compared to (`doc-changes.ts`).
  useEffect(
    () => () => {
      const pending = saveTimer.current !== undefined
      const live = editor !== null && !editor.isDestroyed
      sawText(remote, path, pending && live ? markdown() : lastText.current)
      if (pending) void save()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor]
  )

  // A change on disk comes back in, unless local edits are still pending.
  useEffect(() => {
    if (!editor || mtime === undefined) return
    let live = true
    void trpc.notes.read
      .query({ remote, path })
      .then((text) => {
        if (!live || editor.isDestroyed || text === lastText.current) return
        if (saveTimer.current !== undefined && !locked) return
        const next = splitDocument(text)
        head.current = next.head
        lastText.current = text
        editor.commands.setContent(next.body, {
          contentType: "markdown",
          emitUpdate: false,
        })
        placeRef.current()
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
    // Only a new mtime means the file may have changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mtime, editor])

  // A run that edits the document locks it; done, the lock lifts.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    editor.setEditable(!locked)
  }, [editor, locked])

  // A finished edit clears its pill on its own; an artifact waits to be
  // opened or dismissed.
  useEffect(() => {
    const run = agent.run
    if (!run || run.status !== "done" || run.kind === "artifact") return
    const timer = window.setTimeout(agent.dismiss, 1500)
    return () => window.clearTimeout(timer)
  }, [agent.run, agent.dismiss])

  handlers.current.trigger = (pos, instruction) => {
    if (!editor || !agent.available || isRunLive(agent.run)) return
    setPromptInitial(instruction ?? "")
    setAgentPrompt(editor, pos)
    setPromptOpen(true)
  }

  // The running plugins' slash commands (a vault app's), offered where
  // their plugin says they may run on this note.
  const pluginCommands = useAtomValue(pluginSlashCommandsAtom)
  handlers.current.pluginItems = () =>
    pluginCommands
      .filter((command) => command.offeredIn?.(path) ?? true)
      .map((command) =>
        pluginSlashItem(command, path, (pos, instruction) =>
          handlers.current.trigger(pos, instruction)
        )
      )

  function closePrompt() {
    if (!editor) return
    const pos = agentPromptPos(editor.state)
    setAgentPrompt(editor, null)
    setPromptOpen(false)
    editor.commands.focus(pos ?? "end")
  }

  async function sendPrompt(request: string) {
    if (!editor) return
    // The prompt's line becomes the marker the agent writes at.
    const { state } = editor
    const pos = agentPromptPos(state)
    const tr = state.tr.setMeta(agentPromptKey, { pos: null })
    const marker = state.schema.nodes.htmlBlock?.create({ html: AGENT_MARKER })
    if (pos !== null && marker && onEmptyLineAt(state.doc, pos)) {
      const $pos = state.doc.resolve(pos)
      tr.replaceWith($pos.before(), $pos.after(), marker)
    }
    editor.view.dispatch(tr)
    setPromptOpen(false)
    await save()
    await agent.start("write", request)
  }

  async function quickCommand(verb: string, passage: string) {
    await save()
    await agent.start("rewrite", verb, passage)
  }

  async function turnIntoArtifact() {
    await save()
    await agent.start("artifact", "Make an artifact")
  }

  /**
   * The whole page takes a press. Below the last line it starts a new one
   * (reusing an empty last line); beside the text it puts the caret on the
   * nearest line. Presses on the text itself are the editor's.
   */
  function pressPage(event: React.MouseEvent<HTMLDivElement>) {
    if (!editor || !editor.isEditable || event.button !== 0) return
    // Only the bare page: the scroller, the page box, or the inset around the
    // text. Bubbles, the gutter and the prompt sit in the page too.
    const target = event.target
    if (
      target !== event.currentTarget &&
      target !== pageRef.current &&
      target !== editor.view.dom.parentElement
    )
      return
    event.preventDefault()
    const text = editor.view.dom.getBoundingClientRect()
    if (event.clientY > text.bottom) {
      const { doc, schema } = editor.state
      const last = doc.lastChild
      const emptyLast =
        last?.type.name === "paragraph" && last.content.size === 0
      if (!emptyLast) {
        editor
          .chain()
          .insertContentAt(doc.content.size, { type: schema.nodes.paragraph!.name })
          .run()
      }
      editor.commands.focus("end")
      return
    }
    const x = Math.min(Math.max(event.clientX, text.left + 1), text.right - 1)
    const at = editor.view.posAtCoords({ left: x, top: event.clientY })
    editor.commands.focus(at?.pos ?? "end")
  }

  function openLinkEditor() {
    if (!editor?.isEditable || !editor.can().toggleBold()) return
    if (editor.isActive("link")) editor.chain().extendMarkRange("link").run()
    setRichTextBubble(editor, "documentFormatBubble", "show")
    setLinkOpen(true)
  }

  /**
   * ⌘F (Ctrl+F elsewhere) anywhere in this document's view opens its own find
   * bar, so each view of a split has its own. The selection seeds the query
   * when it is one line. With the bar open, ⌘G and ⇧⌘G step from the text
   * too, and Escape in the text closes it.
   */
  function isFindKey(event: KeyboardEvent | React.KeyboardEvent) {
    const mod = apple ? event.metaKey : event.ctrlKey
    return (
      mod &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === "f"
    )
  }

  function openFind() {
    if (!editor) return
    const { from, to, $from, $to } = editor.state.selection
    const text =
      from < to && $from.sameParent($to)
        ? editor.state.doc.textBetween(from, to)
        : null
    setFind((current) => ({ token: (current?.token ?? 0) + 1, text }))
  }

  /**
   * ⌘F with focus outside every view (the sidebar after opening a document
   * from it, or nothing at all) finds in the document in front: the only
   * view, or a split's focused member. A view that took the key itself has
   * already claimed it, and a dialog keeps its keys.
   */
  const openFindRef = useRef(openFind)
  openFindRef.current = openFind
  useEffect(() => {
    if (!editor) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || !isFindKey(event)) return
      const root = viewRef.current
      const target = event.target instanceof Element ? event.target : null
      if (!root || target?.closest("[data-pane], [role='dialog']")) return
      const pane = root.closest("[data-pane]")
      const inFront =
        !pane ||
        pane.hasAttribute("data-pane-focused") ||
        document.querySelectorAll("[data-pane]").length === 1
      if (!inFront) return
      event.preventDefault()
      openFindRef.current()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, apple])

  function handleViewKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!editor || event.defaultPrevented) return
    const mod = apple ? event.metaKey : event.ctrlKey
    const key = event.key.toLowerCase()
    if (mod && event.altKey && !event.shiftKey && event.code === "KeyM") {
      // ⌘⌥M, as in other editors: comment on the selection.
      event.preventDefault()
      void commentOnSelection()
    } else if (isFindKey(event)) {
      event.preventDefault()
      openFind()
    } else if (find && mod && !event.altKey && key === "g") {
      event.preventDefault()
      ;(event.shiftKey ? findPrev : findNext)(
        editor.state,
        editor.view.dispatch
      )
    } else if (find && event.key === "Escape" && editor.view.hasFocus()) {
      event.preventDefault()
      setFind(null)
    }
  }

  const canAsk = agent.available && !isRunLive(agent.run)

  return (
    <TooltipProvider delayDuration={300}>
      <div
        ref={viewRef}
        className="text-foreground relative flex h-full min-h-0 w-full flex-col"
        onKeyDown={handleViewKeyDown}
      >
        {/* Locked while a run edits the document: nothing in it answers. */}
        <div inert={locked} className="flex min-h-0 flex-1 flex-col">
          {/* On the page's own ground, a hairline under it; the text scrolls
              beneath the line, not under the header. */}
          <DocumentHeader
            editor={editor}
            path={path}
            title={documentTitle(path)}
            saveState={saveState}
            locked={locked}
            markdown={markdown}
            fullWidth={fullWidth}
            smallText={smallText}
            onFullWidthChange={setFullWidth}
            onSmallTextChange={setSmallText}
            onTurnIntoArtifact={canAsk ? () => void turnIntoArtifact() : null}
            holiLinks={holiLinks}
            comments={
              commentable
                ? {
                    count: threads?.filter((t) => !isResolved(t)).length ?? 0,
                    open: commentsOpen,
                    onOpenChange: setCommentsOpen,
                  }
                : null
            }
          />
          <div className="flex min-h-0 flex-1">
          <div
            ref={scrollerRef}
            className="relative min-h-0 min-w-0 flex-1 overflow-y-auto"
            onMouseDown={pressPage}
          >
            {/* The find bar floats at the page's top right, over the text,
                and stays there as it scrolls. */}
            {editor && find ? (
              <div className="sticky top-2 z-40 flex h-0 items-start justify-end px-4">
                <DocumentFindBar
                  editor={editor}
                  request={find}
                  onClose={() => setFind(null)}
                />
              </div>
            ) : null}
            {/* A plugin's card for the file it claims, a link's page. */}
            {Banner !== undefined ? (
              <div
                className={cn(
                  "mx-auto w-full px-4 pt-8 sm:px-16 sm:pt-12",
                  fullWidth ? "max-w-none" : "max-w-3xl"
                )}
              >
                <Banner path={path} />
              </div>
            ) : null}
            {/* A task's fields, on the body's column; nothing for a note. */}
            <TaskProperties
              path={path}
              beforeWrite={save}
              onMoved={onMoved}
              className={cn(
                "mx-auto w-full px-4 pt-8 sm:px-16 sm:pt-12",
                fullWidth ? "max-w-none" : "max-w-3xl"
              )}
            />
            <div ref={pageRef} className={cn("relative min-h-full", DROP_LINE)}>
              {editor ? (
                <EditorContent
                  editor={editor}
                  onKeyDown={(event) => {
                    const mod = event.metaKey || event.ctrlKey
                    if (mod && !event.altKey && event.key.toLowerCase() === "k") {
                      event.preventDefault()
                      openLinkEditor()
                    }
                  }}
                  className={cn(
                    RICH_TEXT_PROSE,
                    RICH_TEXT_TABLE_PROSE,
                    "mx-auto w-full px-4 py-8 sm:px-16 sm:py-12",
                    fullWidth ? "max-w-none" : "max-w-3xl",
                    smallText && "text-sm/6",
                    locked && "opacity-60"
                  )}
                />
              ) : (
                <DocumentSkeleton />
              )}
              {editor ? (
                <>
                  <DocumentFormatBubble
                    editor={editor}
                    linkOpen={linkOpen}
                    onLinkOpenChange={setLinkOpen}
                    onQuickCommand={
                      canAsk
                        ? (verb, passage) => void quickCommand(verb, passage)
                        : null
                    }
                    onComment={
                      commentable ? () => void commentOnSelection() : null
                    }
                  />
                  <RichTextLinkBubble editor={editor} onEdit={openLinkEditor} />
                  <RichTextTableBubble
                    editor={editor}
                    onDeleteTable={() => setDeleteTableOpen(true)}
                  />
                  <RichTextBlockGutter
                    editor={editor}
                    editable={editable}
                    scrollerRef={pageRef}
                    onDeleteTable={() => setDeleteTableOpen(true)}
                  />
                </>
              ) : null}
              {promptOpen
                ? createPortal(
                    <AgentPrompt
                      initial={promptInitial}
                      onSubmit={(request) => void sendPrompt(request)}
                      onCancel={closePrompt}
                    />,
                    promptBox
                  )
                : null}
            </div>
          </div>
          {commentable && commentsOpen ? (
            <CommentsPanel
              load={threadsLoad}
              placed={placed}
              active={activeThread}
              draft={draft}
              onSelect={showThread}
              onDraftSubmit={(body) =>
                commentWrite("The comment could not be saved", async () => {
                  if (draft === null) return
                  const id = await addThread({ path, anchor: draft, body })
                  setDraft(null)
                  if (id) setActiveThread(id)
                })
              }
              onDraftCancel={() => setDraft(null)}
              onReply={(thread, body) =>
                commentWrite("The reply could not be saved", () =>
                  replyThread({ path, thread, body })
                )
              }
              onResolve={(thread, resolved) =>
                commentWrite(
                  resolved
                    ? "The thread could not be resolved"
                    : "The thread could not be reopened",
                  () => resolveThread({ path, thread, resolved })
                ).catch(() => undefined)
              }
              onRetry={() => void refreshThreads(path)}
              onClose={() => {
                setCommentsOpen(false)
                setDraft(null)
                setActiveThread(null)
              }}
              onCommentSelection={
                hasSelection ? () => void commentOnSelection() : null
              }
            />
          ) : null}
          </div>
        </div>

        {agent.run ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center px-4">
            <div className="pointer-events-auto">
              <AgentStatus
                run={agent.run}
                onStop={() => void agent.stop()}
                onDismiss={agent.dismiss}
                onOpenArtifact={() => {
                  agent.dismiss()
                  onOpen(artifactPathFor(path))
                }}
              />
            </div>
          </div>
        ) : null}
      </div>
      <DeleteTableDialog
        editor={editor}
        open={deleteTableOpen}
        onOpenChange={setDeleteTableOpen}
      />
    </TooltipProvider>
  )
}

/** Whether `pos` is still on an empty top-level paragraph. */
function onEmptyLineAt(
  doc: import("@tiptap/pm/model").Node,
  pos: number
): boolean {
  const $pos = doc.resolve(pos)
  return (
    $pos.depth === 1 &&
    $pos.parent.type.name === "paragraph" &&
    $pos.parent.content.size === 0
  )
}

/** "/ai": the same prompt Space opens, for those who reach for the slash. */
function ASK_AI_SLASH_ITEM(open: (pos: number) => void): RichTextSlashItem {
  return {
    id: "ask-ai",
    group: "AI",
    title: "Ask AI",
    hint: "Have Sonnet write or change the document",
    keywords: ["ai", "agent", "write", "sonnet", "claude"],
    icon: <SparklesIcon aria-hidden="true" />,
    can: (editor) => editor.isEditable,
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).run()
      if (onEmptyLine(editor)) open(editor.state.selection.from)
    },
  }
}

function DocumentSkeleton() {
  return (
    <div
      aria-label="Opening the document"
      className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-12 sm:px-16"
    >
      <Skeleton className="h-8 w-2/3" />
      <div className="flex flex-col gap-2.5">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    </div>
  )
}
