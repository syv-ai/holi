import { execFileSync, spawn } from 'node:child_process'
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { buildLeaseForTests } from '../../../../test/fixtures/posix-native-build'
import { inspectPosixOwnership, type PluginCtx } from '../../../main/plugin-api'
import { PRESETS } from '../main/harness/record'
import { agentMain } from '../main/index'
import { activationHosts } from './fixtures/activation-hosts'

const fixture = vi.hoisted(() => ({
  helper: '',
  spawn: vi.fn(),
  sweep: vi.fn(async () => []),
  go: vi.fn(),
  control: undefined as number | undefined,
  stage: undefined as (() => Promise<void>) | undefined,
}))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    async mkdir(...args: Parameters<typeof fs.mkdir>) {
      if (String(args[0]).endsWith('.agent')) await fixture.stage?.()
      return fs.mkdir(...args)
    },
  }
})
vi.mock('electron', () => ({
  app: { getVersion: () => 'test' },
  nativeTheme: { shouldUseDarkColors: false },
}))
vi.mock('../main/memory/sweep', () => ({
  sweepAgentMemory: fixture.sweep,
  SWEEP_EVERY_MS: 60 * 60 * 1000,
}))
vi.mock('../../../main/posix-lease-executable', () => ({
  posixLeaseExecutable: () => fixture.helper,
}))
vi.mock('../../../main/plugin-api', async (original) => ({
  ...(await original<typeof import('../../../main/plugin-api')>()),
  defaultSpawnPty: fixture.spawn,
}))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    writeSync: (...args: Parameters<typeof fs.writeSync>) => {
      const [fd, data] = args
      if (Buffer.isBuffer(data) && data.equals(Buffer.from('G')) && fixture.go(fd))
        throw Object.assign(new Error('fixture withheld GO'), { code: 'EAGAIN' })
      return fs.writeSync(...args)
    },
    closeSync: (fd: number) => {
      if (fd === fixture.control) fixture.control = undefined
      fs.closeSync(fd)
    },
  }
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

it.runIf(process.platform !== 'win32').each(['session', 'fenced', 'list', 'attach'] as const)(
  'invalidates the bound %s PTY before GO while teardown still waits for memory',
  async (kind) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'holi-pty-invalidation-')))
    const native = buildLeaseForTests()
    const host = activationHosts(root)
    const memory = deferred()
    const sleeping = deferred()
    const atGo = deferred()
    const publicExit = deferred()
    const staging = deferred()
    const staged = deferred()
    let lateFence: Promise<unknown> | undefined
    const emittedExit = vi.fn()
    const marker = join(root, 'provider-entered')
    const program = join(root, 'fixture-provider')
    let ctx: PluginCtx | undefined
    const activate = agentMain.activate!
    const capture = vi.spyOn(agentMain, 'activate').mockImplementation((live) => {
      ctx = live
      return activate(live)
    })
    let reaped: Promise<number | null> | undefined
    let output: Promise<unknown> | undefined
    let journal: string | undefined
    let identities: number[] = []
    let stop: Promise<void> | undefined
    let replace: Promise<void> | undefined
    fixture.helper = native.binary
    fixture.sweep.mockImplementationOnce(async () => {
      sleeping.resolve()
      await memory.promise
      return []
    })
    fixture.go.mockImplementation((fd: number) => {
      fixture.control = fd
      atGo.resolve()
      return true
    })
    fixture.spawn.mockImplementation((file, args, opts) => {
      journal = args[4]
      const child = spawn(file, args, { ...opts, detached: true, stdio: 'ignore' })
      reaped = new Promise<number | null>((resolve, reject) => {
        child.once('exit', resolve)
        child.once('error', reject)
      })
      void reaped.catch(() => {})
      const pty = {
        pid: child.pid!,
        _boundClose: false,
        onExit: (cb: (e: { exitCode: number }) => void) => {
          output = reaped!.then(async (code) => {
            pty._boundClose = true
            await publicExit.promise
            emittedExit()
            cb({ exitCode: code ?? 1 })
          })
          void output.catch(() => {})
        },
        onData() {},
        write() {},
        resize() {},
        kill: vi.fn(() => {
          throw new Error('must use lease authority')
        }),
      }
      return pty
    })
    try {
      const vault = host.roots[host.A]
      await mkdir(vault)
      execFileSync('git', ['init', '--template=', '-q', vault])
      execFileSync('git', [
        '-C',
        vault,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--allow-empty',
        '-qm',
        'fixture',
      ])
      await mkdir(join(root, 'fake-codex'), { mode: 0o700 })
      await writeFile(join(root, 'fake-codex', 'auth.json'), '{}', { mode: 0o600 })
      await writeFile(
        program,
        `#!/bin/sh\ncase " $* " in *' --json '*) echo '[]'; exit 0;; esac\nexec /usr/bin/touch '${marker}'\n`,
        { mode: 0o700 },
      )
      vi.stubEnv('TMPDIR', root)
      vi.stubEnv('HOLI_CLAUDE_BIN', program)
      await host.enter(host.A)
      host.host.setDisplayed(host.A)
      await sleeping.promise
      await host.call(host.A, 'agent.harnessSave', {
        harness: {
          ...PRESETS.find(({ id }) => id === 'codex')!,
          command: { bin: program, args: [] },
          env: { CODEX_HOME: join(root, 'fake-codex') },
        },
      })
      const result = await (kind === 'session'
        ? host.call(host.A, 'agent.start', { provider: 'codex' })
        : kind === 'fenced'
          ? host.call(host.A, 'agent.scoped', {
              provider: 'codex',
              name: 'fenced',
              prompt: 'fixture',
              scope: { read: [], write: [] },
            })
          : host.call(host.A, 'agent.open', kind === 'list' ? {} : { attach: '1a2b3c4d' }))
      expect(result).toMatchObject({ ok: true })
      await atGo.promise
      const evidence = await readFile(journal!, 'utf8')
      identities = [...evidence.matchAll(/^(ROOT|REAPER|ANCHOR) (\d+)$/gm)].flatMap(
        ([, role, value]) =>
          role === 'ANCHOR' ? [Number(value)] : [Number(value), -Number(value)],
      )
      expect(identities).toHaveLength(5)
      const owner = dirname(dirname(dirname(journal!)))
      const ownershipRecord = dirname(journal!)
      expect(inspectPosixOwnership(ownershipRecord)).toMatchObject({ state: 'retain' })
      if (kind === 'fenced') {
        fixture.stage = () => {
          staged.resolve()
          return staging.promise
        }
        lateFence = host.call(host.A, 'agent.scoped', {
          provider: 'codex',
          name: 'still staging',
          prompt: 'fixture',
          scope: { read: [], write: [] },
        })
        void lateFence.catch(() => {})
        await staged.promise
      }
      ctx!.invalidateActivation()
      // Check immediately, before starting the async disposer.
      expect(fixture.control).toBeUndefined()
      fixture.go.mockReturnValue(false)
      stop = host.stop(host.A)
      void stop.catch(() => {})
      await reaped
      await vi.waitFor(
        () =>
          expect(inspectPosixOwnership(ownershipRecord)).toEqual({
            state: 'confirmed',
            proof: 'settled',
          }),
        { timeout: 3500 },
      )
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(emittedExit).not.toHaveBeenCalled()
      await access(owner)
      replace = host.enter(host.A)
      const reconciled = vi.fn()
      void replace.then(reconciled, reconciled)
      memory.resolve()
      // The native root is gone, but its terminal output edge still owns the
      // link. Reconciliation cannot replace it while close joins that edge.
      await new Promise<void>((done) => setImmediate(done))
      expect(reconciled).not.toHaveBeenCalled()
      await access(owner)
      if (lateFence) {
        staging.resolve()
        await expect(lateFence).resolves.toMatchObject({ ok: false })
      }
      publicExit.resolve()
      await stop
      await replace
      expect(emittedExit).toHaveBeenCalledOnce()
      expect(fixture.spawn).toHaveBeenCalledOnce()
      expect(await host.call(host.A, 'agent.terminals')).toEqual([])
      await expect(access(owner)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      memory.resolve()
      publicExit.resolve()
      staging.resolve()
      await Promise.allSettled([stop, replace, host.host.stopAll(), reaped, output, lateFence])
      fixture.stage = undefined
      if (journal && identities.length === 0) {
        const retained = await readFile(journal, 'utf8').catch(() => '')
        identities = [...retained.matchAll(/^(ROOT|REAPER|ANCHOR) (\d+)$/gm)].flatMap(
          ([, role, value]) =>
            role === 'ANCHOR' ? [Number(value)] : [Number(value), -Number(value)],
        )
      }
      capture.mockRestore()
      fixture.spawn.mockReset()
      fixture.go.mockReset()
      fixture.sweep.mockClear()
      vi.unstubAllEnvs()
      if (reaped) expect(identities.length).toBeGreaterThan(0)
      for (const pid of identities)
        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
      expect((await readdir(root)).filter((entry) => entry.startsWith('holi-launch-'))).toEqual([])
      await rm(root, { recursive: true, force: true })
      await rm(native.directory, { recursive: true, force: true })
    }
  },
  15000,
)
