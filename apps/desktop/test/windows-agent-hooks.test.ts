import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { installNodeFallback } from '../src/main/bridge/node-fallback'
import { createBridgeServer } from '../src/main/bridge/server'
import { installSignalCommand, registerSignalRoute } from '../src/plugins/agent/main/harness/signal'
import { notifyOverride, registerCodexRoutes } from '../src/plugins/agent/main/codex'
import { installHoliCli } from '../src/main/bridge/cli'
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
    const path = `${join(gitRoot, 'usr', 'bin')};${join(gitRoot, 'bin')};${process.env.PATH}`
    const env = { ...process.env, PATH: path }
    const server = createBridgeServer({ log: () => {} })
    await server.start()
    const token = server.tokenForVault('owner/repo')
    await writeVaultEnv(root, bridgeLines(server.port()!, token))
    return { root, userData, shell, env, server, token }
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
          env: { ...x.env, HOLI_AGENT_SESSION: 'p12345678' },
          timeout: 10000,
        },
      )
      expect(signals).toEqual([
        { session: 'p12345678', signal: { kind: 'status', contextPercent: 42, model: 'Codex' } },
      ])
    } finally {
      await x.server.stop()
    }
  })

  it('executes notifyOverride unchanged and reaches the production Codex route', async () => {
    const x = await setup()
    const turns: unknown[] = []
    registerCodexRoutes(x.server, {
      onTurn: (_remote, session, started, detail) => turns.push({ session, started, detail }),
    })
    try {
      const override = notifyOverride().slice('notify='.length)
      const argv = JSON.parse(override) as string[]
      const payload = JSON.stringify({
        'input-messages': ['hello'],
        'thread-id': '12345678-1234-1234-1234-123456789abc',
      })
      await exec(argv[0]!, [...argv.slice(1), payload], {
        cwd: x.root,
        env: { ...x.env, HOLI_AGENT_SESSION: 'p12345678' },
        timeout: 10000,
      })
      expect(turns).toEqual([{ session: 'p12345678', started: false, detail: null }])
    } finally {
      await x.server.stop()
    }
  })

  it('runs the shipped vault-app hook through the installed CLI store.check contract', async () => {
    const x = await setup()
    const messages: string[] = []
    x.server.route('/cli', {
      body: 'json',
      handle: () => ({
        status: 200,
        body: JSON.stringify({ text: 'invalid record: missing required field name' }),
      }),
    })
    try {
      const cli = await installHoliCli(x.userData)
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
      const result = await exec(process.execPath, [hook], {
        cwd: x.root,
        env: { ...x.env, HOLI_BIN: cli },
        timeout: 10000,
      })
      messages.push(result.stdout)
      expect(messages[0]).toContain('invalid record: missing required field name')
    } finally {
      await x.server.stop()
    }
  })
})
