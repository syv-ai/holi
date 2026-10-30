import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import type { CapabilityContext } from '../../../main/plugin-api'
import { SESSION_ENV } from '../main/codex'
import { harnessCapabilities } from '../main/harness/capabilities'
import {
  harnessArgs,
  parseHarnessFile,
  PRESETS,
  readHarness,
  type Harness,
  type HarnessFile,
} from '../main/harness/record'
import { createHarnessRegistry, harnessProvider, withPreset } from '../main/harness/registry'
import { readSignal, SIGNAL_SCRIPT } from '../main/harness/signal'
import { agentCapabilities } from '../main/host/capabilities'
import type { AgentProvider } from '../main/provider'

const TARGET = { root: '/Users/ada/Holi/syv/vault', configDir: '/v', binDir: '/holi/bin' }

const AIDER: Harness = {
  id: 'aider',
  label: 'Aider',
  command: { bin: 'aider', args: ['--no-auto-commits'] },
  prompt: { args: ['--message', '{prompt}'] },
  resume: { pick: ['--restore-chat-history'], byId: ['--chat', '{id}'] },
  env: { AIDER_DARK_MODE: '1' },
}

const problems = (raw: unknown): string[] => {
  const read = readHarness(raw)
  return read.ok ? [] : read.problems
}

describe('a harness record', () => {
  it('takes a basic terminal agent', () => {
    expect(readHarness(AIDER)).toEqual({ ok: true, harness: AIDER })
  })

  it('refuses an id that is not a slug', () => {
    for (const id of ['Aider', 'a', '1aider', 'ai der', 'a'.repeat(33)]) {
      expect(problems({ ...AIDER, id }).join(' ')).toMatch(/id must be/)
    }
  })

  it('refuses a program written as a shell command, or a relative path', () => {
    expect(problems({ ...AIDER, command: { bin: 'aider --yes', args: [] } }).join(' ')).toMatch(
      /reads as a shell command/,
    )
    expect(problems({ ...AIDER, command: { bin: 'aider;rm -rf ~', args: [] } })).not.toEqual([])
    expect(problems({ ...AIDER, command: { bin: '$(evil)', args: [] } })).not.toEqual([])
    expect(problems({ ...AIDER, command: { bin: 'bin/aider', args: [] } })).not.toEqual([])
    expect(problems({ ...AIDER, command: { bin: '/opt/My Tools/aider', args: [] } })).toEqual([])
  })

  it("refuses an environment that sets PATH, Holi's variables or the bridge's", () => {
    for (const key of ['PATH', 'HOLI_AGENT_SESSION', 'HOLI_BRIDGE_TOKEN', 'HOLI_BRIDGE_PORT']) {
      expect(problems({ ...AIDER, env: { [key]: 'x' } })).not.toEqual([])
    }
    expect(problems({ ...AIDER, env: { 'NOT A NAME': 'x' } })).not.toEqual([])
  })

  it('refuses a placeholder inside a larger argument, or in the wrong list', () => {
    expect(problems({ ...AIDER, prompt: { args: ['--message={prompt}'] } }).join(' ')).toMatch(
      /fills a whole argument/,
    )
    expect(problems({ ...AIDER, resume: { byId: ['--chat={id}'] } })).not.toEqual([])
    expect(problems({ ...AIDER, command: { bin: 'aider', args: ['{prompt}'] } })).not.toEqual([])
    expect(problems({ ...AIDER, prompt: { args: ['--message'] } })).not.toEqual([])
  })

  it('refuses an unknown integration, and a built-in id without its own', () => {
    expect(problems({ ...AIDER, integration: 'gemini' }).join(' ')).toMatch(/not an integration/)
    expect(problems({ ...AIDER, integration: 'codex' })).not.toEqual([])
    expect(problems({ ...AIDER, id: 'claude' }).join(' ')).toMatch(/built-in/)
  })

  it('keeps what reads as a harness out of a hand-edited file, once per id', () => {
    const file = parseHarnessFile({
      version: 1,
      harnesses: [AIDER, { ...AIDER, label: 'Again' }, { id: 'Bad' }, 'nonsense'],
    })
    expect(file).toEqual({ version: 1, harnesses: [AIDER] })
    expect(parseHarnessFile(null)).toEqual({ version: 1, harnesses: [] })
  })
})

describe('a harness command line', () => {
  it('fills placeholders as whole arguments, never splitting what was asked', () => {
    expect(harnessArgs(AIDER, { prompt: '--delete everything; now' })).toEqual([
      '--no-auto-commits',
      '--message',
      '--delete everything; now',
    ])
    expect(harnessArgs(AIDER, { resume: '0b5c2f3e-1d2a-4c5b-8e9f-0a1b2c3d4e5f' })).toEqual([
      '--no-auto-commits',
      '--chat',
      '0b5c2f3e-1d2a-4c5b-8e9f-0a1b2c3d4e5f',
    ])
    expect(harnessArgs(AIDER, { resume: 'pick' })).toEqual([
      '--no-auto-commits',
      '--restore-chat-history',
    ])
    expect(harnessArgs(AIDER, {})).toEqual(['--no-auto-commits'])
  })

  it('runs as a basic terminal agent: argv for the PTY, its env, its session named', () => {
    const provider = harnessProvider(AIDER, () => '/usr/local/bin/aider')
    const cmd = provider.terminal(TARGET, { session: 'p0123456789ab', prompt: 'hi there' })
    expect(cmd?.bin).toBe('/usr/local/bin/aider')
    expect(cmd?.args).toEqual(['--no-auto-commits', '--message', 'hi there'])
    expect(cmd?.env[SESSION_ENV]).toBe('p0123456789ab')
    expect(cmd?.env.AIDER_DARK_MODE).toBe('1')
    expect(cmd?.env.PATH?.startsWith('/holi/bin:')).toBe(true)
    expect(provider.capabilities).toEqual({})
  })

  it('says what it cannot do instead of doing something else', () => {
    const bare = harnessProvider({ id: 'bare', label: 'Bare', command: { bin: 'bare', args: [] } })
    expect(bare.refuses?.({ prompt: 'hi' })).toMatch(/cannot start on a message/)
    expect(bare.refuses?.({ resume: 'pick' })).toMatch(/no resume picker/)
    expect(bare.refuses?.({ resume: '0b5c2f3e-1d2a-4c5b-8e9f-0a1b2c3d4e5f' })).toMatch(/by its id/)
    expect(bare.refuses?.({})).toBeNull()
    expect(bare.unattended).toMatch(/only in a terminal/)
  })

  it('reports a program that is not there in words that say what to do', () => {
    const missing = harnessProvider(AIDER, () => null)
    expect(missing.installed()).toBe(false)
    expect(missing.terminal(TARGET)).toBeNull()
    expect(missing.notInstalled).toMatch(/not found on PATH.*Settings/)
  })
})

/** A file in memory, as `jsonFileStore` keeps one. */
function memoryStore(initial: HarnessFile = { version: 1, harnesses: [] }) {
  let file = initial
  return {
    read: async () => file,
    update: async (change: (f: HarnessFile) => HarnessFile | Promise<HarnessFile>) => {
      file = await change(file)
      return file
    },
    now: () => file,
  }
}

const builtIn = (id: string): AgentProvider =>
  ({
    id,
    label: id,
    notInstalled: `${id} missing`,
    installed: () => true,
    configure: async () => ({ dir: '/' }),
    terminal: () => ({ bin: `/bin/${id}`, args: ['own'], env: { A: '1' } }),
    capabilities: {},
  }) as AgentProvider

async function registry(store = memoryStore()) {
  return createHarnessRegistry({
    store,
    builtIns: {
      claude: (current) => withPreset(builtIn('claude'), current),
      codex: (current) => withPreset(builtIn('codex'), current),
      pi: (current) => withPreset(builtIn('pi'), current),
    },
  })
}

describe('the harness registry', () => {
  it('lists the presets first, then what was added, and re-reads its file', async () => {
    const store = memoryStore()
    const reg = await registry(store)
    expect(reg.providers().map((p) => p.id)).toEqual(['claude', 'codex', 'pi'])
    await store.update(() => ({ version: 1, harnesses: [AIDER] }))
    await reg.reload()
    expect(reg.providers().map((p) => p.id)).toEqual(['claude', 'codex', 'pi', 'aider'])
  })

  it('adds once per id, and refuses to change one that is not there', async () => {
    const reg = await registry()
    await reg.save(AIDER, true)
    await expect(reg.save(AIDER, true)).rejects.toThrow(/exists/)
    await expect(reg.save({ ...AIDER, id: 'other' }, false)).rejects.toThrow(/no agent/)
    await expect(reg.save({ ...PRESETS[1]! }, true)).rejects.toThrow(/exists/)
  })

  it('applies an edited preset to the built-in agent, keeping its own arguments', async () => {
    const store = memoryStore()
    const reg = await registry(store)
    const codex = reg.providers().find((p) => p.id === 'codex')!
    await reg.save(
      {
        ...PRESETS[1]!,
        label: 'My Codex',
        command: { bin: 'codex', args: ['--x'] },
        env: { B: '2' },
      },
      false,
    )
    expect(codex.label).toBe('My Codex')
    expect(codex.terminal(TARGET)).toEqual({
      bin: '/bin/codex',
      args: ['--x', 'own'],
      env: { A: '1', B: '2' },
    })
    // Put back as Holi has it: no entry at all.
    await reg.remove('codex')
    expect(codex.label).toBe('Codex')
    expect(store.now().harnesses).toEqual([])
    await reg.save({ ...PRESETS[1]! }, false)
    expect(store.now().harnesses).toEqual([])
  })

  it('removes one that was added', async () => {
    const reg = await registry(memoryStore({ version: 1, harnesses: [AIDER] }))
    await reg.remove('aider')
    expect(reg.providers().map((p) => p.id)).toEqual(['claude', 'codex', 'pi'])
    await expect(reg.remove('aider')).rejects.toThrow(/no agent/)
  })
})

describe('editing harnesses', () => {
  it('opens only the UI door: no agent session or app can add a program to run', async () => {
    const caps = harnessCapabilities({
      registry: await registry(),
      root: () => '/v',
      changed: () => {},
    })
    expect(Object.keys(caps).sort()).toEqual([
      'agent.harnessRemove',
      'agent.harnessSave',
      'agent.harnessTest',
      'agent.harnesses',
    ])
    for (const entry of Object.values(caps)) expect(entry.doors).toEqual(['ui'])
  })

  it('saves through the same validation, and Test runs the test arguments in the vault', async () => {
    const reg = await registry()
    const runs: unknown[] = []
    const caps = harnessCapabilities({
      registry: reg,
      root: () => '/v',
      changed: () => {},
      run: async (bin, args, opts) => {
        runs.push({ bin, args, cwd: opts.cwd, timeoutMs: opts.timeoutMs })
        return { code: 0, output: 'sh 1.0\n', timedOut: false }
      },
    })
    const ctx = {} as CapabilityContext
    expect(() =>
      caps['agent.harnessSave'].params({ harness: { ...AIDER, env: { PATH: '/x' } } }),
    ).toThrow(/PATH/)
    await caps['agent.harnessSave'].run(ctx, {
      harness: { ...AIDER, command: { bin: '/bin/sh', args: [] }, test: ['-c', 'echo'] },
      create: true,
    })
    const res = await caps['agent.harnessTest'].run(ctx, { id: 'aider' })
    expect(res).toEqual({ ok: true, output: 'sh 1.0\n' })
    expect(runs).toEqual([{ bin: '/bin/sh', args: ['-c', 'echo'], cwd: '/v', timeoutMs: 5000 }])
  })
})

describe('provider selection', () => {
  const custom = harnessProvider(AIDER, () => '/usr/local/bin/aider')
  const claude = {
    id: 'claude',
    label: 'Claude Code',
    capabilities: { background: {} },
  } as unknown as AgentProvider

  function caps(providers: AgentProvider[]) {
    const started: string[] = []
    const table = agentCapabilities({
      sessions: {
        start: async () => {
          started.push('claude')
          return { ok: true as const, sessionId: 'abcd1234', terminalId: 't' }
        },
      } as never,
      own: {
        start: async (provider: string) => {
          started.push(provider)
          return { ok: false as const, message: `${provider} is not an agent on this machine.` }
        },
      } as never,
      jobs: {} as never,
      fenced: {} as never,
      providers: () => providers,
      terminals: {} as never,
      liveRemote: () => 'syv/vault',
      commitNow: async () => null,
      defaultProvider: async () => 'aider',
    })
    return { table, started }
  }
  const ctx = { remote: 'syv/vault', root: '/v' } as unknown as CapabilityContext

  it('never runs an agent this machine does not have on Claude Code', async () => {
    const { table, started } = caps([claude])
    const res = await table['agent.start'].run(
      ctx,
      table['agent.start'].params({ provider: 'gone' }),
    )
    expect(res.ok).toBe(false)
    expect(started).toEqual(['gone'])
  })

  it('refuses unattended work on a harness that was added, saying why', async () => {
    const { table } = caps([claude, custom])
    const entry = table['agent.job']
    const res = await entry.run(
      ctx,
      entry.params({ name: 'Run', prompt: 'Go', scope: { read: [], write: ['notes/**'] } }),
    )
    expect(res).toEqual({ ok: false, message: custom.unattended })
  })

  it('lists what each agent can do, so the UI offers only that', async () => {
    const { table } = caps([custom])
    const [summary] = await table['agent.providers'].run(ctx, {})
    expect(summary).toMatchObject({
      id: 'aider',
      custom: true,
      prompts: true,
      resumePicker: true,
      background: false,
      jobs: false,
      unattended: custom.unattended,
    })
  })
})

describe('holi-signal', () => {
  it('is a shell script that parses', () => {
    expect(() => execFileSync('sh', ['-n'], { input: SIGNAL_SCRIPT })).not.toThrow()
  })

  it('reads a turn end and a status, leaving out what is not its shape', () => {
    const form = (kind: string, args: string[]) =>
      new URLSearchParams([
        ['kind', kind],
        ...args.map((a) => ['arg', a] as [string, string]),
      ]).toString()
    expect(readSignal(form('turn-end', []))).toEqual({ kind: 'turn-end' })
    expect(
      readSignal(form('turn-end', ['--conversation', '0b5c2f3e-1d2a-4c5b-8e9f-0a1b2c3d4e5f'])),
    ).toEqual({ kind: 'turn-end', conversationId: '0b5c2f3e-1d2a-4c5b-8e9f-0a1b2c3d4e5f' })
    expect(readSignal(form('turn-end', ['--conversation', '--rm']))).toEqual({ kind: 'turn-end' })
    expect(readSignal(form('status', ['--context', '42.4', '--model', 'gpt-x']))).toEqual({
      kind: 'status',
      contextPercent: 42,
      model: 'gpt-x',
    })
    expect(readSignal(form('status', ['--context', '900']))).toEqual({ kind: 'status' })
    expect(readSignal(form('reboot', []))).toBeNull()
  })
})
