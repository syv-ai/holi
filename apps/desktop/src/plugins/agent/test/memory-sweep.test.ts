/**
 * Holi's sweep of the agent's short-lived layers: expired personal memories and
 * work-log days past the keep window. Real files in a temp vault.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { staleWorkLogs } from '../main/inbox/work-log'
import { sweepAgentMemory } from '../main/memory/sweep'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

async function vault(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holi-memory-sweep-'))
  roots.push(root)
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true })
    await writeFile(join(root, rel), text, 'utf8')
  }
  return root
}

const expiring = (expires: string) => `---\ntype: project\nexpires: ${expires}\n---\n\nThe fact.\n`

describe('staleWorkLogs', () => {
  it('keeps the last days up to today and leaves anything that is not a day file', () => {
    const names = [
      '2026-10-21.local.md',
      '2026-09-22.local.md',
      '2026-09-21.local.md',
      '2025-01-01.local.md',
      'notes.local.md',
      '2026-13-01.local.md',
    ]
    expect(staleWorkLogs(names, '2026-10-21', 30)).toEqual([
      '2026-09-21.local.md',
      '2025-01-01.local.md',
    ])
  })
})

describe('sweepAgentMemory', () => {
  it('deletes expired personal memories and old log days, and nothing else', async () => {
    const root = await vault({
      '.holi/memory/gone.local.md': expiring('2026-10-20'),
      '.holi/memory/deep/gone-too.local.md': expiring('2026-10-21T09:00'),
      '.holi/memory/still.local.md': expiring('2026-10-21'),
      '.holi/memory/shared.md': expiring('2020-01-01'),
      '.holi/memory/undated.local.md': '---\ntype: person\nexpires: someday\n---\n',
      '.holi/state/log/2026-10-21.local.md': '- 09:00 a\n',
      '.holi/state/log/2026-08-01.local.md': '- 09:00 b\n',
    })

    const deleted = await sweepAgentMemory(root, new Date(2026, 9, 21, 12, 0))

    expect(deleted.sort()).toEqual([
      '.holi/memory/deep/gone-too.local.md',
      '.holi/memory/gone.local.md',
      '.holi/state/log/2026-08-01.local.md',
    ])
    expect((await readdir(join(root, '.holi/memory'))).sort()).toEqual([
      'deep',
      'shared.md',
      'still.local.md',
      'undated.local.md',
    ])
  })

  it('is a no-op in a vault with no memory and no log', async () => {
    expect(await sweepAgentMemory(await vault({}), new Date())).toEqual([])
  })
})
