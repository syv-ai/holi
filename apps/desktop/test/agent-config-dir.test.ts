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

const VAULT = 'owner/repo'
const OTHER_VAULT = 'owner/other'

describe('ensureAgentConfigDir', () => {
  it('creates the vault\'s own directory under userData and returns its absolute path', async () => {
    const userData = await tempDir()
    const configDir = await ensureAgentConfigDir(userData, VAULT)

    expect(configDir).toBe(join(userData, AGENT_CONFIG_DIR_NAME, agentConfigSlug(VAULT)))
    expect(await readdir(configDir)).toContain('settings.json')
  })

  it('gives two vaults two directories, and what one holds the other never sees', async () => {
    // The whole of D86: `plugins/`, marketplaces and settings are keyed by the
    // config directory and by nothing else, so sharing one shares capability.
    const userData = await tempDir()
    const mine = await ensureAgentConfigDir(userData, VAULT)
    const theirs = await ensureAgentConfigDir(userData, OTHER_VAULT)

    expect(mine).not.toBe(theirs)
    await writeFile(join(mine, 'settings.json'), JSON.stringify({ model: 'opus' }))
    expect((await settings(theirs)).model).toBeUndefined()
  })

  it('seeds the connector opt-out — a second layer under the vault own', async () => {
    const configDir = await ensureAgentConfigDir(await tempDir(), VAULT)
    expect((await settings(configDir)).disableClaudeAiConnectors).toBe(true)
  })

  it("stamps Claude Code's theme, and re-stamps it on every spawn", async () => {
    // `theme` is not a default: it tracks a live Holi setting (D85's resolved
    // mode), so unlike the connector opt-out the last write has to win. What the
    // user typed alongside it still survives.
    const userData = await tempDir()
    const configDir = await ensureAgentConfigDir(userData, VAULT, { theme: 'light' })
    expect((await settings(configDir)).theme).toBe('light')

    await writeFile(
      join(configDir, 'settings.json'),
      JSON.stringify({ theme: 'light', model: 'opus' }),
    )
    await ensureAgentConfigDir(userData, VAULT, { theme: 'dark' })

    const after = await settings(configDir)
    expect(after.theme).toBe('dark')
    expect(after.model).toBe('opus')
  })

  it('leaves an existing theme alone when Holi has no mode to offer', async () => {
    const userData = await tempDir()
    const configDir = await ensureAgentConfigDir(userData, VAULT, { theme: 'light' })

    await ensureAgentConfigDir(userData, VAULT)

    expect((await settings(configDir)).theme).toBe('light')
  })

  it('runs on every launch and preserves what the user or the CLI added', async () => {
    // `ensureSeeded`'s lesson: a seed that only runs at creation is a migration
    // that never happens. So this re-runs — and must not discard `/login`'s
    // work, or a model preference typed into the panel.
    const userData = await tempDir()
    const first = await ensureAgentConfigDir(userData, VAULT)
    await writeFile(
      join(first, 'settings.json'),
      JSON.stringify({ disableClaudeAiConnectors: true, model: 'opus' }),
    )

    const second = await ensureAgentConfigDir(userData, VAULT)

    expect(second).toBe(first)
    const after = await settings(second)
    expect(after.model).toBe('opus')
    expect(after.disableClaudeAiConnectors).toBe(true)
  })

  it('adds the opt-out to a settings file that predates it', async () => {
    const userData = await tempDir()
    const configDir = await ensureAgentConfigDir(userData, VAULT)
    await writeFile(join(configDir, 'settings.json'), JSON.stringify({ model: 'opus' }))

    await ensureAgentConfigDir(userData, VAULT)

    const after = await settings(configDir)
    expect(after.disableClaudeAiConnectors).toBe(true)
    expect(after.model).toBe('opus')
  })

  it('does not overrule a user who deliberately set it false', async () => {
    const userData = await tempDir()
    const configDir = await ensureAgentConfigDir(userData, VAULT)
    await writeFile(join(configDir, 'settings.json'), JSON.stringify({ disableClaudeAiConnectors: false }))

    await ensureAgentConfigDir(userData, VAULT)

    expect((await settings(configDir)).disableClaudeAiConnectors).toBe(false)
  })

  it('leaves a malformed settings file alone rather than overwriting it', async () => {
    const userData = await tempDir()
    const configDir = await ensureAgentConfigDir(userData, VAULT)
    await writeFile(join(configDir, 'settings.json'), '{ not json')

    await ensureAgentConfigDir(userData, VAULT, { theme: 'dark' })

    expect(await readFile(join(configDir, 'settings.json'), 'utf8')).toBe('{ not json')
  })

  it('creates nothing Claude Code owns — no projects/, no .claude.json', async () => {
    // Pre-creating another program's state store is guessing at its schema.
    const configDir = await ensureAgentConfigDir(await tempDir(), VAULT)
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
