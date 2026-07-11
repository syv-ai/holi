import type { SyncStatus } from '@holi/shared'
import { atom, useAtomValue } from 'jotai'

const syncStatusAtom = atom<SyncStatus>('offline')

export function App() {
  const status = useAtomValue(syncStatusAtom)
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 bg-neutral-950 text-neutral-100">
      <h1 className="text-3xl font-semibold tracking-tight">Holi</h1>
      <p className="text-sm text-neutral-400">sync: {status}</p>
    </div>
  )
}
