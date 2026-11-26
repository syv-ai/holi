import { execFile } from 'node:child_process'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
let root: string
let shell: (
  args: string[],
  input?: string,
  extra?: NodeJS.ProcessEnv,
) => ReturnType<typeof execAsync>
let shellEnv: NodeJS.ProcessEnv

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe.skipIf(!windows)('Git for Windows Claude helpers', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'holi win café 402-'))
    dirs.push(root)
    const gitPath = (await execAsync('where.exe', ['git'])).stdout.split(/\r?\n/)[0]!.trim()
    const gitRoot = resolve(dirname(gitPath), '..')
    const fallbackDir = await installNodeFallback(join(root, 'user data'), process.execPath)
    const env = {
      ...process.env,
      PATH: `${join(gitRoot, 'usr', 'bin')};${dirname(gitPath)};${fallbackDir}`,
    }
    shellEnv = env
    const sh = join(gitRoot, 'bin', 'sh.exe')
    shell = (args, input = '', extra = {}) => {
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
  })

  it('uses the installed Node shim without jq', async () => {
    const available = await shell(['-c', 'command -v jq || true; command -v node'])
    expect(available.stderr).toBe('')
    const tools = available.stdout.trim().split(/\r?\n/)
    expect(tools).toHaveLength(1)
    expect(tools[0]!.replaceAll('\\', '/')).toContain('/user data/bin/fallback/node')
  })

  it('shares one job identity across hook, CLI and status for each supported path form', async () => {
    const userData = join(root, 'user data')
    const machineToken = 'a'.repeat(64)
    const jobs: string[] = []
    const statuses: string[] = []
    const cliJobs: string[] = []
    const server = createBridgeServer({
      log: () => {},
      cli: {
        dispatch: async ({ params }) => {
          const session = (params as { session?: string }).session ?? ''
          const label = (params as { label?: string }).label ?? ''
          cliJobs.push(`${session}|${label}`)
          return { value: `${session}|${label}`, text: `${session}|${label}` }
        },
        commands: () => [
          {
            name: 'fixture.who',
            cli: { args: ['label'], summary: 'calling job', job: 'session' },
          },
        ],
        rootFor: async () => root,
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
        const note = `note-${index}.md`
        await writeFile(join(root, note), 'safe\n')
        await execAsync('git', ['-C', root, 'add', note])
        await execAsync('git', ['-C', root, 'commit', '-m', 'fixture'], {
          env: { ...shellEnv, CLAUDE_JOB_DIR: jobDir },
          timeout: 10_000,
        })
        expect(
          await shell(
            ['-c', STATUS_LINE],
            '{"model":{"display_name":"Opus"},"context_window":{"used_percentage":41.6}}',
            { CLAUDE_JOB_DIR: jobDir },
          ),
        ).toMatchObject({ stdout: 'Opus · 42% context', stderr: '' })
        const label = `Ada's café "vault" ${index}`
        expect(
          await shell([cli, 'fixture', 'who', label], '', { CLAUDE_JOB_DIR: jobDir }),
        ).toMatchObject({
          stdout: `abcd1234|${label}\n`,
          stderr: '',
        })
      }
      expect(jobs).toEqual(['abcd1234', 'abcd1234'])
      expect(cliJobs).toEqual([`abcd1234|Ada's café "vault" 0`, `abcd1234|Ada's café "vault" 1`])
      await vi.waitFor(() => expect(statuses).toEqual(['abcd1234', 'abcd1234']))
    } finally {
      await server.stop()
    }
  })

  it.each(['', '{bad', 'null', '[]', '{}'])(
    'returns an empty footer for invalid status JSON %j',
    async (input) => {
      expect(await shell(['-c', STATUS_LINE], input, { CLAUDE_JOB_DIR: '' })).toMatchObject({
        stdout: '',
        stderr: '',
      })
    },
  )

  it('renders the model safely when no job marker is present', async () => {
    expect(
      await shell(['-c', STATUS_LINE], '{"model":{"display_name":"Opus"}}', { CLAUDE_JOB_DIR: '' }),
    ).toMatchObject({ stdout: 'Opus', stderr: '' })
    const model = '$(touch injected-marker); `touch injected-marker` & "café"'
    expect(
      await shell(['-c', STATUS_LINE], JSON.stringify({ model: { display_name: model } }), {
        CLAUDE_JOB_DIR: '',
      }),
    ).toMatchObject({ stdout: model, stderr: '' })
    await expect(access(join(root, 'injected-marker'))).rejects.toThrow()
  })

  it.each(['', 'C:\\jobs\\abcd1234&injected=1', 'C:\\jobs\\abcd1234\\'])(
    'rejects invalid job directory %j',
    async (jobDir) => {
      expect(await shell(['-c', STATUS_LINE], '{}', { CLAUDE_JOB_DIR: jobDir })).toMatchObject({
        stdout: '',
        stderr: '',
      })
    },
  )
})
