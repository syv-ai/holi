import { it, expect, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyVaultSnapshot } from '@holi/shared'

const race = vi.hoisted(() => ({
  root: '',
  outside: '',
  armed: false,
  swapped: false,
  restored: false,
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      if (race.armed && String(args[0]).endsWith('/dir/file.txt')) {
        race.armed = false
        await fs.rename(join(race.root, 'dir'), join(race.root, 'saved-dir'))
        await fs.symlink(race.outside, join(race.root, 'dir'))
        race.swapped = true
      }
      return fs.open(...args)
    },
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      const result = await fs.lstat(...args)
      if (race.swapped && !race.restored && String(args[0]).endsWith('/dir/file.txt')) {
        await fs.unlink(join(race.root, 'dir'))
        await fs.rename(join(race.root, 'saved-dir'), join(race.root, 'dir'))
        race.restored = true
      }
      return result
    },
  }
})

const { vaultAttachments } = await import('../main/attachments')

it('refuses the file opened outside the vault during an ancestor ABA swap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-vault-race-'))
  const outside = await mkdtemp(join(tmpdir(), 'holi-outside-race-'))
  try {
    await mkdir(join(root, 'dir'))
    await writeFile(join(root, 'dir/file.txt'), 'approved bytes')
    await writeFile(join(outside, 'file.txt'), 'synthetic outside secret')
    Object.assign(race, { root, outside, armed: true, swapped: false, restored: false })
    const ctx = {
      root,
      remote: 'owner/repo',
      bundle: null,
      snapshot: async () => ({
        ...emptyVaultSnapshot(),
        files: [{ path: 'dir/file.txt', updatedAt: '' }],
      }),
    } as any

    await expect(vaultAttachments(ctx, ['dir/file.txt'])).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(race.swapped).toBe(true)
    expect(race.restored).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
