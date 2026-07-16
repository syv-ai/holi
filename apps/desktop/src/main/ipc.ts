/** IPC surface — the ONLY seam between renderer and main (architecture §8). */
import { ipcMain, shell } from 'electron'
import { randomBytes } from 'node:crypto'
import type { YjsLink } from '@holi/shared'
import { createLoopbackServer, googleAuthorizeUrl, pkcePair } from './oauth'
import {
  API_URL,
  callProcedure,
  createServerClient,
  toEnvelope,
  type ServerClient,
  type TrpcOp,
} from './server-client'
import type { AgentManager } from './agent/agent-manager'
import type { UserStream } from './events/user-stream'
import type { SessionStore } from './session'
import type { VaultManager } from './vault/vault-manager'

export interface PublicUser {
  userId: string
  email: string
  name: string | null
}

export function registerIpc(deps: {
  store: SessionStore
  vaultManager: VaultManager
  agentManager: AgentManager
  /** Started on sign-in, stopped on sign-out — its lifetime is the session's, not any
   * vault's (D50). Every route in has to start it, or that route gets a dead app: no
   * live tree, no switcher updates, no reminders. */
  userStream: UserStream
  /** Push to the renderer — the same seam the SSE feeds use (main/index.ts). */
  send: (channel: string, payload: unknown) => void
}): void {
  const { store, vaultManager, agentManager, userStream } = deps
  const client: ServerClient = createServerClient(() => store.load()?.token ?? null)

  ipcMain.handle('holi:trpc', (_e, op: TrpcOp) => toEnvelope(callProcedure(client, op)))

  ipcMain.handle('holi:auth:get', (): PublicUser | null => {
    const s = store.load()
    return s ? { userId: s.userId, email: s.email, name: s.name } : null
  })

  ipcMain.handle('holi:auth:signIn', () =>
    toEnvelope(signInWithGoogle(client, store).then((user) => (userStream.start(), user))),
  )

  ipcMain.handle('holi:auth:devSignIn', (_e, token: string) =>
    toEnvelope(
      (async () => {
        // validate the pasted token by resolving the session with it
        const probe = createServerClient(() => token)
        const user = await probe.auth.session.query()
        store.save({
          token,
          userId: user.id,
          email: user.email,
          name: user.name,
          cachedAt: new Date().toISOString(),
        })
        userStream.start()
        return { userId: user.id, email: user.email, name: user.name } satisfies PublicUser
      })(),
    ),
  )

  ipcMain.handle('holi:auth:signOut', () =>
    toEnvelope(
      (async () => {
        userStream.stop() // before the token goes: it authenticates with it
        try {
          await client.auth.signOut.mutate()
        } finally {
          store.clear() // local sign-out even if the server is unreachable
        }
        return { ok: true }
      })(),
    ),
  )

  /**
   * Collab (D59) — the renderer binds its Y.Doc to main's rather than dialling the relay
   * itself. Main already holds a Y.Doc + provider for every doc, so the renderer becomes
   * just another writer into it: the DocBridge materializes it to disk and the provider
   * carries it upstream, both already wired.
   *
   * This replaced `holi:collab:auth`, which handed the renderer the raw session token so
   * it could open its own relay connection — the one documented exception to "the token
   * lives only in main" (session.ts). The exception is gone with it.
   *
   * Updates cross as `Uint8Array`. This is the app's first binary IPC — everything else
   * here is JSON — and structured clone carries typed arrays intact in both directions.
   */
  const links = new Map<string, YjsLink>()
  const unlink = (docId: string): void => {
    links.get(docId)?.destroy()
    links.delete(docId)
  }

  ipcMain.handle('holi:collab:open', (_e, docId: string) =>
    toEnvelope(
      (async () => {
        const id = String(docId)
        unlink(id) // a reload re-opens without closing; never stack two links on one doc
        const mirror = vaultManager.activeMirror()
        if (!mirror) throw new Error('no active vault')
        const bound = mirror.linkRenderer(id, {
          sendUpdate: (update) => deps.send('collab:update', { docId: id, update }),
          sendAwareness: (update) => deps.send('collab:awareness', { docId: id, update }),
        })
        // The mirror skips docs it cannot safely hold (an unsafe path). Failing loudly
        // beats handing back an empty doc the user can type into and lose.
        if (!bound) throw new Error(`doc ${id} is not held by the active vault`)
        links.set(id, bound.link)
        return {
          state: bound.link.stateAsUpdate(),
          awareness: bound.link.awarenessAsUpdate(),
          status: bound.status,
        }
      })(),
    ),
  )

  ipcMain.handle('holi:collab:update', (_e, msg: { docId: string; update: Uint8Array }) => {
    links.get(String(msg.docId))?.applyUpdate(new Uint8Array(msg.update))
  })

  ipcMain.handle('holi:collab:awareness', (_e, msg: { docId: string; update: Uint8Array }) => {
    links.get(String(msg.docId))?.applyAwareness(new Uint8Array(msg.update))
  })

  ipcMain.handle('holi:collab:close', (_e, docId: string) => unlink(String(docId)))

  ipcMain.handle('holi:vault:activate', (_e, vaultId: string) =>
    toEnvelope(
      (async () => {
        // Links point at the outgoing vault's docs; the mirror behind them is about to be
        // stopped and its Y.Docs destroyed.
        for (const id of [...links.keys()]) unlink(id)
        return vaultManager.activate(String(vaultId))
      })(),
    ),
  )

  // Agent drawer (spec §AgentRuntime). PTY bytes flow back on the push
  // channels 'agent-pty:data' / 'agent-pty:exit'; status on 'agent:status'.
  ipcMain.handle('agent-pty:start', (_e, args: { vaultId: string; resume?: boolean }) =>
    toEnvelope(agentManager.start({ vaultId: String(args.vaultId), resume: args.resume === true })),
  )
  ipcMain.handle('agent-pty:write', (_e, data: string) => agentManager.write(String(data)))
  ipcMain.handle('agent-pty:resize', (_e, size: { cols: number; rows: number }) =>
    agentManager.resize(Number(size.cols), Number(size.rows)),
  )
  ipcMain.handle('agent-pty:kill', () => toEnvelope(agentManager.kill()))
  /** Replay the terminal as main saw it — scrollback survives a renderer reload. */
  ipcMain.handle('agent-pty:attach', () => agentManager.attach())
  ipcMain.handle('holi:agent:status', () => agentManager.status())
  ipcMain.handle('holi:agent:focus', (_e, focus: { focusedPath: string | null; openPaths: string[] }) =>
    agentManager.setFocus({
      focusedPath: focus.focusedPath ?? null,
      openPaths: Array.isArray(focus.openPaths) ? focus.openPaths.map(String) : [],
    }),
  )

  ipcMain.handle('holi:openExternal', (_e, url: string) => {
    if (!/^https:\/\//.test(url)) throw new Error('only https URLs can be opened')
    return shell.openExternal(url)
  })
}

async function signInWithGoogle(client: ServerClient, store: SessionStore): Promise<PublicUser> {
  const cfg = await client.auth.oauthConfig.query()
  if (!cfg.clientId) {
    throw new Error(`Google OAuth is not configured on the server (${API_URL}) — use the dev token sign-in`)
  }
  const { verifier, challenge } = pkcePair()
  const state = randomBytes(16).toString('base64url')
  const loopback = await createLoopbackServer(state)
  try {
    await shell.openExternal(
      googleAuthorizeUrl({
        clientId: cfg.clientId,
        redirectUri: loopback.redirectUri,
        challenge,
        state,
        hd: cfg.workspaceDomain ?? undefined,
      }),
    )
    const code = await loopback.waitForCode()
    const { token, user } = await client.auth.completeGoogle.mutate({
      code,
      codeVerifier: verifier,
      redirectUri: loopback.redirectUri,
    })
    store.save({
      token,
      userId: user.id,
      email: user.email,
      name: user.name,
      cachedAt: new Date().toISOString(),
    })
    return { userId: user.id, email: user.email, name: user.name }
  } finally {
    loopback.close()
  }
}
