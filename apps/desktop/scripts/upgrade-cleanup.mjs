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
    firstTargetIdentity,
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
        exitCode: Number.isInteger(error.exitCode) ? error.exitCode : null,
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
  let firstTargetDrained = false
  if (firstTargetPid) {
    await attempt('drain-anchored-first-target', async () => {
      assert(
        firstTargetIdentity?.pid === firstTargetPid &&
          firstTargetIdentity.signatureVerified === true &&
          firstTargetIdentity.uid === process.getuid() &&
          Number.isSafeInteger(firstTargetIdentity.startMicros) &&
          firstTargetIdentity.startMicros >= upgradeNotBeforeMicros,
        'first-target cleanup anchor unavailable',
      )
      async function probe(action) {
        return JSON.parse(
          (
            await owned.run(firstObserverBinary, [], {
              input: JSON.stringify({
                action,
                fixtureRoot: root,
                bundlePath: artifact,
                teamIdentifier: team,
                pid: firstTargetPid,
                notBeforeMicros: upgradeNotBeforeMicros,
                expectedStartMicros: firstTargetIdentity.startMicros,
              }),
              label: 'confirm anchored first-target drainage',
            })
          ).output,
        )
      }
      function matching(result) {
        return (
          result.pid === firstTargetPid && result.startMicros === firstTargetIdentity.startMicros
        )
      }
      let exit = await probe('confirm-exit')
      if (exit.outcome === 'still-running' && matching(exit)) {
        const proof = await probe('identify')
        assert(
          proof.outcome === 'identified' &&
            matching(proof) &&
            proof.signatureVerified === true &&
            proof.uid === process.getuid(),
          'first-target cleanup ownership changed',
        )
        try {
          process.kill(firstTargetPid, 'SIGTERM')
        } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
      }
      const deadline = Date.now() + 15_000
      while (exit.outcome === 'still-running' && matching(exit) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        exit = await probe('confirm-exit')
      }
      assert(exit.outcome === 'exited' && matching(exit), 'first-target exit not acknowledged')
      firstTargetDrained = true
    })
  }
  report.firstTargetDrain = firstTargetPid
    ? {
        outcome: firstTargetDrained ? 'acknowledged' : 'unacknowledged',
        acknowledged: firstTargetDrained,
      }
    : { outcome: 'not-applicable', reason: 'no-target' }
  await attempt('stop-owned-groups', () => owned.stopAll())
  await attempt('confirm-process-drain', async () => {
    assert(!firstTargetPid || firstTargetDrained, 'first-target drainage not acknowledged')
    if (artifact) await waitForRuntimeDrain()
    assert(owned.size === 0, 'owned process groups remain')
    drained = true
    inspector?.close()
  })
  report.ownedProcessDrain = {
    acknowledged: drained,
    remainingGroupCount: owned.remainingPids.length,
  }
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
        installer: {
          inspect: async () => {
            if (!installer) {
              report.installerAbsence = { outcome: 'not-applicable' }
              return { present: false }
            }
            try {
              const state = await installer.inspect()
              report.installerAbsence = {
                outcome:
                  state.present === true
                    ? 'present'
                    : state.present === false
                      ? 'absent'
                      : 'unavailable',
              }
              return state
            } catch (error) {
              report.installerAbsence = { outcome: 'unavailable' }
              throw error
            }
          },
        },
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
