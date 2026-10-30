/**
 * The agents a session can run (docs/features/agent-sessions.md, Providers),
 * as main lists them (`agent.providers`), and the one a new session runs: the
 * pick on the new-session page, else this machine's `agentProvider`.
 */
import { atom } from 'jotai'
import type { AgentProviderId } from '@holi/shared'
import { activeRemoteAtom, agentProviderSettingAtom } from '@/plugin-api'
import { agentCap } from '../agent-cap'

/** Mirrors `ProviderSummary` in main/host/capabilities.ts. */
interface AgentProviderInfo {
  id: AgentProviderId
  label: string
  /** Its CLI is on this machine. */
  installed: boolean
  /** Its sessions can run with nobody watching. */
  background: boolean
  /** It can run a job: one prompt, unwatched, in a folder of Holi's. */
  jobs: boolean
  /** A live session of it can be copied. */
  copies: boolean
}

export type ProvidersState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; providers: readonly AgentProviderInfo[] }

export const providersAtom = atom<ProvidersState>({ kind: 'loading' })

/** Ask main again: on opening a vault, and the new-session page's Retry
 *  (an agent installed since). */
export const loadProvidersAtom = atom(null, async (get, set) => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return
  try {
    set(providersAtom, { kind: 'ready', providers: await agentCap.providers(remote) })
  } catch (err) {
    set(providersAtom, { kind: 'error', message: err instanceof Error ? err.message : String(err) })
  }
})

/** The new-session page's pick, until the vault is left. Null follows the
 *  setting. */
export const pickedProviderAtom = atom<AgentProviderId | null>(null)

/** The agent a new session runs. */
export const newSessionProviderAtom = atom(
  (get): AgentProviderId => get(pickedProviderAtom) ?? get(agentProviderSettingAtom),
)

/** An agent's name, as a person says it. */
export const providerLabel = (id: string): string =>
  id === 'codex' ? 'Codex' : id === 'pi' ? 'Pi' : 'Claude Code'
