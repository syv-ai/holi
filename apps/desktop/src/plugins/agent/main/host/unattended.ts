/**
 * Which vaults this machine lets an agent run unattended in, when that
 * agent's jobs can read the whole disk (`JobsCapability.readsAnywhere`:
 * Codex). docs/features/agent-sessions.md, Jobs.
 *
 * A Codex job's sandbox bounds what it writes, not what it reads: it can read
 * any file on this computer and write what it read into the vault's synced
 * folders, so a note from someone untrusted could make it publish private
 * data. So `agent.job` refuses such a run until someone on this machine turned
 * it on for the vault, in Settings (General, Agents), after a dialog that
 * says so. The answer is this machine's, by remote and agent, in `userData`:
 * never in the vault, where a teammate could commit it or a run could write
 * it.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { jsonFileStore } from '../../../../main/plugin-api'
import type { ProviderId } from '../provider'

export interface UnattendedStore {
  allowed(remote: string, provider: ProviderId): Promise<boolean>
  set(remote: string, provider: ProviderId, on: boolean): Promise<void>
}

const keyOf = (remote: string, provider: ProviderId) => `${remote}#${provider}`

/** When each vault's agent was let run unattended, by `remote#agent`. */
type Granted = Record<string, number>

export function createUnattendedStore(path: string, now = () => Date.now()): UnattendedStore {
  const file = jsonFileStore(path, (raw): Granted =>
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? Object.fromEntries(
          Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === 'number'),
        )
      : {},
  )
  return {
    allowed: async (remote, provider) => keyOf(remote, provider) in (await file.read()),
    set: async (remote, provider, on) => {
      await file.update((all) => {
        const { [keyOf(remote, provider)]: _was, ...rest } = all
        return on ? { ...rest, [keyOf(remote, provider)]: now() } : rest
      })
    },
  }
}

/**
 * Why a run did not start, and how to let it.
 * @public exported for its test
 */
export const unattendedRefusal = (label: string): string =>
  `${label} does not run unattended in this vault until someone on this machine allows it: Settings, General, Agents, “Let ${label} run unattended in this vault”. Holi asks first because a ${label} job can read any file on this computer and write what it read into the vault’s synced folders, so a note from someone untrusted could make it publish private data.`
