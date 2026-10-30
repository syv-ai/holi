/**
 * Vault apps in the registry's shapes (docs/features/vault-apps.md): one
 * surface, `app`, whose tab id is the bundle's path and whose header has the
 * app's reload and log; the claim that makes a bundle one document in the
 * tree; and the nav's Apps group.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { AppWindow, Logs, RotateCw } from 'lucide-react'
import { APP_LOG_FILE, appSuffix, isAppBundlePath } from '@holi/shared'
import { APP_MANIFEST_FILE } from '../shared/manifest'
import { appName } from '../shared/bundle'
import {
  openPathAtom,
  snapshotAtom,
  type PathClaim,
  type RailItem,
  type Surface,
} from '@/plugin-api'
import { IconButton, toast } from '@/primitives'
import { AppFrame } from './AppFrame'
import { AppIcon } from './AppIcon'
import { appInstancesAtom, appOpensAtom } from './apps'
import { appsCap } from './apps-cap'

/** What makes a bundle an app at all: its entry document. */
const ENTRY = 'index.html'

/** A new app's first turn: where it goes and what it is for, in the person's
 *  words. The vault-apps skill holds the rest. */
export const newAppPrompt = (parent: string, ask: string): string =>
  `Build a vault app ${parent === '' ? 'at the root of this vault' : `in \`${parent}/\``}: ${ask}\n\n` +
  'Use the vault-apps skill. Name it for what it does, and open it with ' +
  '`holi apps open` once it is finished.'

/** The app's reload, which remounts its frame, and its log
 *  (`log.local.txt`), opened in a pane beside it. The log button is disabled
 *  until the snapshot holds one: the log is not watched, so a first one shows
 *  on the next rescan. */
function AppHeaderActions({ id }: { id?: string }): React.JSX.Element | null {
  const files = useAtomValue(snapshotAtom).files
  const setReloads = useSetAtom(appOpensAtom)
  const openPath = useSetAtom(openPathAtom)
  if (id === undefined) return null
  const log = `${id}/${APP_LOG_FILE}`
  const hasLog = files.some((f) => f.path === log)
  return (
    <>
      <IconButton
        icon={RotateCw}
        label="Reload this app"
        className="ml-1"
        onClick={() => setReloads((n) => ({ ...n, [id]: (n[id] ?? 0) + 1 }))}
      />
      <IconButton
        icon={Logs}
        label={hasLog ? 'Open this app’s log' : 'No log yet'}
        className="ml-1"
        disabled={!hasLog}
        onClick={() => openPath(log, 'pane')}
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
      run: ({ remote, path }) =>
        void appsCap.init(remote, { path }).catch((e: unknown) => console.warn('[apps]', e)),
    },
  ],
  // The person says what the app is for and the agent writes it, named by
  // it: an empty scaffold is a page nobody knows how to fill. The session
  // comes forward, and the agent opens the app once it is finished.
  create: {
    id: 'app',
    label: 'New app…',
    icon: AppWindow,
    placeholder: 'What should the app do?',
    agent: true,
    run: async ({ parent, name, agent }) => {
      if (agent === null) return null
      const res = await agent.start({ name, prompt: newAppPrompt(parent, name) })
      if (!res.ok) toast(res.message)
      return null
    },
  },
}

export const APP_RAIL: RailItem = { surface: 'app', order: 20, label: 'Apps' }
