/**
 * The bottom panel's context chips, main side (docs/features/status-bar.md):
 * reading OSC 7 off a PTY's stream, the cwd it names, the lsof fallback, the
 * git summary against a real repository, and the shell integration run by a
 * real zsh and bash.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { writeShellIntegration } from '../src/main/terminal/shell-integration'
import {
  countStatusV2,
  createOsc7Scanner,
  gitSummary,
  homeLabel,
  parseLsofCwd,
  parseOsc7,
  sumNumstat,
} from '../src/main/terminal/terminal-context'
import { cleanupFixtures, tmp } from './helpers/git-fixtures'

const exec = promisify(execFile)

afterAll(cleanupFixtures)

describe('OSC 7', () => {
  it('finds each sequence, ended by BEL or ST, across chunk boundaries', () => {
    const scan = createOsc7Scanner()
    expect(scan('hello \x1b]7;file://h/a\x07 % ')).toEqual(['file://h/a'])
    expect(scan('out\x1b')).toEqual([])
    expect(scan(']7;file://h/')).toEqual([])
    expect(scan('b c\x1b\\% \x1b]7;file://h/d\x07')).toEqual(['file://h/b c', 'file://h/d'])
    // Another OSC is not this one.
    expect(scan('\x1b]0;title\x07\x1b]2;x\x07')).toEqual([])
  })

  it('drops a sequence that never ends', () => {
    const scan = createOsc7Scanner()
    expect(scan('\x1b]7;' + 'x'.repeat(5000))).toEqual([])
    expect(scan('\x07')).toEqual([])
    expect(scan('\x1b]7;file:///ok\x07')).toEqual(['file:///ok'])
  })

  it('reads a local file URL as its decoded absolute path', () => {
    expect(parseOsc7('file://MacBook.local/Users/me/a%20b/%C3%A9', 'MacBook.local')).toBe(
      '/Users/me/a b/é',
    )
    expect(parseOsc7('file://macbook/Users/me/', 'MacBook.local')).toBe('/Users/me')
    expect(parseOsc7('file:///', 'h')).toBe('/')
    expect(parseOsc7('file://localhost/a/../b', 'h')).toBe('/b')
  })

  it('refuses another machine, another scheme, and nonsense', () => {
    expect(parseOsc7('file://server.example/etc', 'MacBook.local')).toBeNull()
    expect(parseOsc7('https://h/a', 'h')).toBeNull()
    expect(parseOsc7('not a url', 'h')).toBeNull()
    expect(parseOsc7('file://h/a%00b', 'h')).toBeNull()
    expect(parseOsc7('file://h/%E0%A4%A', 'h')).toBeNull()
  })

  it('shows the home folder as ~', () => {
    expect(homeLabel('/Users/me', '/Users/me')).toBe('~')
    expect(homeLabel('/Users/me/dev/holi', '/Users/me')).toBe('~/dev/holi')
    expect(homeLabel('/Users/meg/x', '/Users/me')).toBe('/Users/meg/x')
    expect(homeLabel('/tmp', '/Users/me')).toBe('/tmp')
  })
})

describe('lsof', () => {
  it("reads the cwd from lsof's field output", () => {
    expect(parseLsofCwd('p4242\nfcwd\nn/Users/me/dev\n')).toBe('/Users/me/dev')
    expect(parseLsofCwd('')).toBeNull()
    expect(parseLsofCwd('p1\nfcwd\nnrelative\n')).toBeNull()
  })
})

describe('git summary', () => {
  it('counts porcelain v2 entries, a rename once', () => {
    const out = [
      '1 .M N... 100644 100644 100644 a a a.md',
      '2 R. N... 100644 100644 100644 a a R100 new.md',
      'old.md',
      'u UU N... 1 1 1 1 a a a c.md',
      '? new file.md',
      '! ignored',
      '',
    ].join('\0')
    expect(countStatusV2(out)).toBe(4)
  })

  it('sums numstat, a binary file as nothing and a rename once', () => {
    const out = ['3\t1\ta.md', '-\t-\timg.png', '2\t0\t', 'old.md', 'new.md', ''].join('\0')
    expect(sumNumstat(out)).toEqual({ added: 5, removed: 1 })
  })

  it('reads branch, changed files and lines from a real repository', async () => {
    const dir = await realpath(await tmp('holi-term-git-'))
    const git = (...args: string[]) =>
      exec('git', ['-c', 'user.name=T', '-c', 'user.email=t@e', ...args], { cwd: dir })

    expect(await gitSummary(dir)).toBeNull()

    await git('init', '-q', '-b', 'trunk')
    // No commit yet: everything is new.
    await writeFile(join(dir, 'a.md'), 'one\ntwo\n')
    await git('add', 'a.md')
    expect(await gitSummary(dir)).toEqual({ branch: 'trunk', files: 1, added: 2, removed: 0 })

    await git('commit', '-q', '-m', 'first')
    expect(await gitSummary(dir)).toEqual({ branch: 'trunk', files: 0, added: 0, removed: 0 })

    await writeFile(join(dir, 'a.md'), 'one\nthree\nfour\n')
    await mkdir(join(dir, 'sub'))
    await writeFile(join(dir, 'sub', 'b.md'), 'new\n')
    await git('checkout', '-q', '-b', 'feat/x')
    // From a subfolder: the summary is the whole work tree's.
    expect(await gitSummary(join(dir, 'sub'))).toEqual({
      branch: 'feat/x',
      files: 2,
      added: 2,
      removed: 1,
    })
  })
})

describe.skipIf(process.platform === 'win32')('shell integration', () => {
  async function rigHome() {
    const root = await realpath(await tmp('holi-term-shell-'))
    const home = join(root, 'home')
    const shim = join(root, 'shim')
    await mkdir(join(home, 'a b', 'é'), { recursive: true })
    writeShellIntegration(shim)
    return { home, shim }
  }

  it.skipIf(!existsSync('/bin/zsh'))(
    "zsh: runs the person's own files, keeps their prompt, and prints OSC 7 at each prompt",
    async () => {
      const { home, shim } = await rigHome()
      await writeFile(join(home, '.zshenv'), 'echo MINE_ENV\n')
      await writeFile(join(home, '.zprofile'), 'echo MINE_PROFILE\n')
      await writeFile(join(home, '.zshrc'), "echo MINE_RC\nPROMPT='mine> '\n")
      await writeFile(join(home, '.zlogin'), 'echo MINE_LOGIN\n')
      const run = exec('/bin/zsh', ['-l', '-i'], {
        cwd: home,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: home,
          HOLI_USER_ZDOTDIR: home,
          ZDOTDIR: join(shim, 'zsh'),
        },
      })
      run.child.stdin!.end('cd "a b/é"\necho "Z=${ZDOTDIR-unset} H=$HISTFILE"\nexit\n')
      const { stdout, stderr } = await run
      const out = stdout + stderr
      expect(out).toMatch(/MINE_ENV[\s\S]*MINE_PROFILE[\s\S]*MINE_RC[\s\S]*MINE_LOGIN/)
      expect(out).toContain('mine> ')
      const reported = [...out.matchAll(/\x1b\]7;([^\x07]*)\x07/g)].map((m) => parseOsc7(m[1]!))
      expect(reported).toContain(home)
      expect(reported).toContain(join(home, 'a b', 'é'))
      // ZDOTDIR is theirs again (unset, as it was), and so is the history.
      expect(out).toContain(`Z=unset H=${home}/.zsh_history`)
    },
  )

  it.skipIf(!existsSync('/bin/bash'))(
    "bash: reads the login files, keeps the person's PROMPT_COMMAND, and prints OSC 7",
    async () => {
      const { home, shim } = await rigHome()
      await writeFile(
        join(home, '.bash_profile'),
        'echo MINE_PROFILE\nPROMPT_COMMAND="echo pc;  "\n',
      )
      const run = exec('/bin/bash', ['--init-file', join(shim, 'bash-init.sh'), '-i'], {
        cwd: home,
        // UTF-8, or readline reads the é as a meta key.
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'en_US.UTF-8' },
      })
      run.child.stdin!.end('cd "a b/é"\nexit\n')
      const { stdout, stderr } = await run
      const out = stdout + stderr
      expect(out).toContain('MINE_PROFILE')
      expect(out).toContain('pc')
      const reported = [...out.matchAll(/\x1b\]7;([^\x07]*)\x07/g)].map((m) => parseOsc7(m[1]!))
      expect(reported).toContain(join(home, 'a b', 'é'))
    },
  )
})
