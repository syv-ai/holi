import { readFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCapabilityHost } from '../../../main/capabilities/dispatch'
import { createCapabilityRegistry, cap } from '../../../main/capabilities/registry'
import { noCoreServices } from '../../../main/capabilities/services'
import { writeAtomic } from '../../../main/vault/vault-files'
import { vaultRelPath } from '@holi/shared'

const remote = 'ada/vault'
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

describe('app-door write cancellation', () => {
  it('injects the current door predicate into a capability after an awaited read', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'holi-app-write-lease-'))
    roots.push(root)
    const readStarted = deferred()
    const finishRead = deferred()
    const registry = createCapabilityRegistry()
    registry.register(['sample'], {
      'sample.write': cap({
        doors: ['app'],
        params: () => ({}),
        run: async (ctx) => {
          readStarted.resolve()
          await finishRead.promise
          await writeAtomic(root, vaultRelPath('record.json'), 'written', ctx.assertCurrent)
        },
      }),
    })
    const host = createCapabilityHost({
      registry,
      rootFor: async (target) => (target === remote ? root : null),
      get: (_remote) => null,
      core: noCoreServices,
      pluginEnabled: async () => true,
      claims: async () => [],
    })
    const door = host.openAppDoor({ admit: async () => {} }, remote)
    let current = true
    const call = door.call(remote, 'Tracker.app', 'sample.write', {}, () => current)
    await readStarted.promise
    current = false
    finishRead.resolve()
    await expect(call).rejects.toThrow()
    expect(() => readFileSync(join(root, 'record.json'), 'utf8')).toThrow()
  })
})
