import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runGit } from '../src/main/git'

describe('Git authentication through Holi', () => {
  let directory: string | undefined
  let server: ReturnType<typeof createServer> | undefined

  afterEach(async () => {
    server?.closeAllConnections()
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined
    if (directory) await rm(directory, { recursive: true, force: true })
    directory = undefined
  })

  it('uses the current credential provider for challenged real Git requests and refuses an empty token', async () => {
    directory = await mkdtemp(join(tmpdir(), 'holi-git-auth-'))
    const answers = new Set<string>()
    const challenges: string[] = []
    server = createServer((request, response) => {
      const header = request.headers.authorization
      if (header?.startsWith('Basic ')) {
        const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
        const digest = createHash('sha256').update(decoded).digest('hex')
        challenges.push(digest)
        if (answers.has(decoded)) {
          response.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' })
          response.end('001e# service=git-upload-pack\n00000000')
          return
        }
      }
      response.writeHead(401, { 'www-authenticate': 'Basic realm="fixture"' })
      response.end()
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Loopback fixture failed to bind')
    const url = `http://127.0.0.1:${address.port}/repo.git`
    let token: string | null = 'fixture-1 punctuation !&^()% København ☃'
    answers.add(`x-access-token:${token}`)
    const opts = {
      token: () => token,
      env: {
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GCM_INTERACTIVE: 'never',
      },
    }

    expect(await runGit(directory, ['ls-remote', url], opts)).toBe('')
    expect(challenges).toContain(
      createHash('sha256').update(`x-access-token:${token}`).digest('hex'),
    )

    token = 'fixture-2 replacement !@# København'
    answers.clear()
    answers.add(`x-access-token:${token}`)
    const replacementDigest = createHash('sha256').update(`x-access-token:${token}`).digest('hex')
    expect(await runGit(directory, ['ls-remote', url], opts)).toBe('')
    expect(challenges).toContain(replacementDigest)

    for (token of ['', null]) {
      await expect(runGit(directory, ['ls-remote', url], opts)).rejects.toThrow()
    }
  }, 30_000)

  it.skipIf(process.platform !== 'win32')(
    'persists and removes an exact credential through installed GCM and Windows Credential Manager',
    async () => {
      directory = await mkdtemp(join(tmpdir(), 'holi-gcm-auth-'))
      const config = join(directory, 'gitconfig')
      const target = `https://holi-${randomUUID()}.invalid/repo.git`
      const token = `synthetic-${randomUUID()}`
      const opts = {
        env: {
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: config,
          GCM_INTERACTIVE: 'never',
          GCM_CREDENTIAL_STORE: 'wincredman',
          GIT_TERMINAL_PROMPT: '0',
        },
        executionBudget: { maxBuffer: 1024 * 1024, timeout: 10_000 },
      }
      const request = (operation: 'approve' | 'fill' | 'reject') =>
        `protocol=https\nhost=${new URL(target).host}\npath=repo.git\nusername=x-access-token${operation === 'approve' ? `\npassword=${token}` : ''}\n\n`

      try {
        await runGit(directory, ['config', '--file', config, 'credential.helper', 'manager'], opts)
        await runGit(directory, ['credential', 'approve'], { ...opts, input: request('approve') })
        // Holi's token source is absent for all subsequent protocol operations.
        const filled = await runGit(directory, ['credential', 'fill'], {
          ...opts,
          token: () => null,
          input: request('fill'),
        })
        const fields = new Map(
          filled
            .trim()
            .split(/\r?\n/)
            .map((line) => {
              const separator = line.indexOf('=')
              return [line.slice(0, separator), line.slice(separator + 1)]
            }),
        )
        expect(
          fields.get('password') === token && fields.get('username') === 'x-access-token',
        ).toBe(true)
        await runGit(directory, ['credential', 'reject'], {
          ...opts,
          token: () => null,
          input: request('reject'),
        })
        await expect(
          runGit(directory, ['credential', 'fill'], {
            ...opts,
            token: () => null,
            input: request('fill'),
          }),
        ).rejects.toThrow()
      } finally {
        // Remove only this unique host/path credential, including on failed assertions.
        await runGit(directory, ['credential', 'reject'], {
          ...opts,
          token: () => null,
          input: request('reject'),
        })
      }
    },
  )
})
