import { A, B, adapters, harness, rig, tempDirectory, waitForFile } from './activation-fixture'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, delimiter, join } from 'node:path'
import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PLUGIN_COMMANDS_DIR } from '@holi/shared'
import { claudeProvider } from '../main/claude/index'
import { PRESETS } from '../main/harness/record'

async function fixture() {
  const userData = await tempDirectory('holi-launch-binding-')
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
  const { host, enter, call, bins, userData } = await fixture()
  await enter(A)
  await enter(B)
  const personHome = join(userData, 'person-home')
  await mkdir(personHome)
  const hostile = {
    PATH: '/preset-bin',
    HOLI_BIN: '/wrong/holi',
    KEEP_ME: 'yes',
    CODEX_HOME: personHome,
    PI_CODING_AGENT_DIR: personHome,
  }
  for (const id of ['codex', 'pi']) {
    const preset = PRESETS.find((item) => item.id === id)!
    await call(B, 'agent.harnessSave', {
      harness: { ...preset, command: { bin: process.execPath, args: ['--preset'] }, env: hostile },
    })
  }
  await call(B, 'agent.harnessSave', {
    harness: { ...harness, command: { bin: process.execPath, args: [] }, env: hostile },
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
      binding(adapters.pty.at(-1)!.env, bins[remote])
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
      JSON.stringify({ env: { ...hostile, EXTRA: 'kept' } }),
    )
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
  'binds actual Codex job and Pi RPC children independently of their cwd',
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
const owner = path.basename(path.dirname(process.env.HOLI_BIN));
fs.writeFileSync(path.join(process.env.CAPTURE_DIR, owner + (rpc ? '-rpc' : '-job')), JSON.stringify({ env: process.env, cwd: process.cwd(), args }));
if (!rpc) {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fixture-thread' }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } }));
} else {
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const cmd = JSON.parse(line);
    if (cmd.type === 'prompt') {
      console.log(JSON.stringify({ type: 'agent_start' }));
      console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } }));
      console.log(JSON.stringify({ type: 'agent_settled' }));
    } else if (cmd.type === 'get_session_stats') {
      console.log(JSON.stringify({ type: 'response', id: cmd.id, success: true, data: {} }));
    }
  });
}
`,
    )
    await chmod(executable, 0o755)
    const personHome = join(userData, 'codex-person')
    await mkdir(personHome)
    await enter(A)
    await enter(B)
    for (const id of ['codex', 'pi']) {
      await call(B, 'agent.harnessSave', {
        harness: {
          ...PRESETS.find((item) => item.id === id)!,
          command: { bin: executable, args: [] },
          env: {
            PATH: '/wrong',
            HOLI_BIN: '/wrong/holi',
            CAPTURE_DIR: userData,
            CODEX_HOME: personHome,
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
          await waitForFile(join(userData, `${basename(bins[remote])}-${kind}`)),
        )
        binding(captured.env, bins[remote])
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
    const userData = await tempDirectory('holi-claude-settings-path-')
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
