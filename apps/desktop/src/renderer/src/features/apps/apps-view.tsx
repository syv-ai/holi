/**
 * Apps: every vault app, most recently opened first, from the sidebar's row
 * under Search, each on a card (`app-card.tsx`) with its preview and its
 * menu. Read off the registry's `app` surface (its `instances`, label, icon,
 * `describe`, `preview`, `archived` and `archive`), so core never reaches
 * into the apps plugin, and the page says so when that plugin is off. An
 * archived app leaves the grid for the Archived view, behind the header's
 * toggle, until it is brought back.
 */
import { useMemo, useState } from 'react'
import { atom, useAtomValue, useSetAtom } from 'jotai'
import { AppWindowIcon, ArchiveIcon, PlusIcon, SettingsIcon } from 'lucide-react'
import { toast } from 'sonner'

import { IconStackEmpty } from '@/components/ui/icon-stack-empty'
import { Toggle } from '@/components/ui/toggle'
import { ViewHeader, ViewHeaderTitle } from '@/composites/view-header'
import { canStartConversationAtom, startConversationAtom } from '@/state/agents-slots'
import { surfacesAtom } from '@/state/plugins'
import { revealInFilesAtom } from '@/state/reveal-in-files'
import { openTabAtom } from '@/state/shell-tabs'
import { activeRemoteAtom, snapshotAtom, snapshotLoadedAtom } from '@/state/vaults'
import { AppCard, AppCardSkeleton, type AppCardActions } from './app-card'
import { useNewApp } from './use-new-app'

const NO_APPS = atom<readonly string[]>([])
const NO_VERSIONS = atom<Readonly<Record<string, number>>>({})
const NO_ARCHIVE = atom(null, async () => {})
const NO_REFRESH = atom(null, async (_get, _set, _id: string) => {})

export function AppsView({ onOpen }: { onOpen: (path: string) => void }) {
  const surface = useAtomValue(surfacesAtom).get('app')
  const live = useAtomValue(surface?.instances ?? NO_APPS)
  const archivedApps = useAtomValue(surface?.archived ?? NO_APPS)
  const versions = useAtomValue(surface?.previewVersions ?? NO_VERSIONS)
  const archive = useSetAtom(surface?.archive ?? NO_ARCHIVE)
  const refreshPreview = useSetAtom(surface?.refreshPreview ?? NO_REFRESH)
  const canAsk = useAtomValue(canStartConversationAtom)
  const startConversation = useSetAtom(startConversationAtom)
  const reveal = useSetAtom(revealInFilesAtom)
  /** The Archived view, while there is anything in it. */
  const [showArchived, setShowArchived] = useState(false)
  const inArchive = showArchived && archivedApps.length > 0
  const apps = inArchive ? archivedApps : live
  /** Every app, whichever view: what the stamps are needed for. */
  const all = useMemo(() => [...live, ...archivedApps], [live, archivedApps])
  const remote = useAtomValue(activeRemoteAtom)
  const snapshot = useAtomValue(snapshotAtom)
  const loaded = useAtomValue(snapshotLoadedAtom)
  /** Each app's newest file mtime, so its card reads its description again
   *  when the app changes. */
  const stamps = useMemo(() => {
    const out = new Map<string, string>()
    for (const app of all) {
      let newest = ''
      for (const file of snapshot.files) {
        if (file.path.startsWith(`${app}/`) && file.updatedAt > newest) newest = file.updatedAt
      }
      out.set(app, newest)
    }
    return out
  }, [all, snapshot.files])
  const openTab = useSetAtom(openTabAtom)
  /** The apps plugin's New app, as the Files menu offers it. */
  const { create: newApp, creating } = useNewApp(onOpen)

  const labelOf = (path: string) =>
    surface === undefined
      ? path
      : typeof surface.label === 'function'
        ? surface.label(path)
        : surface.label

  /** Archive or Unarchive, and the toast that undoes it. Nothing is
   *  deleted: one line of the app's manifest changes, and syncs. */
  async function setArchived(path: string, archived: boolean, undo = true) {
    const name = labelOf(path)
    try {
      await archive({ id: path, archived })
    } catch {
      toast.error(
        archived
          ? `Couldn't archive ${name}. Check its app.yaml, then try again.`
          : `Couldn't bring ${name} back. Try again.`,
      )
      return
    }
    // The undo of an archive is not itself offered back as one more toast.
    if (!undo) return
    toast(archived ? `${name} archived` : `${name} is back in Apps`, {
      duration: Infinity,
      closeButton: true,
      action: {
        label: 'Undo',
        onClick: () => void setArchived(path, !archived, false),
      },
    })
  }

  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path)
      toast.success('Path copied', { description: path })
    } catch {
      toast.error("Couldn't copy the path. Try again.")
    }
  }

  /** A chat about the app, beside this page: the new-session page with the
   *  app as a chip in its composer. */
  async function ask(path: string) {
    const res = await startConversation({
      text: '',
      context: [{ kind: 'app', path, name: labelOf(path) }],
      beside: true,
    })
    if (!res.ok) toast.error(`Couldn't start the chat. ${res.message}`)
  }

  function actionsFor(path: string): AppCardActions {
    return {
      onOpenBeside: () => openTab({ kind: 'vault-app', path }, { beside: true }),
      onAsk: canAsk ? () => void ask(path) : undefined,
      onReveal: () => reveal(path),
      onCopyPath: () => void copyPath(path),
      onRefreshPreview:
        surface?.refreshPreview === undefined
          ? undefined
          : () =>
              void refreshPreview(path).catch(() =>
                toast.error("Couldn't refresh the preview. Try again."),
              ),
      onArchive:
        surface?.archive === undefined ? undefined : () => void setArchived(path, !inArchive),
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewHeader>
        <ViewHeaderTitle
          title={inArchive ? 'Archived apps' : 'Apps'}
          badge={
            apps.length > 0 ? (
              <span className="text-muted-foreground text-xs tabular-nums">{apps.length}</span>
            ) : undefined
          }
        />
        {archivedApps.length > 0 ? (
          <Toggle
            size="sm"
            variant="outline"
            className="ms-auto"
            pressed={inArchive}
            onPressedChange={setShowArchived}
            aria-label={inArchive ? 'Show the apps' : 'Show the archived apps'}
          >
            <ArchiveIcon aria-hidden="true" />
            Archived
            <span className="text-muted-foreground tabular-nums">{archivedApps.length}</span>
          </Toggle>
        ) : null}
      </ViewHeader>

      <div className="flex min-h-0 flex-1 flex-col overflow-auto px-4 py-4 lg:px-6">
        {surface === undefined ? (
          <IconStackEmpty
            icon={AppWindowIcon}
            title="Vault apps are off"
            description="Turn on the Vault apps plugin in Settings to open the apps in this vault."
            action={{
              label: 'Open Settings',
              icon: SettingsIcon,
              onClick: () => openTab({ kind: 'settings' }),
            }}
          />
        ) : !loaded && remote !== null ? (
          <ul
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
            aria-label="Loading apps"
          >
            {[0, 1, 2].map((n) => (
              <li key={n}>
                <AppCardSkeleton />
              </li>
            ))}
          </ul>
        ) : apps.length === 0 && archivedApps.length > 0 ? (
          <IconStackEmpty
            icon={ArchiveIcon}
            title="Every app is archived"
            description="Archived apps stay in the vault and open from the files tree. Bring one back to list it here again."
            action={{
              label: 'Show archived',
              icon: ArchiveIcon,
              onClick: () => setShowArchived(true),
            }}
          />
        ) : apps.length === 0 ? (
          <IconStackEmpty
            icon={AppWindowIcon}
            title="No apps yet"
            description="An app is a small web page in the vault, like a dashboard or a CSV explorer. Start one here, or ask the agent to build it."
            action={
              newApp === undefined
                ? undefined
                : {
                    label: creating ? 'Creating…' : 'New app',
                    icon: PlusIcon,
                    disabled: creating || newApp === undefined,
                    onClick: () => void newApp?.(),
                  }
            }
          />
        ) : (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {apps.map((path) => {
              const describe = surface.describe
              const preview = surface.preview
              return (
                <li key={path}>
                  <AppCard
                    path={path}
                    name={labelOf(path)}
                    icon={surface.icon}
                    stamp={stamps.get(path) ?? ''}
                    describe={
                      describe === undefined || remote === null
                        ? undefined
                        : () => describe(remote, path)
                    }
                    preview={
                      preview === undefined || remote === null
                        ? undefined
                        : () => preview(remote, path)
                    }
                    previewVersion={versions[path] ?? 0}
                    archived={inArchive}
                    onOpen={() => onOpen(path)}
                    actions={actionsFor(path)}
                  />
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
