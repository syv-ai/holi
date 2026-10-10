/**
 * Community plugins' renderer side (docs/features/community-plugins.md): a
 * file a running plugin opens shows in its tab, the settings tab installs and
 * switches them, and a vault that uses one this machine cannot run yet says
 * so under the file tree.
 */
import { atom, useAtomValue, useSetAtom, useStore } from 'jotai'
import { useState } from 'react'
import { Puzzle } from 'lucide-react'
import { isPluginFolder, opensPath } from '@holi/shared'
import {
  activeRemoteAtom,
  openDialogAtom,
  openPathAtom,
  type PathClaim,
  type PluginStore,
  type RendererPlugin,
  type Surface,
} from '@/plugin-api'
import { Button } from '@/primitives'
import { COMMUNITY_INFO } from '../info'
import { askToRun, installAndAsk, type InstallFlow } from './install-flow'
import { PluginFrame } from './PluginFrame'
import { PluginsSettings } from './PluginsSettings'
import {
  followRows,
  rowsAtom,
  serversAtom,
  setupLogsAtom,
  type PluginRow,
  type ServerState,
} from './state'

/** The surface a plugin's folder documents open in, one tab per folder. */
const SURFACE = 'plugin-document'

/** A folder document's name: without its suffix, as an app's is without
 *  `.app` and a note's without `.md`. */
const documentName = (path: string, suffix: string) =>
  path.slice(path.lastIndexOf('/') + 1).slice(0, -suffix.length)

/** The store, held while a vault is open, for row menu items, which are not
 *  given one. */
let openStore: PluginStore | null = null

/** One claim over every running plugin's files, and one per plugin that opens
 *  folders, which makes each such folder one document in the tree. */
const claimsAtom = atom((get): readonly PathClaim[] => {
  const running = (get(rowsAtom)?.rows ?? []).filter((r) => r.running)
  const files = running.filter((r) => r.opens.length > 0)
  const claims: PathClaim[] =
    files.length === 0
      ? []
      : [{ match: (path) => files.some((r) => opensPath(r, path)), view: PluginFrame }]
  for (const row of running) {
    const folder = row.folder
    if (folder === undefined) continue
    claims.push({
      match: (path) => isPluginFolder(row, path),
      folder: { surface: SURFACE, entry: folder.entry },
      decorate: {
        icon: Puzzle,
        name: (path) => documentName(path, folder.suffix),
        suffix: () => folder.suffix,
      },
      rowMenu: [
        {
          // The live document is the default; its source is one click away.
          label: `Open ${folder.entry} as Text`,
          run: ({ path }) => openStore?.set(openPathAtom, `${path}/${folder.entry}`, 'pinned'),
        },
      ],
    })
  }
  return claims
})

/** A folder document's tab: the plugin's server for it. */
const DOCUMENT_SURFACE: Surface = {
  kind: SURFACE,
  label: (id) =>
    id === undefined ? 'Document' : id.slice(id.lastIndexOf('/') + 1).replace(/\.[^.]+$/, ''),
  icon: Puzzle,
  render: ({ id }) => (id === undefined ? null : <PluginFrame path={id} />),
  unlisted: true,
}

/** Plugins the vault turns on that cannot run here yet. */
const waitingAtom = atom((get): readonly PluginRow[] =>
  (get(rowsAtom)?.rows ?? []).filter((r) => r.on && r.status !== 'ready'),
)

/**
 * The notice a vault's plugins raise on a machine without them: one line per
 * plugin and its next step. Never an install by itself; the dialog asks.
 */
function WaitingNotice(): React.JSX.Element | null {
  const waiting = useAtomValue(waitingAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const store = useStore()
  const openDialog = useSetAtom(openDialogAtom)
  const [error, setError] = useState<string | null>(null)
  if (waiting.length === 0 || remote === null) return null
  const flow: InstallFlow = {
    remote,
    store,
    openDialog: (render) => openDialog({ id: 'plugin', size: 'md', render }),
  }
  const next = async (row: PluginRow) => {
    setError(null)
    if (row.pin !== null && (row.status === 'not-installed' || row.status === 'pin-differs'))
      setError(
        await installAndAsk(flow, { repo: row.pin.repo, version: row.pin.version, id: row.id }),
      )
    else askToRun(flow, row)
  }
  return (
    <div className="grid gap-1.5 px-3 py-2 text-[11px] text-muted-foreground">
      {waiting.map((row) => (
        <div key={row.id} className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate">
            This vault uses <span className="text-foreground">{row.name}</span>
            {row.pin !== null && <> {row.pin.version}</>}
          </span>
          {(row.pin !== null || row.install !== null) && (
            <Button size="xs" variant="secondary" onClick={() => void next(row)}>
              {row.status === 'not-installed' ? 'Install…' : 'Set up…'}
            </Button>
          )}
        </div>
      ))}
      {error !== null && <p className="text-amber-400">{error}</p>}
    </div>
  )
}

export const communityRenderer: RendererPlugin = {
  info: COMMUNITY_INFO,
  claims: claimsAtom,
  surfaces: [DOCUMENT_SURFACE],
  sidebarSection: WaitingNotice,
  settingsSections: [
    {
      id: 'community-plugins',
      label: 'Community plugins',
      within: 'plugins',
      headings: [],
      files: ['.holi/plugins'],
      Component: ({ remote }) => <PluginsSettings remote={remote} />,
    },
  ],
  vault: (remote, store) => {
    openStore = store
    const stop = followRows(remote, store)
    return () => {
      stop()
      openStore = null
    }
  },
  events: {
    server: ({ remote, payload }, store) => {
      if (remote !== store.get(activeRemoteAtom)) return
      const { path, state } = payload as { path: string; state: ServerState }
      store.set(serversAtom, (all) => ({ ...all, [path]: state }))
    },
    'setup-log': ({ remote, payload }, store) => {
      if (remote !== store.get(activeRemoteAtom)) return
      const { id, line } = payload as { id: string; line: string | null }
      store.set(setupLogsAtom, (all) => ({
        ...all,
        // A null line is setup beginning: its output starts over.
        [id]: line === null ? [] : [...(all[id] ?? []), line].slice(-500),
      }))
    },
  },
}
