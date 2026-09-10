import { SETTINGS_LOCAL_FILE } from '@holi/shared'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AGENT_CONFIG_DIR_NAME,
  agentConfigSlug,
  ensureAgentConfigDir,
  takeFirstSpawn,
  migrateSharedAgentConfig,
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
  it("creates the vault's own directory under userData and returns its absolute path", async () => {
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
    await writeFile(
      join(configDir, 'settings.json'),
      JSON.stringify({ disableClaudeAiConnectors: false }),
    )

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

describe('takeFirstSpawn', () => {
  // §6 of the 2026-08-14 spec, never built: without it an unauthenticated agent
  // prints a bare `Not logged in` and the user is left to infer that `/login` is
  // the answer. Survivable once per install; not once per vault.
  //
  // The first draft read `oauthAccount` out of Claude Code's `.claude.json`, and
  // a real install proved that wrong: the key OUTLIVES the credential. Renaming a
  // config directory re-keys the macOS keychain entry (they are suffixed by a
  // hash of the path), so a migrated directory reports an account it can no
  // longer use — a false "signed in" precisely where the notice was needed most.
  //
  // Holi's own marker instead, and it is a proxy rather than a guess: credentials
  // are keyed to the config directory, so a directory Holi has never spawned in
  // is a directory that cannot be signed in.
  it('is true the first time, and never again', async () => {
    const configDir = await ensureAgentConfigDir(await tempDir(), 'owner/repo')
    expect(await takeFirstSpawn(configDir)).toBe(true)
    expect(await takeFirstSpawn(configDir)).toBe(false)
    expect(await takeFirstSpawn(configDir)).toBe(false)
  })

  it('is per directory, so every vault is greeted once', async () => {
    const userData = await tempDir()
    const mine = await ensureAgentConfigDir(userData, 'owner/repo')
    const theirs = await ensureAgentConfigDir(userData, 'owner/other')

    expect(await takeFirstSpawn(mine)).toBe(true)
    expect(await takeFirstSpawn(theirs)).toBe(true)
    expect(await takeFirstSpawn(mine)).toBe(false)
  })

  it('does not count as something Claude Code owns', async () => {
    // The marker is Holi's, so it is named as Holi's and sits beside the settings
    // file rather than inside anything the CLI writes.
    const configDir = await ensureAgentConfigDir(await tempDir(), 'owner/repo')
    await takeFirstSpawn(configDir)
    const entries = await readdir(configDir)
    expect(entries).toContain('settings.json')
    expect(entries.filter((e) => e !== 'settings.json')).toEqual(['.holi-spawned'])
  })
})

describe('resolveVaultAgentConfig', () => {
  /** A vault clone with a machine-local colour choice, or none at all. */
  async function vault(colorScheme?: string): Promise<string> {
    const root = join(await tempDir(), 'clone')
    await mkdir(join(root, '.holi/settings'), { recursive: true })
    if (colorScheme !== undefined) {
      await writeFile(join(root, SETTINGS_LOCAL_FILE), JSON.stringify({ colorScheme }))
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

  it('reports a fresh directory as a first spawn, once', async () => {
    const args = {
      userDataDir: await tempDir(),
      remote: 'owner/repo',
      root: await vault('dark'),
      systemPrefersDark: true,
    }
    const first = await resolveVaultAgentConfig(args)
    expect(first.dir).toContain(agentConfigSlug('owner/repo'))
    expect(first.firstSpawn).toBe(true)

    expect((await resolveVaultAgentConfig(args)).firstSpawn).toBe(false)
  })
})

describe('migrateSharedAgentConfig', () => {
  const VAULT = 'owner/repo'
  const flat = (userData: string) => join(userData, AGENT_CONFIG_DIR_NAME)
  const slotted = (userData: string, remote = VAULT) =>
    join(flat(userData), agentConfigSlug(remote))

  /** The registry as `list()` hands it over: lastOpenedAt descending. The head is
   *  NOT the vault that used the agent, which is the whole point of these tests. */
  const REGISTRY = [
    { remote: 'owner/looked-at-last', path: '/Holi/owner/looked-at-last' },
    { remote: VAULT, path: '/Holi/owner/repo' },
  ]

  /** The shared directory as D72 left it: logged in, with one vault's transcripts. */
  async function shared(usedBy = '/Holi/owner/repo'): Promise<string> {
    const userData = await tempDir()
    const dir = flat(userData)
    await mkdir(join(dir, 'projects', 'a-vault'), { recursive: true })
    await mkdir(join(dir, 'plugins'), { recursive: true })
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ theme: 'auto' }))
    await writeFile(
      join(dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { id: 'a' }, projects: { [usedBy]: { history: [] } } }),
    )
    await writeFile(join(dir, 'projects', 'a-vault', 'session.jsonl'), 'a turn\n')
    return userData
  }

  it('gives the directory to the vault that USED it, not the one looked at last', async () => {
    // Measured on a real install and very nearly shipped wrong: `lastOpenedAt`
    // answers "which vault did you last look at". The directory says which vault
    // ran the agent, in `.claude.json`'s `projects{}` keys, and that is the one
    // whose login and transcripts are in it.
    const userData = await shared('/Holi/owner/repo')

    expect(await migrateSharedAgentConfig(userData, REGISTRY)).toBe(VAULT)
    expect(await readdir(flat(userData))).toEqual([agentConfigSlug(VAULT)])
  })

  it('falls back to the most recently opened vault when nothing used it', async () => {
    // A directory with no project record has no history to strand, so the head
    // of the registry is as good an answer as any and better than none.
    const userData = await tempDir()
    const dir = flat(userData)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ theme: 'auto' }))

    expect(await migrateSharedAgentConfig(userData, REGISTRY)).toBe('owner/looked-at-last')
  })

  it('ignores a project path no registered vault claims', async () => {
    const userData = await shared('/somewhere/else/entirely')
    expect(await migrateSharedAgentConfig(userData, REGISTRY)).toBe('owner/looked-at-last')
  })

  it('does nothing when there are no vaults to give it to', async () => {
    const userData = await shared()
    expect(await migrateSharedAgentConfig(userData, [])).toBeNull()
    expect(await readdir(flat(userData))).toContain('settings.json')
  })

  it('moves the whole directory into the vault that was using it', async () => {
    // A rename, never a rewrite: the 2026-08-14 spec refused to copy transcripts
    // because rewriting another program's state store is a bad bet. This never
    // opens a file, so the login and the history both survive intact.
    const userData = await shared()

    expect(await migrateSharedAgentConfig(userData, REGISTRY)).toBe(VAULT)

    const dir = slotted(userData)
    expect(JSON.parse(await readFile(join(dir, '.claude.json'), 'utf8')).oauthAccount).toEqual({
      id: 'a',
    })
    expect(await readFile(join(dir, 'projects', 'a-vault', 'session.jsonl'), 'utf8')).toBe(
      'a turn\n',
    )
    expect(await readdir(dir)).toContain('plugins')
    expect(await readdir(flat(userData))).toEqual([agentConfigSlug(VAULT)])
  })

  it('is idempotent — a second launch moves nothing', async () => {
    const userData = await shared()
    expect(await migrateSharedAgentConfig(userData, REGISTRY)).toBe(VAULT)
    expect(await migrateSharedAgentConfig(userData, REGISTRY)).toBeNull()
    expect(await readdir(flat(userData))).toEqual([agentConfigSlug(VAULT)])
  })

  it('does nothing on an install that never had one', async () => {
    const userData = await tempDir()
    expect(await migrateSharedAgentConfig(userData, REGISTRY)).toBeNull()
    expect(await readdir(userData)).toEqual([])
  })

  it('refuses to clobber a slot that already exists', async () => {
    const userData = await shared()
    await mkdir(slotted(userData), { recursive: true })
    await writeFile(join(slotted(userData), 'settings.json'), JSON.stringify({ model: 'opus' }))

    expect(await migrateSharedAgentConfig(userData, REGISTRY)).toBeNull()
    expect(JSON.parse(await readFile(join(slotted(userData), 'settings.json'), 'utf8')).model).toBe(
      'opus',
    )
  })

  it('finishes a run that was interrupted mid-rename', async () => {
    // Two renames, because a directory cannot be renamed into itself. A crash
    // between them leaves the staging directory holding everything.
    const userData = await shared()
    const staging = join(userData, `${AGENT_CONFIG_DIR_NAME}.migrating`)
    await rename(flat(userData), staging)

    expect(await migrateSharedAgentConfig(userData, REGISTRY)).toBe(VAULT)
    expect(await readdir(slotted(userData))).toContain('.claude.json')
  })
})
