import { createHash } from 'node:crypto'
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
    answers.add(`x-access-token:${token}`)
    const replacementDigest = createHash('sha256').update(`x-access-token:${token}`).digest('hex')
    expect(await runGit(directory, ['ls-remote', url], opts)).toBe('')
    expect(challenges).toContain(replacementDigest)

    for (token of ['', null]) {
      const before = challenges.length
      await expect(runGit(directory, ['ls-remote', url], opts)).rejects.toThrow()
      expect(challenges.length).toBeGreaterThan(before)
    }
    expect(challenges.join('')).not.toContain('fixture-')
  }, 30_000)
})
