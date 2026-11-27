import { A, B, adapters, harness, rig, tempDirectory, waitForFile } from './activation-fixture'
import { chmod, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, delimiter, join } from 'node:path'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PLUGIN_COMMANDS_DIR } from '@holi/shared'
import { claudeProvider } from '../main/claude/index'
import { PRESETS } from '../main/harness/record'

const ownedDirectories: string[] = []
afterEach(() => vi.unstubAllEnvs())
// The activation rig joins child drainage in afterEach before directories vanish.
afterAll(async () => {
  await Promise.all(
    ownedDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

async function ownedDirectory(prefix: string) {
  const dir = await tempDirectory(prefix)
  ownedDirectories.push(dir)
  return dir
}

function hostileInheritedEnv(userData: string) {
  // Keep host executables (git and the native process supervisor) available.
  vi.stubEnv(
    'PATH',
    [join(userData, 'wrong-bin'), process.env.PATH].filter(Boolean).join(delimiter),
  )
  vi.stubEnv('HOLI_BIN', join(userData, 'wrong-bin', 'holi'))
}

async function fixture() {
  const userData = await ownedDirectory('holi-launch-binding-')
  const bins = { [A]: join(userData, 'commands-a'), [B]: join(userData, 'commands-b') }
  for (const bin of Object.values(bins)) await mkdir(bin)
  // Model the prepared-bin contract at the plugin seam, without knowing core's
  // descriptor or token layout. All agent activation and launch code is real.
  const result = await rig(userData, undefined, true, {
    retainedContexts: true,
    context: (ctx) => {
      const bin = bins[ctx.remote as typeof A | typeof B]
      ctx.binDir = () => bin
    },
  })
  return { ...result, bins }
}

function binding(env: Record<string, string>, bin: string) {
  expect(env.HOLI_BIN).toBe(join(bin, 'holi'))
  const path = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1]
  expect(path?.split(delimiter)[0]).toBe(bin)
}

it('binds retained activation terminals and regenerated background settings after presets', async () => {
  const { host, enter, call, bins, userData, roots } = await fixture()
  await enter(A)
  await enter(B)
  const personHome = join(userData, 'person-home')
  await mkdir(personHome)
  await writeFile(
    join(personHome, 'auth.json'),
    JSON.stringify({ tokens: { access_token: 'synthetic' } }),
  )
  hostileInheritedEnv(userData)
  const presetEnv = {
    KEEP_ME: 'yes',
    CODEX_HOME: personHome,
    PI_CODING_AGENT_DIR: personHome,
  }
  for (const id of ['codex', 'pi']) {
    const preset = PRESETS.find((item) => item.id === id)!
    await call(B, 'agent.harnessSave', {
      harness: {
        ...preset,
        command: { bin: process.execPath, args: ['--preset'] },
        env: presetEnv,
      },
    })
  }
  await call(B, 'agent.harnessSave', {
    harness: { ...harness, command: { bin: process.execPath, args: [] }, env: presetEnv },
    create: true,
  })
  for (const remote of [A, B] as const) {
    host.setDisplayed(remote)
    for (const provider of ['codex', 'pi', harness.id]) {
      expect(await call(remote, 'agent.start', { provider, prompt: 'hello' })).toMatchObject({
        ok: true,
      })
      const launched = adapters.pty.at(-1)!
      binding(launched.env, bins[remote])
      expect(launched.env.KEEP_ME).toBe('yes')
    }
    for (const provider of ['codex', 'pi']) {
      expect(
        await call(remote, 'agent.start', {
          provider,
          resume: '123e4567-e89b-42d3-a456-426614174000',
        }),
      ).toMatchObject({ ok: true })
      binding(adapters.pty.at(-1)!.env, bins[remote])
      expect(
        await call(remote, 'agent.scoped', {
          provider,
          name: 'fenced',
          prompt: 'noop',
          scope: { read: [], write: [] },
        }),
      ).toMatchObject({ ok: true })
      const fencedEnv = adapters.pty.at(-1)!.env
      expect(fencedEnv.HOLI_BIN).toBeUndefined()
      for (const bin of Object.values(bins)) {
        expect(fencedEnv.PATH?.split(delimiter)).not.toContain(bin)
      }
    }
    expect(await call(remote, 'agent.open', { login: true })).toMatchObject({ ok: true })
    const launched = adapters.pty.at(-1)!
    binding(launched.env, bins[remote])
    const settings = JSON.parse(
      await readFile(join(launched.env.CLAUDE_CONFIG_DIR!, 'settings.json'), 'utf8'),
    )
    binding(settings.env, bins[remote])
    // A later configure must repair stale settings without dropping other keys.
    await writeFile(
      join(launched.env.CLAUDE_CONFIG_DIR!, 'settings.json'),
      JSON.stringify({
        env: { ...presetEnv, PATH: '/stale', HOLI_BIN: '/wrong/holi', EXTRA: 'kept' },
      }),
    )
    // Opening another terminal reuses the existing activation's config; use the
    // provider's public configure interface to model the later regeneration.
    await claudeProvider({
      userData,
      holiBin: () => join(bins[remote], 'holi'),
      systemPrefersDark: () => false,
    }).configure({ remote, root: roots[remote] })
    expect(await call(remote, 'agent.open', { login: true })).toMatchObject({ ok: true })
    const refreshed = JSON.parse(
      await readFile(join(launched.env.CLAUDE_CONFIG_DIR!, 'settings.json'), 'utf8'),
    )
    binding(refreshed.env, bins[remote])
    expect(refreshed.env.EXTRA).toBe('kept')
    expect(
      await call(remote, 'agent.launch', {
        provider: 'claude',
        name: 'background',
        prompt: 'noop',
      }),
    ).toMatchObject({ ok: true })
    const background = adapters.run.mock.calls.filter(([, args]) => args.includes('--bg')).at(-1)!
    binding(background[2].env, bins[remote])
  }
  await host.stop(A)
  host.setDisplayed(B)
  expect(await call(B, 'agent.start', { provider: 'pi' })).toMatchObject({ ok: true })
  binding(adapters.pty.at(-1)!.env, bins[B])
})

it.skipIf(process.platform === 'win32')(
  'excludes CLI authority from actual Codex jobs while binding Pi RPC children',
  async () => {
    const { host, enter, call, bins, userData } = await fixture()
    const executable = join(userData, 'native-launch-fixture')
    await writeFile(
      executable,
      `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const args = process.argv.slice(2);
const rpc = args.includes('--mode');
const capture = rpc ? path.basename(path.dirname(process.env.HOLI_BIN)) + '-rpc' : 'job';
const env = Object.fromEntries(
  ['PATH', 'HOLI_BIN', 'HOLI_AGENT_SESSION', 'CODEX_HOME', 'CAPTURE_DIR']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])
);
fs.writeFileSync(path.join(process.env.CAPTURE_DIR, capture), JSON.stringify({ env, cwd: process.cwd(), args }));
if (!rpc) {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fixture-thread' }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } }));
} else {
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const cmd = JSON.parse(line);
    if (cmd.type === 'prompt') {
      console.log(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true }));
      console.log(JSON.stringify({ type: 'agent_start' }));
      console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } }));
      console.log(JSON.stringify({ type: 'agent_settled', aborted: false }));
    } else if (cmd.type === 'get_session_stats') {
      console.log(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data: { tokens: { input: 0, output: 0, total: 0 } } }));
    } else if (cmd.type === 'abort') {
      console.log(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true }));
    } else {
      console.log(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: false, error: 'Unsupported fixture command' }));
    }
  });
}
`,
    )
    await chmod(executable, 0o755)
    const personHome = join(userData, 'codex-person')
    await mkdir(personHome)
    await writeFile(
      join(personHome, 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'synthetic' } }),
    )
    await enter(A)
    await enter(B)
    hostileInheritedEnv(userData)
    for (const id of ['codex', 'pi']) {
      await call(B, 'agent.harnessSave', {
        harness: {
          ...PRESETS.find((item) => item.id === id)!,
          command: { bin: executable, args: [] },
          env: {
            CAPTURE_DIR: userData,
            CODEX_HOME: personHome,
            PI_CODING_AGENT_DIR: personHome,
          },
        },
      })
    }
    for (const remote of [A, B] as const) {
      const job = await call(remote, 'agent.job', {
        provider: 'codex',
        name: 'fixture',
        prompt: 'noop',
        scope: { read: [], write: [] },
      })
      expect(job).toMatchObject({ ok: true })
      expect(
        await call(remote, 'agent.launch', {
          provider: 'pi',
          name: 'fixture',
          prompt: 'noop',
          tools: 'none',
          keep: true,
        }),
      ).toMatchObject({ ok: true })
      for (const kind of ['job', 'rpc']) {
        const captured = JSON.parse(
          await waitForFile(
            join(userData, kind === 'job' ? 'job' : `${basename(bins[remote])}-rpc`),
          ),
        )
        if (kind === 'job') {
          expect(captured.env.HOLI_BIN).toBeUndefined()
          expect(captured.env.HOLI_AGENT_SESSION).toBeUndefined()
          for (const bin of Object.values(bins)) {
            expect(captured.env.PATH?.split(delimiter)).not.toContain(bin)
          }
          expect(captured.env.CODEX_HOME).not.toBe(personHome)
          await unlink(join(userData, 'job'))
        } else {
          binding(captured.env, bins[remote])
        }
        expect(captured.args).not.toContain('--dangerously-skip-permissions')
      }
    }
    await host.stop(A)
    expect(
      await call(B, 'agent.launch', {
        provider: 'pi',
        name: 'still live',
        prompt: 'noop',
        tools: 'none',
        keep: true,
      }),
    ).toMatchObject({ ok: true })
  },
)

it.skipIf(process.platform === 'win32')(
  'keeps community commands and the owning holi available after Claude settings regeneration',
  async () => {
    const userData = await ownedDirectory('holi-claude-settings-path-')
    const root = join(userData, 'vault')
    const bin = join(userData, 'own-bin')
    const commands = join(root, PLUGIN_COMMANDS_DIR)
    await mkdir(bin)
    await mkdir(commands, { recursive: true })
    await writeFile(join(bin, 'holi'), '#!/bin/sh\nprintf "own-vault"\n', { mode: 0o755 })
    await writeFile(join(commands, 'community-probe'), '#!/bin/sh\nprintf "community"\n', {
      mode: 0o755,
    })
    // Even a community command with the trusted name cannot replace our CLI.
    await writeFile(join(commands, 'holi'), '#!/bin/sh\nprintf "foreign"\n', { mode: 0o755 })
    const provider = claudeProvider({
      userData,
      holiBin: () => join(bin, 'holi'),
      systemPrefersDark: () => false,
    })
    const target = { remote: A, root }
    const config = await provider.configure(target)
    expect(config).not.toBeNull()
    const settingsPath = join(config!.dir, 'settings.json')
    for (let attempt = 0; attempt < 2; attempt++) {
      const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
      binding(settings.env, bin)
      // Settings override the spawn environment: use only the stamped env here.
      for (const [command, answer] of [
        ['holi', 'own-vault'],
        ['community-probe', 'community'],
      ] as const) {
        expect(
          (await promisify(execFile)(command, [], { cwd: root, env: settings.env })).stdout,
        ).toBe(answer)
      }
      if (attempt === 0) {
        await writeFile(
          settingsPath,
          JSON.stringify({ env: { PATH: '/stale', HOLI_BIN: '/wrong' } }),
        )
        await provider.configure(target)
      }
    }
  },
)
