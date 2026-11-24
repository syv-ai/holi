import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

const exec = promisify(execFile)
export function createUpgradeInstaller({ binary, artifact, statePath, label, run = exec }) {
  const invoke = async (mode) => {
    let stdout
    try {
      ;({ stdout } = await run(binary, [mode, label, artifact, statePath], { timeout: 15_000 }))
    } catch (error) {
      const codes = new Map([
        ['launchd inspection failed', 'INSTALLER_INSPECTION_FAILED'],
        ['invalid arguments', 'INSTALLER_ARGUMENTS_INVALID'],
        ['job ownership mismatch', 'INSTALLER_JOB_OWNERSHIP_MISMATCH'],
        ['state ownership mismatch', 'INSTALLER_STATE_OWNERSHIP_MISMATCH'],
        ['job removal failed', 'INSTALLER_REMOVAL_FAILED'],
        ['job restarted or remains', 'INSTALLER_REAPPEARED'],
      ])
      const failure = new Error('native installer command unavailable')
      failure.code =
        codes.get(typeof error.stderr === 'string' ? error.stderr.trim() : '') ??
        'INSTALLER_COMMAND_FAILED'
      if (Number.isInteger(error.code)) failure.exitCode = error.code
      throw failure
    }
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
