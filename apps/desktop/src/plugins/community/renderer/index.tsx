/**
 * Community plugins' renderer side (docs/features/community-plugins.md): a
 * file a running plugin opens shows in its tab, the settings tab installs and
 * switches them, and a vault that uses one this machine cannot run yet says
 * so under the file tree.
 */
import { atom, useAtomValue, useSetAtom, useStore } from 'jotai'
import { useState } from 'react'
import { opensPath } from '@holi/shared'
import { activeRemoteAtom, openDialogAtom, type PathClaim, type RendererPlugin } from '@/plugin-api'
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

/** One claim over every running plugin's files. */
const claimsAtom = atom((get): readonly PathClaim[] => {
  const running = (get(rowsAtom)?.rows ?? []).filter((r) => r.running)
  if (running.length === 0) return []
  return [{ match: (path) => running.some((r) => opensPath(r, path)), view: PluginFrame }]
})

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
  sidebarSection: WaitingNotice,
  settingsSections: [
    {
      id: 'community-plugins',
      label: 'Community plugins',
      headings: [
        { id: 'this-vault', title: 'This vault' },
        { id: 'on-this-machine', title: 'On this machine' },
        { id: 'add-a-plugin', title: 'Add a plugin' },
      ],
      files: ['.holi/plugins'],
      Component: ({ remote }) => <PluginsSettings remote={remote} />,
    },
  ],
  vault: (remote, store) => followRows(remote, store),
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
