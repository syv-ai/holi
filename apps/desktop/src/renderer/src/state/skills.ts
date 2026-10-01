/**
 * Update skills, from the palette: this release's skills and hooks, merged
 * into the vault (`holi skills update` does the same from a shell).
 *
 * A file the vault changed too cannot be merged by Holi. Main answers with
 * the first turn of a session that would merge it, and the agent service
 * starts that session; with no agent the new versions wait beside the files.
 * The outcome is told as a notification, since Holi has no notice surface of
 * its own.
 */
import { atom } from 'jotai'
import type { vaultCapabilities } from '../../../main/capabilities/vault-caps'
import { capClient } from '../lib/cap-client'
import { agentSourceAtom } from './plugins'
import { activeRemoteAtom } from './vaults'

const skills = capClient<Pick<ReturnType<typeof vaultCapabilities>, 'skills.update'>>('skills')

function notify(body: string): void {
  try {
    new Notification('Update skills', { body })
  } catch {
    // No notifications here (a test, or a renderer without the API).
  }
}

export const updateSkillsAtom = atom(null, async (get, set): Promise<void> => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return
  let body: string
  try {
    const result = await skills.update(remote)
    const agent = get(agentSourceAtom)
    body = result.summary
    if (result.conflicts !== null && agent !== null) {
      const started = await set(agent.start, {
        name: 'Update skills',
        prompt: result.conflicts.prompt,
      })
      if (started.ok) body = result.conflicts.summary
    }
  } catch (err) {
    body = err instanceof Error ? err.message : String(err)
  }
  notify(body)
})
