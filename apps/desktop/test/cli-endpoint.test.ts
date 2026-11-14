import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { publishCliEndpoint } from '../src/main/bridge/cli-endpoint'

let dir: string
let path: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holi-cli-endpoint-'))
  path = join(dir, 'cli-endpoint.json')
})
afterEach(async () => rm(dir, { recursive: true, force: true }))

const privateMode = (mode: number) => process.platform === 'win32' || (mode & 0o777) === 0o600

describe('publishCliEndpoint', () => {
  it('publishes a private JSON loopback descriptor with a fresh credential', async () => {
    const endpoint = await publishCliEndpoint(path, 4312)
    const stored = JSON.parse(await readFile(path, 'utf8'))
    expect(stored).toEqual({ host: '127.0.0.1', port: 4312, token: endpoint.token })
    expect(endpoint.token).toMatch(/^[0-9a-f]{64}$/)
    expect(privateMode((await lstat(path)).mode)).toBe(true)
    const next = await publishCliEndpoint(path, 4312)
    expect(next.token).not.toBe(endpoint.token)
    await next.dispose()
  })

  it.each([0, -1, 65536, 1.5, Number.NaN, '80'])('rejects invalid port %s', async (port) => {
    await expect(publishCliEndpoint(path, port as number)).rejects.toThrow(/port/)
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects non-normal paths and unsafe destination entries', async () => {
    await expect(publishCliEndpoint(`${dir}/../x`, 80)).rejects.toThrow(/absolute normalized/)
    await mkdir(path)
    await expect(publishCliEndpoint(path, 80)).rejects.toThrow(/unsafe/)
    await rm(path, { recursive: true })
    const target = join(dir, 'target')
    await writeFile(target, 'leave alone')
    await symlink(target, path)
    await expect(publishCliEndpoint(path, 80)).rejects.toThrow(/unsafe/)
    expect(await readFile(target, 'utf8')).toBe('leave alone')
  })

  it('rejects a public-permission destination without changing it', async () => {
    if (process.platform === 'win32') return
    await writeFile(path, 'existing', { mode: 0o644 })
    await expect(publishCliEndpoint(path, 80)).rejects.toThrow(/not private/)
    expect(await readFile(path, 'utf8')).toBe('existing')
  })

  it('only removes its own descriptor during disposal', async () => {
    const first = await publishCliEndpoint(path, 1001)
    const newer = await publishCliEndpoint(path, 1002)
    await first.dispose()
    expect(JSON.parse(await readFile(path, 'utf8')).port).toBe(1002)
    await newer.dispose()
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes the descriptor on shutdown and leaves a replacement alone', async () => {
    const endpoint = await publishCliEndpoint(path, 2000)
    await endpoint.dispose()
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    const replaced = await publishCliEndpoint(path, 2001)
    await writeFile(path, 'new owner', { mode: 0o600 })
    await replaced.dispose()
    expect(await readFile(path, 'utf8')).toBe('new owner')
  })

  it('cleans temporary files when publication cannot open its destination directory', async () => {
    const missingPath = join(dir, 'missing', 'descriptor.json')
    await expect(publishCliEndpoint(missingPath, 3000)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(dir)).toEqual([])
  })
})
