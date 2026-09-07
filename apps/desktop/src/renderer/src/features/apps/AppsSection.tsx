/**
 * The sidebar's list of vault apps, and the whole of what you can do to one
 * without asking the agent.
 *
 * **Hidden entirely when the vault has no apps**, heading included. That is the
 * rule the agenda and mail chips already follow: a launcher whose only
 * destination is "go make one" is a dead end wearing the clothes of a feature,
 * and an app is made by asking the agent, not by clicking here.
 *
 * Two kinds of row, and the second is the point of the first being a list at
 * all. A **registered** app has a manifest and opens. An **unregistered** one is
 * a directory with an entry document and no manifest — half-written, or written
 * by hand by someone who did not know the manifest was the marker. It used to be
 * computed (`unregisteredAppIdsAtom`) and shown nowhere, which is the failure
 * mode slice 1 proved worst: the app does not appear and there is nowhere to
 * look. It now appears, dimmed, with a menu item that finishes it.
 *
 * **The rows are styled as tree rows, not as chips.** They used to be `Button
 * size="xs"` wearing the chip look — 12px, `font-medium`, 24px tall, a 12px
 * glyph — which read as a fourth chip row stuck under the tree. They are the
 * same kind of thing as a file: something the vault holds, that you click to
 * open. So they take the tree row's metrics verbatim (22px, `text-sm`,
 * `font-normal`, a 14px glyph in the same `w-4` column, `text-brand` when
 * open), and the icons line up with the tree's root-level file icons.
 *
 * The menu deliberately does NOT mirror the file tree's. Most of that menu —
 * New File, Cut, Copy, Paste, Duplicate — is about paths, and an app is not a
 * path: it is a directory whose name is also a `holi-app://` host. Duplicating
 * one would need a second id nobody chose; pasting into one is just editing a
 * file, which the tree already does better. What is left is what actually has a
 * meaning at the level of "an app": open it, edit its source, rename it, delete
 * it, find it on disk.
 */
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { AppWindow, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Input,
  Tooltip,
} from '@/primitives'
import { DeleteConfirm } from '@/composites'
import { APPS_DIR, isValidAppId } from '@holi/shared'
import {
  appDirIdsAtom,
  appsSectionOpenAtom,
  appFilesAtom,
  appIdsAtom,
  deleteAppAtom,
  registerAppAtom,
  renameAppAtom,
  unregisteredAppIdsAtom,
} from '../../state/apps'
import { activeTab, openApp, openInNewPane, openPinned, workspaceAtom } from '../../state/panes'
import { revealPathAtom } from '../../state/reveal'
import { activeRemoteAtom, backrefsForMany, vaultsAtom } from '../../state/vaults'

const ID_RULE = 'lowercase letters, digits and dashes only'

/** The app's own root on disk, relative to the vault. */
const dirOf = (appId: string): string => `${APPS_DIR}/${appId}`
const entryOf = (appId: string): string => `${dirOf(appId)}/index.html`

/**
 * Why this id cannot be used, or null when it can.
 *
 * Main checks the same things against the filesystem and is the authority — it
 * has to be, since a teammate's pull can create a directory between the keypress
 * and the mutation. This exists so the common refusals land under the field
 * instead of after a round-trip.
 */
function rejectId(next: string, current: string, taken: Set<string>): string | null {
  if (next === current) return null
  if (!isValidAppId(next)) return `an app id is ${ID_RULE}`
  if (taken.has(next)) return `${next} already exists`
  return null
}

export function AppsSection(): React.JSX.Element | null {
  const appIds = useAtomValue(appIdsAtom)
  const unregistered = useAtomValue(unregisteredAppIdsAtom)
  const takenIds = useAtomValue(appDirIdsAtom)
  const appFiles = useAtomValue(appFilesAtom)
  const activeRemote = useAtomValue(activeRemoteAtom)
  const vaults = useAtomValue(vaultsAtom)
  const [workspace, setWorkspace] = useAtom(workspaceAtom)
  const revealPath = useSetAtom(revealPathAtom)
  const renameApp = useSetAtom(renameAppAtom)
  const registerApp = useSetAtom(registerAppAtom)
  const deleteApp = useSetAtom(deleteAppAtom)
  const getBackrefs = useSetAtom(backrefsForMany)

  /** The app whose row is currently an input, plus the last refusal to show. */
  const [renaming, setRenaming] = useState<{ appId: string; error: string | null } | null>(null)
  const [confirming, setConfirming] = useState<{
    appId: string
    refs: { path: string; count: number }[]
  } | null>(null)
  const [open, setOpen] = useAtom(appsSectionOpenAtom)

  if (appIds.length === 0 && unregistered.length === 0) return null

  const vaultPath = vaults.find((v) => v.remote === activeRemote)?.path ?? null
  const absOf = (rel: string) => (vaultPath === null ? rel : `${vaultPath}/${rel}`)

  const commitRename = (from: string, raw: string) => {
    const to = raw.trim()
    const reason = rejectId(to, from, takenIds)
    if (reason !== null) {
      setRenaming({ appId: from, error: reason })
      return
    }
    setRenaming(null)
    void renameApp({ from, to }).then((result) => {
      // A refusal from main — the id was taken between keypress and mutation, or
      // the directory moved under us. Put the field back with the reason.
      if (!result.ok) setRenaming({ appId: from, error: result.error })
    })
  }

  const startDelete = (appId: string) => {
    const files = appFiles.get(appId) ?? []
    void getBackrefs(files).then((refs) => setConfirming({ appId, refs }))
  }

  const menuFor = (appId: string, registered: boolean) => (
    <ContextMenuContent
      // Keep focus in the rename field this can open, instead of Radix pulling
      // it back to the row when the menu closes.
      onCloseAutoFocus={(e) => e.preventDefault()}
    >
      {registered ? (
        <>
          <ContextMenuItem onSelect={() => setWorkspace((w) => openApp(w, appId))}>
            Open
          </ContextMenuItem>
          {/* Recorded in vault-apps.md as "not built: a pane system, not a menu
              item". The pane system exists now, so it is a menu item. */}
          <ContextMenuItem
            onSelect={() => setWorkspace((w) => openInNewPane(w, { kind: 'app', appId }))}
          >
            Open in a New Pane
          </ContextMenuItem>
        </>
      ) : (
        // The one action that changes what this row *is*. It writes the manifest
        // and nothing else, so a half-written app becomes a finished one without
        // a round-trip through the agent.
        <ContextMenuItem onSelect={() => void registerApp(appId)}>Finish this app</ContextMenuItem>
      )}
      {/* Opening the tab is only half of it: the file lives under `.holi/apps/`,
          so in most vaults it is not in the explorer at all until the reveal
          puts it there (#18). */}
      <ContextMenuItem
        onSelect={() => {
          const entry = entryOf(appId)
          setWorkspace((w) => openPinned(w, entry))
          revealPath(entry)
        }}
      >
        Edit Source
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => setRenaming({ appId, error: null })}>Rename…</ContextMenuItem>
      <ContextMenuItem variant="destructive" onSelect={() => startDelete(appId)}>
        Delete
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(absOf(dirOf(appId)))}>
        Copy Path
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => void window.holi.openPath(absOf(dirOf(appId)))}>
        Reveal in Finder
      </ContextMenuItem>
    </ContextMenuContent>
  )

  /** The open app, so its row tints like the tree's open file does. */
  const openAppId = (() => {
    const tab = activeTab(workspace)
    return tab?.kind === 'app' ? tab.appId : null
  })()

  const row = (appId: string, registered: boolean) => {
    if (renaming?.appId === appId) {
      return (
        <RenameRow
          key={appId}
          appId={appId}
          error={renaming.error}
          onCommit={(value) => commitRename(appId, value)}
          onCancel={() => setRenaming(null)}
        />
      )
    }
    return (
      <ContextMenu key={appId}>
        {/* Tooltip OUTSIDE the trigger, not inside it: both are `asChild` and
            clone their single child, so the outer one must be the one holding a
            Radix element. Inverted, `ContextMenuTrigger` would try to pass a ref
            to `Tooltip`, which is a plain function component. Empty content
            passes straight through, so a registered row gets no tooltip. */}
        <Tooltip
          content={registered ? '' : `${appId} has no app.yaml yet — right-click to finish it`}
        >
          <ContextMenuTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              className={[
                // A tree row's metrics, overriding the chip ones `size="xs"`
                // brings: its own height, radius, 12px text, medium weight and
                // 12px glyph would otherwise make this a chip under the tree.
                "h-[22px] w-full justify-start gap-1 rounded px-2 text-sm font-normal [&_svg:not([class*='size-'])]:size-3.5",
                appId === openAppId
                  ? 'text-brand'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                registered ? '' : 'italic opacity-60',
              ].join(' ')}
              // An unregistered app has no manifest, so `openAppOp` refuses it —
              // a row that opens a refusal is worse than a row that does not open.
              onClick={registered ? () => setWorkspace((w) => openApp(w, appId)) : undefined}
            >
              <IconColumns appId={appId} />
              <span className="min-w-0 flex-1 truncate text-left">{appId}</span>
            </Button>
          </ContextMenuTrigger>
        </Tooltip>
        {menuFor(appId, registered)}
      </ContextMenu>
    )
  }

  return (
    // Fills its panel: a header that never scrolls, and a list that does. The
    // header is also what stays visible when the panel is collapsed to it, so
    // `shrink-0` here is load-bearing rather than tidiness.
    <div className="flex h-full flex-col overflow-hidden">
      {/* The whole header is the toggle, not a chevron you have to hit — the
          same target VS Code gives a sidebar section. The sidebar has ONE type
          size, `text-sm`, so the heading takes it: it started at 10px uppercase,
          which is the settings panel's system, and a heading a few pixels under
          the rows it labels reads as a mistake rather than as a hierarchy.
          `font-medium` and the muted tint are what mark it as a heading.
          Lowercase, like the chips: nothing else in this sidebar shouts. */}
      <Button
        variant="ghost"
        size="xs"
        aria-expanded={open}
        className="h-[22px] w-full shrink-0 justify-start gap-1 rounded-none px-2 text-sm font-medium text-muted-foreground hover:bg-accent/60"
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight
          className="size-3.5 transition-transform"
          style={{ transform: open ? 'rotate(90deg)' : 'none' }}
          aria-hidden="true"
        />
        apps
      </Button>
      {/* No horizontal padding on the list: each row carries its own `px-2`, the
          way a tree row does, so a hover highlight spans the sidebar rather than
          floating inside an inset box — and the rows sit at the tree's indent
          instead of 8px further in. */}
      <div className="min-h-0 flex-1 overflow-y-auto pb-1">
        {appIds.map((appId) => row(appId, true))}
        {unregistered.map((appId) => row(appId, false))}
      </div>

      {confirming && (
        <DeleteConfirm
          label={dirOf(confirming.appId)}
          refs={confirming.refs}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const appId = confirming.appId
            setConfirming(null)
            void deleteApp(appId)
          }}
        />
      )}
    </div>
  )
}

/** The row as an editable field. Seeded with the current id rather than empty:
 *  a rename is usually a small edit to a name that already exists, and clearing
 *  it would make the common case the expensive one. */
function RenameRow({
  appId,
  error,
  onCommit,
  onCancel,
}: {
  appId: string
  error: string | null
  onCommit: (value: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(appId)
  return (
    <div className="flex flex-col">
      <div className="flex h-[22px] items-center gap-1 px-2">
        <IconColumns appId={appId} />
        <Input
        autoFocus
        aria-label={`rename ${appId}`}
        className="h-[22px] min-w-0 flex-1 rounded border-primary bg-background px-1 py-0 text-sm shadow-none"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Enter' && value.trim()) onCommit(value)
        }}
        // No blur-to-cancel while a refusal is showing: the click that dismissed
        // it would also throw away the reason it was refused.
        onBlur={error === null ? onCancel : undefined}
        />
      </div>
      {error !== null && <p className="pb-0.5 pl-10 pr-2 text-[10px] text-destructive">{error}</p>}
    </div>
  )
}

/**
 * The two fixed-width slots a tree row starts with: the chevron column (empty —
 * an app has nothing to expand, exactly like a file) and the glyph. Keeping the
 * empty one is what lines an app's icon up with the tree's root-level file
 * icons directly above it, instead of half a column to the left.
 */
function IconColumns({ appId }: { appId: string }): React.JSX.Element {
  return (
    <>
      <span className="w-4 shrink-0" aria-hidden="true" />
      <span className="flex w-4 shrink-0 justify-center">
        <AppWindow aria-hidden="true" data-app-icon={appId} />
      </span>
    </>
  )
}
