import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { removeAfterDrain } from './upgrade-installer.mjs'

/** Release the fixture only after both runtime and native installer drainage are proven. */
export async function cleanupUpgradeFixture({ resources, owned, command, runtimePids }) {
  const {
    installerGuardReady,
    installer,
    artifact,
    firstTargetPid,
    firstObserverBinary,
    upgradeNotBeforeMicros,
    firstTargetStartMicros,
    team,
    root,
    inspector,
    launchKeys,
    providers,
    feed,
    appStarted,
    ownsProfile,
    profile,
    vaultRoot,
  } = resources
  const report = {}
  const ownRuntimePids = runtimePids
  async function waitForRuntimeDrain() {
    const deadline = Date.now() + 15_000
    while ((await runtimePids()).length) {
      if (Date.now() >= deadline) {
        report.timedOut = { phase: 'runtime-cleanup', milliseconds: 15_000 }
        throw new Error('owned runtime did not drain')
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  const failures = []
  async function attempt(phase, action) {
    try {
      await action()
      return true
    } catch (error) {
      failures.push({
        phase,
        type: error.name,
        code: /^[A-Z_]+$/.test(error.code || '') ? error.code : null,
      })
      return false
    }
  }
  let drained = false
  let installerDrained = false
  if (installerGuardReady) {
    await attempt('remove-validated-squirrel-job', async () => {
      await installer.removeOwned()
      installerDrained = true
    })
  } else if (!artifact) {
    installerDrained = true
  }
  if (artifact) {
    await attempt('signal-owned-runtime', async () => {
      for (const pid of await ownRuntimePids()) {
        try {
          if (pid === firstTargetPid) {
            const proof = JSON.parse(
              (
                await owned.run(firstObserverBinary, [], {
                  input: JSON.stringify({
                    action: 'identify',
                    fixtureRoot: root,
                    bundlePath: artifact,
                    teamIdentifier: team,
                    pid,
                    notBeforeMicros: upgradeNotBeforeMicros,
                    expectedStartMicros: firstTargetStartMicros,
                  }),
                  label: 'confirm failed first-target cleanup ownership',
                })
              ).output,
            )
            assert(
              proof.outcome === 'identified' &&
                proof.pid === pid &&
                proof.signatureVerified === true &&
                proof.uid === process.getuid(),
              'first-target cleanup ownership unavailable',
            )
          }
          process.kill(pid, 'SIGTERM')
        } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
      }
    })
  }
  await attempt('stop-owned-groups', () => owned.stopAll())
  report.ownedProcessDrain = {
    acknowledged: owned.size === 0,
    remainingGroupCount: owned.remainingPids.length,
  }
  await attempt('confirm-process-drain', async () => {
    if (artifact) await waitForRuntimeDrain()
    assert(owned.size === 0, 'owned process groups remain')
    drained = true
    inspector?.close()
  })
  if (!drained && owned.size) {
    await attempt('inspect-owned-group-states', async () => {
      const groups = new Set(owned.remainingPids)
      const states = { live: 0, zombie: 0 }
      const result = await command('/bin/ps', ['-axo', 'pgid=,stat='], { cleanup: true })
      for (const line of result.stdout.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\S+)/)
        if (match && groups.has(Number(match[1]))) {
          states[match[2].startsWith('Z') ? 'zombie' : 'live']++
        }
      }
      report.cleanupGroupStates = states
    })
  }
  for (const key of launchKeys)
    await attempt(`unset-${key}`, () =>
      command('/bin/launchctl', ['unsetenv', key], { cleanup: true }),
    )
  if (providers) await attempt('provider-shutdown', () => providers.close())
  if (feed) await attempt('feed-shutdown', () => feed.stop())
  let deletionAllowed = false
  if (drained && installerDrained && (!appStarted || installerGuardReady)) {
    await attempt('confirmed-absence-and-remove-resources', async () => {
      await removeAfterDrain({
        runtimeDrained: true,
        installer: installer ?? { inspect: async () => ({ present: false }) },
        removeResources: async () => {
          if (ownsProfile) {
            await rm(profile, { recursive: true, force: true })
            await rm(vaultRoot, { recursive: true, force: true })
          }
          if (root) await rm(root, { recursive: true, force: true })
        },
      })
      deletionAllowed = true
    })
  }
  report.cleanup = {
    failures,
    filesRetained: !deletionAllowed,
    resourcesDeleted: deletionAllowed,
    root: !deletionAllowed ? root : undefined,
  }
  return { report, failed: failures.length > 0 }
}
