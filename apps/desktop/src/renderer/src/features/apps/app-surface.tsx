/**
 * Vault apps in the registry's shapes (docs/features/vault-apps.md): one
 * surface, `app`, whose tab id is the bundle's path; the claim that makes a
 * bundle one document in the tree; and the nav's Apps group. Apps are still
 * core, so `components/core-surfaces.tsx` installs these beside core's own.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { AppWindow, Logs, RotateCw } from 'lucide-react'
import {
  APP_LOG_FILE,
  APP_MANIFEST_FILE,
  APP_SUFFIX,
  appName,
  appSuffix,
  isAppBundlePath,
} from '@holi/shared'
import { AppIcon } from '@/composites/file-icons'
import { trpc } from '@/lib/trpc'
import { joinPath } from '@/lib/tree-paths'
import type { PathClaim, RailItem, Surface } from '@/plugin-api/types'
import { IconButton } from '@/primitives'
import { appInstancesAtom } from '@/state/apps'
import { appOpensAtom, openInNewPane, workspaceAtom } from '@/state/panes'
import { snapshotAtom } from '@/state/vaults'
import { AppFrame } from './AppFrame'

/** What makes a bundle an app at all: its entry document. */
const ENTRY = 'index.html'

/** The app's reload, which remounts its frame, and its log
 *  (`log.local.txt`), opened in a pane beside it. The log button is disabled
 *  until the snapshot holds one: the log is not watched, so a first one shows
 *  on the next rescan. */
function AppHeaderActions({ id }: { id?: string }): React.JSX.Element | null {
  const files = useAtomValue(snapshotAtom).files
  const setReloads = useSetAtom(appOpensAtom)
  const setWorkspace = useSetAtom(workspaceAtom)
  if (id === undefined) return null
  const log = `${id}/${APP_LOG_FILE}`
  const hasLog = files.some((f) => f.path === log)
  return (
    <>
      <IconButton
        icon={RotateCw}
        label="reload this app"
        className="ml-1"
        onClick={() => setReloads((n) => ({ ...n, [id]: (n[id] ?? 0) + 1 }))}
      />
      <IconButton
        icon={Logs}
        label={hasLog ? "open this app's log" : 'no log yet'}
        className="ml-1"
        disabled={!hasLog}
        onClick={() => setWorkspace((w) => openInNewPane(w, { kind: 'note', path: log }))}
      />
    </>
  )
}

function AppSurface({ id }: { id?: string }): React.JSX.Element | null {
  return id === undefined ? null : <AppFrame path={id} />
}

export const APP_SURFACE: Surface = {
  kind: 'app',
  // Without an id, the noun: the tree's "Show App Files" uses it.
  label: (id) => (id === undefined ? 'App' : appName(id)),
  icon: AppIcon,
  render: AppSurface,
  instances: appInstancesAtom,
  headerActions: AppHeaderActions,
}

export const APP_CLAIM: PathClaim = {
  match: isAppBundlePath,
  // A bundle with its entry document is an app. The manifest is the
  // "finished" marker, written last: until it is there the app is a draft,
  // which shows its files rather than a half-written page.
  folder: {
    surface: 'app',
    entry: ENTRY,
    ready: (path, has) => has(`${path}/${APP_MANIFEST_FILE}`),
  },
  // Named without its `.app`, as a note is without its `.md`. A personal app
  // keeps its `.local.app` through a rename: dropping it would publish it.
  decorate: { icon: AppIcon, name: appName, suffix: appSuffix },
  rowMenu: [
    {
      // It has no manifest, so there is nothing to open yet. This writes the
      // manifest and nothing else; the watcher brings the change in.
      label: 'Finish this app',
      when: (path, snapshot) => {
        const has = (p: string) => snapshot.files.some((f) => f.path === p)
        return has(`${path}/${ENTRY}`) && !has(`${path}/${APP_MANIFEST_FILE}`)
      },
      run: ({ remote, path }) => void trpc.apps.register.mutate({ remote, path }),
    },
  ],
  // `holi apps init`'s scaffold. Opening its entry expands the bundle.
  create: {
    id: 'app',
    label: 'New App',
    icon: AppWindow,
    placeholder: 'app name',
    run: async ({ remote, parent, name }) => {
      const bundle = joinPath(parent, name.endsWith(APP_SUFFIX) ? name : `${name}${APP_SUFFIX}`)
      const result = await trpc.apps.register.mutate({ remote, path: bundle })
      return result.ok ? `${bundle}/${ENTRY}` : null
    },
  },
}

export const APP_RAIL: RailItem = { surface: 'app', order: 20, label: 'Apps' }
