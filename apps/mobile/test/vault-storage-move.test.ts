import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createVaultStorage } from '../app/vault-storage'
import { createNodeFiles } from './native-files-node'

const roots: string[] = []
const text = (value: string) => new TextEncoder().encode(value)
const string = (value: Uint8Array) => new TextDecoder().decode(value)
async function root() {
  const path = await mkdtemp(`/tmp/holi-move-${randomUUID()}-`)
  roots.push(path)
  return path
}
afterEach(async () =>
  Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
)

describe('durable note moves', () => {
  it('moves source bytes exactly and rewrites only matching inbound link targets', async () => {
    const base = await root()
    const storage = createVaultStorage(createNodeFiles(), { remote: 'holi/move', root: base })
    const source = text('\uFEFF---\r\ntitle: Cafe\u0301\r\n---\r\n😀\r\n')
    await storage.create('old/é.md', source)
    await storage.create('ref.md', text('[[old/é.md| label ]] [[old/é.md#Heading]] [[other/é.md]]'))
    const moved = await storage.move(
      'old/é.md',
      'new/路径.md',
      (await storage.read('old/é.md')).revision,
    )
    expect([...moved.bytes]).toEqual([...source])
    expect(string((await storage.read('ref.md')).bytes)).toBe(
      '[[new/路径.md| label ]] [[old/é.md#Heading]] [[other/é.md]]',
    )
    await expect(storage.read('old/é.md')).rejects.toThrow()
  })

  it('rejects stale source revisions, collisions and privacy changes', async () => {
    const base = await root()
    const storage = createVaultStorage(createNodeFiles(), { remote: 'holi/move', root: base })
    const original = await storage.create('a.md', text('a'))
    await storage.create('b.md', text('b'))
    await expect(storage.move('a.md', 'b.md', original.revision)).rejects.toThrow()
    await expect(storage.move('a.md', 'private.local.md', original.revision)).rejects.toThrow()
    await expect(storage.move('a.md', 'new.md', 'stale')).rejects.toThrow()
    expect(string((await storage.read('a.md')).bytes)).toBe('a')
  })

  it('does not follow symlinks or accept filesystem spelling aliases', async () => {
    const base = await root()
    const outside = await root()
    await writeFile(join(outside, 'secret.md'), 'outside')
    await symlink(outside, join(base, 'linked'))
    const storage = createVaultStorage(createNodeFiles(), { remote: 'holi/move', root: base })
    await storage.create('A.md', text('a'))
    const rev = (await storage.read('A.md')).revision
    await expect(storage.move('A.md', 'linked/out.md', rev)).rejects.toThrow()
    await expect(storage.move('A.md', 'a.md', rev)).rejects.toThrow()
    expect(await readFile(join(outside, 'secret.md'), 'utf8')).toBe('outside')
  })

  it('recovers exactly once before exposing a vault after each operation checkpoint', async () => {
    for (const phase of [
      'journal-before',
      'journal-after',
      'file-before',
      'file-after',
      'cleanup-before',
      'cleanup-after',
    ] as const) {
      const base = await root()
      const setup = createVaultStorage(createNodeFiles(), { remote: 'holi/setup', root: base })
      const source = await setup.create('from.md', text('source'))
      await setup.create('back.md', text('[[from.md]]'))
      const interrupted = createVaultStorage(createNodeFiles(), {
        remote: 'holi/fault',
        root: base,
        checkpoint: async (event) => {
          if (event.phase === phase) throw new Error(`interrupted ${phase}`)
        },
      })
      await expect(interrupted.move('from.md', 'to.md', source.revision)).rejects.toThrow()
      const reopened = createVaultStorage(createNodeFiles(), { remote: 'holi/reopen', root: base })
      if (phase === 'journal-before') {
        expect(await reopened.list()).toContain('from.md')
        expect(await reopened.list()).not.toContain('to.md')
        expect(string((await reopened.read('back.md')).bytes)).toBe('[[from.md]]')
      } else {
        expect(await reopened.list()).toContain('to.md')
        expect(await reopened.list()).not.toContain('from.md')
        expect(string((await reopened.read('back.md')).bytes)).toBe('[[to.md]]')
      }
    }
  })

  it('refuses malformed recovery evidence without changing vault content', async () => {
    const base = await root()
    const adapter = createNodeFiles()
    const storage = createVaultStorage(adapter, { remote: 'holi/malformed', root: base })
    await storage.create('note.md', text('keep'))
    const id = randomUUID()
    await adapter.privatePublish(
      await adapter.canonicalRoot(base),
      `move-${id}.json`,
      text('{bad'),
      null,
    )
    await expect(storage.list()).rejects.toThrow()
    expect(await readFile(join(base, 'note.md'), 'utf8')).toBe('keep')
    expect(await adapter.privateList(await adapter.canonicalRoot(base))).toContain(
      `move-${id}.json`,
    )
  })

  it('serializes separate handles for one root and isolates identical paths across roots', async () => {
    const a = await root()
    const b = await root()
    const first = createVaultStorage(createNodeFiles(), { remote: 'holi/one', root: a })
    const second = createVaultStorage(createNodeFiles(), { remote: 'holi/one', root: a })
    const other = createVaultStorage(createNodeFiles(), { remote: 'holi/two', root: b })
    const [left, right] = await Promise.all([
      first.create('same.md', text('left')),
      other.create('same.md', text('right')),
    ])
    await expect(second.move('same.md', 'renamed.md', left.revision)).resolves.toMatchObject({
      path: 'renamed.md',
    })
    expect(string((await other.read('same.md')).bytes)).toBe('right')
    expect(string((await second.read('renamed.md')).bytes)).toBe('left')
    expect(right.path).toBe('same.md')
  })
})
