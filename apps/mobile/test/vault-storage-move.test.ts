import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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
    const source = text(
      '\uFEFF---\r\ntitle: Cafe\u0301\r\n---\r\n😀 [[old/é.md| self ]] [[old/é.md#Heading]]\r\n',
    )
    await mkdir(join(base, 'old'))
    await mkdir(join(base, 'new'))
    await storage.create('old/é.md', source)
    await storage.create('ref.md', text('[[old/é.md| label ]] [[old/é.md#Heading]] [[other/é.md]]'))
    const moved = await storage.move(
      'old/é.md',
      'new/路径.md',
      (await storage.read('old/é.md')).revision,
    )
    expect(string(moved.bytes)).toBe(
      '\uFEFF---\r\ntitle: Café\r\n---\r\n😀 [[new/路径.md| self ]] [[old/é.md#Heading]]\r\n',
    )
    expect([...moved.bytes]).not.toEqual([...source])
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
    await expect(storage.move('a.md', 'missing/new.md', original.revision)).rejects.toThrow()
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

  it('publishes both directions for every planned path and journals cleanup', async () => {
    const base = await root()
    const setup = createVaultStorage(createNodeFiles(), {
      remote: 'holi/checkpoint-setup',
      root: base,
    })
    const from = await setup.create('from.md', text('[[from.md]]'))
    await setup.create('back.md', text('[[from.md]]'))
    const events: { phase: string; direction: string; path?: string }[] = []
    const observed = createVaultStorage(createNodeFiles(), {
      remote: 'holi/checkpoint-observe',
      root: base,
      checkpoint: async ({ phase, direction, path }) => {
        events.push({ phase, direction, path })
      },
    })
    await observed.move('from.md', 'to.md', from.revision)
    expect(events).toEqual([
      { phase: 'journal-before', direction: 'before', path: undefined },
      { phase: 'journal-after', direction: 'after', path: undefined },
      ...['from.md', 'to.md', 'back.md'].flatMap((path) => [
        { phase: 'file-before', direction: 'before', path },
        { phase: 'file-after', direction: 'after', path },
      ]),
      {
        phase: 'cleanup-before',
        direction: 'before',
        path: expect.stringMatching(/^move-.*\.json$/),
      },
      {
        phase: 'cleanup-after',
        direction: 'after',
        path: expect.stringMatching(/^move-.*\.json$/),
      },
    ])
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

  it('refuses conflicting preimages and preserves the recovery journal', async () => {
    const base = await root()
    const adapter = createNodeFiles()
    const storage = createVaultStorage(adapter, { remote: 'holi/conflict', root: base })
    await storage.create('note.md', text('newer user bytes'))
    const id = randomUUID()
    const journal = {
      schema: 1,
      root: await adapter.canonicalRoot(base),
      operationId: id,
      changes: [
        { path: 'note.md', before: [...text('old bytes')], after: [...text('renamed bytes')] },
        { path: 'target.md', before: null, after: [...text('newer user bytes')] },
      ],
    }
    await adapter.privatePublish(
      journal.root,
      `move-${id}.json`,
      text(JSON.stringify(journal)),
      null,
    )
    await expect(storage.list()).rejects.toThrow()
    expect(await readFile(join(base, 'note.md'), 'utf8')).toBe('newer user bytes')
    expect(await adapter.privateList(journal.root)).toContain(`move-${id}.json`)
  })

  it('rejects semantically forged plans even when filesystem preimages match', async () => {
    const base = await root()
    const adapter = createNodeFiles()
    const storage = createVaultStorage(adapter, { remote: 'holi/forged', root: base })
    await storage.create('from.md', text('[[other.md]]'))
    await storage.create('other.md', text('untouched'))
    const id = randomUUID()
    const canonical = await adapter.canonicalRoot(base)
    const journal = {
      schema: 2,
      root: canonical,
      operationId: id,
      from: 'from.md',
      to: 'to.md',
      changes: [
        { path: 'from.md', before: [...text('[[other.md]]')], after: null },
        { path: 'to.md', before: null, after: [...text('[[other.md]]')] },
        { path: 'other.md', before: [...text('untouched')], after: [...text('forged rewrite')] },
      ],
    }
    await adapter.privatePublish(canonical, `move-${id}.json`, text(JSON.stringify(journal)), null)
    await expect(storage.list()).rejects.toThrow()
    expect(await readFile(join(base, 'from.md'), 'utf8')).toBe('[[other.md]]')
    expect(await readFile(join(base, 'other.md'), 'utf8')).toBe('untouched')
    expect(await adapter.privateList(canonical)).toContain(`move-${id}.json`)
  })

  it('can be interrupted repeatedly during recovery without losing the operation', async () => {
    const base = await root()
    const setup = createVaultStorage(createNodeFiles(), {
      remote: 'holi/recovery-setup',
      root: base,
    })
    const source = await setup.create('from.md', text('source'))
    await setup.create('back.md', text('[[from.md]]'))
    const interruptedMove = createVaultStorage(createNodeFiles(), {
      remote: 'holi/recovery-interrupt',
      root: base,
      checkpoint: async (event) => {
        if (event.phase === 'file-after' && event.direction === 'after' && event.path === 'from.md')
          throw new Error('pause after unlink')
      },
    })
    await expect(interruptedMove.move('from.md', 'to.md', source.revision)).rejects.toThrow()
    const interruptedRecovery = createVaultStorage(createNodeFiles(), {
      remote: 'holi/recovery-interrupt-again',
      root: base,
      checkpoint: async (event) => {
        if (event.phase === 'file-before' && event.direction === 'before')
          throw new Error('pause during recovery')
      },
    })
    await expect(interruptedRecovery.list()).rejects.toThrow()
    const recovered = createVaultStorage(createNodeFiles(), {
      remote: 'holi/recovered',
      root: base,
    })
    expect(await recovered.list()).toContain('to.md')
    expect(await recovered.list()).not.toContain('from.md')
    expect(string((await recovered.read('back.md')).bytes)).toBe('[[to.md]]')
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
    let announce!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
      announce = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const delayed = createVaultStorage(createNodeFiles(), {
      remote: 'holi/delayed',
      root: a,
      checkpoint: async (event) => {
        if (
          event.phase === 'file-before' &&
          event.direction === 'before' &&
          event.path === 'same.md'
        ) {
          announce()
          await gate
        }
      },
    })
    const moving = delayed.move('same.md', 'renamed.md', left.revision)
    await entered
    let readFinished = false
    const reading = second.read('same.md').then((value) => {
      readFinished = true
      return value
    })
    await Promise.resolve()
    expect(readFinished).toBe(false)
    release()
    await expect(moving).resolves.toMatchObject({ path: 'renamed.md' })
    await expect(reading).rejects.toThrow()
    expect(string((await other.read('same.md')).bytes)).toBe('right')
    expect(string((await second.read('renamed.md')).bytes)).toBe('left')
    expect(right.path).toBe('same.md')
  })
})
