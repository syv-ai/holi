/**
 * The agents a session can run (docs/features/agent-sessions.md, Providers),
 * as main lists them (`agent.providers`), and the one a new session runs: the
 * pick on the new-session page, else this machine's `agentProvider`.
 */
import { atom } from 'jotai'
import type { AgentProviderId } from '@holi/shared'
import { activeRemoteAtom, agentProviderSettingAtom, type PluginEventHandler } from '@/plugin-api'
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
  /** A harness a person added. */
  custom: boolean
  /** It can start on a first message. */
  prompts: boolean
  /** It has a picker of its earlier conversations. */
  resumePicker: boolean
  /** Why it runs nothing unattended, or null when it can. */
  unattended: string | null
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

const BUILT_IN_LABELS: Readonly<Record<string, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
}

/** An agent's name, as a person says it: this machine's registry's, the
 *  built-in name until it answers, else its id. */
export const providerLabel = (providers: ProvidersState, id: string): string =>
  (providers.kind === 'ready' ? providers.providers.find((p) => p.id === id)?.label : undefined) ??
  BUILT_IN_LABELS[id] ??
  id

/** The default agent names none on this machine: a harness since removed.
 *  A new session then asks which agent, never picks one itself. */
export const defaultMissingAtom = atom((get): boolean => {
  if (get(pickedProviderAtom) !== null) return false
  const providers = get(providersAtom)
  const id = get(agentProviderSettingAtom)
  return providers.kind === 'ready' && !providers.providers.some((p) => p.id === id)
})

/** Main changed this machine's harnesses (Settings, General, Agents): the
 *  list is asked for again. */
export const providerEvents: Readonly<Record<string, PluginEventHandler>> = {
  providers: ({ remote }, store) => {
    if (remote === store.get(activeRemoteAtom)) void store.set(loadProvidersAtom)
  },
}
