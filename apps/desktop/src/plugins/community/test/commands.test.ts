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
import { linkCommands, unlinkCommands, type PluginCommands } from '../main/commands'

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

  test("refuses a plugin whose folder can't be read, and links the others", async () => {
    const gh = await plugin('gh', { 'tool.sh': 0o755 })
    const gone = join(dir, 'plugins', 'gone')
    const result = await linkCommands(
      vault,
      [
        { id: 'gone', bin: { dashctl: 'bin/dashctl' }, codeDir: gone },
        { id: 'gh', bin: { ghx: 'tool.sh' }, codeDir: gh },
      ],
      '',
    )
    expect(result).toEqual({
      linked: ['ghx'],
      refused: [
        { id: 'gone', name: 'dashctl', reason: `the plugin's folder ${gone} can't be read` },
      ],
    })
  })

  test('runs rebuilds of a vault one at a time, the last one winning', async () => {
    const a = await plugin('alpha', { x: 0o755 })
    const b = await plugin('beta', { x: 0o755 })
    const sets: PluginCommands[][] = [
      [{ id: 'alpha', bin: { one: 'x' }, codeDir: a }],
      [{ id: 'beta', bin: { two: 'x' }, codeDir: b }],
      [],
      [
        { id: 'alpha', bin: { one: 'x' }, codeDir: a },
        { id: 'beta', bin: { two: 'x' }, codeDir: b },
      ],
    ]
    const results = await Promise.all(
      [...sets, ...sets].map((plugins) => linkCommands(vault, plugins, '')),
    )
    expect(results.at(-1)).toEqual({ linked: ['one', 'two'], refused: [] })
    expect(await linked()).toEqual(['one', 'two'])
    expect(existsSync(join(vault, `${PLUGIN_COMMANDS_DIR}.next`))).toBe(false)
  })

  test('reads what runs when its turn comes', async () => {
    const a = await plugin('alpha', { x: 0o755 })
    let running = [{ id: 'alpha', bin: { one: 'x' }, codeDir: a }]
    const first = linkCommands(vault, running, '')
    const second = linkCommands(vault, async () => running, '')
    running = []
    await first
    expect(await second).toEqual({ linked: [], refused: [] })
  })

  test('takes every command away when the community plugin is off', async () => {
    const a = await plugin('alpha', { x: 0o755 })
    await linkCommands(vault, [{ id: 'alpha', bin: { one: 'x' }, codeDir: a }], '')
    await unlinkCommands(vault)
    expect(await linked()).toEqual([])
  })
})
