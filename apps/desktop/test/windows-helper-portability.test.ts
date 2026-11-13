import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installGitHook } from '../src/main/vault/large-files'
import { installNodeFallback } from '../src/main/bridge/node-fallback'
import { createBridgeServer } from '../src/main/bridge/server'
import { registerAgentRoutes } from '../src/plugins/agent/main/claude/routes'
import { STATUS_LINE } from '../src/plugins/agent/main/claude/seed'
import { bridgeLines, writeVaultEnv } from './helpers/bridge-env'

const execAsync = promisify(execFile)
const windows = process.platform === 'win32'
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe.skipIf(!windows)('Git for Windows Claude helpers', () => {
  it('reports matching job ids and formats status without jq', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holi win café 402-'))
    dirs.push(root)
    const gitPath = (await execAsync('where.exe', ['git'])).stdout.split(/\r?\n/)[0]!.trim()
    const gitRoot = resolve(dirname(gitPath), '..')
    const sh = join(gitRoot, 'bin', 'sh.exe')
    const gitTools = join(gitRoot, 'usr', 'bin')
    const fallbackDir = await installNodeFallback(join(root, 'user data'), process.execPath)
    const env = { ...process.env, PATH: `${gitTools};${dirname(gitPath)};${fallbackDir}` }
    const jobs: string[] = []
    const statuses: string[] = []
    const server = createBridgeServer({ log: () => {} })
    registerAgentRoutes(server, {
      onStatus: (_remote, job) => statuses.push(job),
      onChannel: () => {},
      log: () => {},
    })
    server.route('/hooks/pre-commit', {
      body: 'discard',
      handle: (_remote, query) => {
        jobs.push(query.get('job') ?? '')
        return { status: 204, body: '' }
      },
    })
    await server.start()
    try {
      const token = server.tokenForVault('owner/repo')
      await writeVaultEnv(root, bridgeLines(server.port()!, token))
      await execAsync('git', ['init', '-b', 'main', root])
      await execAsync('git', ['-C', root, 'config', 'user.name', 'Holi Test'])
      await execAsync('git', ['-C', root, 'config', 'user.email', 'test@holi.invalid'])
      await installGitHook(root, 1024)

      for (const [index, jobDir] of [
        'C:\\Users\\Ada\\Vault café\\jobs\\abcd1234',
        'C:/Users/Ada/Vault café/jobs/abcd1234',
      ].entries()) {
        await writeFile(join(root, `note-${index}.md`), 'safe\n')
        await execAsync('git', ['-C', root, 'add', `note-${index}.md`])
        await execAsync('git', ['-C', root, 'commit', '-m', `fixture ${index}`], {
          env: { ...env, CLAUDE_JOB_DIR: jobDir },
        })
        const footer = await new Promise<string>((resolve, reject) => {
          const child = execFile(sh, ['-c', STATUS_LINE], {
            cwd: root,
            env: { ...env, CLAUDE_JOB_DIR: jobDir },
          })
          let output = ''
          let errors = ''
          const timer = setTimeout(() => {
            child.kill()
            reject(new Error(`sh timed out; stderr: ${errors}`))
          }, 10_000)
          child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()))
          child.stderr?.on('data', (chunk: Buffer) => (errors += chunk.toString()))
          child.on('error', (error) => {
            clearTimeout(timer)
            reject(error)
          })
          child.on('close', (code) => {
            clearTimeout(timer)
            code === 0 ? resolve(output) : reject(new Error(`sh exited ${code}; stderr: ${errors}`))
          })
          child.stdin?.end(
            '{"model":{"display_name":"Opus"},"context_window":{"used_percentage":41.6}}',
          )
        })
        expect(footer).toBe('Opus · 42% context')
      }
      expect(jobs).toEqual(['abcd1234', 'abcd1234'])
      await vi.waitFor(() => expect(statuses).toEqual(['abcd1234', 'abcd1234']))
    } finally {
      await server.stop()
    }
  })
})
