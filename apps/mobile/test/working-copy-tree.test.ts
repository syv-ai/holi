import { describe, expect, it } from 'vitest'
import {
  prepareWorkingCopyTree,
  type NativeTreePreparation,
  type NativeWorkingCopy,
  type PreparedWorkingCopyTree,
} from '../app/working-copy'
import { createVaultStorage } from '../app/vault-storage'
import { createNodeFiles } from './native-files-node'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Adapter = Pick<NativeWorkingCopy, 'identity'> & NativeTreePreparation
const tree: PreparedWorkingCopyTree = {
  treeOID: 'a'.repeat(40),
  parentOID: 'b'.repeat(40),
  branch: 'main',
  unchanged: false,
}
const bytes = (value: string) => new TextEncoder().encode(value)
const vault = (root: string) => ({ root, remote: 'holi/vault', branch: 'main' })
const signal = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}
const root = () => mkdtemp(join(tmpdir(), 'holi-tree-'))
// Models the classification/result contract; real native containment and Git are covered on iOS.
function adapter(
  paths: string[] = [],
  prepare: (root: string, eligible: string[]) => Promise<PreparedWorkingCopyTree> = async () =>
    tree,
): Adapter {
  return {
    identity: async () => ({ remotes: ['holi/vault'], branch: 'main', attached: true }),
    async prepareWorkingCopyTree(canonical, _remote, _branch, policy) {
      const eligible: string[] = []
      for (const path of paths) {
        const decision = policy(path)
        if (decision === -1) throw new Error('Invalid native candidate')
        if (decision === 1) eligible.push(path)
      }
      return prepare(canonical, eligible)
    },
  }
}

describe('working-copy tree preparation', () => {
  it('includes non-note and hidden content, excluding protected aliases before content selection', async () => {
    const base = await root()
    try {
      const candidates = [
        'note.md',
        'image.bin',
        'document.pdf',
        '.ordinary',
        '.env',
        '.ENV',
        'private.local.md',
        'private.LOCAL.md',
        '.holi-storage-private/data',
      ]
      let selected: string[] = []
      const native = adapter(candidates, async (_root, eligible) => {
        selected = eligible
        return tree
      })
      expect(await prepareWorkingCopyTree(createNodeFiles(), native, vault(base))).toEqual(tree)
      expect(selected).toEqual(['note.md', 'image.bin', 'document.pdf', '.ordinary'])
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('makes canonical aliases observe completed saves while another checkout remains independent', async () => {
    const base = await root()
    const other = await root()
    const alias = `${base}-alias`
    const entered = signal()
    const release = signal()
    const pending: Promise<unknown>[] = []
    const track = <T>(promise: Promise<T>) => {
      pending.push(promise)
      void promise.catch(() => undefined)
      return promise
    }
    let armed = false
    try {
      await symlink(base, alias)
      await writeFile(join(other, 'note.md'), 'independent')
      const files = createNodeFiles(async (phase) => {
        if (armed && phase === 'stage-write') {
          entered.resolve()
          await release.promise
        }
      })
      const storage = createVaultStorage(files, vault(base))
      await storage.create('note.md', bytes('before'))
      armed = true
      const saving = track(
        storage.save('note.md', bytes('saved'), (await storage.read('note.md')).revision),
      )
      await entered.promise
      const observed = new Map<string, string>()
      const native = adapter(['note.md'], async (canonical) => {
        observed.set(canonical, await readFile(join(canonical, 'note.md'), 'utf8'))
        return tree
      })
      const waiting = track(prepareWorkingCopyTree(files, native, vault(alias)))
      expect(await prepareWorkingCopyTree(files, native, vault(other))).toEqual(tree)
      expect([...observed.values()]).toEqual(['independent'])
      release.resolve()
      await saving
      expect(await waiting).toEqual(tree)
      expect([...observed.values()]).toEqual(['independent', 'saved'])
    } finally {
      release.resolve()
      await Promise.allSettled(pending)
      await rm(alias, { force: true })
      await rm(base, { recursive: true, force: true })
      await rm(other, { recursive: true, force: true })
    }
  })

  it('recovers an interrupted public move before preparation and permits subsequent saves', async () => {
    const base = await root()
    try {
      const files = createNodeFiles()
      const storage = createVaultStorage(files, vault(base))
      const source = await storage.create('from.md', bytes('moved bytes'))
      const interrupted = createVaultStorage(files, vault(base), {
        checkpoint: async (event) => {
          if (
            event.phase === 'file-after' &&
            event.direction === 'after' &&
            event.path === 'from.md'
          )
            throw new Error('interrupt move')
        },
      })
      await expect(interrupted.move('from.md', 'to.md', source.revision)).rejects.toThrow()
      let observed = ''
      const native = adapter(['to.md'], async (canonical) => {
        observed = await readFile(join(canonical, 'to.md'), 'utf8')
        return tree
      })
      expect(await prepareWorkingCopyTree(files, native, vault(base))).toEqual(tree)
      expect(observed).toBe('moved bytes')
      const current = await storage.read('to.md')
      expect((await storage.save('to.md', bytes('ordinary save'), current.revision)).bytes).toEqual(
        bytes('ordinary save'),
      )
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('refuses invalid identities and unsupported names, and propagates native failure', async () => {
    const base = await root()
    try {
      let selected = false
      const native = adapter([], async () => {
        selected = true
        return tree
      })
      await expect(
        prepareWorkingCopyTree(createNodeFiles(), native, { ...vault(base), remote: 'bad remote' }),
      ).rejects.toThrow()
      expect(selected).toBe(false)
      await expect(
        prepareWorkingCopyTree(createNodeFiles(), adapter(['bad\\name.md']), vault(base)),
      ).rejects.toThrow('Invalid native candidate')
      const failure = adapter([], async () => {
        throw new Error('Native refused unsafe entry')
      })
      await expect(prepareWorkingCopyTree(createNodeFiles(), failure, vault(base))).rejects.toThrow(
        'Native refused unsafe entry',
      )
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('rejects malformed native receipts instead of exposing a successful preparation', async () => {
    const base = await root()
    try {
      for (const invalid of [
        { ...tree, treeOID: 'a'.repeat(41) },
        { ...tree, parentOID: null },
        { ...tree, branch: 'wrong' },
      ]) {
        const native = adapter([], async () => invalid as PreparedWorkingCopyTree)
        await expect(
          prepareWorkingCopyTree(createNodeFiles(), native, vault(base)),
        ).rejects.toThrow()
      }
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})
