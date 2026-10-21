import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  THEME_FILE,
  THEME_LOCAL_FILE,
  holiTheme,
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

/** A theme file, written the way a theme file is written: as CSS. */
async function writeTheme(
  root: string,
  rel: string,
  body: Record<string, Record<string, string>>,
): Promise<void> {
  const text = Object.entries(body)
    .map(([mode, block]) => {
      const decls = Object.entries(block)
        .map(([slug, value]) => `  --${slug}: ${value};`)
        .join('\n')
      return `[data-theme='${mode}'] {\n${decls}\n}`
    })
    .join('\n\n')
  await mkdir(join(root, '.holi/settings'), { recursive: true })
  await writeFile(join(root, rel), text, 'utf8')
}

describe('readVaultTheme', () => {
  it('resolves to the empty theme when no files exist', async () => {
    const root = await tempDir()
    expect(await readVaultTheme(root)).toEqual({ light: {}, dark: {}, warnings: [] })
  })

  it('reads the committed theme.css', async () => {
    const root = await tempDir()
    await writeTheme(root, THEME_FILE, { dark: { primary: '#111', radius: '1rem' } })
    const { dark } = await readVaultTheme(root)
    expect(dark).toEqual({ primary: '#111', radius: '1rem' })
  })

  it('lets theme.local.css override the committed file per token', async () => {
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
  it('puts one mode back to Holi’s in the shared file, clears it locally, and leaves the other', async () => {
    const root = await tempDir()
    await writeTheme(root, THEME_FILE, { dark: { primary: '#111' }, light: { primary: '#222' } })
    await writeTheme(root, THEME_LOCAL_FILE, {
      dark: { primary: '#f00' },
      light: { brand: '#0f0' },
    })
    await resetVaultTheme(root, 'dark')
    const { dark, light } = await readVaultTheme(root)
    expect(dark).toEqual(holiTheme().dark)
    expect(light).toEqual({ primary: '#222', brand: '#0f0' })
  })

  it('writes the files when there are none', async () => {
    const root = await tempDir()
    await resetVaultTheme(root, 'light')
    expect((await readVaultTheme(root)).light).toEqual(holiTheme().light)
  })
})
