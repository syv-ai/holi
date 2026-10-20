/**
 * Linking community plugins' commands into a vault: what is linked, what is
 * refused and why, and that each run replaces the last.
 */
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { PLUGIN_COMMANDS_DIR } from '@holi/shared'
import { linkCommands } from '../main/commands'

let dir: string
let vault: string

async function plugin(id: string, files: Record<string, number>): Promise<string> {
  const codeDir = join(dir, 'plugins', id)
  for (const [file, mode] of Object.entries(files)) {
    await mkdir(join(codeDir, file, '..'), { recursive: true })
    await writeFile(join(codeDir, file), '#!/bin/sh\n')
    await chmod(join(codeDir, file), mode)
  }
  return codeDir
}

const linked = () => readdir(join(vault, PLUGIN_COMMANDS_DIR)).then((names) => names.sort())

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holi-commands-'))
  vault = join(dir, 'vault')
  await mkdir(vault)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('linkCommands', () => {
  test('links each command and replaces what was linked before', async () => {
    const dash = await plugin('dash', { 'bin/dashctl': 0o755 })
    const gh = await plugin('gh', { 'tool.sh': 0o755 })
    expect(
      await linkCommands(
        vault,
        [
          { id: 'dash', bin: { dashctl: 'bin/dashctl' }, codeDir: dash },
          { id: 'gh', bin: { ghx: 'tool.sh' }, codeDir: gh },
        ],
        '',
      ),
    ).toEqual({ linked: ['dashctl', 'ghx'], refused: [] })
    expect(await linked()).toEqual(['dashctl', 'ghx'])

    await linkCommands(vault, [{ id: 'gh', bin: { ghx: 'tool.sh' }, codeDir: gh }], '')
    expect(await linked()).toEqual(['ghx'])
    await linkCommands(vault, [], '')
    expect(await linked()).toEqual([])
    expect(existsSync(join(vault, `${PLUGIN_COMMANDS_DIR}.next`))).toBe(false)
  })

  test('refuses a name the machine already has on PATH, not shadowing it', async () => {
    const machineBin = join(dir, 'usr-bin')
    await mkdir(machineBin)
    await writeFile(join(machineBin, 'dashctl'), '#!/bin/sh\n')
    await chmod(join(machineBin, 'dashctl'), 0o755)
    const dash = await plugin('dash', { 'bin/dashctl': 0o755 })
    const result = await linkCommands(
      vault,
      [{ id: 'dash', bin: { dashctl: 'bin/dashctl' }, codeDir: dash }],
      `/nowhere:${machineBin}`,
    )
    expect(result.linked).toEqual([])
    expect(result.refused).toEqual([
      {
        id: 'dash',
        name: 'dashctl',
        reason: `${join(machineBin, 'dashctl')} already answers to dashctl`,
      },
    ])
  })

  test('gives a name to the first plugin by id, and says so to the other', async () => {
    const a = await plugin('alpha', { x: 0o755 })
    const b = await plugin('beta', { x: 0o755 })
    const result = await linkCommands(
      vault,
      [
        { id: 'beta', bin: { tool: 'x' }, codeDir: b },
        { id: 'alpha', bin: { tool: 'x' }, codeDir: a },
      ],
      '',
    )
    expect(result).toEqual({
      linked: ['tool'],
      refused: [{ id: 'beta', name: 'tool', reason: 'alpha already adds tool' }],
    })
  })

  test('refuses a missing file, one that is not executable, and a link out of the plugin', async () => {
    const codeDir = await plugin('dash', { 'bin/plain': 0o644 })
    await writeFile(join(dir, 'outside'), '#!/bin/sh\n')
    await chmod(join(dir, 'outside'), 0o755)
    await symlink(join(dir, 'outside'), join(codeDir, 'bin/escape'))
    const result = await linkCommands(
      vault,
      [
        {
          id: 'dash',
          bin: { gone: 'bin/gone', plain: 'bin/plain', escape: 'bin/escape' },
          codeDir,
        },
      ],
      '',
    )
    expect(result.linked).toEqual([])
    expect(result.refused.map((r) => r.reason)).toEqual([
      'bin/gone is not in the plugin',
      'bin/plain is not an executable file',
      'bin/escape points outside the plugin',
    ])
  })
})
