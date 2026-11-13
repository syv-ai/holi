import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { GitError, askpassScript, ensureAskpass, runGit } from '../src/main/git'

const exec = promisify(execFile)

describe('Windows askpass', () => {
  it('generates a batch answerer that safely handles all prompt classes', () => {
    const script = askpassScript('win32')

    expect(script).toContain('findstr /i /c:"username"')
    expect(script).toContain('echo(!HOLI_GIT_TOKEN!)')
    expect(script).not.toContain('echo %HOLI_GIT_TOKEN%')
  })

  it.skipIf(process.platform !== 'win32')(
    'answers Git prompts through the generated batch file',
    async () => {
      const [generatedPath, concurrentPath] = await Promise.all([ensureAskpass(), ensureAskpass()])
      expect(concurrentPath).toBe(generatedPath)
      const spacedDirectory = await mkdtemp(join(tmpdir(), 'holi askpass space '))
      const path = join(spacedDirectory, 'credential helper.bat')
      await copyFile(generatedPath, path)
      const answer = (prompt: string, token: string) =>
        exec(path, [prompt], {
          env: { ...process.env, HOLI_GIT_TOKEN: token },
          shell: true,
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

  it.skipIf(process.platform !== 'win32')(
    'authenticates real Git against a local endpoint',
    async () => {
      const received: string[] = []
      const server = createServer((request, response) => {
        const authorization = request.headers.authorization
        if (authorization) {
          const decoded = Buffer.from(authorization.replace(/^Basic /, ''), 'base64').toString()
          received.push(decoded)
          if (decoded === 'x-access-token:synthetic !&^()%!') {
            response.writeHead(200, {
              'content-type': 'application/x-git-upload-pack-advertisement',
            })
            response.end('001f# service=git-upload-pack\n0000')
            return
          }
        }
        response.writeHead(401, { 'www-authenticate': 'Basic realm="local test"' })
        response.end()
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Local test server did not bind')
      const url = `http://127.0.0.1:${address.port}/repo.git`

      try {
        const output = await runGit(process.cwd(), ['-c', 'credential.helper=', 'ls-remote', url], {
          token: () => 'synthetic !&^()%!',
          env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' },
        })
        expect(output).toBe('')
        expect(received).toContain('x-access-token:synthetic !&^()%!')

        received.length = 0
        const failure = await runGit(
          process.cwd(),
          ['-c', 'credential.helper=', 'ls-remote', url],
          {
            token: () => '',
            env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' },
          },
        ).catch((error) => error)
        expect(failure).toBeInstanceOf(GitError)
        expect(received.length).toBeGreaterThan(0)
        expect(received.every((credential) => credential === 'x-access-token:')).toBe(true)
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
      }
    },
    30_000,
  )

  it.skipIf(process.platform !== 'win32')(
    'forces background Git settings without disabling helpers',
    async () => {
      const result = await runGit(process.cwd(), ['/d', '/s', '/c', 'set'], {
        gitPath: process.env.ComSpec ?? 'cmd.exe',
        env: {
          GCM_INTERACTIVE: 'always',
          GIT_TERMINAL_PROMPT: '1',
          GIT_ASKPASS: 'unsafe-override',
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'credential.helper',
          GIT_CONFIG_VALUE_0: 'synthetic-helper',
        },
      })

      expect(result).toContain('GCM_INTERACTIVE=never')
      expect(result).toContain('GIT_TERMINAL_PROMPT=0')
      expect(result).toContain('GIT_CONFIG_VALUE_0=synthetic-helper')
    },
  )

  it('keeps the POSIX helper byte-for-byte unchanged', () => {
    expect(askpassScript('darwin')).toBe(
      '#!/bin/sh\ncase "$1" in *sername*) echo "x-access-token";; *) echo "$HOLI_GIT_TOKEN";; esac\n',
    )
  })
})
