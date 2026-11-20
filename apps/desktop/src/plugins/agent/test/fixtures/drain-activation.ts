// Register the native/process mocks before importing the activation host.
import {
  physical,
  drainProcesses,
  type FixtureNative,
  type Kind,
  type Plan,
} from './drain-processes'
import { execFileSync } from 'node:child_process'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, onTestFinished, vi } from 'vitest'
import { jsonFileStore, readVaultSettings } from '../../../../main/plugin-api'
import { createHolis, parseHolisFile } from '../../../holis/main/holis'
import { posixFixtureLedger } from '../../../../../test/fixtures/posix-fixture-ledger'
import { PRESETS } from '../../main/harness/record'
import { agentScratchRoots } from '../../main/host/scratch-roots'
import { activationHosts, activationHttp } from './activation-hosts'

export { bounded, physical } from './drain-processes'

type Remote = 'fixture/a' | 'fixture/b'

export async function withDrainActivation(
  test: (f: ReturnType<typeof activation>) => Promise<void>,
) {
  const ledger = await posixFixtureLedger()
  const children = drainProcesses(ledger)
  const f = activation(ledger.root, children)
  onTestFinished(async () => {
    children.openGates()
    const [disposed, reaped] = await Promise.allSettled([
      f.dispose(),
      physical(ledger.reap(), 'retained fixture leases'),
    ])
    try {
      if (reaped.status === 'rejected') throw reaped.reason
      await children.joinOutput()
      if (disposed.status === 'rejected' && f.pending.size !== 0) throw disposed.reason
      await ledger.remove()
      if (disposed.status === 'rejected') throw disposed.reason
    } finally {
      children.reset()
    }
  })
  await f.setup()
  await test(f)
}

function activation(root: string, children: FixtureNative) {
  const commit = (vault: string) => {
    execFileSync('git', ['-C', vault, 'add', '--all'])
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
  }
  const routeFailures = new Map<Remote, Error>()
  const h = activationHosts(
    root,
    (path, adapter, remote) => {
      const error = routeFailures.get(remote as Remote)
      if (error && path === '/codex/turn-end') {
        routeFailures.delete(remote as Remote)
        throw error
      }
      return http.route(path, adapter, remote)
    },
    commit,
  )
  const holis = createHolis({
    store: jsonFileStore(join(root, 'approval-fixture.json'), parseHolisFile),
    provider: async (vault) => (await readVaultSettings(vault)).agentProvider,
    launch: async () => {
      throw new Error('Approval inspection must not launch')
    },
    emit: () => {},
  })
  const approvalVault = (remote: Remote) => ({ root: h.roots[remote], remote })

  const http = activationHttp(h)
  const expectedFailures = new Map<Remote, unknown>()
  return {
    ...h,
    cli: http.cli,
    hook: http.hook,
    expectedFailures,
    async failActivation(remote: Remote, cause: Error) {
      const { jobs } = await agentScratchRoots(root, { remote, root: h.roots[remote] })
      const sweep = children.holdReadDir(jobs)
      routeFailures.set(remote, cause)
      const entering = h.enter(remote)
      void entering.catch(() => {})
      return { jobs, sweep, entering }
    },
    approval: async (remote: Remote) => (await holis.list(approvalVault(remote)))[0],
    failPtyStart(remote: Remote, cause: Error) {
      children.plan({ kind: 'fenced', stdio: 'ignore', code: 0, launchError: cause })
      const starting = h.call(remote, 'agent.scoped', {
        provider: 'codex',
        name: 'failed startup',
        prompt: 'hold',
        scope: { read: ['input.md'], write: ['output.md'] },
      })
      void starting.catch(() => {})
      return { starting, run: () => children.runs.at(-1)! }
    },
    async setup() {
      for (const [remote, vault] of Object.entries(h.roots)) {
        await mkdir(vault)
        await writeFile(join(vault, 'input.md'), remote)
        execFileSync('git', ['init', '-q', vault])
        const holi = join(vault, '.holi', 'holis', 'fixture')
        await mkdir(holi, { recursive: true })
        await writeFile(
          join(holi, 'holi.yaml'),
          'name: Fixture\nmodel: sonnet\nallow: ["Edit(output.md)"]\n',
        )
        await writeFile(join(holi, 'SOUL.md'), '# Soul\n\nWrite a fixture note.\n')
        commit(vault)
        const selected = approvalVault(remote as Remote)
        const [row] = await holis.list(selected)
        await holis.approve(selected, 'fixture', row!.fingerprint!)
      }
      const home = join(root, 'synthetic-codex-home')
      await mkdir(home)
      await writeFile(join(home, 'auth.json'), '{"fixture":"not a credential"}')
      await h.enter(h.A)
      for (const id of ['codex', 'pi']) {
        await h.call(h.A, 'agent.harnessSave', {
          harness: {
            ...PRESETS.find((preset) => preset.id === id)!,
            command: { bin: process.execPath, args: [] },
            env: {
              FIXTURE_PERMISSION: 'unchanged',
              ...(id === 'codex' ? { CODEX_HOME: home } : {}),
            },
          },
        })
      }
      await h.enter(h.B)
      await http.start()
    },
    async dispose() {
      await Promise.allSettled([...h.pending])
      const results = await Promise.allSettled([h.stop(h.A), h.stop(h.B), http.stop()])
      await Promise.allSettled([...h.pending])
      for (const [i, result] of results.entries()) {
        const expected = expectedFailures.get(i === 0 ? h.A : h.B)
        if (i !== 2 && expected !== undefined)
          expect(result).toEqual({ status: 'rejected', reason: expected })
        else if (result.status === 'rejected') throw result.reason
      }
    },
    async start(remote: Remote, kind: Kind, stdio: Plan['stdio'], code = 0, prompt = 'hold') {
      children.plan({ kind, stdio, code })
      const name = `${remote}:${kind}`
      const result = (await h.call(
        remote,
        { pi: 'agent.launch', pty: 'agent.start', fenced: 'agent.scoped', job: 'agent.job' }[kind],
        {
          provider: kind === 'pi' ? 'pi' : 'codex',
          name,
          prompt,
          ...(kind === 'pi' ? { keep: true, tools: 'none', system: 'fixture instruction' } : {}),
          scope: { read: ['input.md'], write: ['output.md'] },
        },
      )) as { ok: boolean; sessionId: string; terminalId?: string }
      expect(result, JSON.stringify(result)).toMatchObject({
        ok: true,
        sessionId: expect.any(String),
      })
      const run = children.runs.at(-1)!
      await run.waitReady()
      const pidFile = join(dirname(run.cwd), `${result.sessionId}.pid`)
      if (kind === 'job') await vi.waitFor(() => access(pidFile))
      return Object.assign(run, result, {
        pidFile,
        name,
      })
    },
  }
}
