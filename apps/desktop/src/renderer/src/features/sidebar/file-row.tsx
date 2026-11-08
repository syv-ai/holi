import type { ComponentType, ReactElement } from 'react'
import type { ItemInstance } from '@headless-tree/core'
import { FolderIcon, FolderOpenIcon, TriangleAlertIcon } from 'lucide-react'

import { FileType, getFileType } from '@/components/ui/file-type'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FolderDocumentMark } from '@/composites/marks'
import type { TreeItemData } from '@/lib/tree-data'

/** A row in a hover card when its claim draws one; the row alone otherwise. */
export function RowHover({
  card: Card,
  path,
  children,
}: {
  card: ComponentType<{ path: string }> | undefined
  path: string
  children: ReactElement
}) {
  if (Card === undefined) return children
  return (
    <HoverCard openDelay={500} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent side="right" align="start" variant="flush" className="w-80">
        <Card path={path} />
      </HoverCardContent>
    </HoverCard>
  )
}

/** A row's name: the file's name without its extension, which the icon
 *  already says. Folders keep theirs whole. */
export function displayName(item: ItemInstance<TreeItemData>): string {
  const name = item.getItemName()
  if (item.isFolder() && !item.getItemData()?.isDocument) return name
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/** Folders keep their folder glyph; every file shows ReUI's file-type icon
 *  for its kind, and a folder document (a deck, an app) its kind's glyph. */
export function FileGlyph({ item }: { item: ItemInstance<TreeItemData> }) {
  const data = item.getItemData()
  if (data?.isDocument === true) return <FolderDocumentMark name={item.getItemName()} />
  if (item.isFolder()) {
    return item.isExpanded() ? (
      <FolderOpenIcon className="text-muted-foreground size-4" aria-hidden="true" />
    ) : (
      <FolderIcon className="text-muted-foreground size-4" aria-hidden="true" />
    )
  }
  return (
    <FileType
      type={getFileType(item.getItemName())}
      size="mini"
      aria-hidden="true"
      className="shrink-0"
    />
  )
}

const MB = 1024 * 1024

/** A size as the settings name the limit: `11.7 MB`, `10 MB`. */
function megabytes(bytes: number): string {
  const mb = bytes / MB
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`
}

/** Why a held-back file is not syncing, or a closed folder holding some:
 *  the size against the vault's limit (`null` while the settings load). */
function heldBackReason(held: readonly { bytes: number }[], limit: number | null): string {
  const over = limit === null ? 'over the size limit' : `over the ${megabytes(limit)} limit`
  const [only] = held
  if (held.length === 1 && only !== undefined)
    return `Not synced: ${megabytes(only.bytes)}, ${over}`
  return `Not synced: ${held.length} files ${over}`
}

/** The warning at a row's end on a file the large-file gate held back, and
 *  on a folder holding some: `held` is what the row holds, if anything. */
export function HeldBackMark({
  held,
  limit,
}: {
  held: readonly { bytes: number }[] | undefined
  limit: number | null
}) {
  if (held === undefined || held.length === 0) return null
  const reason = heldBackReason(held, limit)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span role="img" aria-label={reason} className="ms-auto flex shrink-0">
          <TriangleAlertIcon className="text-warning size-4" aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">{reason}</TooltipContent>
    </Tooltip>
  )
}
