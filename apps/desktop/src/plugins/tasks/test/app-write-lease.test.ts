import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CapabilityContext } from '../../../main/capabilities/registry'
import { noCoreServices } from '../../../main/capabilities/services'
import { taskCapabilities } from '../main/capabilities'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function rig() {
  const root = await mkdtemp(join(tmpdir(), 'holi-task-write-lease-'))
  roots.push(root)
  const capabilities = taskCapabilities({ today: () => '2026-10-01' })
  const context: CapabilityContext = {
    remote: 'ada/vault',
    root,
    bundle: 'Tracker.app',
    assertCurrent: () => {
      throw new Error('revoked')
    },
    snapshot: async () => ({}) as never,
    claims: async () => [],
    core: noCoreServices(),
  }
  return { root, capabilities, context }
}

describe('app task write cancellation', () => {
  it('does not create a task after checking its available filenames', async () => {
    const { root, capabilities, context } = await rig()
    await expect(
      capabilities['tasks.create'].run(context, {
        title: 'Call the bank',
        shared: true,
        extra: {},
      }),
    ).rejects.toThrow('revoked')
    await expect(access(join(root, 'task.call-the-bank.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('does not update a task after reading and preparing its fields', async () => {
    const { root, capabilities, context } = await rig()
    const path = join(root, 'task.review-plan.md')
    const original = '---\nstatus: todo\n---\n\n# Review plan\n'
    await writeFile(path, original)
    await expect(
      capabilities['tasks.update'].run(context, {
        path: 'task.review-plan.md',
        patch: { priority: 'high' },
      }),
    ).rejects.toThrow('revoked')
    await expect(readFile(path, 'utf8')).resolves.toBe(original)
  })
})
