/**
 * What the chat does with what a person attaches: any file, picked, dropped,
 * or pasted (a screenshot on the clipboard is a file named `image.png`).
 *
 * **An attachment is a marker in the text.** Attaching inserts `[Image 1]` (or
 * `[notes.pdf]`) at the cursor, so the words around it say what each one is
 * for, and deleting the marker removes the attachment. On send, main writes
 * each file into the vault (`main/host/uploads.ts`) and the marker is replaced
 * by `@<path>` where it stood, which is how Claude Code is given a file, so
 * the agent reads each file in the place its comment is.
 *
 * Pure, so it is testable without a DOM.
 */

/** The most attachments one message may carry. */
export const MAX_ATTACHMENTS = 8

/** One file waiting to go with the message, named in the text by `marker`. */
export interface Attachment {
  id: string
  file: File
  marker: string
}

export const isImage = (file: File): boolean => file.type.startsWith('image/')

/** Chromium names a clipboard bitmap `image.png`, or leaves it nameless. */
const isBitmapName = (name: string): boolean => name === '' || /^image\.(png|jpe?g)$/i.test(name)

/**
 * The files on a clipboard or a drag. Chromium lists a pasted screenshot in
 * `files`, but some sources only in `items`, so both are read, each file once.
 */
export function filesOf(data: DataTransfer | null): File[] {
  if (data === null) return []
  const files = Array.from(data.files ?? [])
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file !== null && !files.some((f) => f.name === file.name && f.size === file.size)) {
      files.push(file)
    }
  }
  return files
}

/** What a paste means for the chat. */
export interface Pasted {
  /** Files to attach. */
  files: File[]
  /** A picture is on the clipboard but the browser gave no bytes for it. */
  unreadable: boolean
}

/**
 * Rich text (a spreadsheet's cells) carries a picture of itself beside its
 * text: that paste is the text's, so its bitmap is not an attachment. A
 * screenshot, or "Copy image" in a browser, has no plain text with it.
 */
export function pastedFiles(data: DataTransfer | null): Pasted {
  if (data === null) return { files: [], unreadable: false }
  const richText = Array.from(data.types ?? []).includes('text/plain')
  const all = filesOf(data)
  const files = all.filter((f) => !(richText && isImage(f) && isBitmapName(f.name)))
  const imageItem = Array.from(data.items ?? []).some((i) => i.type.startsWith('image/'))
  return { files, unreadable: !richText && imageItem && files.length === 0 }
}

/** A name main can keep the extension of: a file keeps its own. */
export function uploadName(file: File): string {
  if (/\.[a-z0-9]{1,10}$/i.test(file.name)) return file.name
  const ext = { 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/png': 'png' }[
    file.type
  ]
  const stem = file.name === '' ? 'file' : file.name
  return ext === undefined ? stem : `${stem}.${ext}`
}

/** A file's bytes as base64, the way a capability carries them. */
export function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('That file could not be read.'))
    reader.onload = () => {
      const result = String(reader.result)
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The marker for a file about to be attached: `[Image N]` for a picture,
 * numbered past every one already attached or typed, else `[name]`, made
 * distinct from the others if the name repeats.
 */
export function markerFor(file: File, taken: readonly string[], draft: string): string {
  const used = (marker: string): boolean => taken.includes(marker) || draft.includes(marker)
  if (isImage(file)) {
    let n = 1
    while (used(`[Image ${n}]`)) n += 1
    return `[Image ${n}]`
  }
  const name = file.name.replace(/[[\]]/g, '') || 'file'
  let marker = `[${name}]`
  for (let n = 2; used(marker); n += 1) marker = `[${name} (${n})]`
  return marker
}

/**
 * `marker` put into `text` over the selection, with a space either side where
 * it would otherwise touch a word. Answers the new text and where the caret
 * goes: just after the marker.
 */
export function insertMarker(
  text: string,
  start: number,
  end: number,
  marker: string,
): { text: string; caret: number } {
  const before = text.slice(0, start)
  const after = text.slice(end)
  const lead = before === '' || /\s$/.test(before) ? '' : ' '
  const trail = after === '' || /^\s/.test(after) ? '' : ' '
  const head = `${before}${lead}${marker}`
  return { text: `${head}${trail}${after}`, caret: head.length + (after === '' ? 0 : trail.length) }
}

/** A marker for a picture, which the field draws with the picture icon. */
export const markerIsImage = (marker: string): boolean => /^\[Image \d+\]$/.test(marker)

/** What a chip says: the marker without its brackets. */
export const markerLabel = (marker: string): string => marker.slice(1, -1)

/** The attachments whose marker is still in the text: the rest were deleted,
 *  which is how one is removed. */
export function stillAttached(text: string, attachments: readonly Attachment[]): Attachment[] {
  return attachments.filter((a) => text.includes(a.marker))
}

/** One file named in a message: `@path`, quoted when the path has a space. */
export const mention = (path: string): string => (/\s/.test(path) ? `@"${path}"` : `@${path}`)

/**
 * The message as it is sent: each marker replaced by the `@path` of its file,
 * where it stood. A space is kept after it when a word follows, because
 * Claude Code reads a path up to the next space.
 */
export function withPaths(text: string, paths: ReadonlyMap<string, string>): string {
  let out = text
  for (const [marker, path] of paths) {
    out = out.replace(new RegExp(`${escapeRe(marker)}(?=(\\S?))`, 'g'), (_m, next: string) => {
      return `${mention(path)}${next === '' ? '' : ' '}`
    })
  }
  return out
}

/** An `@path` into the chat's uploads folder, quoted or not. */
const MENTION = /@(?:"([^"]*chat\.local\.uploads\/[^"]+)"|(\S*chat\.local\.uploads\/\S+))(?=\s|$)/g

/** A message split into what was typed and the files it names, in order. */
export type UserPart =
  { kind: 'text'; text: string } | { kind: 'file'; path: string; label: string; image: boolean }

/** The name an upload had, less the stamp main put in front of it. */
export function uploadLabel(path: string): string {
  const file = path.slice(path.lastIndexOf('/') + 1)
  return file.replace(/^[0-9a-z]+-[0-9a-f]{6}-/, '')
}

export function splitUserText(text: string): UserPart[] {
  const parts: UserPart[] = []
  let last = 0
  for (const match of text.matchAll(MENTION)) {
    const before = text.slice(last, match.index).trim()
    if (before !== '') parts.push({ kind: 'text', text: before })
    const path = (match[1] ?? match[2])!
    parts.push({
      kind: 'file',
      path,
      label: uploadLabel(path),
      image: /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(path),
    })
    last = match.index + match[0].length
  }
  const rest = text.slice(last).trim()
  if (rest !== '') parts.push({ kind: 'text', text: rest })
  return parts
}

/** The uploads folder, as a vault-relative path. */
const UPLOADS = '.holi/state/chat.local.uploads/'

/**
 * Where an uploaded file is in the vault, which is what `holi-vault://` serves
 * (`vaultAssetUrl`): an upload is named in a message by its absolute path, so
 * this is the part from the uploads folder on. Null for any other path.
 */
export function uploadVaultPath(path: string): string | null {
  const at = path.indexOf(UPLOADS)
  return at === -1 ? null : path.slice(at)
}
