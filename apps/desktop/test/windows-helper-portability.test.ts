import { execFile } from 'node:child_process'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installGitHook } from '../src/main/vault/large-files'
import { installHoliCli } from '../src/main/bridge/cli'
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
  it('shares job identity across hook, CLI and jq-free status using the installed Node shim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holi win café 402-'))
    dirs.push(root)
    const gitPath = (await execAsync('where.exe', ['git'])).stdout.split(/\r?\n/)[0]!.trim()
    const gitRoot = resolve(dirname(gitPath), '..')
    const sh = join(gitRoot, 'bin', 'sh.exe')
    const gitTools = join(gitRoot, 'usr', 'bin')
    const userData = join(root, 'user data')
    // The installed shim uses the supplied runtime, as it uses Electron in the app.
    const fallbackDir = await installNodeFallback(userData, process.execPath)
    const env = { ...process.env, PATH: `${gitTools};${dirname(gitPath)};${fallbackDir}` }
    const shell = (args: string[], input = '', extra: NodeJS.ProcessEnv = {}) => {
      const running = execAsync(sh, args, {
        cwd: root,
        env: { ...env, ...extra },
        timeout: 10_000,
        windowsHide: true,
      })
      running.child.stdin?.on('error', () => {})
      running.child.stdin?.end(input)
      return running
    }
    const jobs: string[] = []
    const statuses: string[] = []
    const cliJobs: string[] = []
    const machineToken = 'a'.repeat(64)
    const server = createBridgeServer({
      log: () => {},
      cli: {
        dispatch: async ({ params }) => {
          const session = (params as { session?: string }).session ?? ''
          cliJobs.push(session)
          return { value: session, text: session }
        },
        commands: () => [
          { name: 'fixture.who', cli: { args: [], summary: 'calling job', job: 'session' } },
        ],
        rootFor: async () => root,
        // An explicit fixture target isolates transport from launcher discovery.
        machine: {
          token: () => machineToken,
          resolveTarget: async () => ({ remote: 'owner/repo', root, live: true }),
        },
      },
    })
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
      const available = await shell(['-c', 'command -v jq || true; command -v node'])
      expect(available.stderr).toBe('')
      const tools = available.stdout.trim().split(/\r?\n/)
      expect(tools).toHaveLength(1)
      expect(tools[0]!.replaceAll('\\', '/')).toContain('/user data/bin/fallback/node')
      await writeVaultEnv(root, bridgeLines(server.port()!, server.tokenForVault('owner/repo')))
      const cli = await installHoliCli(userData)
      await writeFile(
        join(userData, 'cli-endpoint.json'),
        JSON.stringify({ host: '127.0.0.1', port: server.port(), token: machineToken }, null, 2) +
          '\n',
      )
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
          timeout: 10_000,
        })
        const footer = await shell(
          ['-c', STATUS_LINE],
          '{"model":{"display_name":"Opus"},"context_window":{"used_percentage":41.6}}',
          { CLAUDE_JOB_DIR: jobDir },
        )
        expect(footer).toMatchObject({ stdout: 'Opus · 42% context', stderr: '' })
        expect(await shell([cli, 'fixture', 'who'], '', { CLAUDE_JOB_DIR: jobDir })).toMatchObject({
          stdout: 'abcd1234\n',
          stderr: '',
        })
      }
      expect(jobs).toEqual(['abcd1234', 'abcd1234'])
      expect(cliJobs).toEqual(['abcd1234', 'abcd1234'])
      await vi.waitFor(() => expect(statuses).toEqual(['abcd1234', 'abcd1234']))

      for (const input of ['', '{bad', 'null', '[]', '{}']) {
        expect(await shell(['-c', STATUS_LINE], input, { CLAUDE_JOB_DIR: '' })).toMatchObject({
          stdout: '',
          stderr: '',
        })
      }
      expect(
        await shell(['-c', STATUS_LINE], '{"model":{"display_name":"Opus"}}', {
          CLAUDE_JOB_DIR: '',
        }),
      ).toMatchObject({ stdout: 'Opus', stderr: '' })
      const model = '$(touch injected-marker); `touch injected-marker` & "café"'
      expect(
        await shell(['-c', STATUS_LINE], JSON.stringify({ model: { display_name: model } }), {
          CLAUDE_JOB_DIR: '',
        }),
      ).toMatchObject({ stdout: model, stderr: '' })
      await expect(access(join(root, 'injected-marker'))).rejects.toThrow()
      for (const jobDir of ['', 'C:\\jobs\\abcd1234&injected=1', 'C:\\jobs\\abcd1234\\']) {
        expect(await shell(['-c', STATUS_LINE], '{}', { CLAUDE_JOB_DIR: jobDir })).toMatchObject({
          stdout: '',
          stderr: '',
        })
      }
    } finally {
      await server.stop()
    }
  })
})
