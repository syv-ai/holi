import { describe, expect, it } from 'vitest'
import {
  prepareWorkingCopyTree,
  type NativeWorkingCopy,
  type NativeTreePreparation,
} from '../app/working-copy'
import { createVaultStorage } from '../app/vault-storage'
import { createNodeFiles } from './native-files-node'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tree = {
  treeOID: 'a'.repeat(40),
  parentOID: 'b'.repeat(40),
  branch: 'main',
  unchanged: false,
}
const bytes = (value: string) => new TextEncoder().encode(value)
const signal = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

async function root() {
  return mkdtemp(join(tmpdir(), 'holi-tree-'))
}

describe('prepareWorkingCopyTree', () => {
  it('classifies native inventory paths without authorizing or proving native containment', async () => {
    const base = await root()
    try {
      let decisions: Array<[string, number]> = []
      const native: NativeWorkingCopy & NativeTreePreparation = {
        recoveryPending: async () => false,
        canonicalRoot: async (value) => value,
        identity: async () => ({ remotes: ['holi/vault'], branch: 'main', attached: true }),
        candidates: async () => [
          { path: 'note.md' },
          { path: 'assets/image.bin' },
          { path: 'document.pdf' },
          { path: '.ordinary' },
          { path: '.env' },
          { path: '.ENV' },
          { path: 'private.local.md' },
          { path: 'private.LOCAL.md' },
          { path: '.holi-storage-test/data' },
        ],
        status: async () => [],
        prepareWorkingCopyTree: async (_root, _remote, _branch, policy) => {
          decisions = [
            'note.md',
            'assets/image.bin',
            'document.pdf',
            '.ordinary',
            '.env',
            '.ENV',
            'private.local.md',
            'private.LOCAL.md',
            '.holi-storage-test/data',
          ].map((path) => [path, policy(path)])
          if (decisions.some(([, decision]) => decision === -1)) throw new Error('unsafe candidate')
          return tree
        },
      }
      const result = await prepareWorkingCopyTree(createNodeFiles(), native, {
        root: base,
        remote: 'holi/vault',
        branch: 'main',
      })
      expect(result).toEqual(tree)
      expect(decisions).toEqual([
        ['note.md', 1],
        ['assets/image.bin', 1],
        ['document.pdf', 1],
        ['.ordinary', 1],
        ['.env', 0],
        ['.ENV', 0],
        ['private.local.md', 0],
        ['private.LOCAL.md', 0],
        ['.holi-storage-test/data', 0],
      ])
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('waits for a save through a canonical alias while another checkout prepares independently', async () => {
    const base = await root()
    const other = await root()
    const alias = `${base}-alias`
    const entered = signal()
    const release = signal()
    let armed = false
    const pending: Promise<unknown>[] = []
    const track = <T>(promise: Promise<T>) => {
      pending.push(promise)
      void promise.catch(() => undefined)
      return promise
    }
    try {
      await symlink(base, alias)
      await writeFile(join(other, 'note.md'), 'independent')
      const files = createNodeFiles(async (phase) => {
        if (armed && phase === 'stage-write') {
          entered.resolve()
          await release.promise
        }
      })
      const storage = createVaultStorage(files, { remote: 'holi/vault', root: base })
      await storage.create('note.md', bytes('before'))
      armed = true
      const saving = track(
        storage.save('note.md', bytes('saved'), (await storage.read('note.md')).revision),
      )
      await entered.promise
      let output = ''
      const nativeFor = (): NativeWorkingCopy & NativeTreePreparation => ({
        recoveryPending: async () => false,
        canonicalRoot: async (value) => files.canonicalRoot(value),
        identity: async () => ({ remotes: ['holi/vault'], branch: 'main', attached: true }),
        candidates: async () => [{ path: 'note.md' }],
        status: async () => [],
        prepareWorkingCopyTree: async (canonical) => {
          output = await readFile(join(canonical, 'note.md'), 'utf8')
          return tree
        },
      })
      const waiting = track(
        prepareWorkingCopyTree(files, nativeFor(), {
          root: alias,
          remote: 'holi/vault',
          branch: 'main',
        }),
      )
      const independent = await prepareWorkingCopyTree(files, nativeFor(), {
        root: other,
        remote: 'holi/vault',
        branch: 'main',
      })
      expect(independent).toEqual(tree)
      release.resolve()
      await saving
      expect(await waiting).toEqual(tree)
      expect(output).toBe('saved')
    } finally {
      release.resolve()
      await Promise.allSettled(pending)
      await rm(base, { recursive: true, force: true })
      await rm(other, { recursive: true, force: true })
      await rm(alias, { recursive: true, force: true })
    }
  })

  it('recovers an interrupted public move before native preparation', async () => {
    const base = await root()
    try {
      const files = createNodeFiles()
      const setup = createVaultStorage(files, { remote: 'holi/vault', root: base })
      const source = await setup.create('from.md', bytes('moved bytes'))
      const interrupted = createVaultStorage(
        files,
        { remote: 'holi/vault', root: base },
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
      let observed = ''
      const native: NativeWorkingCopy & NativeTreePreparation = {
        recoveryPending: async () => false,
        canonicalRoot: async (value) => files.canonicalRoot(value),
        identity: async () => ({ remotes: ['holi/vault'], branch: 'main', attached: true }),
        candidates: async () => [{ path: 'to.md' }],
        status: async () => [],
        prepareWorkingCopyTree: async (canonical) => {
          observed = await readFile(join(canonical, 'to.md'), 'utf8')
          return tree
        },
      }
      expect(
        await prepareWorkingCopyTree(files, native, {
          root: base,
          remote: 'holi/vault',
          branch: 'main',
        }),
      ).toEqual(tree)
      expect(observed).toBe('moved bytes')
      const current = await setup.read('to.md')
      expect((await setup.save('to.md', bytes('ordinary save'), current.revision)).bytes).toEqual(
        bytes('ordinary save'),
      )
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('refuses ambiguous paths and invalid native object identifiers before exposing native output', async () => {
    const base = await root()
    try {
      let prepared = false
      const native: NativeWorkingCopy & NativeTreePreparation = {
        recoveryPending: async () => false,
        canonicalRoot: async (value) => value,
        identity: async () => ({ remotes: ['holi/vault'], branch: 'main', attached: true }),
        candidates: async () => [{ path: 'note.md' }],
        status: async () => [],
        prepareWorkingCopyTree: async () => {
          prepared = true
          return { ...tree, treeOID: 'a'.repeat(41) }
        },
      }
      await expect(
        prepareWorkingCopyTree(createNodeFiles(), native, {
          root: base,
          remote: 'holi/vault',
          branch: 'main',
        }),
      ).rejects.toThrow()
      expect(prepared).toBe(false)
      const invalidPath = {
        ...native,
        prepareWorkingCopyTree: async (
          _root: string,
          _remote: string,
          _branch: string,
          policy: (path: string) => number,
        ) => {
          const decisions = (await native.candidates(_root)).map(({ path }) => policy(path))
          expect(decisions).toContain(-1)
          throw new Error('unsafe candidate')
        },
        candidates: async () => [{ path: 'bad\\path.md' }],
      }
      await expect(
        prepareWorkingCopyTree(createNodeFiles(), invalidPath, {
          root: base,
          remote: 'holi/vault',
          branch: 'main',
        }),
      ).rejects.toThrow('unsafe candidate')
      const invalidResult = { ...native, candidates: async () => [{ path: 'note.md' }] }
      await expect(
        prepareWorkingCopyTree(createNodeFiles(), invalidResult, {
          root: base,
          remote: 'holi/vault',
          branch: 'main',
        }),
      ).rejects.toThrow()
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('refuses invalid identity before native preparation', async () => {
    const base = await root()
    try {
      let prepared = false
      const native: NativeWorkingCopy & NativeTreePreparation = {
        recoveryPending: async () => false,
        canonicalRoot: async (value) => value,
        identity: async () => ({ remotes: ['holi/vault'], branch: 'main', attached: true }),
        candidates: async () => [{ path: 'note.md' }],
        status: async () => [],
        prepareWorkingCopyTree: async () => {
          prepared = true
          return tree
        },
      }
      await expect(
        prepareWorkingCopyTree(createNodeFiles(), native, {
          root: base,
          remote: 'bad remote',
          branch: 'main',
        }),
      ).rejects.toThrow()
      await expect(
        prepareWorkingCopyTree(createNodeFiles(), native, {
          root: base,
          remote: 'holi/vault',
          branch: 'main',
        }),
      ).rejects.toThrow()
      expect(prepared).toBe(false)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})
