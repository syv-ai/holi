/**
 * Hand-verification rig for the vault pre-commit transforms.
 *
 * Stands up the real hook server against a scratch vault, then leaves it
 * running so you can `git mv` and `git commit` in a terminal and watch what
 * happens to the files. A scratch vault, never a real one: these transforms
 * rewrite files, and the point of the exercise is to see them do it.
 *
 *   pnpm exec vite-node verify-hooks.mts /tmp/hookvault
 *
 * The e2e test covers the same chain; this exists so a person can look at the
 * log and the diff and judge whether they read sensibly, which no assertion
 * does.
 */
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createAgentOps } from './src/main/agent/ops'
import { createHookServer } from './src/main/agent/hook-server'
import { installGitHook, writeHookEndpoint } from './src/main/vault/large-files'
import { runPreCommit } from './src/main/vault/hooks/runner'
import { stagedChanges } from './src/main/vault/hooks/staged'
import { VAULT_TRANSFORMS, readHookSettings } from './src/main/vault/hooks/transforms'

const exec = promisify(execFile)
const dir = process.argv[2]
if (dir === undefined) throw new Error('usage: verify-hooks.mts <scratch dir>')

const git = (args: string[]) => exec('git', ['-C', dir, ...args])

await exec('git', ['init', '-q', '-b', 'main', dir])
await git(['config', 'user.email', 'test@holi.invalid'])
await git(['config', 'user.name', 'Holi Test'])
await mkdir(join(dir, 'projects'), { recursive: true })
await mkdir(join(dir, '.holi'), { recursive: true })
await writeFile(join(dir, '.gitignore'), '*.local.*\n', 'utf8')
await writeFile(join(dir, 'projects/roadmap.md'), '# Roadmap\n', 'utf8')
await writeFile(
  join(dir, 'notes.md'),
  'see [[projects/roadmap.md]] and [[projects/roadmap.md|the plan]]\n',
  'utf8',
)
await git(['add', '-A'])
await git(['commit', '-q', '-m', 'seed'])

const server = createHookServer({
  onTurnStart: () => {},
  onTurnEnd: () => {},
  ops: createAgentOps({
    openApp: () => Promise.resolve({ ok: true }),
    initApp: () => Promise.resolve({ ok: true, created: [] }),
    refreshSeed: () => Promise.resolve({ refreshed: [], skipped: [] }),
    runPreCommitHooks: async () => {
      const result = await runPreCommit(dir, await stagedChanges(dir), {
        settings: await readHookSettings(dir),
        transforms: VAULT_TRANSFORMS,
      })
      console.log('[hooks] ran:', JSON.stringify(result))
      return { changed: result.changed, failed: result.failed }
    },
  }),
})
await server.start()
await installGitHook(dir, 10 * 1024 * 1024)
await writeHookEndpoint(dir, { port: server.port()!, token: server.token() })

console.log(`\nScratch vault ready at ${dir}`)
console.log(`Hook server on 127.0.0.1:${server.port()}\n`)
console.log('Try:')
console.log(`  git -C ${dir} mv projects/roadmap.md projects/plan.md`)
console.log(`  git -C ${dir} commit -m rename`)
console.log(`  git -C ${dir} show --stat HEAD`)
console.log(`  cat ${dir}/.holi/hooks.local.log\n`)
console.log('Ctrl-C when done.')
