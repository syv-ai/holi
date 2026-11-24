import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

const exec = promisify(execFile)
export function createUpgradeInstaller({ binary, artifact, statePath, label, run = exec }) {
  const invoke = async (mode) => {
    const { stdout } = await run(binary, [mode, label, artifact, statePath], { timeout: 15_000 })
    const result = JSON.parse(stdout)
    if (!result || typeof result.present !== 'boolean') throw new Error('invalid installer receipt')
    return result
  }
  return {
    async inspect() {
      return invoke('inspect')
    },
    async assertAbsent() {
      const result = await invoke('inspect')
      if (result.present) throw new Error('pre-existing Squirrel installer job')
    },
    async removeOwned() {
      const result = await invoke('remove')
      if (result.present !== false || result.removed !== true)
        throw new Error('Squirrel installer job was not confirmed removed')
      return result
    },
  }
}
export async function removeAfterDrain({ runtimeDrained, installer, removeResources }) {
  if (runtimeDrained !== true) throw new Error('runtime is not drained')
  const receipt = await installer.inspect()
  if (receipt.present !== false) throw new Error('Squirrel installer job is present')
  await removeResources()
}
export const installerStatePath = (label) =>
  join(process.env.HOME, 'Library', 'Caches', label, 'ShipItState.plist')
