/**
 * Screenshots live in the OS temp directory, owner-only, and prune themselves.
 */
import { lstat, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeScreenshot } from '../src/main/screenshot-files'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

async function folder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holi-shots-'))
  roots.push(root)
  return root
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

describe('writeScreenshot', () => {
  it('makes an owner-only folder and keeps only the newest 20', async () => {
    const dir = join(await folder(), 'shots')
    const paths: string[] = []
    const start = Date.now()
    for (let i = 0; i < 22; i++) {
      paths.push(await writeScreenshot(PNG, { dir, now: start + i * 1000 }))
    }
    const names = (await readdir(dir)).sort()
    expect(names).toHaveLength(20)
    expect(names.map((n) => join(dir, n))).toEqual(paths.slice(2))
    if (process.platform !== 'win32') expect((await lstat(dir)).mode & 0o777).toBe(0o700)
  })

  it('drops one older than a day', async () => {
    const dir = await folder()
    const old = join(dir, '2000-01-01T00-00-00-000Z-aaaaaaaaaaaa.png')
    await writeFile(old, PNG)
    await utimes(old, new Date(2000, 0, 1), new Date(2000, 0, 1))
    const fresh = await writeScreenshot(PNG, { dir })
    expect(await readdir(dir)).toEqual([fresh.split('/').at(-1)])
  })

  it('refuses a folder that is a symlink', async () => {
    const root = await folder()
    await symlink(await folder(), join(root, 'link'))
    await expect(writeScreenshot(PNG, { dir: join(root, 'link') })).rejects.toThrow()
  })
})
