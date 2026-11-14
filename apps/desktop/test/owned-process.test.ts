import { ChildProcess } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSystemErrorName } from 'node:util'
import { describe, expect, it, onTestFailed } from 'vitest'
import { spawnOwnedProgram } from '../src/main/owned-process'

const windows = process.platform === 'win32'

async function waitForFile(file: string): Promise<string> {
  const deadline = Date.now() + 10_000
  while (true) {
    try {
      return await readFile(file, 'utf8')
    } catch {
      if (Date.now() >= deadline) throw new Error(`No handshake at ${file}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}

function diagnostics(child: ReturnType<typeof spawnOwnedProgram>): void {
  let lastPhase = 'none'
  child.stderr?.on('data', (chunk: Buffer | string) => {
    const text = String(chunk)
    const phases = [...text.matchAll(/phase=([^\s]+)/g)]
    if (phases.length) lastPhase = phases[phases.length - 1][1]
  })
  onTestFailed(async () => {
    console.error(
      `[owned-process test failure] pid=${child.pid ?? 'none'} exitCode=${child.exitCode} signalCode=${child.signalCode} lastPhase=${lastPhase}`,
    )
    await cleanup(child)
  })
}

async function cleanup(child: ReturnType<typeof spawnOwnedProgram>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill()
  await Promise.race([
    completion(child).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 500)),
  ])
  if (child.exitCode === null && child.signalCode === null) {
    ChildProcess.prototype.kill.call(child, 'SIGKILL')
    await Promise.race([
      completion(child).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ])
  }
}

function completion(child: ReturnType<typeof spawnOwnedProgram>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve(code))
  })
}

describe('spawnOwnedProgram', () => {
  it('preserves exact argv and output', async () => {
    const args = ['one two', '', '☃', 'one\r\ntwo', 'q"uote', 'x'.repeat(12_000)]
    const child = spawnOwnedProgram(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...args],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...(windows ? { HOLI_OWNED_PROCESS_TRACE: '1' } : {}) },
      },
    )
    let error = ''
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (error += chunk))
    diagnostics(child)
    const done = completion(child)
    let output = ''
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
    try {
      expect(await done, error).toBe(0)
      expect(JSON.parse(output)).toEqual(args)
    } finally {
      await cleanup(child)
    }
  })

  it.skipIf(!windows)('does not resolve the helper from a poisoned vault cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-owned-poisoned-cwd-'))
    const poison = join(dir, 'powershell.exe')
    let child: ReturnType<typeof spawnOwnedProgram> | undefined
    try {
      await copyFile(process.execPath, poison)
      child = spawnOwnedProgram(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      })
      diagnostics(child)
      const done = completion(child)
      let output = ''
      child.stdout!.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
      expect(await done).toBe(0)
      expect(output).toBe(dir)
    } finally {
      if (child) await cleanup(child)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!windows)('handles a missing helper without leaking stdin errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-owned-missing-helper-'))
    const previousSystemRoot = process.env.SystemRoot
    process.env.SystemRoot = dir
    let child: ReturnType<typeof spawnOwnedProgram> | undefined
    let childErrors = 0
    let stdinErrors = 0
    try {
      child = spawnOwnedProgram(process.execPath, ['-e', 'process.exit(0)'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      })
      child.on('error', () => childErrors++)
      child.stdin!.on('error', () => stdinErrors++)
      const closed = new Promise<number | null>((resolve) => child!.once('close', resolve))
      await expect(completion(child)).rejects.toMatchObject({ code: 'ENOENT' })
      const code = await closed
      expect(getSystemErrorName(code!)).toBe('ENOENT')
      const previousStdinErrors = stdinErrors
      child.stdin!.emit('error', Object.assign(new Error('test input failure'), { code: 'EPIPE' }))
      expect(stdinErrors).toBe(previousStdinErrors + 1)
      expect(childErrors).toBe(1)
    } finally {
      if (previousSystemRoot === undefined) delete process.env.SystemRoot
      else process.env.SystemRoot = previousSystemRoot
      if (child) await cleanup(child)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!windows).each([false, true])(
    'terminates descendants before reporting root exit (pipes: %s)',
    async (pipes) => {
      const dir = await mkdtemp(join(tmpdir(), 'holi-owned-'))
      const pidFile = join(dir, 'descendant-pid')
      let child: ReturnType<typeof spawnOwnedProgram> | undefined
      try {
        const descendant = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdout.write('ready\\n');setInterval(()=>0,1000)`
        const root = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','pipe',${pipes ? "'inherit'" : "'ignore'"}],windowsHide:true});c.stdout.once('data',()=>process.exit(23))`
        child = spawnOwnedProgram(process.execPath, ['-e', root], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ...(windows ? { HOLI_OWNED_PROCESS_TRACE: '1' } : {}) },
        })
        let error = ''
        child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (error += chunk))
        diagnostics(child)
        expect(await completion(child), error).toBe(23)
        const pid = Number(await readFile(pidFile, 'utf8'))
        expect(pid).toBeGreaterThan(1)
        expect(() => process.kill(pid, 0)).toThrow()
      } finally {
        if (child) await cleanup(child)
        await rm(dir, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(!windows).each([false, true])(
    'stops the entire owned job and leaves no stop artifact (stdin failure: %s)',
    async (stdinFailure) => {
      const dir = await mkdtemp(join(tmpdir(), 'holi-owned-stop-'))
      const pidFile = join(dir, 'descendant-pid')
      let child: ReturnType<typeof spawnOwnedProgram> | undefined
      try {
        const descendant = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>0,1000)`
        const root = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore',windowsHide:true});setInterval(()=>0,1000)`
        child = spawnOwnedProgram(process.execPath, ['-e', root], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ...(windows ? { HOLI_OWNED_PROCESS_TRACE: '1' } : {}) },
        })
        diagnostics(child)
        const done = completion(child)
        const pid = Number(await waitForFile(pidFile))
        if (stdinFailure) {
          child.stdin!.emit(
            'error',
            Object.assign(new Error('test input failure'), { code: 'EPIPE' }),
          )
        } else {
          expect(child.kill('SIGTERM')).toBe(true)
          expect(child.kill('SIGKILL')).toBe(true)
        }
        expect(await done).toBe(1)
        expect(() => process.kill(pid, 0)).toThrow()
      } finally {
        if (child) await cleanup(child)
        await rm(dir, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(!windows)('fails closed when its parent is gone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-owned-parent-'))
    const sentinel = join(dir, 'should-not-run')
    let child: ReturnType<typeof spawnOwnedProgram> | undefined
    try {
      child = spawnOwnedProgram(
        process.execPath,
        ['-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'ran')`],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ...(windows ? { HOLI_OWNED_PROCESS_TRACE: '1' } : {}) },
        },
        2_000_000_000,
      )
      diagnostics(child)
      expect(await completion(child)).toBe(125)
      await expect(readFile(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      if (child) await cleanup(child)
      await rm(dir, { recursive: true, force: true })
    }
  })
})
