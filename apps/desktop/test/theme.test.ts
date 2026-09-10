import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  THEME_FILE,
  THEME_LOCAL_FILE,
  readVaultTheme,
  resetVaultTheme,
} from '../src/main/vault/theme'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-theme-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function writeTheme(root: string, rel: string, body: unknown): Promise<void> {
  await mkdir(join(root, '.holi/settings'), { recursive: true })
  await writeFile(join(root, rel), JSON.stringify(body), 'utf8')
}

describe('readVaultTheme', () => {
  it('resolves to the empty theme when no files exist', async () => {
    const root = await tempDir()
    expect(await readVaultTheme(root)).toEqual({ light: {}, dark: {}, warnings: [] })
  })

  it('reads the committed theme.json', async () => {
    const root = await tempDir()
    await writeTheme(root, THEME_FILE, { dark: { primary: '#111', radius: '1rem' } })
    const { dark } = await readVaultTheme(root)
    expect(dark).toEqual({ primary: '#111', radius: '1rem' })
  })

  it('lets theme.local.json override the committed file per key', async () => {
    const root = await tempDir()
    await writeTheme(root, THEME_FILE, { dark: { primary: '#111', background: '#000' } })
    await writeTheme(root, THEME_LOCAL_FILE, { dark: { primary: '#f00' } })
    const { dark } = await readVaultTheme(root)
    expect(dark).toEqual({ primary: '#f00', background: '#000' })
  })

  it('drops non-whitelisted / invalid keys as it resolves', async () => {
    const root = await tempDir()
    await writeTheme(root, THEME_FILE, { dark: { primary: '#111', width: '50px' } })
    const { dark, warnings } = await readVaultTheme(root)
    expect(dark).toEqual({ primary: '#111' })
    expect(warnings.some((w) => w.includes('width'))).toBe(true)
  })
})

describe('resetVaultTheme', () => {
  it('removes both theme files, returning the vault to standard', async () => {
    const root = await tempDir()
    await writeTheme(root, THEME_FILE, { dark: { primary: '#111' } })
    await writeTheme(root, THEME_LOCAL_FILE, { dark: { primary: '#f00' } })
    await resetVaultTheme(root)
    expect(await readVaultTheme(root)).toEqual({ light: {}, dark: {}, warnings: [] })
  })

  it('is a no-op when there is no theme to reset', async () => {
    const root = await tempDir()
    await expect(resetVaultTheme(root)).resolves.toBeUndefined()
  })
})
