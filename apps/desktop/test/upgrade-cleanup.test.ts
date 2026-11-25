import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanupUpgradeFixture } from '../scripts/upgrade-cleanup.mjs'
import { createOwnedProcesses } from '../scripts/owned-processes.mjs'

describe.skipIf(process.platform === 'win32')('upgrade fixture cleanup', () => {
  it.each([
    'clear',
    'unacknowledged',
    'installer-returned',
    'installer-unavailable',
    'missing-anchor',
    'replacement',
    'late-job',
    'late-job-refused',
  ] as const)(
    'deletes fixture data only with acknowledged drainage and fresh installer absence: %s',
    async (scenario) => {
      const root = await mkdtemp(join(tmpdir(), 'holi-565-cleanup-'))
      const profile = join(root, 'profile')
      const vaultRoot = join(root, 'vaults')
      await mkdir(profile)
      await mkdir(vaultRoot)
      const sentinel = join(profile, 'fixture-data')
      await writeFile(sentinel, 'retained credential fixture')
      const childProcesses = createOwnedProcesses()
      const child = ['missing-anchor', 'replacement'].includes(scenario)
        ? childProcesses.start(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
        : undefined
      const owned = {
        size: scenario === 'unacknowledged' ? 1 : 0,
        remainingPids: scenario === 'unacknowledged' ? [12345] : [],
        run: async () => ({
          output: JSON.stringify({ outcome: 'ownership-refused', reason: 'process-changed' }),
        }),
        stopAll: async () => {
          if (scenario === 'unacknowledged') throw new Error('drain not acknowledged')
        },
      }
      let removalAttempts = 0
      let lateJobPresent = false
      const installer = {
        removeOwned: async () => {
          removalAttempts++
          if (removalAttempts === 2 && scenario.startsWith('late-job')) {
            if (scenario === 'late-job-refused')
              throw Object.assign(new Error('job ownership changed'), {
                code: 'INSTALLER_STATE_OWNERSHIP_MISMATCH',
                exitCode: 2,
              })
            lateJobPresent = false
          }
        },
        inspect: async () => {
          if (scenario === 'installer-unavailable')
            throw Object.assign(new Error('inspection unavailable'), {
              code: 'INSTALLER_STATE_OWNERSHIP_MISMATCH',
              exitCode: 2,
            })
          return { present: scenario === 'installer-returned' || lateJobPresent }
        },
      }
      try {
        const result = await cleanupUpgradeFixture({
          resources: {
            root,
            profile,
            vaultRoot,
            ownsProfile: true,
            launchKeys: [],
            installer,
            installerGuardReady: true,
            appStarted: false,
            firstTargetPid: child?.child.pid,
            firstTargetIdentity:
              scenario === 'replacement'
                ? {
                    pid: child?.child.pid,
                    startMicros: Date.now() * 1000,
                    uid: process.getuid!(),
                    signatureVerified: true,
                  }
                : undefined,
            upgradeNotBeforeMicros: 0,
          },
          owned,
          runtimePids: async () => {
            if (scenario.startsWith('late-job')) lateJobPresent = true
            return []
          },
          command: async () => ({ stdout: '' }),
        })
        if (
          ['clear', 'installer-returned', 'installer-unavailable', 'late-job'].includes(scenario)
        ) {
          expect(result.report.installerAbsence).toMatchObject({
            outcome:
              scenario === 'clear'
                ? 'absent'
                : scenario === 'installer-returned'
                  ? 'present'
                  : scenario === 'late-job'
                    ? 'absent'
                    : 'unavailable',
          })
        }
        if (scenario === 'installer-unavailable' || scenario === 'late-job-refused')
          expect(result.report.cleanup.failures).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ code: 'INSTALLER_STATE_OWNERSHIP_MISMATCH', exitCode: 2 }),
            ]),
          )
        if (scenario === 'clear' || scenario === 'late-job') {
          expect(result.failed).toBe(false)
          expect(result.report.cleanup).toMatchObject({
            filesRetained: false,
            resourcesDeleted: true,
          })
          expect(result.report.firstTargetDrain).toEqual({
            outcome: 'not-applicable',
            reason: 'no-target',
          })
          await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
        } else {
          expect(result.failed).toBe(true)
          expect(result.report.cleanup.filesRetained).toBe(true)
          expect(await readFile(sentinel, 'utf8')).toBe('retained credential fixture')
          if (scenario === 'unacknowledged') {
            expect(result.report.ownedProcessDrain.acknowledged).toBe(false)
            expect(result.report.cleanupGroupStates).toEqual({ live: 0, zombie: 0 })
          }
        }
      } finally {
        await childProcesses.stopAll()
        await rm(root, { recursive: true, force: true })
      }
    },
  )
})
