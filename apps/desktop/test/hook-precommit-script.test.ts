/**
 * The seeded `pre-commit`, driven as a real git hook.
 *
 * One script does two jobs, and they have opposite powers. The large-file guard
 * **vetoes** — git history is permanent and push is automatic, so an oversized
 * blob committed once is published to everyone, forever. The transforms
 * **never** veto: Holi's auto-commit is the user's save, and an opinion about
 * formatting does not outrank their words.
 *
 * The guarantee the whole design rests on is the exit code, so that is what
 * these assert, against a real `git commit`.
 */
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { installGitHook } from '../src/main/vault/large-files'

const exec = promisify(execFile)
const dirs: string[] = []

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-precommit-'))
  dirs.push(dir)
  await exec('git', ['init', '-b', 'main', dir])
  await exec('git', ['-C', dir, 'config', 'user.email', 'a@b.c'])
  await exec('git', ['-C', dir, 'config', 'user.name', 'Test'])
  return dir
}

/** Commit, and report the exit code plus stderr rather than throwing. */
async function commit(dir: string): Promise<{ code: number; stderr: string }> {
  try {
    const { stderr } = await exec('git', ['-C', dir, 'commit', '-m', 'x'])
    return { code: 0, stderr }
  } catch (error) {
    const e = error as { code?: number; stderr?: string }
    return { code: e.code ?? 1, stderr: e.stderr ?? '' }
  }
}

async function stage(dir: string, rel: string, text: string): Promise<void> {
  await mkdir(join(dir, rel, '..'), { recursive: true })
  await writeFile(join(dir, rel), text, 'utf8')
  await exec('git', ['-C', dir, 'add', rel])
}

describe('the installed script', () => {
  it('is executable, at .git/hooks/pre-commit', async () => {
    const dir = await repo()
    await installGitHook(dir, 1024)
    const mode = (await stat(join(dir, '.git/hooks/pre-commit'))).mode
    expect(mode & 0o111).not.toBe(0)
  })

  it('is never committed — .git/ is machine-local by construction', async () => {
    // The whole reason the hook lives here rather than in the tracked tree: a
    // teammate cannot push a pre-commit that runs on your laptop, because there
    // is no path by which this file travels.
    const dir = await repo()
    await installGitHook(dir, 1024)
    await stage(dir, 'a.md', '# a\n')
    await commit(dir)
    const { stdout } = await exec('git', ['-C', dir, 'ls-files'])
    expect(stdout).not.toContain('hooks/pre-commit')
  })
})

describe('the large-file guard still vetoes', () => {
  it('refuses a commit over the cap', async () => {
    const dir = await repo()
    await installGitHook(dir, 1024)
    await stage(dir, 'big.bin', 'x'.repeat(4096))

    const result = await commit(dir)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/refusing to commit/i)
  })

  it('lets an ordinary commit through', async () => {
    const dir = await repo()
    await installGitHook(dir, 1024)
    await stage(dir, 'a.md', '# small\n')
    expect((await commit(dir)).code).toBe(0)
  })
})

describe('the transform half never vetoes', () => {
  it('exits 0 when Holi is not running at all', async () => {
    // Committing from a terminal with the app closed is a normal thing to do.
    const dir = await repo()
    await installGitHook(dir, 1024)
    await stage(dir, 'a.md', '# a\n')
    expect((await commit(dir)).code).toBe(0)
  })

  it('exits 0 when the endpoint file points nowhere', async () => {
    const dir = await repo()
    await installGitHook(dir, 1024)
    await mkdir(join(dir, '.holi/state'), { recursive: true })
    // A stale endpoint from a previous run: the port is closed now.
    await writeFile(
      join(dir, '.holi/state/hook-endpoint.local.txt'),
      '1\nstale\n',
      'utf8',
    )
    await stage(dir, 'a.md', '# a\n')
    expect((await commit(dir)).code).toBe(0)
  })

  it('exits 0 when the endpoint file is junk', async () => {
    const dir = await repo()
    await installGitHook(dir, 1024)
    await mkdir(join(dir, '.holi/state'), { recursive: true })
    await writeFile(join(dir, '.holi/state/hook-endpoint.local.txt'), 'not an endpoint at all', 'utf8')
    await stage(dir, 'a.md', '# a\n')
    expect((await commit(dir)).code).toBe(0)
  })

  it('does not hang waiting for an unreachable Holi', async () => {
    // A commit that blocks for 30 seconds is a commit that failed, from the
    // user's point of view. The curl gets a hard timeout.
    const dir = await repo()
    await installGitHook(dir, 1024)
    await mkdir(join(dir, '.holi/state'), { recursive: true })
    await writeFile(
      join(dir, '.holi/state/hook-endpoint.local.txt'),
      '9\nx\n', // discard port: accepts, never answers
      'utf8',
    )
    await stage(dir, 'a.md', '# a\n')

    const started = Date.now()
    expect((await commit(dir)).code).toBe(0)
    expect(Date.now() - started).toBeLessThan(15_000)
  })
})

describe('it actually reaches Holi', () => {
  it('POSTs the commit to the endpoint, with the token', async () => {
    const dir = await repo()
    await installGitHook(dir, 1024)

    const hits: { url: string }[] = []
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        hits.push({ url: req.url ?? '' })
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"changed":[]}')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port

    try {
      await mkdir(join(dir, '.holi/state'), { recursive: true })
      await writeFile(
        join(dir, '.holi/state/hook-endpoint.local.txt'),
        `${port}\ntok-123\n`,
        'utf8',
      )
      await stage(dir, 'a.md', '# a\n')

      expect((await commit(dir)).code).toBe(0)
      expect(hits).toHaveLength(1)
      expect(hits[0]!.url).toContain('/hooks/pre-commit')
      expect(hits[0]!.url).toContain('t=tok-123')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('still exits 0 when Holi answers with an error', async () => {
    const dir = await repo()
    await installGitHook(dir, 1024)

    const server = createServer((req, res) => {
      req.resume()
      res.writeHead(500).end('everything is broken')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port

    try {
      await mkdir(join(dir, '.holi/state'), { recursive: true })
      await writeFile(
        join(dir, '.holi/state/hook-endpoint.local.txt'),
        `${port}\nx\n`,
        'utf8',
      )
      await stage(dir, 'a.md', '# a\n')
      expect((await commit(dir)).code).toBe(0)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
