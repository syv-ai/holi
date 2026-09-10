/**
 * Writing a vault's theme (#16, over D64).
 *
 * The disk half. The merge itself is pure and tested in `@holi/shared`; what is
 * worth testing here is that a write lands in the right FILE, keeps what it did
 * not touch, and survives arriving at a vault that has no theme file yet.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  THEME_FILE,
  THEME_LOCAL_FILE,
  readVaultTheme,
  writeVaultTheme,
} from '../src/main/vault/theme'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

async function vault(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holi-theme-write-'))
  roots.push(root)
  await mkdir(join(root, '.holi/settings'), { recursive: true })
  for (const [rel, text] of Object.entries(files)) await writeFile(join(root, rel), text, 'utf8')
  return root
}

const read = (root: string, rel: string) => readFile(join(root, rel), 'utf8').then(parseYaml)

describe('writeVaultTheme', () => {
  it('creates the committed file when the vault has no theme yet', async () => {
    const root = await vault()

    await writeVaultTheme(root, 'committed', { dark: { primary: '#ff0000' } })

    expect(await read(root, THEME_FILE)).toEqual({
      $schema: 'holi-theme/v1',
      dark: { primary: '#ff0000' },
      light: {},
    })
  })

  it('puts a local write in the local file and leaves the committed one alone', async () => {
    const root = await vault({ [THEME_FILE]: stringifyYaml({ dark: { primary: '#111111' } }) })

    await writeVaultTheme(root, 'local', { dark: { primary: '#ff0000' } })

    expect((await read(root, THEME_LOCAL_FILE)).dark).toEqual({ primary: '#ff0000' })
    expect((await read(root, THEME_FILE)).dark).toEqual({ primary: '#111111' })
  })

  it('keeps tokens the pane never touched', async () => {
    // A vault's theme is as likely to have been written by hand or by the agent
    // as by these controls, so a whole-file replace would eat their work.
    const root = await vault({
      [THEME_FILE]: stringifyYaml({ dark: { primary: '#111111', brand: '#222222' } }),
    })

    await writeVaultTheme(root, 'committed', { dark: { primary: '#ff0000' } })

    expect((await read(root, THEME_FILE)).dark).toEqual({ primary: '#ff0000', brand: '#222222' })
  })

  it('clears a token on null, which is what a reset does', async () => {
    const root = await vault({
      [THEME_FILE]: stringifyYaml({ dark: { primary: '#111111', brand: '#222222' } }),
    })

    await writeVaultTheme(root, 'committed', { dark: { primary: null } })

    expect((await read(root, THEME_FILE)).dark).toEqual({ brand: '#222222' })
  })

  it('does not touch the disk at all for an empty patch', async () => {
    const root = await vault()

    await writeVaultTheme(root, 'committed', {})

    await expect(readFile(join(root, THEME_FILE), 'utf8')).rejects.toThrow()
  })

  it('round-trips: what it writes is what readVaultTheme resolves', async () => {
    // The pane must not be able to store a value that reads back as nothing.
    const root = await vault()

    await writeVaultTheme(root, 'committed', { dark: { primary: '#ff0000' } })
    await writeVaultTheme(root, 'local', { dark: { brand: '#00ff00' } })

    const resolved = await readVaultTheme(root)
    // Local wins per key, committed supplies the rest — D64's layering.
    expect(resolved.dark).toEqual({ primary: '#ff0000', brand: '#00ff00' })
    expect(resolved.warnings).toEqual([])
  })
})
