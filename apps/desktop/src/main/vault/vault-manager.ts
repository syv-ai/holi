/** One active vault at a time (spec §Session lifecycle): activate tears down
 * the previous vault's mirror + event stream and starts the next. Working
 * copies live under userData/working-copies/<vaultId>; frozen bases under
 * userData/vault-bases/<vaultId>. */
import { join } from 'node:path'
import { app } from 'electron'
import { API_URL, RELAY_URL, createServerClient } from '../server-client'
import type { SessionStore } from '../session'
import { makeMirrorApi } from './mirror-api'
import { SseClient } from './sse-client'
import { VaultMirror, type DocsEvent } from './vault-mirror'

export interface VaultManager {
  activate(vaultId: string): Promise<{ ok: true }>
  deactivate(): Promise<void>
  /** The active working dir — slice 2 points the PTY here. */
  workRootFor(vaultId: string): string
}

export function createVaultManager(deps: { store: SessionStore; dataDir?: string }): VaultManager {
  let current: { vaultId: string; mirror: VaultMirror; events: SseClient } | null = null

  const dataDir = () => deps.dataDir ?? app.getPath('userData')
  const workRootFor = (vaultId: string) => join(dataDir(), 'working-copies', vaultId)

  async function deactivate(): Promise<void> {
    if (!current) return
    const { mirror, events } = current
    current = null
    events.stop()
    await mirror.stop()
  }

  async function activate(vaultId: string): Promise<{ ok: true }> {
    if (current?.vaultId === vaultId) return { ok: true }
    await deactivate()
    const session = deps.store.load()
    if (!session) throw new Error('not signed in')
    const client = createServerClient(() => deps.store.load()?.token ?? null)
    const mirror = new VaultMirror({
      vaultId,
      workRoot: workRootFor(vaultId),
      baseDir: join(dataDir(), 'vault-bases', vaultId),
      relayUrl: RELAY_URL,
      token: session.token,
      api: makeMirrorApi(client, vaultId),
    })
    const events = new SseClient({
      url: `${API_URL}/events/${vaultId}`,
      getToken: () => deps.store.load()?.token ?? null,
      onEvent: (channel, data) => {
        if (channel === 'docs') mirror.handleDocsEvent(data as DocsEvent)
        // 'tasks' + 'reminders' get consumers in slice 2 (ContextSnapshot)
      },
      onReconnect: () => void mirror.refresh().catch((err) => console.error('[mirror] refresh failed:', err)),
    })
    await mirror.start()
    events.start()
    current = { vaultId, mirror, events }
    return { ok: true }
  }

  return { activate, deactivate, workRootFor }
}
