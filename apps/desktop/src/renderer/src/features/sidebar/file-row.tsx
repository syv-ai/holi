import type { ComponentType, ReactElement } from 'react'
import type { ItemInstance } from '@headless-tree/core'
import { FolderIcon, FolderOpenIcon, TriangleAlertIcon } from 'lucide-react'

import { FileType, getFileType } from '@/components/ui/file-type'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FolderDocumentMark } from '@/composites/marks'
import { megabytes } from '@/lib/megabytes'
import type { TreeItemData } from '@/lib/tree-data'

/** A held-back file as main pushes it (`HeldBackFile`): its size and the
 *  limit it was held back against. */
interface Held {
  bytes: number
  limit: number
}

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

/** Why a held-back file is not syncing, or a closed folder holding some:
 *  the size against the limit main held it back at. One commit tick holds
 *  them all against the same limit. */
function heldBackReason([first, ...rest]: readonly Held[]): string {
  if (first === undefined) return ''
  const over = `over the ${megabytes(first.limit)} limit`
  if (rest.length === 0) return `Not synced: ${megabytes(first.bytes)}, ${over}`
  return `Not synced: ${rest.length + 1} files ${over}`
}

/** The warning at a row's end on a file the large-file gate held back, and
 *  on a folder holding some: `held` is what the row holds, if anything. */
export function HeldBackMark({ held }: { held: readonly Held[] | undefined }) {
  if (held === undefined || held.length === 0) return null
  const reason = heldBackReason(held)
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
