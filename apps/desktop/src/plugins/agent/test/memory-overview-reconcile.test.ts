import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { reconcileMemoryOverviewHook } from '../main/memory/overview-hook'

const roots: string[] = []
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
)

async function vault(settings: string) {
  const root = await mkdtemp(join(tmpdir(), 'holi-overview-reconcile-'))
  roots.push(root)
  await mkdir(join(root, '.claude', 'hooks'), { recursive: true })
  await writeFile(join(root, '.claude', 'settings.json'), settings)
  await writeFile(join(root, '.claude', 'hooks', 'memory-overview.mjs'), 'keep bytes\n')
  return root
}

describe('reconcileMemoryOverviewHook', () => {
  it('disables and re-enables only its hook, idempotently', async () => {
    const initial = JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'custom' }] }],
      },
      permissions: { allow: ['Read(*)'] },
      other: true,
    })
    const root = await vault(initial)
    const script = join(root, '.claude', 'hooks', 'memory-overview.mjs')
    await reconcileMemoryOverviewHook(root, true)
    const enabled = await readFile(join(root, '.claude', 'settings.json'), 'utf8')
    const managed = (settings: {
      hooks: { SessionStart: { matcher?: string; hooks: { command: string }[] }[] }
    }) =>
      settings.hooks.SessionStart.filter((g) =>
        g.hooks.some((h) => h.command.includes('.claude/hooks/memory-overview.mjs')),
      )
    expect(managed(JSON.parse(enabled))).toHaveLength(1)
    expect(managed(JSON.parse(enabled))[0]!.matcher).toBeUndefined()
    await reconcileMemoryOverviewHook(root, true)
    expect(await readFile(join(root, '.claude', 'settings.json'), 'utf8')).toBe(enabled)
    await reconcileMemoryOverviewHook(root, false)
    await reconcileMemoryOverviewHook(root, false)
    const disabled = JSON.parse(await readFile(join(root, '.claude', 'settings.json'), 'utf8'))
    expect(managed(disabled)).toHaveLength(0)
    await reconcileMemoryOverviewHook(root, true)
    expect(
      managed(JSON.parse(await readFile(join(root, '.claude/settings.json'), 'utf8'))),
    ).toHaveLength(1)
    expect(disabled.permissions).toEqual({ allow: ['Read(*)'] })
    expect(disabled.hooks.SessionStart[0]).toEqual({
      matcher: 'startup',
      hooks: [{ type: 'command', command: 'custom' }],
    })
    expect(await readFile(script, 'utf8')).toBe('keep bytes\n')
  })

  it('preserves malformed settings and refuses a settings symlink outside the vault', async () => {
    const root = await vault('{ broken')
    const settings = join(root, '.claude', 'settings.json')
    await expect(reconcileMemoryOverviewHook(root, true)).rejects.toThrow()
    expect(await readFile(settings, 'utf8')).toBe('{ broken')

    const outside = await mkdtemp(join(tmpdir(), 'holi-outside-'))
    roots.push(outside)
    await writeFile(join(outside, 'settings.json'), '{"permissions":{}}')
    await rm(settings)
    await symlink(join(outside, 'settings.json'), settings)
    await expect(reconcileMemoryOverviewHook(root, false)).rejects.toThrow()
    expect(await readFile(join(outside, 'settings.json'), 'utf8')).toBe('{"permissions":{}}')
  })
})
