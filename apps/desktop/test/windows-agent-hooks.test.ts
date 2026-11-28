import { execFile, spawn } from 'node:child_process'
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { delimiter, join, resolve as resolvePath } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { installNodeFallback } from '../src/main/bridge/node-fallback'
import { createBridgeServer } from '../src/main/bridge/server'
import { installSignalCommand, registerSignalRoute } from '../src/plugins/agent/main/harness/signal'
import { notifyOverride, registerCodexRoutes } from '../src/plugins/agent/main/codex'
import { installHoliCli } from '../src/main/bridge/cli'
import { resolveBundledWindowsNode } from '../src/main/windows-node-runtime'
import { bridgeLines, writeVaultEnv } from './helpers/bridge-env'

const exec = promisify(execFile)
const windows = process.platform === 'win32'
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.skipIf(!windows)('Windows agent hook launchers', () => {
  async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'holi-agent-hook-'))
    roots.push(root)
    const userData = join(root, 'user data')
    await mkdir(userData, { recursive: true })
    const git = (await exec('where.exe', ['git'])).stdout.split(/\r?\n/)[0]!.trim()
    const gitRoot = join(git, '..', '..')
    const shell = join(gitRoot, 'bin', 'sh.exe')
    const fallbackDir = await installNodeFallback(userData, process.execPath)
    const systemPath = (process.env.PATH ?? '')
      .split(delimiter)
      .filter((entry) => !/node/i.test(entry))
    const path = [
      join(gitRoot, 'usr', 'bin'),
      join(gitRoot, 'bin'),
      ...systemPath,
      fallbackDir,
    ].join(delimiter)
    const env = { ...process.env, PATH: path }
    const nodePath = resolveBundledWindowsNode()
    if (!nodePath) throw new Error('Bundled Windows Node is required')
    const dispatched: unknown[] = []
    let checkResult = {
      value: ['invalid record: missing required field name'],
      text: 'invalid record: missing required field name',
    }
    const server = createBridgeServer({
      log: () => {},
      cli: {
        dispatch: async (invocation) => {
          dispatched.push(invocation)
          return checkResult
        },
        commands: () => [
          {
            name: 'store.check',
            cli: { args: ['path'], summary: 'check a record' },
          },
        ],
        rootFor: async () => root,
      },
    })
    await server.start()
    const token = server.tokenForVault('owner/repo')
    await writeVaultEnv(root, bridgeLines(server.port()!, token))
    return {
      root,
      userData,
      shell,
      env,
      server,
      token,
      dispatched,
      nodePath,
      acceptRecord: () => {
        checkResult = { value: [], text: '' }
      },
    }
  }

  it('runs the installed signal command into the registered signal route', async () => {
    const x = await setup()
    const signals: unknown[] = []
    registerSignalRoute(x.server, {
      onSignal: (_remote, session, signal) => signals.push({ session, signal }),
    })
    try {
      const bin = join(x.userData, 'bin')
      await installSignalCommand(bin)
      await exec(
        x.shell,
        [join(bin, 'holi-signal'), 'status', '--context', '42.4', '--model', 'Codex'],
        {
          cwd: x.root,
          env: { ...x.env, HOLI_AGENT_SESSION: 'p123456789abc' },
          timeout: 10000,
        },
      )
      expect(signals).toEqual([
        {
          session: 'p123456789abc',
          signal: { kind: 'status', contextPercent: 42, model: 'Codex' },
        },
      ])
    } finally {
      await x.server.stop()
    }
  })

  it('executes notifyOverride unchanged and reaches the production Codex route', async () => {
    const x = await setup()
    const turns: unknown[] = []
    const conversations: unknown[] = []
    registerCodexRoutes(x.server, {
      onConversation: (_remote, session, conversation) =>
        conversations.push({ session, conversation }),
      onTurn: (_remote, session, started, detail) => turns.push({ session, started, detail }),
    })
    try {
      const override = notifyOverride().slice('notify='.length)
      const argv = JSON.parse(override) as string[]
      const payload = JSON.stringify({
        'input-messages': ['hello'],
        'thread-id': '123e4567-e89b-42d3-a456-426614174000',
      })
      await exec(argv[0]!, [...argv.slice(1), payload], {
        cwd: x.root,
        env: { ...x.env, HOLI_AGENT_SESSION: 'p123456789abc' },
        timeout: 10000,
      })
      expect(turns).toEqual([{ session: 'p123456789abc', started: false, detail: null }])
      expect(conversations).toEqual([
        {
          session: 'p123456789abc',
          conversation: { name: 'hello', conversationId: '123e4567-e89b-42d3-a456-426614174000' },
        },
      ])
    } finally {
      await x.server.stop()
    }
  })

  it('runs the shipped vault-app hook through the installed CLI store.check contract', async () => {
    const x = await setup()
    try {
      const binding = {
        descriptorPath: join(x.userData, 'vault-cli-endpoint.json'),
        binDir: join(x.userData, 'vault-bin'),
      }
      const cli = await installHoliCli(x.userData, 'win32', binding)
      await writeFile(
        binding.descriptorPath,
        JSON.stringify({ host: '127.0.0.1', port: x.server.port(), token: x.token }, null, 2) +
          '\n',
      )
      const hook = join(x.root, 'vault-app-check.mjs')
      await copyFile(
        join(
          process.cwd(),
          'src/plugins/apps/main/vault/shipped/.claude/hooks/vault-app-check.mjs',
        ),
        hook,
      )
      const app = join(x.root, 'demo.app', 'data', 'things', 'record.json')
      await mkdir(join(x.root, 'demo.app/data/things'), { recursive: true })
      await writeFile(app, '{}')
      const result = await new Promise<{ stdout: string }>((resolve, reject) => {
        const child = spawn(x.nodePath, [hook], {
          cwd: x.root,
          env: { ...x.env, HOLI_BIN: cli },
          timeout: 10000,
        })
        let stdout = ''
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
        child.on('error', reject)
        child.on('close', (code) =>
          code === 0 ? resolve({ stdout }) : reject(new Error(`hook exited ${code}`)),
        )
        child.stdin.on('error', reject)
        child.stdin.end(JSON.stringify({ cwd: x.root, tool_input: { file_path: app } }))
      })
      const output = JSON.parse(result.stdout) as {
        hookSpecificOutput?: { additionalContext?: string }
      }
      expect(output.hookSpecificOutput?.additionalContext).toContain(
        'invalid record: missing required field name',
      )
      expect(x.dispatched).toHaveLength(1)
      const invocation = x.dispatched[0] as { params: { path: string } }
      expect(invocation).toMatchObject({ name: 'store.check', remote: 'owner/repo' })
      expect(resolvePath(x.root, invocation.params.path)).toBe(app)

      x.acceptRecord()
      await writeFile(app, '{"name":"valid"}')
      const valid = await new Promise<string>((resolve, reject) => {
        const child = spawn(x.nodePath, [hook], { cwd: x.root, env: { ...x.env, HOLI_BIN: cli } })
        let stdout = ''
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
        child.on('error', reject)
        child.on('close', (code) =>
          code === 0 ? resolve(stdout) : reject(new Error(`hook exited ${code}`)),
        )
        child.stdin.on('error', reject)
        child.stdin.end(JSON.stringify({ cwd: x.root, tool_input: { file_path: app } }))
      })
      expect(valid).toBe('')
      expect(x.dispatched.slice(1)).toContainEqual(expect.objectContaining({ name: 'store.check' }))
    } finally {
      await x.server.stop()
    }
  })
})
