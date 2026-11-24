import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

const exec = promisify(execFile)
export function createUpgradeInstaller({ binary, artifact, statePath, label, run = exec }) {
  const invoke = async (mode) => {
    const { stdout } = await run(binary, [mode, label, artifact, statePath], { timeout: 15_000 })
    return JSON.parse(stdout)
  }
  return {
    async assertAbsent() {
      const result = await invoke('inspect')
      if (result.present) throw new Error('pre-existing Squirrel installer job')
    },
    async removeOwned() {
      const result = await invoke('remove')
      if (!result.removed) throw new Error('Squirrel installer job was not confirmed removed')
    },
  }
}
export const installerStatePath = (label) =>
  join(process.env.HOME, 'Library', 'Caches', label, 'ShipItState.plist')
