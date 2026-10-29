import type { ComponentType, ReactElement } from 'react'
import type { ItemInstance } from '@headless-tree/core'
import { FolderIcon, FolderOpenIcon } from 'lucide-react'

import { FileType, getFileType } from '@/components/ui/file-type'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
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

/** Folders keep their folder glyph; every file, an app bundle included,
 *  shows ReUI's file-type icon for its kind. A folder document (a deck, an
 *  app) shows its kind's glyph rather than a label: at row size a label is
 *  a coloured band too small to read, and a deck's red one passed for a
 *  PDF's orange. */
export function FileGlyph({ item }: { item: ItemInstance<TreeItemData> }) {
  const data = item.getItemData()
  if (item.isFolder() && !data?.isDocument) {
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
      glyph={data?.isDocument === true}
      aria-hidden="true"
      className="shrink-0"
    />
  )
}
