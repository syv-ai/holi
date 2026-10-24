/**
 * Files the composer sends with a message: images (pasted, dropped or picked
 * from disk) go to Claude Code as image blocks, PDFs as document blocks and
 * text files as their text, named (`main/claude-stream.ts`, `userMessage`).
 * A vault document is not attached at all: it is an `@path` reference in the
 * text, which Claude Code reads itself.
 *
 * After MonoCode's composer attachments (`features/sessions/model/
 * attachments.ts`, `Composer.pasteImage`; MIT, Copyright (c) 2026 Nick; see
 * NOTICE.md).
 */
import { FileIcon, XIcon } from "lucide-react"

import { Badge } from "@/components/reui/badge"
import { Button } from "@/components/ui/button"
import type { SendFile } from "./state/chats"

/** One file waiting in the composer. */
export interface ComposerFile extends SendFile {
  id: string
  size: number
  /** An object URL for an image's thumbnail. */
  preview?: string
}

/** What one file may weigh: the main side's cap, so it never refuses one. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_ATTACHMENTS = 10

const IMAGE = /^image\/(png|jpeg|gif|webp)$/
const TEXT_EXT =
  /\.(md|markdown|txt|csv|tsv|json|ya?ml|toml|xml|html?|css|js|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cpp|sh|sql|log|ini|env\.example)$/i

/** The media type a file goes as, or null when Claude Code cannot take it. */
export function sendableType(file: {
  name: string
  type: string
}): string | null {
  if (IMAGE.test(file.type)) return file.type
  if (file.type === "application/pdf") return file.type
  if (file.type.startsWith("text/")) return file.type
  if (/^application\/(json|xml|x-yaml|yaml|toml)$/.test(file.type)) {
    return file.type
  }
  if (TEXT_EXT.test(file.name)) return "text/plain"
  return null
}


/** A picked, pasted or dropped file, read for sending; a reason when not. */
export function readAttachment(
  file: File
): Promise<ComposerFile | { error: string }> {
  const mediaType = sendableType(file)
  if (mediaType === null) {
    return Promise.resolve({
      error: `${file.name} can’t be sent: Claude Code takes images, PDFs and text files.`,
    })
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return Promise.resolve({
      error: `${file.name} is larger than 10 MB, so it can’t be sent.`,
    })
  }
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      const data = url.slice(url.indexOf(",") + 1)
      const name =
        file.name !== ""
          ? file.name
          : `Pasted image.${mediaType.split("/")[1] ?? "png"}`
      resolve({
        id: crypto.randomUUID(),
        name,
        mediaType,
        data,
        size: file.size,
        ...(IMAGE.test(mediaType)
          ? { preview: URL.createObjectURL(file) }
          : {}),
      })
    }
    reader.onerror = () =>
      resolve({ error: `${file.name || "The file"} could not be read.` })
    reader.readAsDataURL(file)
  })
}

/** Let go of a file's thumbnail. */
export function releaseAttachment(file: ComposerFile): void {
  if (file.preview !== undefined) URL.revokeObjectURL(file.preview)
}

/** The files above the text: a thumbnail for an image, a chip for a file,
 *  each with its own Remove. */
export function AttachmentTray({
  files,
  onRemove,
}: {
  files: readonly ComposerFile[]
  onRemove(id: string): void
}) {
  if (files.length === 0) return null
  return (
    <ul
      className="flex w-full flex-wrap items-center gap-2"
      aria-label="Attached files"
      data-attachments=""
    >
      {files.map((f) => (
        <li key={f.id} className="relative flex items-center">
          {f.preview !== undefined ? (
            <img
              src={f.preview}
              alt={f.name}
              className="ring-foreground/10 size-12 rounded-md object-cover ring-1"
            />
          ) : (
            <Badge variant="outline" className="max-w-48 pe-6">
              <FileIcon aria-hidden="true" />
              <span className="min-w-0 truncate">{f.name}</span>
            </Badge>
          )}
          <Button
            type="button"
            variant="secondary"
            size="icon-xs"
            aria-label={`Remove ${f.name}`}
            className="absolute -end-1.5 -top-1.5 rounded-full"
            onClick={() => onRemove(f.id)}
          >
            <XIcon aria-hidden="true" />
          </Button>
        </li>
      ))}
    </ul>
  )
}
