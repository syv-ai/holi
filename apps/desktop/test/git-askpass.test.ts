import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { askpassScript, ensureAskpass, runGit } from '../src/main/git'

const exec = promisify(execFile)

async function gitShell(): Promise<string> {
  if (process.platform !== 'win32') return 'sh'
  // The app needs Git on PATH, not sh. Use Git's bundled interpreter in tests
  // too, rather than assuming the runner exposes Unix tools in its parent PATH.
  const { stdout } = await exec('git', ['--exec-path'], { timeout: 5_000 })
  return join(stdout.trim(), '..', '..', '..', 'usr', 'bin', 'sh.exe')
}

describe('Windows askpass', () => {
  it('answers prompts without interpreting arguments or token text as shell syntax', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holi askpass København '))
    const marker = join(directory, 'executed')
    const helper = join(directory, 'credential helper.sh')
    const script = askpassScript('win32')
    const token = 'quote " !&^()%<>%VAR% ; $(touch marker)'
    const shell = await gitShell()
    const runHelper = (prompt: string, answer = token) =>
      exec(shell, [helper, prompt], {
        env: { ...process.env, HOLI_GIT_TOKEN: answer },
        timeout: 5_000,
        windowsHide: true,
      }).then(({ stdout }) => stdout.replace(/[\r\n]+$/, ''))

    await writeFile(helper, script, { mode: 0o700 })
    try {
      expect((await runHelper('uSeRnAmE: prompt')).trimEnd()).toBe('x-access-token')
      expect(await runHelper("Password for 'https://myusername@example.test/path'")).toBe(token)
      expect(await runHelper(`Password: \\"$(touch '${marker}')\\"`)).toBe(token)
      for (const literal of ['-n', '-e', 'literal\\nbackslash']) {
        expect(await runHelper('Password: literal token', literal)).toBe(literal)
      }
      expect(
        await exec(shell, [helper, 'Password: empty'], {
          env: { ...process.env, HOLI_GIT_TOKEN: '' },
          timeout: 5_000,
        }).then(({ stdout }) => stdout),
      ).toBe('\n')
      await expect(rm(marker)).rejects.toThrow()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'win32')(
    'answers Git prompts through the generated shell helper',
    async () => {
      const [generatedPath, concurrentPath] = await Promise.all([ensureAskpass(), ensureAskpass()])
      expect(concurrentPath).toBe(generatedPath)
      const spacedDirectory = await mkdtemp(join(tmpdir(), 'holi askpass space '))
      const path = join(spacedDirectory, 'credential helper.sh')
      await writeFile(path, askpassScript('win32'), { mode: 0o700 })
      const shell = await gitShell()
      const answer = (prompt: string, token: string) =>
        exec(shell, [path, prompt], {
          env: { ...process.env, HOLI_GIT_TOKEN: token },
          timeout: 5_000,
          windowsHide: true,
        }).then(({ stdout }) => stdout.trimEnd())

      try {
        for (const prompt of [
          "Username for 'https://example.test/a b'",
          'uSeRnAmE: punctuation !@#$%^&()_+-=[]{};,.?',
          'USERNAME — København ☃',
        ]) {
          expect(await answer(prompt, 'synthetic-token')).toBe('x-access-token')
        }

        for (const prompt of [
          "Password for 'https://example.test/a b'",
          'PaSsWoRd: punctuation !@#$%^&()_+-=[]{};,.?',
          'PASSWORD — København ☃',
        ]) {
          expect(await answer(prompt, 'punctuation !&^()%! token')).toBe(
            'punctuation !&^()%! token',
          )
          expect(await answer(prompt, '')).toBe('')
        }
      } finally {
        await rm(spacedDirectory, { recursive: true, force: true })
      }
    },
    30_000,
  )

  it('authenticates real Git against a local endpoint', async () => {
    const received: string[] = []
    const directory = await mkdtemp(join(tmpdir(), 'holi askpass endpoint København '))
    const helper = join(directory, 'credential helper.sh')
    if (process.platform === 'win32') {
      await copyFile(await ensureAskpass(), helper)
    } else {
      await writeFile(helper, askpassScript('win32'), { mode: 0o700 })
    }
    const server = createServer((request, response) => {
      const authorization = request.headers.authorization
      if (authorization) {
        const decoded = Buffer.from(authorization.replace(/^Basic /, ''), 'base64').toString()
        received.push(decoded)
        if (
          decoded === 'configured-username:synthetic !&^()%!' ||
          decoded === 'x-access-token:synthetic !&^()%!'
        ) {
          response.writeHead(200, {
            'content-type': 'application/x-git-upload-pack-advertisement',
          })
          response.end('001e# service=git-upload-pack\n00000000')
          return
        }
      }
      response.writeHead(401, { 'www-authenticate': 'Basic realm="local test"' })
      response.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Local test server did not bind')
    const endpoint = `127.0.0.1:${address.port}/repo.git`

    try {
      const gitEnv = {
        ...process.env,
        GIT_ASKPASS: helper,
        GIT_TERMINAL_PROMPT: '0',
        HOLI_GIT_TOKEN: 'synthetic !&^()%!',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      }
      for (const username of ['x-access-token', 'configured-username']) {
        const login = username === 'x-access-token' ? '' : `${username}@`
        const gitArgs = ['-c', 'credential.helper=', 'ls-remote', `http://${login}${endpoint}`]
        received.length = 0
        const { stdout: output } = await exec('git', gitArgs, {
          env: gitEnv,
          timeout: 10_000,
          windowsHide: true,
        })
        expect(output).toBe('')
        expect(received).toContain(`${username}:synthetic !&^()%!`)

        received.length = 0
        const failure = await exec('git', gitArgs, {
          env: { ...gitEnv, HOLI_GIT_TOKEN: '' },
          timeout: 10_000,
          windowsHide: true,
        }).catch((error) => error)
        expect(failure).toBeInstanceOf(Error)
        expect(received.length).toBeGreaterThan(0)
        expect(received.every((credential) => credential === `${username}:`)).toBe(true)
      }
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  it.skipIf(process.platform !== 'win32')(
    'forces background Git settings without disabling helpers',
    async () => {
      let tokenReads = 0
      const result = await runGit(
        process.cwd(),
        [
          '/d',
          '/s',
          '/c',
          'set GCM_INTERACTIVE & set GIT_TERMINAL_PROMPT & set GIT_ASKPASS & set GIT_CONFIG_VALUE_0',
        ],
        {
          gitPath: process.env.ComSpec ?? 'cmd.exe',
          token: () => {
            tokenReads += 1
            return 'fixture-only'
          },
          env: {
            GCM_INTERACTIVE: 'always',
            GIT_TERMINAL_PROMPT: '1',
            GIT_ASKPASS: 'unsafe-override',
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'credential.helper',
            GIT_CONFIG_VALUE_0: 'synthetic-helper',
            git_askpass: 'unsafe-lowercase-override',
            gcm_interactive: 'always-lowercase',
          },
        },
      )

      expect(result).toContain('GCM_INTERACTIVE=never')
      expect(result).toContain('GIT_TERMINAL_PROMPT=0')
      expect(result).toContain('GIT_CONFIG_VALUE_0=synthetic-helper')
      expect(result).toContain('GIT_ASKPASS=')
      expect(result).not.toContain('unsafe-')
      expect(result).not.toContain('fixture-only')
      expect(tokenReads).toBe(1)
    },
  )

  it('keeps the POSIX helper byte-for-byte unchanged', () => {
    expect(askpassScript('darwin')).toBe(
      '#!/bin/sh\ncase "$1" in *sername*) echo "x-access-token";; *) echo "$HOLI_GIT_TOKEN";; esac\n',
    )
  })
})
