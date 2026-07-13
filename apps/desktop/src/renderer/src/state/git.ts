/** Vault git-mirror + GitHub-connection state (thin — server owns everything). */
import { atom } from 'jotai'
import { trpc } from '../lib/trpc'
import { activeVaultIdAtom } from './vaults'

export interface GitStatusView {
  repoUrl: string
  defaultBranch: string
  status: 'ok' | 'paused' | 'attention'
  statusDetail: string | null
  warnings: Array<{ at: string; kind: string; path: string; detail?: string }>
  lastExportAt: string | null
  lastIngestAt: string | null
}

export function describeGitStatus(s: GitStatusView | null): { label: string; tone: 'idle' | 'ok' | 'error' } {
  if (!s) return { label: 'Not connected', tone: 'idle' }
  if (s.status === 'attention') return { label: `Sync needs attention: ${s.statusDetail ?? ''}`.trim(), tone: 'error' }
  if (s.status === 'paused') return { label: 'Sync paused', tone: 'idle' }
  const when = s.lastExportAt ? new Date(s.lastExportAt).toLocaleTimeString() : 'never'
  return { label: `Synced — last export ${when}`, tone: 'ok' }
}

export const gitStatusAtom = atom<GitStatusView | null>(null)
export const githubLoginAtom = atom<string | null>(null)

export const loadGitStatusAtom = atom(null, async (get, set) => {
  const vaultId = get(activeVaultIdAtom)
  if (!vaultId) return
  const [status, conn] = await Promise.all([
    trpc.git.status.query({ vaultId }),
    trpc.github.connectionStatus.query(),
  ])
  set(gitStatusAtom, status as GitStatusView | null)
  set(githubLoginAtom, conn.connected ? conn.login : null)
})

export const connectGithubAtom = atom(null, async (_get, set) => {
  const { url } = await trpc.github.startConnect.mutate()
  await window.holi.openExternal(url)
  // poll until the browser round-trip lands (the callback hits the server)
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const conn = await trpc.github.connectionStatus.query()
    if (conn.connected) {
      set(githubLoginAtom, conn.login)
      return
    }
  }
})

export const connectRepoAtom = atom(null, async (get, set, repoUrl: string) => {
  const vaultId = get(activeVaultIdAtom)
  if (!vaultId) return
  await trpc.git.connectRepo.mutate({ vaultId, repoUrl })
  await set(loadGitStatusAtom)
})

export const disconnectRepoAtom = atom(null, async (get, set) => {
  const vaultId = get(activeVaultIdAtom)
  if (!vaultId) return
  await trpc.git.disconnectRepo.mutate({ vaultId })
  set(gitStatusAtom, null)
})

export const syncNowAtom = atom(null, async (get, set) => {
  const vaultId = get(activeVaultIdAtom)
  if (!vaultId) return
  await trpc.git.syncNow.mutate({ vaultId })
  await set(loadGitStatusAtom)
})
