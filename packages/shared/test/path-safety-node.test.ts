import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PathSafetyError } from '../src/path-safety'
import { exactPath, resolveRelative } from '../src/path-safety-node'

let vault: string
beforeEach(async () => {
  // macOS /tmp is a symlink to /private/tmp — canonicalize so expectations
  // compare like with like.
  vault = await realpath(await mkdtemp(join(tmpdir(), 'vault-')))
})
afterEach(async () => {
  await rm(vault, { recursive: true, force: true })
})

describe('resolveRelative (fs canonicalization + containment)', () => {
  it('resolves an existing file inside the vault root', async () => {
    await mkdir(join(vault, 'notes'))
    await writeFile(join(vault, 'notes', 'a.md'), 'hi')
    await expect(resolveRelative(vault, 'notes/a.md')).resolves.toBe(join(vault, 'notes/a.md'))
  })

  it('rejects escape via a symlink planted inside the vault', async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'outside-')))
    try {
      await writeFile(join(outside, 'secret.md'), 'secret')
      await symlink(outside, join(vault, 'escape'))
      await expect(resolveRelative(vault, 'escape/secret.md')).rejects.toThrow(PathSafetyError)
      // …even when the target doesn't exist yet (create-through-symlink):
      await expect(resolveRelative(vault, 'escape/new.md')).rejects.toThrow(PathSafetyError)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('accepts a nonexistent leaf inside the vault (create case), no trailing separator', async () => {
    const resolved = await resolveRelative(vault, 'notes/brand/new.md')
    expect(resolved).toBe(join(vault, 'notes/brand/new.md'))
    expect(resolved.endsWith('/')).toBe(false)
  })

  it('follows a symlink that stays inside the vault to its canonical target', async () => {
    await mkdir(join(vault, 'real'))
    await writeFile(join(vault, 'real', 'a.md'), 'hi')
    await symlink(join(vault, 'real'), join(vault, 'alias'))
    await expect(resolveRelative(vault, 'alias/a.md')).resolves.toBe(join(vault, 'real/a.md'))
  })

  it('rejects lexically invalid input before touching the filesystem', async () => {
    await expect(resolveRelative(vault, '../escape')).rejects.toThrow(PathSafetyError)
    await expect(resolveRelative(vault, '/etc/passwd')).rejects.toThrow(PathSafetyError)
    await expect(resolveRelative(vault, 'a\0b')).rejects.toThrow(PathSafetyError)
    await expect(resolveRelative(vault, '')).rejects.toThrow(PathSafetyError)
  })
})

describe('exactPath (the path is what it says on disk)', () => {
  it('is the path for a real file, and for a leaf that does not exist yet', async () => {
    await mkdir(join(vault, 'notes'))
    await writeFile(join(vault, 'notes', 'a.md'), 'hi')
    await expect(exactPath(vault, 'notes/a.md')).resolves.toBe(join(vault, 'notes/a.md'))
    await expect(exactPath(vault, 'notes/new/b.md')).resolves.toBe(join(vault, 'notes/new/b.md'))
  })

  it('refuses a symlink at any depth, even one that stays inside the vault', async () => {
    await mkdir(join(vault, 'memory'))
    await writeFile(join(vault, 'memory', 'x.md'), 'secret')
    await mkdir(join(vault, 'App.app'))
    await symlink('../memory/x.md', join(vault, 'App.app', 'leaf.txt'))
    await symlink('../memory', join(vault, 'App.app', 'dir'))
    await expect(exactPath(vault, 'App.app/leaf.txt')).resolves.toBeNull()
    await expect(exactPath(vault, 'App.app/dir/x.md')).resolves.toBeNull()
    // Writing through a linked directory is refused too.
    await expect(exactPath(vault, 'App.app/dir/new.json')).resolves.toBeNull()
    await symlink('../memory/gone.json', join(vault, 'App.app', 'dangling.json'))
    await expect(exactPath(vault, 'App.app/dangling.json')).resolves.toBeNull()
  })

  it('refuses a name whose case differs from the one on disk', async () => {
    await mkdir(join(vault, 'data'))
    await writeFile(join(vault, 'data', 'a.json'), '{}')
    // Only a case-insensitive filesystem (macOS by default) opens the alias.
    await expect(exactPath(vault, 'Data/a.json')).resolves.toBeNull()
  })

  it('refuses what vaultRelPath refuses', async () => {
    await expect(exactPath(vault, '../x')).resolves.toBeNull()
    await expect(exactPath(vault, '/etc/passwd')).resolves.toBeNull()
  })
})
