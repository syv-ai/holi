import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  buildSystemPrompt,
  capPrompt,
  MEMORY_MD_BUDGET,
  readVaultTree,
  renderVaultTree,
  USER_MD_BUDGET,
} from '../src/main/agent/system-prompt'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-sysprompt-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('buildSystemPrompt', () => {
  const fixture = {
    identity: '# IDENTITY\n\nSenior engineer pairing on Holi.',
    soul: '# SOUL\n\nCurious and direct.',
    tree: [],
  }

  it('orders identity layers before tools: IDENTITY < SOUL < Tools', () => {
    const out = buildSystemPrompt(fixture)
    const identityIdx = out.indexOf('# IDENTITY')
    const soulIdx = out.indexOf('# SOUL')
    const toolsIdx = out.indexOf('## Tools')
    expect(identityIdx).toBeGreaterThanOrEqual(0)
    expect(soulIdx).toBeGreaterThan(identityIdx)
    expect(toolsIdx).toBeGreaterThan(soulIdx)
  })

  it('omits the identity block when both layers are empty', () => {
    const out = buildSystemPrompt({ identity: '  ', soul: null, tree: [] })
    expect(out.startsWith('## Tools')).toBe(true)
    expect(out).not.toContain('# IDENTITY')
  })

  it('contains every section header', () => {
    const out = buildSystemPrompt(fixture)
    for (const header of [
      '## Tools',
      '## Asking the user',
      '## Agenda heuristics',
      '## Memory: USER.md',
      '## Memory: MEMORY.md',
      '## When to save to memory',
      '## Skills',
      '## The vault system (Holi)',
      '## Vault conventions',
      '## Output formatting',
      '## Scripting',
      '## Vault top-level layout',
    ]) {
      expect(out).toContain(header)
    }
  })

  it('drops the old permission-mode, memory-op, and apps content', () => {
    const out = buildSystemPrompt(fixture)
    expect(out).not.toContain('Permission mode')
    expect(out).not.toContain('mcp__holi__memory_write')
    expect(out).not.toContain('## Apps')
  })

  it('retargets guidance to the 3 ops + native tools', () => {
    const out = buildSystemPrompt(fixture)
    expect(out).toContain('mcp__holi__note_rename')
    expect(out).toContain('mcp__holi__task_list')
    expect(out).toContain('mcp__holi__task_set')
    expect(out).toContain('AskUserQuestion')
    expect(out).toContain(`${USER_MD_BUDGET.toLocaleString('en-US')}`)
    expect(out).toContain(`${MEMORY_MD_BUDGET.toLocaleString('en-US')}`)
  })

  it('names the retired ops nowhere — they are file operations now', () => {
    const out = buildSystemPrompt(fixture)
    for (const retired of ['task_new', 'task_get', 'task_link', 'task_delete']) {
      expect(out).not.toContain(retired)
    }
  })

  it('tells the agent tasks ARE files — the old prompt said the opposite', () => {
    const out = buildSystemPrompt(fixture)
    expect(out).toContain('tasks/<slug>-<id>.md')
    // the two claims that became false when the projection landed. A prompt that
    // still said these would steer the agent away from the whole feature.
    expect(out).not.toContain('There is nothing to `Read` or `Edit` for a task')
    expect(out).not.toContain('they have no path')
    // and it must still route completion through the op, because a file cannot
    // say whether a recurring task rolls forward or ends
    expect(out).toContain('task_set')
  })

  it('joins top-level blocks with the *** separator', () => {
    const out = buildSystemPrompt(fixture)
    expect(out).toContain('\n\n***\n\n')
  })

  it('caps at 192,000 chars with the truncation marker', () => {
    const out = buildSystemPrompt({
      ...fixture,
      identity: 'x'.repeat(300_000),
    })
    expect(out.endsWith('[…truncated to 192,000 chars]')).toBe(true)
    expect(out.length).toBeLessThan(300_000)
  })
})

describe('capPrompt', () => {
  it('returns short text untouched', () => {
    expect(capPrompt('hello', 100)).toBe('hello')
  })

  it('truncates with an en-US thousands-separated marker', () => {
    const out = capPrompt('a'.repeat(200), 100)
    expect(out).toBe(`${'a'.repeat(100)}\n\n[…truncated to 100 chars]`)
    const big = capPrompt('a'.repeat(200_000), 192_000)
    expect(big.endsWith('[…truncated to 192,000 chars]')).toBe(true)
  })
})

describe('readVaultTree / renderVaultTree', () => {
  it('reads top level plus one descent, skips dot-entries, sorts', async () => {
    const root = await tempDir()
    await mkdir(join(root, 'notes', 'deep'), { recursive: true })
    await mkdir(join(root, '.claude'), { recursive: true })
    await writeFile(join(root, 'notes', 'b.md'), 'x')
    await writeFile(join(root, 'notes', 'a.md'), 'x')
    await writeFile(join(root, 'notes', 'deep', 'hidden-level2.md'), 'x')
    await writeFile(join(root, 'zebra.md'), 'x')
    await writeFile(join(root, '.hidden.md'), 'x')

    const tree = await readVaultTree(root)
    expect(tree.map((e) => e.name)).toEqual(['notes', 'zebra.md'])
    const notes = tree[0]!
    expect(notes.isDir).toBe(true)
    expect(notes.children?.map((e) => e.name)).toEqual(['a.md', 'b.md', 'deep'])
    // one descent only — deep/ appears but its children do not
    const deep = notes.children?.find((e) => e.name === 'deep')
    expect(deep?.isDir).toBe(true)
    expect(deep?.children).toBeUndefined()

    const rendered = renderVaultTree(tree)
    expect(rendered).toBe(
      [
        '## Vault top-level layout',
        '- notes/',
        '  - a.md',
        '  - b.md',
        '  - deep/',
        '- zebra.md',
      ].join('\n'),
    )
  })

  it('returns empty tree for a missing root', async () => {
    const tree = await readVaultTree('/nonexistent/holi-vault')
    expect(tree).toEqual([])
    expect(renderVaultTree(tree)).toBe('## Vault top-level layout')
  })
})
