/**
 * A Codex run's own folder (`codex/home.ts`): the person's sign-in and model
 * settings and nothing else, and a refreshed sign-in handed back.
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareCodexHome, releaseCodexHome, runConfig } from '../main/codex/home'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})
const temp = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'holi-codex-'))
  dirs.push(dir)
  return dir
}

const AUTH = JSON.stringify({ tokens: { access_token: 'old' } })
const REFRESHED = JSON.stringify({ tokens: { access_token: 'new' } })

describe("a Codex run's config", () => {
  it('keeps the model and its provider, and drops MCP servers and the rest', () => {
    const config = runConfig(
      [
        'model = "gpt-5.5"',
        'model_provider = "corp"',
        'approval_policy = "never"',
        'mcp_servers.inline.command = "x"',
        '[model_providers.corp]',
        'base_url = "https://llm.example"',
        'env_key = "CORP_KEY"',
        '[mcp_servers.synthetic]',
        'command = "echo"',
        '[profiles.fast]',
        'model = "o4"',
      ].join('\n'),
    )
    expect(config).toContain('model = "gpt-5.5"')
    expect(config).toContain('model_provider = "corp"')
    expect(config).toContain('base_url = "https://llm.example"')
    expect(config).toContain('cli_auth_credentials_store = "file"')
    for (const gone of ['mcp_servers', 'profiles', 'approval_policy']) {
      expect(config).not.toContain(gone)
    }
  })

  it('refuses a config.toml it cannot read', () => {
    expect(() => runConfig('model = ')).toThrow(/not TOML/)
  })
})

describe("a Codex run's folder", () => {
  it('hands over the sign-in, through a link to what it names', async () => {
    const person = await temp()
    const real = await temp()
    await writeFile(join(real, 'auth.json'), AUTH)
    await symlink(join(real, 'auth.json'), join(person, 'auth.json'))
    const state = await temp()
    const home = prepareCodexHome(state, { CODEX_HOME: person })
    expect(home).toBe(join(state, 'codex-home'))
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe(AUTH)
  })

  it('does not run with no sign-in to hand over, unless a key is in the environment', async () => {
    const person = await temp()
    const state = await temp()
    expect(() => prepareCodexHome(state, { CODEX_HOME: person })).toThrow(/codex login/)
    expect(prepareCodexHome(state, { CODEX_HOME: person, OPENAI_API_KEY: 'sk' })).toBe(
      join(state, 'codex-home'),
    )
  })

  it('hands a refreshed sign-in back, into the file a link names', async () => {
    const person = await temp()
    const real = await temp()
    await writeFile(join(real, 'auth.json'), AUTH)
    await symlink(join(real, 'auth.json'), join(person, 'auth.json'))
    const state = await temp()
    const home = prepareCodexHome(state, { CODEX_HOME: person })
    await writeFile(join(home, 'auth.json'), REFRESHED)
    await releaseCodexHome(state, { CODEX_HOME: person })
    expect(await readFile(join(real, 'auth.json'), 'utf8')).toBe(REFRESHED)
    expect(await readFile(join(person, 'auth.json'), 'utf8')).toBe(REFRESHED)
  })

  it('leaves a sign-in that changed meanwhile, and one Codex left unreadable', async () => {
    const person = await temp()
    await writeFile(join(person, 'auth.json'), AUTH)
    const state = await temp()
    const home = prepareCodexHome(state, { CODEX_HOME: person })
    await writeFile(join(person, 'auth.json'), 'theirs')
    await writeFile(join(home, 'auth.json'), REFRESHED)
    await releaseCodexHome(state, { CODEX_HOME: person })
    expect(await readFile(join(person, 'auth.json'), 'utf8')).toBe('theirs')

    await writeFile(join(person, 'auth.json'), AUTH)
    prepareCodexHome(state, { CODEX_HOME: person })
    await writeFile(join(home, 'auth.json'), 'half a fi')
    await releaseCodexHome(state, { CODEX_HOME: person })
    expect(await readFile(join(person, 'auth.json'), 'utf8')).toBe(AUTH)
  })

  it('never writes to the person’s folder but for a refreshed sign-in', async () => {
    const person = await temp()
    await mkdir(person, { recursive: true })
    await writeFile(join(person, 'auth.json'), AUTH)
    await writeFile(join(person, 'config.toml'), '[mcp_servers.x]\ncommand = "y"\n')
    const state = await temp()
    prepareCodexHome(state, { CODEX_HOME: person })
    await releaseCodexHome(state, { CODEX_HOME: person })
    expect(await readFile(join(person, 'config.toml'), 'utf8')).toBe(
      '[mcp_servers.x]\ncommand = "y"\n',
    )
    expect(await readFile(join(person, 'auth.json'), 'utf8')).toBe(AUTH)
  })
})
