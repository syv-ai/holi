/**
 * The instrument panel — a tracer bullet, not a product surface.
 *
 * Plan 4's job is the main process: the watcher, the commit loop, the pull
 * loop, the IPC seam. None of that can be trusted until something drives it
 * through the real seam rather than through a test harness, and the real UI
 * cannot boot — `Shell.tsx` and `EditorPane.tsx` import modules the D60 pivot
 * deleted, and one of them wants `yjs`, which is not even a dependency.
 *
 * So: a deliberately ugly diagnostic surface that exercises every main-side
 * path end to end and is drivable headlessly over CDP. **Plan 5 deletes this
 * file.** It imports nothing from `components/` or `state/` — those are
 * quarantined, and reaching into them is exactly how the boot path breaks.
 *
 * Inline styles rather than Tailwind classes, for the same reason: fewer things
 * that have to be working for the window to tell you what is wrong.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { VaultSnapshot } from '@holi/shared'
import type { SyncState } from '../../../main/vault/active-vault'
import { trpc } from '../lib/trpc'

const EMPTY: VaultSnapshot = { docs: [], tasks: [], broken: [] }

const styles = {
  page: { font: '13px ui-monospace, SFMono-Regular, Menlo, monospace', padding: 12 },
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const },
  panes: { display: 'flex', gap: 16, marginTop: 12, alignItems: 'flex-start' },
  list: { minWidth: 260, maxHeight: '60vh', overflow: 'auto' },
  item: { cursor: 'pointer', padding: '1px 0' },
  editor: { flex: 1, minWidth: 320 },
  area: { width: '100%', height: '46vh', font: 'inherit' },
  bar: { borderBottom: '1px solid #8884', paddingBottom: 8, marginBottom: 8 },
  err: { color: '#c00', whiteSpace: 'pre-wrap' as const, marginTop: 8 },
}

function describe(state: SyncState | null): string {
  if (state === null) return '—'
  switch (state.kind) {
    case 'ahead':
      return `${state.count} to publish`
    case 'conflict':
      return `conflict: ${state.paths.join(', ')}`
    case 'paused':
      return state.reason
    default:
      return state.kind
  }
}

export function Panel() {
  const [vaults, setVaults] = useState<{ remote: string; path: string }[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<VaultSnapshot>(EMPTY)
  const [sync, setSync] = useState<SyncState | null>(null)
  const [openPath, setOpenPath] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const addRef = useRef<HTMLInputElement>(null)
  const createRef = useRef<HTMLInputElement>(null)
  const newNoteRef = useRef<HTMLInputElement>(null)

  /** Every action goes through here so a rejection is visible on screen rather
   *  than only in a devtools console nobody has open. */
  const run = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(`${label}: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [])

  const refreshVaults = useCallback(async () => {
    setVaults(await trpc.vaults.list.query())
  }, [])

  useEffect(() => {
    void run('vaults.list', refreshVaults)
    // Main pushes the whole snapshot; nothing here reconciles events.
    const offSnapshot = window.holi.vault.onSnapshot(setSnapshot)
    const offSync = window.holi.vault.onSyncState(setSync)
    return () => {
      offSnapshot()
      offSync()
    }
  }, [run, refreshVaults])

  const open = (remote: string) =>
    run('vaults.open', async () => {
      setSnapshot(await trpc.vaults.open.mutate({ remote }))
      setSync(await trpc.sync.state.query())
      setActive(remote)
      setOpenPath(null)
      setText('')
    })

  const openNote = (path: string) =>
    run('notes.read', async () => {
      setText(await trpc.notes.read.query({ remote: active!, path }))
      setOpenPath(path)
    })

  return (
    <div style={styles.page}>
      <div style={{ ...styles.row, ...styles.bar }}>
        <strong>{active ?? 'no vault open'}</strong>
        <span>· {describe(sync)}</span>
        <button disabled={!active || busy} onClick={() => run('sync.commitNow', () => trpc.sync.commitNow.mutate())}>
          Commit now
        </button>
        <button disabled={!active || busy} onClick={() => run('sync.publish', () => trpc.sync.publish.mutate())}>
          Publish
        </button>
        <button disabled={!active || busy} onClick={() => run('vaults.snapshot', async () => {
          setSnapshot(await trpc.vaults.snapshot.query({ remote: active! }))
        })}>
          Rescan
        </button>
      </div>

      <div style={{ ...styles.row, ...styles.bar }}>
        <input ref={addRef} placeholder="owner/repo" size={20} />
        <button
          disabled={busy}
          onClick={() =>
            run('vaults.add', async () => {
              const remote = addRef.current!.value.trim()
              setSnapshot(await trpc.vaults.add.mutate({ remote }))
              setActive(remote)
              await refreshVaults()
            })
          }
        >
          Add vault
        </button>
        <input ref={createRef} placeholder="new vault name" size={18} />
        <button
          disabled={busy}
          onClick={() =>
            run('vaults.create', async () => {
              setSnapshot(await trpc.vaults.create.mutate({ name: createRef.current!.value.trim() }))
              await refreshVaults()
            })
          }
        >
          New vault
        </button>
      </div>

      <div style={styles.row}>
        {vaults.map((v) => (
          <button key={v.remote} disabled={busy} onClick={() => open(v.remote)}>
            {v.remote}
          </button>
        ))}
      </div>

      {error !== null && <div style={styles.err}>{error}</div>}

      <div style={styles.panes}>
        <div style={styles.list}>
          <div>
            <em>docs ({snapshot.docs.length})</em>
          </div>
          {snapshot.docs.map((d) => (
            <div key={d.path} style={styles.item} onClick={() => openNote(d.path)}>
              {d.kind === 'daily' ? '◆' : '·'} {d.path}
            </div>
          ))}
          <div style={{ marginTop: 8 }}>
            <em>tasks ({snapshot.tasks.length})</em>
          </div>
          {snapshot.tasks.map((t) => (
            <div key={t.path} style={styles.item} onClick={() => openNote(t.path)}>
              [{t.status}] {t.path}
            </div>
          ))}
          {snapshot.broken.length > 0 && (
            <div style={{ marginTop: 8, color: '#c60' }}>
              <em>broken ({snapshot.broken.length})</em>
              {snapshot.broken.map((b) => (
                <div key={b.path}>
                  {b.path} — {b.error}
                </div>
              ))}
            </div>
          )}
          <div style={{ ...styles.row, marginTop: 10 }}>
            <input ref={newNoteRef} placeholder="notes/new.md" size={16} />
            <button
              disabled={!active || busy}
              onClick={() =>
                run('notes.create', async () => {
                  const path = newNoteRef.current!.value.trim()
                  await trpc.notes.create.mutate({ remote: active!, path, text: '# New\n' })
                  await openNote(path)
                })
              }
            >
              New note
            </button>
          </div>
        </div>

        <div style={styles.editor}>
          <div>{openPath ?? 'no note open'}</div>
          <textarea
            style={styles.area}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={openPath === null}
          />
          <button
            disabled={openPath === null || busy}
            onClick={() =>
              run('notes.write', () =>
                trpc.notes.write.mutate({ remote: active!, path: openPath!, text }),
              )
            }
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
