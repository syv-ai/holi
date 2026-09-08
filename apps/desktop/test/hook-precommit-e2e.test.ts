/**
 * The whole chain, with nothing faked but Electron.
 *
 * A real `git commit` in a real repo fires the real generated hook, which curls
 * the real hook server, which routes to the real ops handler, which runs the
 * real transforms against the real staged set — and the assertion is on the
 * commit git actually made.
 *
 * Every piece here is unit-tested in isolation already. This exists because the
 * pieces are joined by a shell script, a loopback port and a file of two lines,
 * and none of those three shows up in a unit test. It is the test that would
 * have caught the sed backreference that produced a script matching nothing.
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { createAgentOps } from '../src/main/agent/ops'
import { createHookServer, type HookServer } from '../src/main/agent/hook-server'
import { installGitHook, writeHookEndpoint } from '../src/main/vault/large-files'
import { resetBreaker, runPreCommit } from '../src/main/vault/hooks/runner'
import { stagedChanges } from '../src/main/vault/hooks/staged'
import { VAULT_TRANSFORMS, readHookSettings } from '../src/main/vault/hooks/transforms'

const exec = promisify(execFile)
const dirs: string[] = []
const servers: HookServer[] = []

afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const git = (dir: string, args: string[]) => exec('git', ['-C', dir, ...args])

/** A vault with Holi's hook installed and a live endpoint pointing at a real
 *  server running the real transforms. */
async function vault(settings: Record<string, boolean> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-e2e-'))
  dirs.push(dir)
  await exec('git', ['init', '-q', '-b', 'main', dir])
  await git(dir, ['config', 'user.email', 'test@holi.invalid'])
  await git(dir, ['config', 'user.name', 'Holi Test'])
  await mkdir(join(dir, '.holi'), { recursive: true })
  await writeFile(join(dir, '.gitignore'), '*.local.*\n', 'utf8')
  // `scaffold-md` is off HERE, not in the product: every fixture below is a new
  // `.md` and would otherwise be committed with a frontmatter block on top,
  // which obscures what each test is actually asserting about relink and
  // normalize. One test turns it back on and checks it through a real commit.
  await writeFile(
    join(dir, '.holi/settings.json'),
    JSON.stringify({ hooks: { 'scaffold-md': false, ...settings } }, null, 2),
    'utf8',
  )

  resetBreaker()
  const server = createHookServer({
    onTurnStart: () => {},
    onTurnEnd: () => {},
    log: () => {},
    // One vault in these; the server routes by the caller's token (D87).
    opsFor: () => createAgentOps({
      openApp: () => Promise.resolve({ ok: true }),
      initApp: () => Promise.resolve({ ok: true, created: [] }),
      refreshSeed: () => Promise.resolve({ refreshed: [], skipped: [] }),
      runPreCommitHooks: async () => {
        const result = await runPreCommit(dir, await stagedChanges(dir), {
          settings: await readHookSettings(dir),
          transforms: VAULT_TRANSFORMS,
        })
        return { changed: result.changed, failed: result.failed }
      },
    }),
  })
  servers.push(server)
  await server.start()

  await installGitHook(dir, 10 * 1024 * 1024)
  await writeHookEndpoint(dir, { port: server.port()!, token: server.tokenForVault('owner/repo') })
  return dir
}

/** What the commit actually contains at `rel`. */
async function committed(dir: string, rel: string): Promise<string> {
  const { stdout } = await git(dir, ['show', `HEAD:${rel}`])
  return stdout
}

describe('relink, through a real commit', () => {
  it('rewrites the referring note IN the same commit as the rename', async () => {
    // The whole point of restaging. A commit that ships the move with the links
    // still pointing at the old path is a broken commit, whatever the next one
    // does.
    const dir = await vault()
    await mkdir(join(dir, 'projects'), { recursive: true })
    await writeFile(join(dir, 'projects/roadmap.md'), '# Roadmap\n', 'utf8')
    await writeFile(join(dir, 'notes.md'), 'see [[projects/roadmap.md]]\n', 'utf8')
    await git(dir, ['add', '-A'])
    await git(dir, ['commit', '-q', '-m', 'seed'])

    await git(dir, ['mv', 'projects/roadmap.md', 'projects/plan.md'])
    await git(dir, ['commit', '-q', '-m', 'rename'])

    expect(await committed(dir, 'notes.md')).toBe('see [[projects/plan.md]]\n')
    // And the working tree is clean: the rewrite was staged, not left behind.
    const { stdout } = await git(dir, ['status', '--porcelain'])
    expect(stdout.trim()).toBe('')
  })

  it('leaves the commit alone when relink is turned off', async () => {
    const dir = await vault({ relink: false })
    await writeFile(join(dir, 'a.md'), '# a\n', 'utf8')
    await writeFile(join(dir, 'notes.md'), 'see [[a.md]]\n', 'utf8')
    await git(dir, ['add', '-A'])
    await git(dir, ['commit', '-q', '-m', 'seed'])

    await git(dir, ['mv', 'a.md', 'b.md'])
    await git(dir, ['commit', '-q', '-m', 'rename'])

    expect(await committed(dir, 'notes.md')).toBe('see [[a.md]]\n')
  })
})

describe('normalize-md, through a real commit', () => {
  it('tidies a staged file and commits the tidied version', async () => {
    const dir = await vault()
    await writeFile(join(dir, 'a.md'), '# Title \n\nbody', 'utf8')
    await git(dir, ['add', '-A'])
    await git(dir, ['commit', '-q', '-m', 'write'])

    expect(await committed(dir, 'a.md')).toBe('# Title\n\nbody\n')
  })
})

describe('scaffold-md, through a real commit', () => {
  it('commits a new note with the frontmatter it arrived without', async () => {
    // The route the issue was reported against: a `.md` written by anything
    // other than the file-tree `+` — an agent, an import, another editor.
    const dir = await vault({ 'scaffold-md': true })
    await writeFile(join(dir, 'a.md'), '# Title\n\nbody\n', 'utf8')
    await git(dir, ['add', '-A'])
    await git(dir, ['commit', '-q', '-m', 'write'])

    const text = await committed(dir, 'a.md')
    expect(text).toMatch(/^---\ncreated: \d{4}-\d{2}-\d{2}\ntags: \[\]\n---\n\n/)
    expect(text.endsWith('# Title\n\nbody\n')).toBe(true)
  })

  it('leaves a file it did not create alone on a later commit', async () => {
    // `added` only. A note already in the vault stays as its author left it,
    // however bare — which is the whole answer to rewriting somebody else's file.
    const dir = await vault({ 'scaffold-md': false })
    await writeFile(join(dir, 'theirs.md'), 'body\n', 'utf8')
    await git(dir, ['add', '-A'])
    await git(dir, ['commit', '-q', '-m', 'seed'])

    await writeFile(join(dir, '.holi/settings.json'), JSON.stringify({ hooks: {} }), 'utf8')
    await writeFile(join(dir, 'theirs.md'), 'body, edited\n', 'utf8')
    await git(dir, ['add', '-A'])
    await git(dir, ['commit', '-q', '-m', 'edit'])

    expect(await committed(dir, 'theirs.md')).toBe('body, edited\n')
  })
})

describe('the log', () => {
  it('records the run, and is not in the commit', async () => {
    const dir = await vault()
    await writeFile(join(dir, 'a.md'), '# a\n', 'utf8')
    await writeFile(join(dir, 'notes.md'), 'see [[a.md]]\n', 'utf8')
    await git(dir, ['add', '-A'])
    await git(dir, ['commit', '-q', '-m', 'seed'])
    await git(dir, ['mv', 'a.md', 'b.md'])
    await git(dir, ['commit', '-q', '-m', 'rename'])

    const log = await readFile(join(dir, '.holi/hooks.local.log'), 'utf8')
    expect(log).toMatch(/relink: rewrote links in 1 file/)

    const { stdout } = await git(dir, ['ls-files'])
    expect(stdout).not.toContain('hooks.local.log')
  })
})

describe('nothing here can stop a commit', () => {
  it('commits fine when the ops route itself throws', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-e2e-'))
    dirs.push(dir)
    await exec('git', ['init', '-q', '-b', 'main', dir])
    await git(dir, ['config', 'user.email', 'test@holi.invalid'])
    await git(dir, ['config', 'user.name', 'Holi Test'])

    const server = createHookServer({
      onTurnStart: () => {},
      onTurnEnd: () => {},
      log: () => {},
      // One vault in these; the server routes by the caller's token (D87).
    opsFor: () => createAgentOps({
        openApp: () => Promise.resolve({ ok: true }),
        initApp: () => Promise.resolve({ ok: true, created: [] }),
        refreshSeed: () => Promise.resolve({ refreshed: [], skipped: [] }),
        runPreCommitHooks: () => Promise.reject(new Error('everything is broken')),
      }),
    })
    servers.push(server)
    await server.start()
    await installGitHook(dir, 10 * 1024 * 1024)
    await writeHookEndpoint(dir, { port: server.port()!, token: server.tokenForVault('owner/repo') })

    await writeFile(join(dir, 'a.md'), '# a\n', 'utf8')
    await git(dir, ['add', '-A'])
    await expect(git(dir, ['commit', '-q', '-m', 'x'])).resolves.toBeDefined()
  })

  it('commits fine when Holi has quit and the endpoint is gone', async () => {
    const dir = await vault()
    await writeHookEndpoint(dir, null) // what close() does
    await writeFile(join(dir, 'a.md'), '# a\n', 'utf8')
    await git(dir, ['add', '-A'])
    await expect(git(dir, ['commit', '-q', '-m', 'x'])).resolves.toBeDefined()
  })
})
