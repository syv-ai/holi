import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { spawnOwnedProgram } from '../src/main/owned-process'

const until = async (check: () => Promise<boolean>, message: string): Promise<void> => {
  const deadline = Date.now() + 10_000
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('spawnOwnedProgram', () => {
  it('starts ordinary programs with argv and output on POSIX', async () => {
    if (process.platform === 'win32') return
    const child = spawnOwnedProgram(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', 'one two'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let output = ''
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
    const [code] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
      child.once('close', (status, signal) => resolve([status, signal])),
    )
    expect(code).toBe(0)
    expect(JSON.parse(output)).toEqual(['one two'])
  })

  it('stops and waits for the Windows ownership job', async () => {
    if (process.platform !== 'win32') return
    const dir = await mkdtemp(join(tmpdir(), 'holi-owned-stop-'))
    const ready = join(dir, 'ready')
    const rootExited = join(dir, 'root-exited')
    const pidFile = join(dir, 'descendant-pid')
    const descendant = [
      'const fs=require("node:fs");',
      `const dir=${JSON.stringify(dir)};`,
      'const watcher=fs.watch(dir,()=>{});',
      `fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));`,
      `fs.writeFileSync(${JSON.stringify(ready)},"ready");`,
    ].join('')
    const root = [
      'const fs=require("node:fs");const cp=require("node:child_process");',
      `cp.spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{stdio:"ignore",windowsHide:true});`,
      `fs.writeFileSync(${JSON.stringify(rootExited)},"exit");process.exit(23);`,
    ].join('')
    try {
      const child = spawnOwnedProgram(process.execPath, ['-e', root], { stdio: 'ignore' })
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once('close', (code, signal) => resolve({ code, signal })),
      )
      await until(async () => {
        try {
          await readFile(ready)
          await readFile(rootExited)
          await readFile(pidFile)
          return true
        } catch {
          return false
        }
      }, 'root/descendant stop handshake timed out')
      expect(child.kill('SIGTERM')).toBe(true)
      expect(await closed).toEqual({ code: 1, signal: null })
      const pid = Number(await readFile(pidFile, 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.each([false, true])(
    'holds Windows descendants through root exit (inherited pipes: %s)',
    async (inheritedPipes) => {
      if (process.platform !== 'win32') return
      const dir = await mkdtemp(join(tmpdir(), 'holi-owned-'))
      const ready = join(dir, 'ready')
      const rootExited = join(dir, 'root-exited')
      const release = join(dir, 'release')
      const descendantDone = join(dir, 'descendant-done')
      const descendant = [
        'const fs=require("node:fs");',
        `const dir=${JSON.stringify(dir)};`,
        'const watcher=fs.watch(dir,()=>{if(fs.existsSync(dir+"/release")){watcher.close();fs.writeFileSync(dir+"/descendant-done","done")}});',
        'fs.writeFileSync(dir+"/ready","ready");',
      ].join('')
      const root = [
        'const fs=require("node:fs");const cp=require("node:child_process");',
        `cp.spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{stdio:${inheritedPipes ? '"inherit"' : '["ignore","ignore","ignore"]'},windowsHide:true});`,
        `fs.writeFileSync(${JSON.stringify(rootExited)},"exit");process.exit(23);`,
      ].join('')
      try {
        const child = spawnOwnedProgram(process.execPath, ['-e', root], {
          stdio: ['ignore', inheritedPipes ? 'pipe' : 'ignore', inheritedPipes ? 'pipe' : 'ignore'],
        })
        let closed = false
        const closedPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) =>
            child.once('close', (code, signal) => {
              closed = true
              resolve({ code, signal })
            }),
        )
        await until(async () => {
          try {
            await readFile(ready)
            await readFile(rootExited)
            return true
          } catch {
            return false
          }
        }, 'root/descendant handshake timed out')
        expect(closed).toBe(false)
        await writeFile(release, 'release')
        await until(async () => {
          try {
            await readFile(descendantDone)
            return true
          } catch {
            return false
          }
        }, 'descendant did not finish')
        expect(await closedPromise).toEqual({ code: 23, signal: null })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  )
})
