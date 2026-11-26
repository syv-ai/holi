import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { closeSync, readFileSync } from 'node:fs'
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { buildLeaseForTests } from '../../../../test/fixtures/posix-native-build'
import {
  inspectPosixOwnership,
  ownedProcessDrain,
  preparePosixLaunch,
} from '../../../main/plugin-api'
import { createPiBackground } from '../main/pi/background'
import { activationOwnership } from '../main/host/ownership'
import { agentScratchRoots } from '../main/host/scratch-roots'
import { recoverFencedScratch } from '../main/host/fenced'
import { PRESETS } from '../main/harness/record'
import { activationHosts } from './fixtures/activation-hosts'

const native = vi.hoisted(() => ({
  helper: '',
  parent: '',
  fds: new Set<number>(),
  onRead: undefined as ((value: string) => void) | undefined,
  holdWrite: undefined as ((value: string) => boolean) | undefined,
  onRename: undefined as ((edge: 'before' | 'after', from: string, to: string) => void) | undefined,
  onSpawn: undefined as
    | ((child: ChildProcess & { [ownedProcessDrain]?: { drain(): Promise<void> } }) => void)
    | undefined,
}))
vi.mock('electron', () => ({
  app: { getVersion: () => 'test' },
  nativeTheme: { shouldUseDarkColors: false },
}))
vi.mock('../../../main/posix-lease-executable', () => ({
  posixLeaseExecutable: () => native.helper,
}))
vi.mock('../../../main/plugin-api', async (original) => {
  const api = await original<typeof import('../../../main/plugin-api')>()
  return {
    ...api,
    spawnOwnedProgram: (...args: Parameters<typeof api.spawnOwnedProgram>) => {
      const child = api.spawnOwnedProgram(...args)
      native.onSpawn?.(child)
      return child
    },
  }
})
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      native.onRename?.('before', from, to)
      fs.renameSync(from, to)
      native.onRename?.('after', from, to)
    },
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args)
      if (native.parent && String(args[0]).startsWith(native.parent + '/holi-launch-'))
        native.fds.add(fd)
      return fd
    },
    readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: null) => {
      const read = fs.readSync(fd, buffer, offset, length, position)
      if (read && native.fds.has(fd))
        native.onRead?.(buffer.toString('utf8', offset, offset + read))
      return read
    },
    writeSync: (fd: number, buffer: Buffer, offset: number, length: number) => {
      if (
        length === 1 &&
        native.fds.has(fd) &&
        native.holdWrite?.(buffer.toString('utf8', offset, offset + length))
      )
        return 0
      return fs.writeSync(fd, buffer, offset, length)
    },
    closeSync: (fd: number) => {
      native.fds.delete(fd)
      fs.closeSync(fd)
    },
  }
})
vi.mock('../main/claude/cli', async (original) => ({
  ...(await original<typeof import('../main/claude/cli')>()),
  resolveClaudeBin: () => null,
}))

const it = test.runIf(process.platform !== 'win32')
const signal = () => new AbortController().signal
const absent = (pid: number) =>
  expect(() => process.kill(pid, 0), `new fixture identity ${pid}`).toThrow(
    expect.objectContaining({ code: 'ESRCH' }),
  )

it.each(['ignore', 'inherit'] as const)(
  'holds a cold fenced Vault through controller EOF with %s stdio, while B serves capabilities',
  async (stdio) => {
    const data = await realpath(await mkdtemp(join(tmpdir(), 'holi-cold-fenced-')))
    const fixture = activationHosts(data)
    const { A, B, roots } = fixture
    const a = { root: roots[A], remote: A }
    const controller = new AbortController()
    const id = 'ad012345abcd'
    const release = join(data, 'release')
    const childId = join(data, 'writer-pid')
    const helper = buildLeaseForTests()
    native.helper = helper.binary
    native.parent = data
    let journal: string | undefined
    let root: number | undefined
    let exited: Promise<unknown> | undefined
    const loseController = () => {
      controller.abort()
      // These are the exact private descriptors retained by this one launch;
      // closing them is the OS effect of Main disappearing without a disposer.
      for (const fd of native.fds) closeSync(fd)
    }
    try {
      for (const path of Object.values(roots)) await mkdir(path)
      const { fenced } = await agentScratchRoots(data, a)
      const old = activationOwnership(data, a, controller.signal)!
      recoverFencedScratch(old, fenced)
      const linked = old.allocate('fenced', id)
      const ownershipRecordPath = linked.ownershipRecordPath!
      journal = join(ownershipRecordPath, 'journal')
      const cwd = join(fenced, id)
      const home = join(fenced, `${id}.agent`)
      await mkdir(cwd, { recursive: true })
      await mkdir(home)
      await writeFile(join(home, 'private'), 'old provider state')
      const childScript = `
        const fs = require('fs');
        process.on('SIGTERM', () => fs.writeFileSync('term', 'resisted'));
        fs.writeFileSync('output', 'old writer');
        fs.writeFileSync(${JSON.stringify(childId)}, String(process.pid));
        setInterval(() => {
          if (fs.existsSync(${JSON.stringify(release)})) process.exit(0);
          fs.writeFileSync('output', 'old writer');
        }, 15);
        setTimeout(() => process.exit(0), 6000);
      `
      const mainScript = `
        process.on('SIGTERM', () => {});
        require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}],
          {stdio: ${JSON.stringify(stdio)}}).once('exit', () => process.exit(0));
      `
      const launch = preparePosixLaunch(process.execPath, ['-e', mainScript], {
        cwd,
        directory: data,
        ownershipRecordPath,
        stdio: 'ignore',
        graceMs: 2500,
      })
      const child = spawn(launch.executable, launch.args, launch.options)
      root = child.pid!
      exited = once(child, 'exit')
      void exited.catch(() => {})
      await launch.bind(root)
      await vi.waitFor(() => expect(readFile(childId, 'utf8')).resolves.toMatch(/^\d+$/))
      loseController()
      await vi.waitFor(() => expect(readFile(join(cwd, 'term'), 'utf8')).resolves.toBe('resisted'))
      const text = await readFile(journal, 'utf8')
      const reaper = Number(/^REAPER (\d+)$/m.exec(text)?.[1])
      expect(reaper).toBeGreaterThan(1)
      expect(() => process.kill(-reaper, 0)).not.toThrow()
      expect(inspectPosixOwnership(ownershipRecordPath)).toMatchObject({ state: 'retain' })
      await fixture.enter(A)
      await expect(fixture.call(A, 'agent.terminals')).rejects.toThrow('no such method')
      expect(await readFile(join(cwd, 'output'), 'utf8')).toBe('old writer')
      expect(await readFile(join(home, 'private'), 'utf8')).toBe('old provider state')
      await fixture.enter(B)
      expect(await fixture.call(B, 'agent.terminals')).toEqual([])
      expect(() => process.kill(-root!, 0)).not.toThrow()

      await writeFile(release, '')
      await exited
      await vi.waitFor(
        () =>
          expect(inspectPosixOwnership(ownershipRecordPath)).toEqual({
            state: 'confirmed',
            proof: 'kernel-absence',
          }),
        { timeout: 4000 }, // EOF's anchor keeps the group reserved for the full grace.
      )
      await fixture.enter(A)
      expect(await fixture.call(A, 'agent.terminals')).toEqual([])
      expect(await fixture.call(B, 'agent.terminals')).toEqual([])
      await expect(access(cwd)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(ownershipRecordPath)).rejects.toMatchObject({ code: 'ENOENT' })
      // Verify the ledger before recovery's deleted record can no longer be read.
      for (const pid of [
        root,
        -root,
        reaper,
        -reaper,
        Number(/^ANCHOR (\d+)$/m.exec(text)?.[1]),
        Number(await readFile(childId, 'utf8')),
      ])
        absent(pid)
      journal = undefined
    } finally {
      loseController()
      await writeFile(release, '')
      await exited?.catch(() => {})
      await fixture.host.stopAll()
      if (root) {
        const text = journal ? await readFile(journal, 'utf8').catch(() => '') : ''
        const owners = [...text.matchAll(/^(ROOT|REAPER|ANCHOR) (\d+)$/gm)].flatMap(
          ([, role, value]) =>
            role === 'ANCHOR' ? [Number(value)] : [Number(value), -Number(value)],
        )
        const writer = Number(await readFile(childId, 'utf8').catch(() => '0'))
        if (writer > 1) owners.push(writer)
        await vi.waitFor(
          () => {
            for (const pid of [root!, -root!, ...owners]) absent(pid)
          },
          { timeout: 8000 },
        )
      }
      native.parent = ''
      await rm(data, { recursive: true, force: true })
      await rm(helper.directory, { recursive: true, force: true })
      await expect(access(data)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  },
  15000,
)

it.each(['output', 'settled', 'failed', 'outer only', 'outer and caller'] as const)(
  'recovers native-settled fenced scratch only after positive caller proof (%s)',
  async (phase) => {
    const data = await realpath(await mkdtemp(join(tmpdir(), 'holi-cold-fenced-caller-')))
    const helper = buildLeaseForTests()
    native.helper = helper.binary
    const controller = new AbortController()
    const vault = { root: data, remote: 'fixture/caller' }
    const { fenced } = await agentScratchRoots(data, vault)
    const old = activationOwnership(data, vault, controller.signal)!
    recoverFencedScratch(old, fenced)
    const id = 'ad012345abcd'
    const linked = old.allocate('fenced', id)
    const path = linked.ownershipRecordPath!
    const cwd = join(fenced, id)
    const context = join(fenced, `${id}.agent`)
    await mkdir(cwd, { recursive: true })
    await mkdir(context)
    await writeFile(join(context, 'private'), 'fixture context')
    const launch = preparePosixLaunch('/bin/sh', ['-c', 'printf only-copy > output'], {
      cwd,
      ownershipRecordPath: path,
      directory: data,
      graceMs: 25,
    })
    const child = spawn(launch.executable, launch.args, {
      ...launch.options,
      stdio: 'ignore',
    })
    const exited = once(child, 'exit')
    const probe = vi.spyOn(process, 'kill')
    let identities: number[] = []
    try {
      await launch.bind(child.pid!)
      await exited
      if (phase !== 'output' && phase !== 'outer only') linked.beginCallerFinalization()
      await launch.drain()
      const text = await readFile(join(path, 'journal'), 'utf8')
      identities = [...text.matchAll(/^(ROOT|REAPER|ANCHOR) (\d+)$/gm)].flatMap(
        ([, role, value]) =>
          role === 'ANCHOR' ? [Number(value)] : [Number(value), -Number(value)],
      )
      expect(identities).toHaveLength(5)
      expect(inspectPosixOwnership(path)).toEqual({ state: 'confirmed', proof: 'settled' })
      expect(await readFile(join(cwd, 'output'), 'utf8')).toBe('only-copy')
      if (phase === 'settled' || phase === 'outer and caller') {
        // Emulate the crash after copy/release and their durable receipt, but
        // before the caller could delete its two source directories.
        await writeFile(join(data, 'published'), await readFile(join(cwd, 'output')))
        linked.settleCaller()
      } else if (phase === 'failed') {
        linked.fail(new Error('first copy failure'))
        linked.fail(new Error('secondary failure'))
      }
      if (phase === 'outer only' || phase === 'outer and caller') {
        const entry = dirname(dirname(path))
        await writeFile(join(entry, 'settled'), `HOLI-AGENT-1 ${basename(entry)}\nSETTLED\n`, {
          mode: 0o600,
        })
      }
      controller.abort() // Virtual Main death: the stale caller never gets its output/copy back.
      probe.mockClear()
      const next = activationOwnership(data, vault, signal())!
      if (phase === 'settled' || phase === 'outer and caller') {
        recoverFencedScratch(next, fenced)
        await expect(access(cwd)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await readFile(join(data, 'published'), 'utf8')).toBe('only-copy')
      } else {
        expect(() => recoverFencedScratch(next, fenced)).toThrow(
          phase === 'failed' ? /first copy failure/ : /fenced.*(settlement|pending)/i,
        )
        expect(await readFile(join(cwd, 'output'), 'utf8')).toBe('only-copy')
        expect(await readFile(join(context, 'private'), 'utf8')).toBe('fixture context')
        await access(path)
      }
      expect(probe).not.toHaveBeenCalled()
    } finally {
      probe.mockRestore()
      await exited
      await launch.drain()
      if (identities.length === 0) {
        const text = await readFile(join(path, 'journal'), 'utf8')
        identities = [...text.matchAll(/^(ROOT|REAPER|ANCHOR) (\d+)$/gm)].flatMap(
          ([, role, value]) =>
            role === 'ANCHOR' ? [Number(value)] : [Number(value), -Number(value)],
        )
      }
      for (const pid of identities) absent(pid)
      await rm(data, { recursive: true, force: true })
      await rm(helper.directory, { recursive: true, force: true })
    }
  },
)

it.each(['missing', 'malformed', 'failure', 'unlinked'] as const)(
  'keeps fenced scratch with %s evidence and never signals from a record',
  async (kind) => {
    const data = await mkdtemp(join(tmpdir(), 'holi-cold-fenced-evidence-'))
    const probe = vi.spyOn(process, 'kill')
    try {
      const vault = { root: data, remote: 'fixture/evidence' }
      const { fenced } = await agentScratchRoots(data, vault)
      const controller = new AbortController()
      const old = activationOwnership(data, vault, controller.signal)!
      recoverFencedScratch(old, fenced)
      const id = 'ad012345abcd'
      if (kind !== 'unlinked') {
        const record = old.allocate('fenced', id)
        if (kind === 'failure') {
          record.nonLaunch()
          const cause = new Error('original caller failure')
          record.fail(cause)
          record.fail(new Error('must not replace first failure'))
          expect(() => record.retire()).toThrow(cause)
        }
        if (kind === 'malformed') {
          const nativePath = record.ownershipRecordPath!
          expect(basename(dirname(nativePath))).toBe('native')
          await mkdir(nativePath, { mode: 0o700 })
          await writeFile(join(nativePath, 'journal'), 'bad framing', { mode: 0o600 })
        }
      }
      const output = join(fenced, id, 'output')
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, 'preserved')
      controller.abort()
      const next = activationOwnership(data, vault, signal())!
      expect(() => recoverFencedScratch(next, fenced)).toThrow(
        kind === 'failure' ? /original caller failure/ : /Retaining/,
      )
      expect(await readFile(output, 'utf8')).toBe('preserved')
      expect(probe).not.toHaveBeenCalled()
    } finally {
      probe.mockRestore()
      await rm(data, { recursive: true, force: true })
    }
  },
)

it('links a real Pi RPC process before provider entry and retires after Stop', async () => {
  const data = await realpath(await mkdtemp(join(tmpdir(), 'holi-cold-pi-link-')))
  const helper = buildLeaseForTests()
  native.helper = helper.binary
  const fixture = activationHosts(data)
  const { A, roots } = fixture
  const root = roots[A]
  const key = createHash('sha256')
    .update(JSON.stringify([A, root]))
    .digest('hex')
  const scope = join(data, 'agent-ownership', key, 'pi')
  const seen = join(data, 'pi-started')
  const executable = join(data, 'fixture-pi')
  const program = join(data, 'fixture-pi.cjs')
  let leasePath: string | undefined
  let identities: number[] = []
  vi.stubEnv('TMPDIR', data)
  try {
    await mkdir(root)
    execFileSync('git', ['init', '--template=', '-q', root])
    execFileSync('git', [
      '-C',
      root,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'fixture',
    ])
    await writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" "${program}" "$@"\n`, {
      mode: 0o700,
    })
    await writeFile(
      program,
      `
      const fs = require('node:fs');
      const path = require('node:path');
      const parent = ${JSON.stringify(scope)};
      const [nonce] = fs.readdirSync(parent);
      const dir = path.join(parent, nonce);
      const link = fs.readFileSync(path.join(dir, 'link'), 'utf8');
      const journal = fs.readFileSync(path.join(dir, 'native', nonce, 'journal'), 'utf8');
      fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ nonce, link, journal, pid: process.pid }));
      process.stdin.resume();
    `,
    )
    await fixture.enter(A)
    await fixture.call(A, 'agent.harnessSave', {
      harness: {
        ...PRESETS.find(({ id }) => id === 'pi')!,
        command: { bin: executable, args: [] },
      },
    })
    const launch = { provider: 'pi', name: 'fixture', prompt: 'fixture', keep: true }
    expect(await fixture.call(A, 'agent.launch', { ...launch, model: 'invalid' })).toMatchObject({
      ok: false,
    })
    expect(await readdir(scope)).toEqual([])
    const run = (await fixture.call(A, 'agent.launch', launch)) as {
      ok: boolean
      sessionId: string
    }
    expect(run).toMatchObject({ ok: true })
    const entry = await vi.waitFor(
      async () =>
        JSON.parse(await readFile(seen, 'utf8')) as {
          nonce: string
          link: string
          journal: string
          pid: number
        },
    )
    leasePath = join(scope, entry.nonce, 'native', entry.nonce)
    identities = [...entry.journal.matchAll(/^(ROOT|REAPER|ANCHOR) (\d+)$/gm)].flatMap(
      ([, role, value]) => (role === 'ANCHOR' ? [Number(value)] : [Number(value), -Number(value)]),
    )
    expect(identities).toHaveLength(5)
    expect(entry.journal).toContain(`ROOT ${entry.pid}\n`)
    expect(entry.journal).toMatch(/COMPLETE\n$/)
    expect(entry.link).toContain(`native ${run.sessionId}\n`)
    expect(await fixture.call(A, 'agent.stop', { id: run.sessionId })).toEqual({ ok: true })
    expect(await readdir(scope)).toEqual([])
  } finally {
    const stopped = await fixture.host.stopAll().then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    vi.unstubAllEnvs()
    for (const pid of identities) absent(pid)
    if (leasePath) await expect(access(leasePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await rm(data, { recursive: true, force: true })
    await rm(helper.directory, { recursive: true, force: true })
    if (!stopped.ok) throw stopped.error
  }
}, 15000)

const journalIdentities = (text: string) =>
  [...text.matchAll(/^(ROOT|REAPER|ANCHOR) (\d+)$/gm)].flatMap(([, role, value]) =>
    role === 'ANCHOR' ? [Number(value)] : [Number(value), -Number(value)],
  )

it.each([
  ['pi', 'retired'],
  ['fenced', 'retired'],
  ['pty', 'retired'],
  ['jobs', 'retired'],
  ['fenced', 'active'],
  ['fenced', 'partial'],
  ['fenced', 'malformed'],
  ['fenced', 'wrong link'],
  ['fenced', 'wrong journal'],
  ['fenced', 'caller failed'],
] as const)(
  'cold discard for %s is restartable or retains evidence (%s)',
  async (kind, phase) => {
    const data = await realpath(await mkdtemp(join(tmpdir(), 'holi-cold-discard-')))
    const helper = buildLeaseForTests()
    native.helper = helper.binary
    native.parent = data
    const vault = { root: data, remote: 'fixture/discard' }
    const controller = new AbortController()
    const recover = (registry: ReturnType<typeof activationOwnership>) => {
      if (kind === 'fenced') recoverFencedScratch(registry!, join(data, 'scratch'))
      else registry!.recover(kind)
    }
    const old = activationOwnership(data, vault, controller.signal)!
    recover(old)
    const record = old.allocate(kind, 'ad012345abcd')
    const path = record.ownershipRecordPath!
    const entry = dirname(dirname(path))
    const retired = `${entry}.retired`
    const scratch = join(data, 'scratch', 'ad012345abcd', 'output')
    const launch = preparePosixLaunch('/bin/true', [], {
      cwd: data,
      directory: data,
      ownershipRecordPath: path,
      graceMs: 25,
      stdio: 'ignore',
    })
    let child: ChildProcess | undefined
    let exited: Promise<unknown> | undefined
    let identities: number[] = []
    let lostController = false
    try {
      if (kind === 'fenced') {
        await mkdir(dirname(scratch), { recursive: true })
        await writeFile(scratch, 'discard only after full proof')
      }
      child = spawn(launch.executable, launch.args, launch.options)
      exited = once(child, 'exit')
      void exited.catch(() => {})
      await launch.bind(child.pid!)
      const journal = await readFile(join(path, 'journal'), 'utf8')
      identities = journalIdentities(journal)
      expect(identities).toHaveLength(5)
      lostController = true
      controller.abort()
      for (const fd of native.fds) closeSync(fd)
      await exited
      await vi.waitFor(() => {
        for (const pid of identities) absent(pid)
      })
      const kernel = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('kernel proof unavailable')
      })
      try {
        expect(() => recover(activationOwnership(data, vault, signal()))).toThrow(
          /kernel proof unavailable/,
        )
        expect(kernel).toHaveBeenCalled()
        await expect(access(join(entry, 'cold-discard'))).rejects.toMatchObject({ code: 'ENOENT' })
        if (kind === 'fenced')
          expect(await readFile(scratch, 'utf8')).toBe('discard only after full proof')
      } finally {
        kernel.mockRestore()
      }
      const isActive = phase === 'active' || phase === 'partial'
      const current = isActive ? entry : retired
      const interruption = new Error(`interrupted cold discard (${phase})`)
      native.onRename = (edge, from, to) => {
        if (isActive) {
          if (
            to === join(entry, 'cold-discard') &&
            edge === (phase === 'partial' ? 'before' : 'after')
          )
            throw interruption
        } else if (edge === 'after' && from === entry && to === retired) throw interruption
      }
      expect(() => recover(activationOwnership(data, vault, signal()))).toThrow(interruption)
      native.onRename = undefined
      expect(await readdir(current)).toEqual([
        phase === 'partial' ? 'cold-discard.tmp' : 'cold-discard',
        'link',
        'native',
      ])
      const currentNative = join(current, 'native', basename(entry))
      expect(await readdir(currentNative)).toEqual(['journal'])
      if (isActive) expect(await readFile(scratch, 'utf8')).toBe('discard only after full proof')
      else if (kind === 'fenced')
        await expect(access(scratch)).rejects.toMatchObject({ code: 'ENOENT' })
      if (phase === 'malformed') {
        await writeFile(join(retired, 'cold-discard'), 'not a complete receipt')
      } else if (phase === 'wrong link') {
        const link = await readFile(join(retired, 'link'), 'utf8')
        await writeFile(join(retired, 'link'), link.replace('ad012345abcd', 'ad012345abce'))
      } else if (phase === 'wrong journal') {
        // Complete and correctly framed, but not the proof that was cached.
        await writeFile(join(currentNative, 'journal'), journal.replace(/ROOT \d+/, 'ROOT 999999'))
      } else if (phase === 'caller failed') {
        await writeFile(
          join(retired, 'failed'),
          `HOLI-AGENT-1 ${basename(entry)}\noriginal caller failure`,
          { mode: 0o600 },
        )
      }
      const noProbe = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('cached recovery must not probe recycled identities')
      })
      try {
        const restart = () => recover(activationOwnership(data, vault, signal()))
        if (phase === 'retired' || phase === 'active') {
          restart()
          await expect(access(current)).rejects.toMatchObject({ code: 'ENOENT' })
          if (kind === 'fenced')
            await expect(access(scratch)).rejects.toMatchObject({ code: 'ENOENT' })
        } else {
          expect(restart).toThrow(
            phase === 'caller failed' ? /original caller failure/ : /Retaining/,
          )
          await access(current)
          if (phase === 'partial')
            expect(await readFile(scratch, 'utf8')).toBe('discard only after full proof')
        }
        expect(noProbe).not.toHaveBeenCalled()
      } finally {
        noProbe.mockRestore()
      }
    } finally {
      native.onRename = undefined
      if (!lostController) {
        if (child?.pid !== undefined) await launch.drain()
        else await launch.cancel('possibly-launched')
      }
      await exited
      if (identities.length === 0) {
        identities = journalIdentities(await readFile(join(path, 'journal'), 'utf8'))
        if (child?.pid) identities.push(child.pid, -child.pid)
      }
      await vi.waitFor(() => {
        for (const pid of identities) absent(pid)
      })
      expect(native.fds.size).toBe(0)
      native.parent = ''
      await rm(data, { recursive: true, force: true })
      await rm(helper.directory, { recursive: true, force: true })
    }
  },
  15_000,
)

it.each([
  'never drained',
  'interrupted drain',
  'native settled',
  'outer only',
  'caller settled',
  'retired',
] as const)(
  'cold-recovers a real Pi lease only with sufficient caller evidence (%s)',
  async (phase) => {
    const data = await realpath(await mkdtemp(join(tmpdir(), 'holi-cold-pi-phase-')))
    const helper = buildLeaseForTests()
    native.helper = helper.binary
    native.parent = data
    const vault = { root: data, remote: 'fixture/pi-phase' }
    const controller = new AbortController()
    const old = activationOwnership(data, vault, controller.signal)!
    old.recover('pi')
    const record = old.allocate('pi', 'test')
    const path = record.ownershipRecordPath!
    const launch = preparePosixLaunch('/bin/true', [], {
      cwd: data,
      directory: data,
      ownershipRecordPath: path,
      graceMs: 25,
      stdio: 'ignore',
    })
    let child: ChildProcess | undefined
    let exited: Promise<unknown> | undefined
    let identities: number[] = []
    let lostController = false
    try {
      child = spawn(launch.executable, launch.args, launch.options)
      exited = once(child, 'exit')
      void exited.catch(() => {})
      await launch.bind(child.pid!)
      identities = journalIdentities(await readFile(join(path, 'journal'), 'utf8'))
      expect(identities).toHaveLength(5)
      if (phase === 'interrupted drain' || phase === 'caller settled' || phase === 'retired')
        record.beginCallerFinalization()
      if (phase === 'never drained' || phase === 'interrupted drain') {
        // Main disappears before it can record physical settlement. The
        // native anchor still owns EOF teardown; do not reconstruct signals.
        lostController = true
        for (const fd of native.fds) closeSync(fd)
      } else {
        await launch.drain()
        if (phase === 'caller settled' || phase === 'retired') record.settleCaller()
      }
      controller.abort()
      await exited
      await vi.waitFor(() => {
        for (const pid of identities) absent(pid)
      })
      expect(inspectPosixOwnership(path)).toEqual({
        state: 'confirmed',
        proof: lostController ? 'kernel-absence' : 'settled',
      })
      const next = activationOwnership(data, vault, signal())!
      if (phase === 'retired' || phase === 'outer only') {
        // Outer settlement is not a substitute for durable caller settlement.
        const entry = dirname(dirname(path))
        await writeFile(join(entry, 'settled'), `HOLI-AGENT-1 ${basename(entry)}\nSETTLED\n`, {
          mode: 0o600,
        })
        const retired = `${entry}.retired`
        if (phase === 'retired') await rename(entry, retired)
        const probe = vi.spyOn(process, 'kill')
        try {
          if (phase === 'retired') next.recover('pi')
          else expect(() => next.recover('pi')).toThrow(/Pi.*settlement/)
          expect(probe).not.toHaveBeenCalled()
        } finally {
          probe.mockRestore()
        }
        if (phase === 'retired')
          await expect(access(retired)).rejects.toMatchObject({ code: 'ENOENT' })
        else await access(entry)
      } else if (phase === 'interrupted drain' || phase === 'native settled') {
        expect(() => next.recover('pi')).toThrow(/Pi.*(pending|settlement)/)
        await access(path)
      } else {
        next.recover('pi')
        await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
      }
    } finally {
      if (!lostController) {
        if (child?.pid !== undefined) await launch.drain()
        else await launch.cancel('possibly-launched')
      }
      await exited
      if (identities.length === 0) {
        identities = journalIdentities(await readFile(join(path, 'journal'), 'utf8'))
        if (child?.pid) identities.push(child.pid, -child.pid)
      }
      await vi.waitFor(() => {
        for (const pid of identities) absent(pid)
      })
      expect(native.fds.size).toBe(0)
      native.parent = ''
      await rm(data, { recursive: true, force: true })
      await rm(helper.directory, { recursive: true, force: true })
    }
  },
)

it.each(
  (['stop', 'leave'] as const).flatMap((route) =>
    (['held START', 'held GO', 'queued GO'] as const).map((gate) => ({ route, gate })),
  ),
)(
  'direct Pi $route revokes native admission at $gate',
  async ({ route, gate }) => {
    const data = await realpath(await mkdtemp(join(tmpdir(), 'holi-pi-gate-')))
    const helper = buildLeaseForTests()
    native.helper = helper.binary
    native.parent = data
    vi.stubEnv('TMPDIR', data)
    const vault = { root: data, remote: 'fixture/pi-gate' }
    const registry = activationOwnership(data, vault, signal())!
    registry.recover('pi')
    const marker = join(data, 'provider-ran')
    const executable = join(data, 'fixture-pi')
    let recordPath: string | undefined
    let childPID: number | undefined
    let nativeDrain: (() => Promise<void>) | undefined
    let outputClosed: Promise<unknown> | undefined
    let identities: number[] = []
    const nonLaunch = vi.fn()
    let goWrites = 0
    let phaseAtDrain: string | undefined
    const manager = createPiBackground({
      // Direct Stop/leave: deliberately no activation-signal invalidation.
      bin: () => executable,
      allocateOwnership: (id, proof) => {
        const record = registry.allocate('pi', id, proof)
        recordPath = record.ownershipRecordPath!
        return {
          ...record,
          nonLaunch: () => {
            record.nonLaunch()
            nonLaunch()
          },
        }
      },
      bracket: vi.fn(),
      changed() {},
    })
    manager.setVault(vault.remote, vault.root)
    try {
      await writeFile(executable, `#!/bin/sh\nprintf ran > "${marker}"\n`, { mode: 0o700 })
      native.onSpawn = (child) => {
        childPID = child.pid
        const supervision = child[ownedProcessDrain]
        nativeDrain = supervision?.drain
        if (supervision) {
          const drain = supervision.drain
          child[ownedProcessDrain] = {
            drain: () => {
              try {
                phaseAtDrain = readFileSync(
                  join(dirname(dirname(recordPath!)), 'caller-finalizing'),
                  'utf8',
                )
              } catch {
                // Assert after cleanup rather than throwing ahead of revocation.
              }
              return drain()
            },
          }
        }
        outputClosed = new Promise((resolve) => child.once('close', resolve))
      }
      let id: string | undefined
      let snapped = false
      let stopped!: (result: unknown) => void
      let failed!: (error: unknown) => void
      const stopping = new Promise<unknown>((resolve, reject) => {
        stopped = resolve
        failed = reject
      })
      void stopping.catch(() => {})
      const scheduleStop = () => {
        if (snapped) return
        snapped = true
        identities = journalIdentities(readFileSync(join(recordPath!, 'journal'), 'utf8'))
        queueMicrotask(() => {
          const result = route === 'stop' ? manager.stop(id!) : manager.leave()
          result.then(stopped, failed)
        })
      }
      native.onRead = (value) => {
        // Resolving the START wait queues the startup continuation behind the
        // Stop call, but ahead of any work deferred by Stop itself.
        if (gate === 'queued GO' && value.split('\n').includes('START')) scheduleStop()
      }
      native.holdWrite = (value) => {
        if ((gate === 'held START' && value === 'S') || (gate === 'held GO' && value === 'G')) {
          scheduleStop()
          return true
        }
        if (value === 'G') goWrites++
        return false
      }
      const result = await manager.launch({ name: 'gate', prompt: 'go' })
      expect(result).toMatchObject({ ok: true })
      id = result.ok ? result.sessionId : undefined
      await expect(stopping).resolves.toEqual(route === 'stop' ? { ok: true } : undefined)
      expect(goWrites).toBe(0)
      expect(phaseAtDrain).toMatch(/\nFINALIZING\n$/)
      expect(nonLaunch).toHaveBeenCalledOnce()
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(recordPath!)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(identities).toHaveLength(5)
    } finally {
      native.onRead = native.holdWrite = native.onSpawn = undefined
      await manager.leave().catch(() => {})
      if (childPID !== undefined) {
        if (!nativeDrain) throw new Error('Missing native drain authority for gate fixture')
        await nativeDrain()
        await outputClosed
        if (!identities.length && recordPath)
          identities = journalIdentities(await readFile(join(recordPath, 'journal'), 'utf8'))
        for (const pid of new Set([childPID, -childPID, ...identities])) absent(pid)
      }
      expect(native.fds.size).toBe(0)
      vi.unstubAllEnvs()
      native.parent = ''
      await rm(data, { recursive: true, force: true })
      await rm(helper.directory, { recursive: true, force: true })
    }
  },
  15_000,
)

it.each(
  (['active', 'retired'] as const).flatMap((phase) =>
    (['missing native', 'failed native', 'non-launch', 'explicit'] as const).map((proof) => ({
      phase,
      proof,
    })),
  ),
)('validates $proof beside outer settlement ($phase)', async ({ phase, proof }) => {
  // Disk-only fixture: no process or PID is created, even for native failure.
  const data = await realpath(await mkdtemp(join(tmpdir(), 'holi-outer-receipt-')))
  const probe = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw new Error('An outer settlement must never probe the kernel')
  })
  try {
    const vault = { root: data, remote: 'fixture/outer-receipt' }
    const controller = new AbortController()
    const registry = activationOwnership(data, vault, controller.signal)!
    const scratch = join(data, 'scratch')
    const id = 'ad012345abcd'
    const output = join(scratch, id, 'output')
    const key = createHash('sha256')
      .update(JSON.stringify([vault.remote, data]))
      .digest('hex')
    const parent = join(data, 'agent-ownership', key, 'fenced')
    recoverFencedScratch(registry, scratch)
    const record = registry.allocate('fenced', id, proof === 'explicit' ? 'explicit' : 'native')
    const [nonce] = await readdir(parent)
    const entry = join(parent, nonce!)
    const current = phase === 'retired' ? `${entry}.retired` : entry
    if (proof === 'non-launch') record.nonLaunch()
    else {
      record.beginCallerFinalization()
      record.settleCaller()
    }
    if (proof === 'failed native') {
      const path = record.ownershipRecordPath!
      const header = `HOLI-POSIX-1 ${nonce}\n`
      await mkdir(path, { mode: 0o700 })
      await writeFile(join(path, 'journal'), header, { mode: 0o600 })
      await writeFile(join(path, 'failed'), header + 'FAILED drain\n', { mode: 0o600 })
      await writeFile(join(path, 'settled'), header + 'SETTLED\n', { mode: 0o600 })
    }
    if (phase === 'active') {
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, 'keep until full proof')
    }
    await writeFile(join(entry, 'settled'), `HOLI-AGENT-1 ${nonce}\nSETTLED\n`, { mode: 0o600 })
    controller.abort()
    if (phase === 'retired') await rename(entry, current)
    const recover = () => recoverFencedScratch(activationOwnership(data, vault, signal())!, scratch)
    if (proof === 'failed native' || proof === 'missing native') {
      expect(recover).toThrow(proof === 'failed native' ? /cleanup failed/ : /Missing native/)
      await access(current)
      if (phase === 'active') expect(await readFile(output, 'utf8')).toBe('keep until full proof')
    } else {
      recover()
      await expect(access(current)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(output)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(probe).not.toHaveBeenCalled()
  } finally {
    probe.mockRestore()
    await rm(data, { recursive: true, force: true })
  }
})

it.each([
  'missing link',
  'missing settlement',
  'malformed settlement',
  'partial failure',
  'partial native',
] as const)('retains an interrupted retired record with %s', async (fault) => {
  const data = await mkdtemp(join(tmpdir(), 'holi-retired-partial-'))
  const probe = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw new Error('A retired receipt must not reach the kernel')
  })
  try {
    const vault = { root: data, remote: 'fixture/retired' }
    const controller = new AbortController()
    const registry = activationOwnership(data, vault, controller.signal)!
    registry.recover('fenced')
    const record = registry.allocate('fenced', 'partial')
    if (fault !== 'partial native') record.nonLaunch()
    else {
      record.beginCallerFinalization()
      record.settleCaller()
    }
    const path = record.ownershipRecordPath!
    const entry = dirname(dirname(path))
    const retired = `${entry}.retired`
    const header = `HOLI-AGENT-1 ${basename(entry)}\n`
    if (fault !== 'missing settlement') {
      await writeFile(
        join(entry, 'settled'),
        header + (fault === 'malformed settlement' ? 'SET' : 'SETTLED\n'),
        {
          mode: 0o600,
        },
      )
    }
    if (fault === 'missing link') await rm(join(entry, 'link'))
    if (fault === 'partial failure')
      await writeFile(join(entry, 'failed.tmp'), header, { mode: 0o600 })
    if (fault === 'partial native') await mkdir(path, { mode: 0o700 })
    controller.abort()
    await rename(entry, retired)
    const next = activationOwnership(data, vault, signal())!
    expect(() => next.recover('fenced')).toThrow(/Retaining/)
    await access(retired)
    expect(probe).not.toHaveBeenCalled()
  } finally {
    probe.mockRestore()
    await rm(data, { recursive: true, force: true })
  }
})
