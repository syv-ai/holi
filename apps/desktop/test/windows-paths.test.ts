/**
 * A path a person or an agent types, as the vault path it names, on Windows
 * and on POSIX (docs/architecture.md, Security boundaries): `typedVaultPath`
 * and the callers that read an absolute path an agent's tool printed. The
 * platform is injected where a case is about one OS; the rest use real paths
 * of whatever OS runs them.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vaultRelPath } from '@holi/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { taskDoneOp } from '../src/plugins/tasks/main/task-done'
import { pdfCommentsInVault } from '../src/plugins/pdf/main/comments'
import { pathUnderRoot, typedVaultPath } from '../src/main/vault/vault-files'

const WIN_ROOT = String.raw`C:\Users\ada\Holi\o\r`

describe('typedVaultPath', () => {
  const win = (typed: string) => typedVaultPath(WIN_ROOT, typed, 'win32')

  it('turns a Windows absolute path inside the vault into its vault path', () => {
    expect(win(String.raw`C:\Users\ada\Holi\o\r\tasks\task.x.md`)).toBe('tasks/task.x.md')
    expect(win('C:/Users/ada/Holi/o/r/tasks/task.x.md')).toBe('tasks/task.x.md')
    expect(win(String.raw`c:\users\ada\holi\o\r\tasks\task.x.md`)).toBe('tasks/task.x.md')
    expect(vaultRelPath(win(String.raw`C:\Users\ada\Holi\o\r\a.pdf`))).toBe('a.pdf')
  })

  it('reads a relative path with either separator', () => {
    expect(win(String.raw`tasks\task.x.md`)).toBe('tasks/task.x.md')
    expect(win(String.raw`.\tasks\task.x.md`)).toBe('tasks/task.x.md')
    expect(win('./tasks/task.x.md')).toBe('tasks/task.x.md')
  })

  it('leaves a path outside the vault for vaultRelPath to refuse', () => {
    for (const typed of [
      String.raw`C:\Users\ada\Holi\o\r-other\a.md`,
      String.raw`C:\Users\ada\other\a.md`,
      String.raw`D:\Holi\o\r\a.md`,
      String.raw`\server\share\a.md`,
    ]) {
      expect(() => vaultRelPath(win(typed))).toThrow()
    }
  })

  it('does not change what POSIX takes', () => {
    const posix = (typed: string) => typedVaultPath('/home/ada/Holi/o/r', typed, 'linux')
    expect(posix('/home/ada/Holi/o/r/tasks/task.x.md')).toBe('tasks/task.x.md')
    expect(posix('./tasks/task.x.md')).toBe('tasks/task.x.md')
    expect(posix('tasks/task.x.md')).toBe('tasks/task.x.md')
    // A backslash is a character on POSIX, and still no vault path.
    expect(() => vaultRelPath(posix(String.raw`tasks\task.x.md`))).toThrow()
    expect(() => vaultRelPath(posix('/home/ada/other/a.md'))).toThrow()
  })
})

describe('pathUnderRoot', () => {
  it('cuts the vault off a Windows path in either spelling', () => {
    const rel = String.raw`Work\Tracker.app\data\items\h.json`
    expect(pathUnderRoot(WIN_ROOT, `${WIN_ROOT}\\${rel}`, 'win32')).toBe(
      'Work/Tracker.app/data/items/h.json',
    )
    expect(pathUnderRoot(WIN_ROOT, `c:\\users\\ada\\holi\\o\\r\\${rel}`, 'win32')).toBe(
      'Work/Tracker.app/data/items/h.json',
    )
    expect(pathUnderRoot(WIN_ROOT, rel, 'win32')).toBe('Work/Tracker.app/data/items/h.json')
    expect(pathUnderRoot(WIN_ROOT, `${WIN_ROOT}-other\\a.md`, 'win32')).toBe(
      `${WIN_ROOT.replaceAll('\\', '/')}-other/a.md`,
    )
  })

  it('takes a root written with a trailing separator', () => {
    expect(pathUnderRoot(`${WIN_ROOT}\\`, `${WIN_ROOT}\\a\\b.md`, 'win32')).toBe('a/b.md')
    expect(pathUnderRoot('/r/', '/r/a.md', 'linux')).toBe('a.md')
  })

  it('reads POSIX exactly, a backslash being a character', () => {
    const root = '/home/ada/Holi/o/r'
    expect(pathUnderRoot(root, `${root}/Work/a.json`, 'linux')).toBe('Work/a.json')
    expect(pathUnderRoot(root, '/HOME/ada/Holi/o/r/a.json', 'linux')).toBe(
      '/HOME/ada/Holi/o/r/a.json',
    )
    expect(pathUnderRoot(root, String.raw`Work\a.json`, 'linux')).toBe(String.raw`Work\a.json`)
  })
})

describe('an absolute path an agent printed, on this OS', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'holi-win-paths-'))
    await mkdir(join(root, 'tasks'))
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  it('marks a task done by its absolute path', async () => {
    const abs = join(root, 'tasks', 'task.x.md')
    await writeFile(abs, '---\nstatus: todo\n---\n# X\n')
    const result = await taskDoneOp(root, abs, '2026-11-11')
    expect(result).toEqual({ ok: true, path: 'tasks/task.x.md', status: 'done' })
    expect(await readFile(abs, 'utf8')).toContain('done')
  })

  it('reads a PDF’s comments by its absolute path', async () => {
    const abs = join(root, 'tasks', 'a.pdf')
    await writeFile(abs, 'not a pdf')
    const result = await pdfCommentsInVault(root, abs)
    // The path was accepted: what is refused is the file, not where it is.
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain('not a path inside this vault')
    expect(JSON.stringify(result)).toContain('tasks/a.pdf')
  })
})
