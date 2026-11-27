import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ownedFixtureDirectory } from './owned-fixture-directory'
import { VaultRegistry } from '../src/main/vault/registry'

const remotes = ['holi-550-fixture/vault-a', 'holi-550-fixture/vault-b'] as const

async function main(): Promise<void> {
  const argument = process.argv[2]
  if (!argument) throw new Error('Usage: seed-agent-inbox-550 <existing-owned-runtime-directory>')
  const runtime = resolve(argument)
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('The agent inbox fixture requires POSIX ownership checks')
  const stat = await lstat(runtime)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid)
    throw new Error(`Runtime must be an existing directory owned by uid ${uid}: ${runtime}`)
  if ((await realpath(runtime)) !== runtime)
    throw new Error(`Runtime path must be canonical: ${runtime}`)

  const home = join(runtime, 'home')
  const vaultRoot = join(runtime, 'vaults')
  const remoteRoot = join(runtime, 'remotes')
  const userData = join(runtime, 'user-data')
  for (const directory of [home, vaultRoot, remoteRoot, userData])
    ownedFixtureDirectory(runtime, relative(runtime, directory))

  const gitConfig = join(home, '.gitconfig')
  const rewrite = pathToFileURL(`${remoteRoot}/`).href
  await writeFile(
    gitConfig,
    `[user]\n\tname = Holi 550 Fixture\n\temail = holi-550-fixture@example.invalid\n[credential]\n\thelper =\n[url "${rewrite}"]\n\tinsteadOf = https://github.com/holi-550-fixture/\n`,
    { flag: 'wx' },
  )
  const env = {
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_AUTHOR_NAME: 'Holi 550 Fixture',
    GIT_AUTHOR_EMAIL: 'holi-550-fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Holi 550 Fixture',
    GIT_COMMITTER_EMAIL: 'holi-550-fixture@example.invalid',
    PATH: process.env.PATH ?? '',
  }

  const runGit = async (cwd: string, ...args: string[]) => {
    const { spawnSync } = await import('node:child_process')
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' })
    if (result.error || result.status !== 0)
      throw new Error(
        `git ${args.join(' ')} failed: ${result.stderr || result.error?.message || result.status}`,
      )
  }

  const registry = new VaultRegistry(join(userData, 'vaults.json'))
  const now = Date.now()
  for (const [index, remote] of remotes.entries()) {
    const [owner, repo] = remote.split('/') as [string, string]
    const clone = join(vaultRoot, owner, repo)
    const bare = join(remoteRoot, `${repo}.git`)
    for (const target of [clone, bare]) {
      try {
        await lstat(target)
        throw new Error(`Refusing to overwrite existing fixture path: ${target}`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    ownedFixtureDirectory(runtime, relative(runtime, dirname(clone)))
    ownedFixtureDirectory(runtime, relative(runtime, dirname(bare)))
    await runGit(runtime, 'init', '--bare', '--initial-branch=main', bare)
    const canonical = `https://github.com/${remote}.git`
    await runGit(runtime, 'clone', canonical, clone)
    const settings = join(clone, '.holi/settings')
    await mkdir(settings, { recursive: true })
    await writeFile(
      join(settings, 'plugins.local.yaml'),
      'plugins:\n' +
        [
          'automations',
          'holis',
          'tasks',
          'pdf',
          'reader',
          'links',
          'browser',
          'google',
          'apps',
          'community',
          'transcribe',
        ]
          .map((id) => `  ${id}: false\n`)
          .join(''),
      { flag: 'wx' },
    )
    await writeFile(
      join(clone, 'Welcome.md'),
      `# Welcome to ${repo}\n\nThis is an owned Holi 550 fixture vault.\n`,
    )
    await runGit(clone, 'add', 'Welcome.md')
    await runGit(clone, 'commit', '-m', 'Add welcome note')
    await runGit(clone, 'push', '-u', 'origin', 'HEAD')
    await registry.add({
      remote,
      path: clone,
      name: repo,
      lastOpenedAt: new Date(now - index).toISOString(),
    })
  }
  console.log(JSON.stringify({ vaults: await registry.list() }))
}

main().catch((error: unknown) => {
  console.error(
    `Could not seed agent inbox fixture. Partial owned paths remain under runtime: ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exitCode = 1
})
