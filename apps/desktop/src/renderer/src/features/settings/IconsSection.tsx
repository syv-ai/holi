/**
 * Every icon this vault has set, in one place (D82).
 *
 * **The map had no view.** An icon is set from a tree row's "Edit Icon…", one
 * path at a time, and the only way to see the whole map was to open
 * `.holi/settings/icons.yaml` and read JSON. That is fine for setting one and
 * useless for the thing a list is actually for: noticing that six of them point
 * at files you renamed months ago.
 *
 * **Icons rot on rename, by design** (D82: the map is keyed by path and there is
 * no second source to lose to). So this marks an entry whose path is no longer
 * in the vault rather than hiding it — a stale entry is invisible everywhere
 * else, and this list is the only place it can be cleaned up.
 *
 * **Reuses the tree's own dialog** rather than growing a second editor. The
 * dialog registry lives in `state/`, which is not a feature, so summoning
 * `edit-icon` from here crosses no boundary and cannot drift from what the tree
 * does: same validator, same writer, same "an empty field means no entry".
 */
import { useMemo } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { ICONS_FILE } from '@holi/shared'
import { Button, Tooltip } from '@/primitives'
import { SettingsList, SettingsNote } from './settings-ui'
import { trpc } from '@/lib/trpc'
import { openDialogAtom } from '@/state/dialogs'
import { openPinned, workspaceAtom } from '@/state/panes'
import { activeRemoteAtom, snapshotAtom } from '@/state/vaults'

export function IconsSection(): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const snapshot = useAtomValue(snapshotAtom)
  const openDialog = useSetAtom(openDialogAtom)
  const setWorkspace = useSetAtom(workspaceAtom)

  /** Every path the vault actually holds, so a stale entry can be named as one.
   *  Directories included: the map decorates folders too. */
  const present = useMemo(() => {
    const paths = new Set<string>(snapshot.dirs)
    for (const doc of snapshot.docs) paths.add(doc.path)
    for (const file of snapshot.files) paths.add(file.path)
    return paths
  }, [snapshot])

  const entries = useMemo(
    () => Object.entries(snapshot.icons).sort(([a], [b]) => a.localeCompare(b)),
    [snapshot.icons],
  )

  const openMap = (): void => setWorkspace((w) => openPinned(w, ICONS_FILE))

  const edit = (path: string, current: string): void => {
    if (remote === null) return
    openDialog({ id: 'edit-icon', size: 'sm', remote, path, current, onOpenMap: openMap })
  }

  const clear = (path: string): void => {
    if (remote === null) return
    // `undefined`, which is what removes the entry — the same call the dialog
    // makes when you empty its field.
    void trpc.notes.setIcon.mutate({ remote, path, emoji: undefined })
  }

  if (entries.length === 0) {
    return (
      <SettingsNote>
        Nothing has an icon yet. Right-click a note, a folder or a file in the tree and choose
        &ldquo;Edit Icon…&rdquo;.
      </SettingsNote>
    )
  }

  return (
    <SettingsList>
      {entries.map(([path, emoji]) => {
        const stale = !present.has(path)
        return (
          <div key={path} className="flex items-center gap-3 py-2" data-icon-path={path}>
            {/* `text-base` is the one size override in this tab that is not
                typography: an emoji at `text-xs` is unreadable, and this is the
                glyph the row exists to show. */}
            <span className="w-5 shrink-0 text-center text-base leading-none" aria-hidden="true">
              {emoji}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium">{path}</span>
              {stale && (
                <span className="text-[11px] text-muted-foreground">
                  no longer in this vault — renamed or deleted
                </span>
              )}
            </span>
            <Tooltip content={`change the icon for ${path}`}>
              <Button variant="ghost" size="xs" onClick={() => edit(path, emoji)}>
                Edit
              </Button>
            </Tooltip>
            <Tooltip content={`remove this entry from ${ICONS_FILE}`}>
              <Button
                variant="ghost"
                size="xs"
                aria-label={`clear the icon for ${path}`}
                onClick={() => clear(path)}
              >
                Clear
              </Button>
            </Tooltip>
          </div>
        )
      })}
    </SettingsList>
  )
}
