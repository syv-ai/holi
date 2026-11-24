import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUpgradeInstaller, removeAfterDrain } from '../scripts/upgrade-installer.mjs'

const dirs: string[] = []
afterEach(async () =>
  Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))),
)
async function setup(present = false) {
  const dir = await mkdtemp(join(tmpdir(), 'installer-gate-'))
  dirs.push(dir)
  const resource = join(dir, 'resource')
  await mkdir(resource)
  let live = present
  const run = async (_binary: string, [mode]: string[]) => {
    if (mode === 'inspect') return { stdout: JSON.stringify({ present: live }) }
    if (live) live = false
    return { stdout: JSON.stringify({ present: false, removed: true }) }
  }
  const installer = createUpgradeInstaller({
    binary: 'native',
    artifact: 'app',
    statePath: 'state',
    label: 'job',
    run,
  })
  return {
    dir,
    resource,
    installer,
    setLive: (value: boolean) => {
      live = value
    },
  }
}

describe('upgrade installer deletion gate', () => {
  it('retains resources unless runtime drained and fresh inspection confirms absence', async () => {
    for (const scenario of ['live', 'restart', 'failed-runtime'] as const) {
      const state = await setup(scenario !== 'failed-runtime')
      if (scenario === 'restart') {
        await state.installer.removeOwned()
        state.setLive(true)
      }
      await expect(
        removeAfterDrain({
          runtimeDrained: scenario !== 'failed-runtime',
          installer: state.installer,
          removeResources: () => rm(state.resource, { recursive: true }),
        }),
      ).rejects.toThrow()
      await expect(
        import('node:fs/promises').then(({ access }) => access(state.resource)),
      ).resolves.toBeUndefined()
    }
  })
  it('deletes only after confirmed absence; absent removal has a valid receipt', async () => {
    const state = await setup(false)
    await expect(state.installer.removeOwned()).resolves.toMatchObject({
      present: false,
      removed: true,
    })
    await removeAfterDrain({
      runtimeDrained: true,
      installer: state.installer,
      removeResources: () => rm(state.resource, { recursive: true }),
    })
    await expect(
      import('node:fs/promises').then(({ access }) => access(state.resource)),
    ).rejects.toThrow()
  })
  it.each(['state ownership mismatch', 'untrusted fixture payload'])(
    'reports only allowlisted native command failures: %s',
    async (stderr) => {
      const installer = createUpgradeInstaller({
        binary: 'native',
        artifact: 'app',
        statePath: 'state',
        label: 'job',
        run: async () => {
          throw Object.assign(new Error('untrusted fixture payload'), { stderr, code: 1 })
        },
      })
      const failure = await installer.inspect().then(
        () => undefined,
        (error: Error) => error,
      )
      expect(failure).toMatchObject({
        code:
          stderr === 'state ownership mismatch'
            ? 'INSTALLER_STATE_OWNERSHIP_MISMATCH'
            : 'INSTALLER_COMMAND_FAILED',
        exitCode: 1,
      })
      expect(String(failure)).not.toContain('untrusted fixture payload')
      expect(failure).not.toHaveProperty('stderr')
    },
  )

  it('retains resources when native inspection fails or returns an invalid receipt', async () => {
    const state = await setup()
    for (const run of [
      async () => {
        throw new Error('native inspection unavailable')
      },
      async () => ({ stdout: '{}' }),
    ]) {
      const installer = createUpgradeInstaller({
        binary: 'native',
        artifact: 'app',
        statePath: 'state',
        label: 'job',
        run,
      })
      await expect(
        removeAfterDrain({
          runtimeDrained: true,
          installer,
          removeResources: () => rm(state.resource, { recursive: true }),
        }),
      ).rejects.toThrow()
      await expect(
        import('node:fs/promises').then(({ access }) => access(state.resource)),
      ).resolves.toBeUndefined()
    }
  })
})
