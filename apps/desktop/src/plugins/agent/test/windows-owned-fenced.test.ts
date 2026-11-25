import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { OwnedPtyLaunch } from '../../../main/owned-windows-pty'
import { createFencedSessions } from '../main/host/fenced'
import { createJobs } from '../main/host/jobs'
import { createPtySessions } from '../main/host/pty-sessions'
import { createAgentTerminals } from '../main/host/terminals'
import type { AgentProvider } from '../main/provider'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function vaultFixture(root: string, name: string, releaseGate = Promise.resolve()) {
  const vault = { root: join(root, name, 'vault'), remote: `test/${name}` }
  await mkdir(vault.root, { recursive: true })
  const launches: Array<{
    cwd: string
    proof: ReturnType<typeof deferred<void>>
    rootExit(): void
    writes: string[]
  }> = []
  const controller = new AbortController()
  const terminals = createAgentTerminals({
    platform: 'win32',
    activationSignal: controller.signal,
    emit: () => {},
    log: () => {},
    launchWindowsPty: (options): OwnedPtyLaunch => {
      const proof = deferred<void>()
      const writes: string[] = []
      let exit: ((event: { exitCode: number }) => void) | undefined
      launches.push({ cwd: options.cwd, proof, writes, rootExit: () => exit?.({ exitCode: 0 }) })
      return {
        ready: Promise.resolve({
          pid: 999_999,
          write: (data) => {
            writes.push(data)
          },
          resize: () => {},
          onData: () => {},
          onExit: (callback) => {
            exit = callback
          },
        }),
        completion: proof.promise,
        stop: () => proof.promise,
      }
    },
  })
  const release = vi.fn(async () => {
    await releaseGate
  })
  const provider: AgentProvider = {
    id: 'codex',
    label: 'Codex',
    notInstalled: 'not installed',
    installed: () => true,
    configure: async () => ({ dir: vault.root }),
    terminal: () => ({ bin: 'agent.exe', args: [], env: {} }),
    capabilities: { fenced: 'sandbox' },
    release,
  }
  const sessions = createPtySessions({
    vault,
    providers: () => [provider],
    terminals,
    bracket: () => {},
    binDir: () => null,
    onChange: () => {},
    activationSignal: controller.signal,
  })
  const jobs = createJobs({
    platform: 'win32',
    vault,
    scratchRoot: join(root, name, 'jobs'),
    onChange: () => {},
    log: () => {},
  })
  const scratchRoot = join(root, name, 'fenced')
  const fenceDeps = { vault, scratchRoot, own: sessions, copyBack: jobs.copyBack, log: () => {} }
  const fenced = createFencedSessions(fenceDeps)
  const spec = {
    provider,
    name: 'fenced',
    prompt: 'write result',
    scope: { read: [], write: ['result.md'] },
  }
  return {
    vault,
    terminals,
    sessions,
    jobs,
    fenced,
    fenceDeps,
    spec,
    launches,
    release,
    start: () => fenced.start(spec),
    scratchRoot,
    controller,
    async dispose() {
      for (const launch of launches) launch.proof.resolve()
      await Promise.allSettled([
        terminals.closeAll(),
        sessions.leave(),
        fenced.leave(),
        jobs.leave(),
      ])
    },
  }
}

it('joins Windows native drainage, real fenced copy and provider release without retiring another vault', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-windows-fenced-'))
  const releaseGate = deferred<void>()
  const a = await vaultFixture(root, 'one', releaseGate.promise)
  const b = await vaultFixture(root, 'two')
  const signal = vi.spyOn(process, 'kill')
  try {
    const first = await a.start()
    const second = await b.start()
    if (!first.ok || !second.ok) throw new Error('Fenced launch refused')
    await new Promise((resolve) => setImmediate(resolve))
    const native = a.launches[0]!
    await writeFile(join(native.cwd, 'result.md'), 'first vault result')
    native.rootExit()
    let settled = false
    const stopping = a.sessions.stop(first.sessionId).then(() => {
      settled = true
    })
    expect(a.sessions.has(first.sessionId)).toBe(true)
    expect(a.terminals.list().some((t) => t.id === first.terminalId)).toBe(true)
    expect(existsSync(native.cwd)).toBe(true)
    expect(existsSync(join(a.vault.root, 'result.md'))).toBe(false)
    expect(a.release).not.toHaveBeenCalled()
    expect(settled).toBe(false)
    expect(b.sessions.has(second.sessionId)).toBe(true)
    b.terminals.write(second.terminalId, 'still usable')
    expect(b.launches[0]!.writes).toContain('still usable')
    native.proof.resolve()
    await vi.waitFor(() => expect(a.release).toHaveBeenCalledOnce())
    expect(await readFile(join(a.vault.root, 'result.md'), 'utf8')).toBe('first vault result')
    expect(existsSync(native.cwd)).toBe(true)
    expect(a.sessions.has(first.sessionId)).toBe(true)
    expect(settled).toBe(false)
    releaseGate.resolve()
    await stopping
    expect(a.sessions.has(first.sessionId)).toBe(false)
    expect(a.terminals.list()).toEqual([])
    expect(existsSync(native.cwd)).toBe(false)
    expect(b.sessions.has(second.sessionId)).toBe(true)
    expect(b.release).not.toHaveBeenCalled()
    const stoppingB = b.sessions.stop(second.sessionId)
    b.launches[0]!.proof.resolve()
    await stoppingB
    expect(b.sessions.has(second.sessionId)).toBe(false)
    expect(b.release).toHaveBeenCalledOnce()
    expect(signal).not.toHaveBeenCalled()
  } finally {
    releaseGate.resolve()
    await Promise.all([a.dispose(), b.dispose()])
    signal.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps the original failed Windows session and scratch across Stop, leave and activation replacement while another vault closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-windows-fenced-failed-'))
  const a = await vaultFixture(root, 'one')
  const b = await vaultFixture(root, 'two')
  const signal = vi.spyOn(process, 'kill')
  try {
    const first = await a.start()
    const second = await b.start()
    if (!first.ok || !second.ok) throw new Error('Fenced launch refused')
    await new Promise((resolve) => setImmediate(resolve))
    const native = a.launches[0]!
    await writeFile(join(native.cwd, 'result.md'), 'unconfirmed source')
    native.rootExit()
    const cause = new Error('native Job could not confirm zero')
    const failed = expect(a.sessions.stop(first.sessionId)).rejects.toBe(cause)
    native.proof.reject(cause)
    await failed
    await expect(a.sessions.stop(first.sessionId)).rejects.toBe(cause)
    await expect(a.terminals.close(first.terminalId)).rejects.toBe(cause)
    await expect(a.terminals.closeAll()).rejects.toThrow()
    await expect(a.sessions.leave()).rejects.toThrow()
    await expect(a.fenced.leave()).rejects.toThrow()
    expect(a.sessions.has(first.sessionId)).toBe(true)
    expect(a.terminals.list().some((t) => t.id === first.terminalId)).toBe(true)
    expect((await a.sessions.reopen(first.sessionId, { cols: 80, rows: 24 })).ok).toBe(false)
    expect(await readFile(join(native.cwd, 'result.md'), 'utf8')).toBe('unconfirmed source')
    expect(existsSync(join(a.vault.root, 'result.md'))).toBe(false)
    expect(a.release).not.toHaveBeenCalled()
    const replacement = createFencedSessions(a.fenceDeps)
    await expect(replacement.start(a.spec)).rejects.toThrow()
    await expect(replacement.leave()).rejects.toThrow()
    expect(a.launches).toHaveLength(1)
    expect(await readFile(join(native.cwd, 'result.md'), 'utf8')).toBe('unconfirmed source')
    b.terminals.write(second.terminalId, 'unaffected')
    expect(b.launches[0]!.writes).toContain('unaffected')
    const stoppingB = b.sessions.stop(second.sessionId)
    b.launches[0]!.proof.resolve()
    await stoppingB
    expect(b.sessions.has(second.sessionId)).toBe(false)
    expect(b.release).toHaveBeenCalledOnce()
    expect(signal).not.toHaveBeenCalled()
  } finally {
    await Promise.all([a.dispose(), b.dispose()])
    signal.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
