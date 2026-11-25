import { describe, expect, it } from 'vitest'
import {
  prepareWorkingCopyTree,
  type NativeWorkingCopy,
  type NativeTreePreparation,
} from '../app/working-copy'
import { createNodeFiles } from './native-files-node'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tree = { treeOID: 'a'.repeat(40), parentOID: null, branch: 'main', unchanged: false }

describe('prepareWorkingCopyTree', () => {
  it('authorizes the complete eligible inventory and excludes protected aliases before preparation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holi-tree-'))
    try {
      const seen: string[][] = []
      const native: NativeWorkingCopy & NativeTreePreparation = {
        recoveryPending: async () => false,
        canonicalRoot: async (value) => value,
        identity: async () => ({ remotes: ['holi/vault'], branch: 'main', attached: true }),
        candidates: async () => [
          { path: 'note.md' },
          { path: 'assets/image.bin' },
          { path: '.env' },
          { path: 'private.local.md' },
          { path: 'again/note.md'.normalize('NFC') },
          { path: 'AGAIN/note.md' },
        ],
        authorize: async () => true,
        status: async () => [],
        prepareWorkingCopyTree: async (_root, _remote, _branch, paths) => {
          seen.push(paths)
          return tree
        },
      }
      const result = await prepareWorkingCopyTree(createNodeFiles(), native, {
        root,
        remote: 'holi/vault',
        branch: 'main',
      })
      expect(result).toEqual(tree)
      expect(seen[0]).toEqual(['assets/image.bin', 'note.md'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses invalid identity and unsafe eligible candidates before native preparation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holi-tree-'))
    try {
      let prepared = false
      const native: NativeWorkingCopy & NativeTreePreparation = {
        recoveryPending: async () => false,
        canonicalRoot: async (value) => value,
        identity: async () => ({ remotes: ['holi/vault'], branch: 'main', attached: true }),
        candidates: async () => [{ path: 'note.md' }],
        authorize: async () => false,
        status: async () => [],
        prepareWorkingCopyTree: async () => {
          prepared = true
          return tree
        },
      }
      await expect(
        prepareWorkingCopyTree(createNodeFiles(), native, {
          root,
          remote: 'bad remote',
          branch: 'main',
        }),
      ).rejects.toThrow()
      await expect(
        prepareWorkingCopyTree(createNodeFiles(), native, {
          root,
          remote: 'holi/vault',
          branch: 'main',
        }),
      ).rejects.toThrow()
      expect(prepared).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
