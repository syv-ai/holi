import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AGENT_CONFIG_DIR_NAME,
  agentConfigSlug,
  ensureAgentConfigDir,
  isAgentSignedIn,
  resolveVaultAgentConfig,
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

describe('isAgentSignedIn', () => {
  // §6 of the 2026-08-14 spec, never built: without it an unauthenticated agent
  // prints `Not logged in` and the user is left to infer that `/login` is the
  // answer. Survivable once per install; not once per vault.
  it('says no for a directory Claude Code has never written to', async () => {
    // The fresh-vault case, and the only one that has to nag.
    const configDir = await ensureAgentConfigDir(await tempDir(), 'owner/repo')
    expect(await isAgentSignedIn(configDir)).toBe(false)
  })

  it('says yes when .claude.json carries an oauthAccount', async () => {
    const configDir = await ensureAgentConfigDir(await tempDir(), 'owner/repo')
    await writeFile(
      join(configDir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'ada@syv.ai' }, projects: {} }),
    )
    expect(await isAgentSignedIn(configDir)).toBe(true)
  })

  it('says no when .claude.json exists but has no oauthAccount', async () => {
    const configDir = await ensureAgentConfigDir(await tempDir(), 'owner/repo')
    await writeFile(join(configDir, '.claude.json'), JSON.stringify({ projects: {} }))
    expect(await isAgentSignedIn(configDir)).toBe(false)
  })

  it('does not nag on a file it cannot read', async () => {
    // Never scrape the PTY for this, and never guess either: an unparseable file
    // is not evidence of anything, and a wrong nag is worse than a missing one.
    const configDir = await ensureAgentConfigDir(await tempDir(), 'owner/repo')
    await writeFile(join(configDir, '.claude.json'), '{ not json')
    expect(await isAgentSignedIn(configDir)).toBe(true)
  })
})

describe('resolveVaultAgentConfig', () => {
  /** A vault clone with a machine-local colour choice, or none at all. */
  async function vault(colorScheme?: string): Promise<string> {
    const root = join(await tempDir(), 'clone')
    await mkdir(join(root, '.holi'), { recursive: true })
    if (colorScheme !== undefined) {
      await writeFile(
        join(root, '.holi', 'settings.local.json'),
        JSON.stringify({ colorScheme }),
      )
    }
    return root
  }

  it("hands the agent the vault's own colour, not Claude Code's `auto`", async () => {
    const userDataDir = await tempDir()
    const { dir } = await resolveVaultAgentConfig({
      userDataDir,
      remote: 'owner/repo',
      root: await vault('light'),
      systemPrefersDark: true,
    })
    expect((await settings(dir)).theme).toBe('light')
  })

  it('resolves `system` the same way the app does', async () => {
    // Same pure `resolveColorMode` that drives `data-theme`, so `system` cannot
    // come to mean one thing to the app and another to the agent.
    const userDataDir = await tempDir()
    const root = await vault('system')

    const dark = await resolveVaultAgentConfig({
      userDataDir,
      remote: 'owner/dark',
      root,
      systemPrefersDark: true,
    })
    const light = await resolveVaultAgentConfig({
      userDataDir,
      remote: 'owner/light',
      root,
      systemPrefersDark: false,
    })

    expect((await settings(dark.dir)).theme).toBe('dark')
    expect((await settings(light.dir)).theme).toBe('light')
  })

  it('resolves a vault that has never been asked, rather than throwing', async () => {
    const { dir } = await resolveVaultAgentConfig({
      userDataDir: await tempDir(),
      remote: 'owner/repo',
      root: await vault(),
      systemPrefersDark: false,
    })
    expect((await settings(dir)).theme).toBe('light') // the default is `system`
  })

  it('reports a fresh directory as needing a sign-in', async () => {
    const res = await resolveVaultAgentConfig({
      userDataDir: await tempDir(),
      remote: 'owner/repo',
      root: await vault('dark'),
      systemPrefersDark: true,
    })
    expect(res.dir).toContain(agentConfigSlug('owner/repo'))
    expect(res.signedIn).toBe(false)
  })
})
