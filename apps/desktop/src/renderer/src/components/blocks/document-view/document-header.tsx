/**
 * The document's band, after the rich-text block's page header: its
 * name and save state, who has written it (GitHub), undo and redo, and the
 * document menu.
 */
import { type Ref } from "react"
import type { Editor } from "@tiptap/react"

import { RichTextHistory } from "@/components/blocks/rich-text-editor-2/components/rich-text-controls"
import { useRichTextState } from "@/components/blocks/rich-text-editor-2/components/rich-text-state"
import { RichTextToolbarSeparator } from "@/components/blocks/rich-text-editor-2/components/rich-text-toolbar"
import { Badge } from "@/components/reui/badge"
import { ViewHeader, ViewHeaderTitle } from "@/composites/ViewHeader"
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "@/components/ui/avatar"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

import { FileHistoryButton } from "../file-history/file-history-button"
import { initials, useFileAuthors } from "../file-history/use-file-history"

import { DocumentActions, type DocumentActionsProps } from "./document-actions"

export type SaveState = "saved" | "saving" | "error"

/** Faces shown before the rest fold into "+N". */
const MAX_FACES = 4

function Dot() {
  return (
    <span
      aria-hidden="true"
      className="bg-muted-foreground/40 size-1 shrink-0 rounded-full"
    />
  )
}

/** Who has written the file: GitHub accounts where commits link to one. */
function Contributors({ path }: { path: string }) {
  const data = useFileAuthors(path)
  if (data.length === 0) return null

  const shown = data.slice(0, MAX_FACES)
  const label = `Written by ${new Intl.ListFormat("en-US").format(
    data.map((person) => person.login ?? person.name)
  )}`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <AvatarGroup
          role="group"
          tabIndex={0}
          aria-label={label}
          // Gives way below a 576px pane: the History dialog names them too.
          className="hidden @xl/view-header:flex"
        >
          {shown.map((person) => (
            <Avatar key={person.login ?? person.name} size="sm">
              {person.avatarUrl ? (
                <AvatarImage src={person.avatarUrl} alt={person.name} />
              ) : null}
              <AvatarFallback>{initials(person.name)}</AvatarFallback>
            </Avatar>
          ))}
          {data.length > MAX_FACES ? (
            <AvatarGroupCount>+{data.length - MAX_FACES}</AvatarGroupCount>
          ) : null}
        </AvatarGroup>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

interface DocumentHeaderProps extends Omit<DocumentActionsProps, "editor"> {
  ref?: Ref<HTMLElement>
  editor: Editor | null
  path: string
  title: string
  saveState: SaveState
  /** An agent run is editing the document. */
  locked: boolean
}

export function DocumentHeader({
  ref,
  editor,
  path,
  title,
  saveState,
  locked,
  ...actions
}: DocumentHeaderProps) {
  const state = useRichTextState(editor)
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null

  // One row at every width (`ViewHeader`): as the pane narrows the commit
  // line goes first, then the faces, History's label, and undo and redo
  // (⌘Z still works); the title truncates and the menu always stays.
  return (
    <ViewHeader ref={ref}>
      <ViewHeaderTitle
        title={title}
        badge={
          locked ? (
            <Badge variant="outline" className="shrink-0 font-normal">
              Locked
            </Badge>
          ) : undefined
        }
        meta={
          <>
            {folder ? (
              <>
                <span className="truncate">{folder}</span>
                <Dot />
              </>
            ) : null}
            <span aria-live="polite" className="shrink-0">
              {saveState === "saving"
                ? "Saving…"
                : saveState === "error"
                  ? "Not saved"
                  : "Saved"}
            </span>
          </>
        }
      />

      <Contributors path={path} />
      <FileHistoryButton path={path} />

      <div className="flex shrink-0 items-center gap-1">
        <div className="hidden items-center gap-1 @md/view-header:flex">
          <RichTextHistory editor={editor} state={state} />
          <RichTextToolbarSeparator />
        </div>
        <DocumentActions editor={editor} {...actions} />
      </div>
    </ViewHeader>
  )
}
