/** IPC surface — the ONLY seam between renderer and main (architecture §8). */
import { ipcMain, shell } from 'electron'
import { randomBytes } from 'node:crypto'
import { createLoopbackServer, googleAuthorizeUrl, pkcePair } from './oauth'
import {
  API_URL,
  RELAY_URL,
  callProcedure,
  createServerClient,
  toEnvelope,
  type ServerClient,
  type TrpcOp,
} from './server-client'
import type { AgentManager } from './agent/agent-manager'
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
}): void {
  const { store, vaultManager, agentManager } = deps
  const client: ServerClient = createServerClient(() => store.load()?.token ?? null)

  ipcMain.handle('holi:trpc', (_e, op: TrpcOp) => toEnvelope(callProcedure(client, op)))

  ipcMain.handle('holi:auth:get', (): PublicUser | null => {
    const s = store.load()
    return s ? { userId: s.userId, email: s.email, name: s.name } : null
  })

  ipcMain.handle('holi:auth:signIn', () => toEnvelope(signInWithGoogle(client, store)))

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
        return { userId: user.id, email: user.email, name: user.name } satisfies PublicUser
      })(),
    ),
  )

  ipcMain.handle('holi:auth:signOut', () =>
    toEnvelope(
      (async () => {
        try {
          await client.auth.signOut.mutate()
        } finally {
          store.clear() // local sign-out even if the server is unreachable
        }
        return { ok: true }
      })(),
    ),
  )

  /** Transient collab credentials for the renderer's HocuspocusProvider (plan decision #1). */
  ipcMain.handle('holi:collab:auth', () => {
    const s = store.load()
    return s ? { url: RELAY_URL, token: s.token } : null
  })

  ipcMain.handle('holi:vault:activate', (_e, vaultId: string) =>
    toEnvelope(vaultManager.activate(String(vaultId))),
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
