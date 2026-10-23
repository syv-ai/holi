/**
 * What a session's `init` and `result` add to a chat (its `/` commands, the
 * model that answered, a turn's tokens) and the `/` menu's sources.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeChatArgs, newClaudeReader, readClaudeRecord, turnUsage } from '../main/claude-stream'
import { describe as describeFile, listCommands } from '../main/commands'
import { applyChatEvent, modelLabel } from '../shared/chat'

/** Trimmed from a real Claude Code 2.1 run. */
const INIT = {
  type: 'system',
  subtype: 'init',
  session_id: 's-1',
  model: 'claude-haiku-5-5',
  slash_commands: ['tdd', 'syv-skills:handoff', 'compact', 'context', 'doctor', 'standup'],
  terminal_slash_commands: ['doctor'],
  skills: ['tdd', 'syv-skills:handoff'],
}
const RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  session_id: 's-1',
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 16158,
    cache_read_input_tokens: 11335,
    output_tokens: 22,
  },
  modelUsage: { 'claude-sonnet-5-5': { outputTokens: 22, contextWindow: 1000000 } },
}

describe('a session tells the chat', () => {
  it('passes the effort to Claude Code', () => {
    expect(claudeChatArgs({ mode: 'default', effort: 'medium' }).join(' ')).toContain(
      '--effort medium',
    )
  })

  it('its / commands, leaving out the TUI-only ones', () => {
    const res = readClaudeRecord(newClaudeReader(), INIT)
    expect(res.commands?.names).toEqual([
      'tdd',
      'syv-skills:handoff',
      'compact',
      'context',
      'standup',
    ])
    expect(res.commands?.skills).toEqual(['tdd', 'syv-skills:handoff'])
    expect(res.sessionId).toBe('s-1')
  })

  it('the model that answered and what the turn cost', () => {
    const reader = newClaudeReader()
    readClaudeRecord(reader, INIT)
    const end = readClaudeRecord(reader, RESULT).turnEnded!
    expect(end.model).toBe('claude-sonnet-5-5')
    expect(end.usage).toMatchObject({ inputTokens: 2, outputTokens: 22, cacheReadTokens: 11335 })
    expect(Math.round(end.usage!.cacheHitPercent!)).toBe(41)
    expect(turnUsage({ type: 'result' })).toBeUndefined()
  })

  it('keeps them on the turn', () => {
    let items = applyChatEvent([], { type: 'turn-start', id: 't', at: 0 }).items
    items = applyChatEvent(items, {
      type: 'turn-end',
      at: 6_000,
      model: 'claude-opus-5-5',
      usage: { outputTokens: 22 },
    }).items
    expect(items[0]).toMatchObject({ endedAt: 6_000, model: 'claude-opus-5-5' })
  })
})

describe('modelLabel', () => {
  it('reads a model as a person does', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelLabel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
    expect(modelLabel('claude-haiku-4')).toBe('Haiku 4')
    expect(modelLabel('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5')
    expect(modelLabel('claude-opus-5-5[1m]')).toBe('Opus 5.5')
    expect(modelLabel('opus')).toBe('Opus')
    expect(modelLabel('gpt-x')).toBe('gpt-x')
  })
})

describe('the / menu', () => {
  async function vault() {
    const root = await mkdtemp(join(tmpdir(), 'holi-commands-'))
    const config = join(root, '.config')
    await mkdir(join(root, '.claude/commands/notes'), { recursive: true })
    await mkdir(join(root, '.claude/skills/standup'), { recursive: true })
    await mkdir(join(config, 'skills/tdd'), { recursive: true })
    await writeFile(
      join(root, '.claude/commands/notes/weekly.md'),
      '---\ndescription: "Write the weekly note"\n---\nBody',
    )
    await writeFile(
      join(root, '.claude/skills/standup/SKILL.md'),
      '---\nname: standup\ndescription: Brief me on today\n---\n',
    )
    await writeFile(join(config, 'skills/tdd/SKILL.md'), '# TDD\n\nRed, green, refactor.\n')
    return { root, config }
  }

  it('reads the vault and its config directory before any session has run', async () => {
    const { root, config } = await vault()
    const list = await listCommands({ root, configDir: config, session: null })
    expect(list.slice(0, 3)).toEqual([
      {
        name: 'notes:weekly',
        kind: 'command',
        scope: 'vault',
        description: 'Write the weekly note',
      },
      { name: 'standup', kind: 'skill', scope: 'vault', description: 'Brief me on today' },
      { name: 'tdd', kind: 'skill', scope: 'user', description: 'Red, green, refactor.' },
    ])
    expect(list.some((c) => c.name === 'compact' && c.kind === 'builtin')).toBe(true)
  })

  it("follows what the session said, with the files' descriptions", async () => {
    const { root, config } = await vault()
    const list = await listCommands({
      root,
      configDir: config,
      session: {
        names: ['tdd', 'syv-skills:handoff', 'compact'],
        skills: ['tdd', 'syv-skills:handoff'],
      },
    })
    expect(list.map((c) => c.name)).toEqual([
      'notes:weekly',
      'standup',
      'tdd',
      'syv-skills:handoff',
      'compact',
    ])
    expect(list.find((c) => c.name === 'tdd')?.description).toBe('Red, green, refactor.')
    expect(list.find((c) => c.name === 'syv-skills:handoff')).toMatchObject({
      kind: 'skill',
      scope: 'plugin',
    })
    expect(list.some((c) => c.name === 'cost')).toBe(false)
  })

  it('takes a description from frontmatter or the first prose line', () => {
    expect(describeFile('---\ndescription: Hi\n---\n')).toBe('Hi')
    expect(describeFile('# Title\n\nFirst line.')).toBe('First line.')
    expect(describeFile('')).toBeUndefined()
  })
})
