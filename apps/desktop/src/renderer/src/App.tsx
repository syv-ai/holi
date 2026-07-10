import type { SyncStatus } from '@holi/shared'
import { atom, useAtom, useAtomValue } from 'jotai'

const syncStatusAtom = atom<SyncStatus>('offline')
const pingAtom = atom('…')

export function App() {
  const [ping, setPing] = useAtom(pingAtom)
  const status = useAtomValue(syncStatusAtom)
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 bg-neutral-950 text-neutral-100">
      <h1 className="text-3xl font-semibold tracking-tight">Holi</h1>
      <p className="text-sm text-neutral-400">sync: {status}</p>
      <button
        className="rounded bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700"
        onClick={async () => setPing(await window.holi.ping())}
      >
        ping main → {ping}
      </button>
    </div>
  )
}
