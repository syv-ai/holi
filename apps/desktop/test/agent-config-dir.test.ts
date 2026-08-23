import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AGENT_CONFIG_DIR_NAME,
  agentConfigSlug,
  ensureAgentConfigDir,
} from '../src/main/agent/agent-config-dir'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-agent-config-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function settings(configDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(configDir, 'settings.json'), 'utf8')) as Record<
    string,
    unknown
  >
}

describe('ensureAgentConfigDir', () => {
  it('creates the directory under userData and returns its absolute path', async () => {
    const userData = await tempDir()
    const configDir = await ensureAgentConfigDir(userData)

    expect(configDir).toBe(join(userData, AGENT_CONFIG_DIR_NAME))
    expect(await readdir(configDir)).toContain('settings.json')
  })

  it('seeds the connector opt-out — a second layer under the vault own', async () => {
    const configDir = await ensureAgentConfigDir(await tempDir())
    expect((await settings(configDir)).disableClaudeAiConnectors).toBe(true)
  })

  it('runs on every launch and preserves what the user or the CLI added', async () => {
    // `ensureSeeded`'s lesson: a seed that only runs at creation is a migration
    // that never happens. So this re-runs — and must not discard `/login`'s
    // work, or a model preference typed into the panel.
    const userData = await tempDir()
    const first = await ensureAgentConfigDir(userData)
    await writeFile(
      join(first, 'settings.json'),
      JSON.stringify({ disableClaudeAiConnectors: true, model: 'opus' }),
    )

    const second = await ensureAgentConfigDir(userData)

    expect(second).toBe(first)
    const after = await settings(second)
    expect(after.model).toBe('opus')
    expect(after.disableClaudeAiConnectors).toBe(true)
  })

  it('adds the opt-out to a settings file that predates it', async () => {
    const userData = await tempDir()
    const configDir = await ensureAgentConfigDir(userData)
    await writeFile(join(configDir, 'settings.json'), JSON.stringify({ model: 'opus' }))

    await ensureAgentConfigDir(userData)

    const after = await settings(configDir)
    expect(after.disableClaudeAiConnectors).toBe(true)
    expect(after.model).toBe('opus')
  })

  it('does not overrule a user who deliberately set it false', async () => {
    const userData = await tempDir()
    const configDir = await ensureAgentConfigDir(userData)
    await writeFile(join(configDir, 'settings.json'), JSON.stringify({ disableClaudeAiConnectors: false }))

    await ensureAgentConfigDir(userData)

    expect((await settings(configDir)).disableClaudeAiConnectors).toBe(false)
  })

  it('leaves a malformed settings file alone rather than overwriting it', async () => {
    const userData = await tempDir()
    const configDir = await ensureAgentConfigDir(userData)
    await writeFile(join(configDir, 'settings.json'), '{ not json')

    await ensureAgentConfigDir(userData)

    expect(await readFile(join(configDir, 'settings.json'), 'utf8')).toBe('{ not json')
  })

  it('creates nothing Claude Code owns — no projects/, no .claude.json', async () => {
    // Pre-creating another program's state store is guessing at its schema.
    const configDir = await ensureAgentConfigDir(await tempDir())
    expect(await readdir(configDir)).toEqual(['settings.json'])
  })
})

describe('agentConfigSlug', () => {
  it('reads as the vault it belongs to, and is filesystem-safe', () => {
    const slug = agentConfigSlug('nthomsencph/privat')
    expect(slug).toMatch(/^nthomsencph-privat-/)
    expect(slug).toMatch(/^[a-z0-9-]+$/)
  })

  it('is stable — the same remote is the same directory, forever', () => {
    // A slug that drifts orphans a login and a transcript store.
    expect(agentConfigSlug('owner/repo')).toBe(agentConfigSlug('owner/repo'))
  })

  it('separates two remotes that sanitize alike', () => {
    // Claude Code's own projects/ convention (non-alphanumerics to dashes) maps
    // both of these to `syv-better-holi`. Two vaults sharing one config dir is
    // the plugin leak D86 exists to kill, so the name carries a hash of the remote.
    expect(agentConfigSlug('syv/better-holi')).not.toBe(agentConfigSlug('syv-better/holi'))
  })

  it('still names a directory when nothing in the remote survives sanitizing', () => {
    const slug = agentConfigSlug('///')
    expect(slug).not.toBe('')
    expect(slug).not.toContain('/')
    expect(slug).toMatch(/^[a-z0-9-]+$/)
  })
})
