import { createRoot } from 'react-dom/client'
import { Provider, createStore, useAtomValue } from 'jotai'
import { Button } from '@/components/ui/button'
import {
  activeRemoteAtom,
  openedRemoteAtom,
  openVaultAtom,
  snapshotAtom,
  subscribeToVault,
  syncStateAtom,
} from '@/state/vaults'
import { switchVaultAtom } from '@/state/vault-switch'
import { registerBuffer } from '@/lib/buffer-registry'
import { trpc } from '@/lib/trpc'
import '@/index.css'

const store = createStore()
subscribeToVault(store)
let buffer = ''
let rejectFlush = false
let releaseBuffer: (() => void) | undefined
const fixture = {
  async select(remote: string) {
    await store.set(switchVaultAtom, remote)
    await store.set(openVaultAtom, remote)
  },
  editBuffer(text: string, fail = false) {
    releaseBuffer?.()
    buffer = text
    rejectFlush = fail
    const remote = store.get(activeRemoteAtom)!
    releaseBuffer = registerBuffer(async () => {
      if (!buffer) return
      if (rejectFlush) throw new Error('fixture write refused')
      await trpc.notes.write.mutate({ remote, path: 'buffer.md', text: buffer })
      buffer = ''
    })
  },
  state() {
    return {
      remote: store.get(activeRemoteAtom),
      ready: store.get(openedRemoteAtom),
      paths: store.get(snapshotAtom).docs.map((doc) => doc.path),
      sync: store.get(syncStateAtom),
      buffer,
    }
  },
}
Object.assign(window, { multiVault: fixture })
function Fixture() {
  const remote = useAtomValue(activeRemoteAtom)
  const snapshot = useAtomValue(snapshotAtom)
  const sync = useAtomValue(syncStateAtom)
  return (
    <main className="flex flex-col gap-6 p-8 text-sm">
      <header className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold">Holi — two live vaults</h1>
        <p>Production vault state, IPC, router and runtime in a private native fixture.</p>
      </header>
      <nav className="flex gap-2">
        {['smoke/vault-a', 'smoke/vault-b'].map((id) => (
          <Button
            key={id}
            variant={remote === id ? 'default' : 'outline'}
            onClick={() => void fixture.select(id)}
          >
            {id}
          </Button>
        ))}
      </nav>
      <section className="flex flex-col gap-3">
        <h2 className="font-semibold">Displayed: {remote}</h2>
        <p>Sync: {sync.kind}</p>
        <ul>
          {snapshot.docs.map((doc) => (
            <li key={doc.path}>{doc.path}</li>
          ))}
        </ul>
      </section>
    </main>
  )
}
createRoot(document.getElementById('root')!).render(
  <Provider store={store}>
    <Fixture />
  </Provider>,
)
