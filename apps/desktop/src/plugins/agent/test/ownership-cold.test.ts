import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { closeSync } from 'node:fs'
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
import { basename, dirname, join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { buildLeaseForTests } from '../../../../test/fixtures/posix-native-build'
import { inspectPosixOwnership, preparePosixLaunch } from '../../../main/plugin-api'
import { activationOwnership } from '../main/host/ownership'
import { agentScratchRoots } from '../main/host/scratch-roots'
import { recoverFencedScratch } from '../main/host/fenced'
import { PRESETS } from '../main/harness/record'
import { activationHosts } from './fixtures/activation-hosts'

const native = vi.hoisted(() => ({ helper: '', parent: '', fds: new Set<number>() }))
vi.mock('electron', () => ({
  app: { getVersion: () => 'test' },
  nativeTheme: { shouldUseDarkColors: false },
}))
vi.mock('../../../main/posix-lease-executable', () => ({
  posixLeaseExecutable: () => native.helper,
}))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args)
      if (native.parent && String(args[0]).startsWith(native.parent + '/holi-launch-'))
        native.fds.add(fd)
      return fd
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
          record.fail(new Error('original caller failure'))
          record.fail(new Error('must not replace first failure'))
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
