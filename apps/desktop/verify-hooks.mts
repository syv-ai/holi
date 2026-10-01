/**
 * Hand-verification rig for the vault pre-commit transforms.
 *
 * Stands up the real bridge server against a scratch vault, then leaves it
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
import { createBridgeServer } from './src/main/bridge/server'
import { registerGitRoutes } from './src/main/vault/git-routes'
import { installGitHook, writeHookEndpoint } from './src/main/vault/large-files'

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

const server = createBridgeServer()
registerGitRoutes(server, { rootFor: async () => dir })
await server.start()
await installGitHook(dir, 10 * 1024 * 1024)
await writeHookEndpoint(dir, { port: server.port()!, token: server.tokenForVault('scratch/vault') })

console.log(`\nScratch vault ready at ${dir}`)
console.log(`Bridge server on 127.0.0.1:${server.port()}\n`)
console.log('Try:')
console.log(`  git -C ${dir} mv projects/roadmap.md projects/plan.md`)
console.log(`  git -C ${dir} commit -m rename`)
console.log(`  git -C ${dir} show --stat HEAD`)
console.log(`  cat ${dir}/.holi/state/hooks.local.log\n`)
console.log('Ctrl-C when done.')
