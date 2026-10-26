/**
 * One vault app on the Apps page, on ReUI's card pattern: the inset
 * image is the app's preview, the picture taken the last time it ran here, or its own icon on a muted
 * plate when it has none; the Trending badge says whether the app is shared
 * through the vault or personal to this machine; Featured is its folder; the
 * blurb is its manifest's description; Get Started opens it. The name, which
 * the example has no place for, sits above the description.
 *
 * The card is a context menu's trigger: right-click it, or press the menu
 * key (or Shift+F10) with its Open button focused, for Open, Open beside,
 * Ask about this app, Reveal in Files, Copy path, Refresh preview and
 * Archive.
 */
import { useEffect, useRef, useState, type ComponentType } from 'react'
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowRightIcon,
  CopyIcon,
  FolderIcon,
  FolderTreeIcon,
  ImageIcon,
  LockIcon,
  RefreshCwIcon,
  SparklesIcon,
  SquareSplitHorizontalIcon,
  UsersIcon,
} from 'lucide-react'
import { isLocalOnlyPath } from '@holi/shared'

import { Badge } from '@/components/reui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardTitle } from '@/components/ui/card'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Skeleton } from '@/components/ui/skeleton'

type Description = { kind: 'loading' } | { kind: 'ready'; text: string | null } | { kind: 'error' }

/** The manifest's description, read again when `stamp` (the newest of the
 *  app's files) moves or Retry is pressed. */
function useDescription(
  describe: (() => Promise<string | null>) | undefined,
  stamp: string,
): [Description, () => void] {
  const [state, setState] = useState<Description>(
    describe === undefined ? { kind: 'ready', text: null } : { kind: 'loading' },
  )
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (describe === undefined) return
    let live = true
    describe().then(
      (text) => live && setState({ kind: 'ready', text }),
      () => live && setState({ kind: 'error' }),
    )
    return () => {
      live = false
    }
    // `describe` is a fresh closure every render; the app and its files are
    // what decide when to read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, attempt])
  return [
    state,
    () => {
      setState({ kind: 'loading' })
      setAttempt((n) => n + 1)
    },
  ]
}

type Preview = { kind: 'loading' } | { kind: 'ready'; url: string | null }

/** The app's preview, read again when `stamp` or `version` moves. One that
 *  cannot be read is no preview: the icon plate stands in, as for an app
 *  that never ran here. */
function usePreview(
  preview: (() => Promise<string | null>) | undefined,
  stamp: string,
  version: number,
): Preview {
  const [state, setState] = useState<Preview>(
    preview === undefined ? { kind: 'ready', url: null } : { kind: 'loading' },
  )
  useEffect(() => {
    if (preview === undefined) return
    let live = true
    preview().then(
      (url) => live && setState({ kind: 'ready', url }),
      () => live && setState({ kind: 'ready', url: null }),
    )
    return () => {
      live = false
    }
    // `preview` is a fresh closure every render; the app's files and its
    // picture being taken again are what decide when to read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, version])
  return state
}

/** What the card's menu can do; an action left out is not offered. */
export interface AppCardActions {
  onOpenBeside: () => void
  /** A chat about the app, beside; absent while no agent can start one. */
  onAsk?: () => void
  onReveal: () => void
  onCopyPath: () => void
  onRefreshPreview?: () => void
  /** Archive the app, or bring it back when it is archived. */
  onArchive?: () => void
}

export function AppCard({
  path,
  name,
  icon: Icon,
  stamp,
  describe,
  preview: readPreview,
  previewVersion = 0,
  archived = false,
  onOpen,
  actions,
}: {
  path: string
  name: string
  icon: ComponentType<{ className?: string }>
  /** The newest mtime among the app's files. */
  stamp: string
  describe?: () => Promise<string | null>
  /** Its picture, a `data:` URL, or null when it has none. */
  preview?: () => Promise<string | null>
  /** Moves when its picture is taken again or let go. */
  previewVersion?: number
  archived?: boolean
  onOpen: () => void
  actions?: AppCardActions
}) {
  const [description, retry] = useDescription(describe, stamp)
  const preview = usePreview(readPreview, stamp, previewVersion)
  const leaving = useRef(false)
  const slash = path.lastIndexOf('/')
  const folder = slash === -1 ? null : path.slice(0, slash)
  const personal = isLocalOnlyPath(path)

  const card = (
    <Card className="w-full">
      <CardContent>
        <div className="flex flex-col gap-4">
          <div className="bg-muted relative flex h-48 w-full items-center justify-center overflow-hidden rounded-lg">
            {preview.kind === 'loading' ? (
              <Skeleton className="size-full" aria-label={`Loading the preview of ${name}`} />
            ) : preview.url !== null ? (
              <img
                src={preview.url}
                alt={`${name}, as it last looked`}
                className="size-full object-cover object-left-top"
              />
            ) : (
              <Icon className="text-muted-foreground size-12" />
            )}
          </div>

          <div className="flex items-center justify-between gap-5">
            <Badge variant="outline">
              {personal ? <LockIcon aria-hidden="true" /> : <UsersIcon aria-hidden="true" />}
              {personal ? 'Personal' : 'Shared'}
            </Badge>
            <div className="flex min-w-0 items-center gap-1">
              <FolderIcon className="size-4 shrink-0" aria-hidden="true" />
              <span className="text-secondary-foreground truncate text-xs font-medium">
                {folder ?? 'Vault root'}
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-0.5">
            <CardTitle>
              <span className="block truncate">{name}</span>
            </CardTitle>
            {description.kind === 'loading' ? (
              <div className="flex flex-col gap-1.5 py-0.5" aria-label="Loading the description">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            ) : description.kind === 'error' ? (
              <div className="flex items-center justify-between gap-2">
                <p className="text-muted-foreground text-sm">Couldn't read its description.</p>
                <Button variant="outline" size="sm" onClick={retry}>
                  <RefreshCwIcon data-icon="inline-start" aria-hidden="true" />
                  Retry
                </Button>
              </div>
            ) : description.text === null ? (
              <p className="text-muted-foreground text-sm">No description yet.</p>
            ) : (
              <p className="text-foreground line-clamp-3 text-sm">{description.text}</p>
            )}
          </div>

          <Button onClick={onOpen} aria-label={`Open ${name}`}>
            Open
            <ArrowRightIcon aria-hidden="true" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )

  if (actions === undefined) return card
  /** What opens somewhere else (a tab, a split, the sidebar) keeps the
   *  focus it moved there: the menu does not hand it back to the card. */
  const away = (run: () => void) => () => {
    leaving.current = true
    run()
  }
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
      <ContextMenuContent
        className="w-56"
        aria-label={`${name} actions`}
        onCloseAutoFocus={(event) => {
          if (leaving.current) event.preventDefault()
          leaving.current = false
        }}
      >
        <ContextMenuItem onSelect={away(onOpen)}>
          <ArrowRightIcon aria-hidden="true" />
          Open
        </ContextMenuItem>
        <ContextMenuItem onSelect={away(actions.onOpenBeside)}>
          <SquareSplitHorizontalIcon aria-hidden="true" />
          Open beside
        </ContextMenuItem>
        {actions.onAsk !== undefined ? (
          <ContextMenuItem onSelect={away(actions.onAsk)}>
            <SparklesIcon aria-hidden="true" />
            Ask about this app
          </ContextMenuItem>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={away(actions.onReveal)}>
          <FolderTreeIcon aria-hidden="true" />
          Reveal in Files
        </ContextMenuItem>
        <ContextMenuItem onSelect={actions.onCopyPath}>
          <CopyIcon aria-hidden="true" />
          Copy path
        </ContextMenuItem>
        {actions.onRefreshPreview !== undefined ? (
          <ContextMenuItem onSelect={actions.onRefreshPreview}>
            <ImageIcon aria-hidden="true" />
            Refresh preview
          </ContextMenuItem>
        ) : null}
        {actions.onArchive !== undefined ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={actions.onArchive}>
              {archived ? (
                <ArchiveRestoreIcon aria-hidden="true" />
              ) : (
                <ArchiveIcon aria-hidden="true" />
              )}
              {archived ? 'Unarchive' : 'Archive'}
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** A card while the vault's files are still loading, in the card's shape. */
export function AppCardSkeleton() {
  return (
    <Card className="w-full" aria-hidden="true">
      <CardContent>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-48 w-full" />
          <div className="flex items-center justify-between gap-5">
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-4 w-24" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-4 w-full" />
          </div>
          <Skeleton className="h-8 w-full" />
        </div>
      </CardContent>
    </Card>
  )
}
