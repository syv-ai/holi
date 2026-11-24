import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { withVaultOperation } from '../app/operation-gate'
import { createVaultStorage } from '../app/vault-storage'
import { createNodeFiles } from './native-files-node'

const roots: string[] = []
const bytes = (value: string) => new TextEncoder().encode(value)
async function root() {
  const path = await mkdtemp(`/tmp/holi-operation-${randomUUID()}-`)
  roots.push(path)
  return path
}
const signal = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}
afterEach(async () =>
  Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
)

describe('vault operation gate', () => {
  it('makes queued operations on canonical-root aliases observe completed storage saves', async () => {
    const base = await root()
    const alias = `${base}/.`
    const entered = signal()
    const release = signal()
    let armed = false
    const adapter = createNodeFiles(async (phase) => {
      if (armed && phase === 'stage-write') {
        entered.resolve()
        await release.promise
      }
    })
    const storage = createVaultStorage(adapter, { remote: 'holi/gate-save', root: base })
    await storage.create('note.md', bytes('initial'))
    armed = true
    const saving = storage.save('note.md', bytes('final'), (await storage.read('note.md')).revision)
    await entered.promise
    const observed = withVaultOperation(adapter, alias, async (canonical) =>
      readFile(join(canonical, 'note.md'), 'utf8'),
    )
    release.resolve()
    await saving
    expect(await observed).toBe('final')
  })

  it('recovers interrupted moves before work and refuses conflicts without changing evidence', async () => {
    const base = await root()
    const adapter = createNodeFiles()
    const storage = createVaultStorage(adapter, { remote: 'holi/gate-recovery', root: base })
    const source = await storage.create('from.md', bytes('source'))
    const interrupted = createVaultStorage(
      adapter,
      { remote: 'holi/gate-recovery', root: base },
      {
        checkpoint: async (event) => {
          if (
            event.phase === 'file-after' &&
            event.direction === 'after' &&
            event.path === 'from.md'
          )
            throw new Error('interrupt move')
        },
      },
    )
    await expect(interrupted.move('from.md', 'to.md', source.revision)).rejects.toThrow()
    let recovered = ''
    await withVaultOperation(adapter, base, async (canonical) => {
      recovered = await readFile(join(canonical, 'to.md'), 'utf8')
    })
    expect(recovered).toBe('source')
    expect(await readdir(base)).toContain('to.md')

    await writeFile(join(base, 'conflict.md'), 'user bytes')
    const canonical = await adapter.canonicalRoot(base)
    const id = randomUUID()
    const name = `move-${id}.json`
    const journal = bytes(
      JSON.stringify({
        schema: 2,
        root: canonical,
        operationId: id,
        from: 'conflict.md',
        to: 'target.md',
        changes: [
          { path: 'conflict.md', before: [...bytes('expected old')], after: null },
          { path: 'target.md', before: null, after: [...bytes('expected old')] },
        ],
      }),
    )
    await adapter.privatePublish(canonical, name, journal, null)
    let started = false
    await expect(
      withVaultOperation(adapter, base, async () => {
        started = true
      }),
    ).rejects.toThrow('Move recovery conflict at conflict.md')
    expect(started).toBe(false)
    expect(await readFile(join(base, 'conflict.md'), 'utf8')).toBe('user bytes')
    expect(await adapter.privateRead(canonical, name)).toEqual(journal)
    const second = await root()
    expect(await withVaultOperation(adapter, second, async () => 'independent')).toBe('independent')
    await writeFile(join(base, 'conflict.md'), 'expected old')
    expect(
      await withVaultOperation(adapter, base, async (resolved) =>
        readFile(join(resolved, 'target.md'), 'utf8'),
      ),
    ).toBe('expected old')
    expect(await adapter.privateList(canonical)).not.toContain(name)
  })

  it('releases a root after rejection while another root can proceed independently', async () => {
    const first = await root()
    const second = await root()
    const adapter = createNodeFiles()
    const entered = signal()
    const release = signal()
    const failed = withVaultOperation(adapter, first, async () => {
      entered.resolve()
      await release.promise
      throw new Error('operation failed')
    })
    await entered.promise
    const otherRoot = withVaultOperation(adapter, second, async () => 'other root')
    expect(await otherRoot).toBe('other root')
    const following = withVaultOperation(adapter, first, async () => 'next operation')
    release.resolve()
    await expect(failed).rejects.toThrow('operation failed')
    expect(await following).toBe('next operation')
  })
})
