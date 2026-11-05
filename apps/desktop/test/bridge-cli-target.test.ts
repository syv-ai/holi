import { describe, expect, it } from 'vitest'
import { resolveArgv } from '../src/main/bridge/cli'
import type { CliCommand } from '../src/main/capabilities/registry'

const command: CliCommand = {
  name: 'docs.read',
  cli: { args: ['path'], summary: 'read', stdin: 'content' },
}

describe('CLI vault selector', () => {
  it('removes the selector from params and supports equals syntax after prefix', () => {
    expect(
      resolveArgv(['docs', 'read', 'note.md', '--vault=owner/repo'], [command], null),
    ).toMatchObject({
      kind: 'stdin',
      vault: 'owner/repo',
    })
  })

  it('retains selectors on stdin requests and respects --', () => {
    expect(
      resolveArgv(['docs', 'read', 'note.md', '--vault', 'owner/repo'], [command], null),
    ).toMatchObject({ kind: 'stdin', vault: 'owner/repo' })
    expect(resolveArgv(['docs', 'read', '--', '--vault'], [command], null)).toMatchObject({
      kind: 'stdin',
      vault: null,
    })
  })

  it('rejects missing, duplicate, and malformed selectors', () => {
    for (const args of [
      ['docs', 'read', 'x', '--vault'],
      ['docs', 'read', 'x', '--vault=a/b', '--vault', 'c/d'],
      ['docs', 'read', 'x', '--vault=a'],
      ['--vault=a/b', 'docs', 'read', 'x'],
    ])
      expect(resolveArgv(args, [command], null).kind).toBe('usage')
  })
})
