import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const done = completion(child)
    let output = ''
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
    let error = ''
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (error += chunk))
    expect(await done, error).toBe(0)
    expect(JSON.parse(output)).toEqual(args)
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
        })
        let error = ''
        child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (error += chunk))
        expect(await completion(child), error).toBe(23)
        const pid = Number(await readFile(pidFile, 'utf8'))
        expect(pid).toBeGreaterThan(1)
        expect(() => process.kill(pid, 0)).toThrow()
      } finally {
        child?.kill()
        await rm(dir, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(!windows)('stops the entire owned job and leaves no stop artifact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-owned-stop-'))
    const pidFile = join(dir, 'descendant-pid')
    let child: ReturnType<typeof spawnOwnedProgram> | undefined
    try {
      const descendant = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>0,1000)`
      const root = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore',windowsHide:true});setInterval(()=>0,1000)`
      child = spawnOwnedProgram(process.execPath, ['-e', root], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const done = completion(child)
      const pid = Number(await waitForFile(pidFile))
      expect(child.kill('SIGTERM')).toBe(true)
      expect(child.kill('SIGKILL')).toBe(true)
      expect(await done).toBe(1)
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      child?.kill()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!windows)('fails closed when its parent is gone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-owned-parent-'))
    const sentinel = join(dir, 'should-not-run')
    try {
      const child = spawnOwnedProgram(
        process.execPath,
        ['-e', `require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'ran')`],
        { stdio: ['ignore', 'pipe', 'pipe'] },
        2_000_000_000,
      )
      child.stderr!.resume()
      expect(await completion(child)).toBe(125)
      await expect(readFile(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
