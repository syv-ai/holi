import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { TrpcCache, readThrough } from '../src/main/trpc-cache'
import type { TrpcOp } from '../src/main/server-client'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

async function cache(): Promise<TrpcCache> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-tc-'))
  dirs.push(dir)
  return new TrpcCache(dir)
}

const listOp: TrpcOp = { path: 'vaults.list', type: 'query', input: undefined }
const docsOp = (vaultId: string): TrpcOp => ({
  path: 'vaults.listDocs',
  type: 'query',
  input: { vaultId },
})

/** A tRPC error that reached the server carries a `data.code`; a transport failure — the
 * server never answered — does not. The cache exists for the latter only. */
const transportErr = (): Error => new Error('fetch failed')
const codedErr = (code: string): Error => Object.assign(new Error('server said no'), { data: { code } })

describe('TrpcCache', () => {
  it('round-trips a cached value', async () => {
    const c = await cache()
    await c.save('vaults.list', [{ id: 'v1' }])
    expect(await c.load('vaults.list')).toEqual([{ id: 'v1' }])
  })

  it('is null for a key it has never seen', async () => {
    expect(await (await cache()).load('vaults.list')).toBeNull()
  })

  // An unreadable cache must degrade to "the query just failed", never throw and turn a
  // recoverable offline read into a crash.
  it('is null — never a throw — on a corrupt file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'holi-tc-'))
    dirs.push(dir)
    const c = new TrpcCache(dir)
    await c.save('vaults.list', [{ id: 'v1' }])
    const [file] = await readdir(dir)
    await writeFile(join(dir, file), 'not json at all', 'utf8')
    expect(await c.load('vaults.list')).toBeNull()
  })

  // vaults.listDocs is keyed by vaultId; two vaults must not clobber each other's tree.
  it('keys by input so two vaults do not collide', async () => {
    const c = await cache()
    await c.save('vaults.listDocs:{"vaultId":"a"}', { docs: [{ id: 'da' }], folders: [] })
    await c.save('vaults.listDocs:{"vaultId":"b"}', { docs: [{ id: 'db' }], folders: [] })
    expect(await c.load('vaults.listDocs:{"vaultId":"a"}')).toEqual({ docs: [{ id: 'da' }], folders: [] })
    expect(await c.load('vaults.listDocs:{"vaultId":"b"}')).toEqual({ docs: [{ id: 'db' }], folders: [] })
  })
})

describe('readThrough', () => {
  // The whole point: an online success seeds the cache; the next offline read serves it.
  it('caches a cacheable query and serves it when the server is unreachable', async () => {
    const c = await cache()
    const live = [{ id: 'v1' }]
    expect(await readThrough(listOp, async () => live, c)).toEqual(live)
    expect(await readThrough(listOp, async () => { throw transportErr() }, c)).toEqual(live)
  })

  it('serves the per-vault doc list from cache offline', async () => {
    const c = await cache()
    const tree = { docs: [{ id: 'd1', path: 'a.md' }], folders: [] }
    await readThrough(docsOp('v1'), async () => tree, c)
    expect(await readThrough(docsOp('v1'), async () => { throw transportErr() }, c)).toEqual(tree)
  })

  it('rethrows a transport failure when nothing is cached', async () => {
    const c = await cache()
    await expect(readThrough(listOp, async () => { throw transportErr() }, c)).rejects.toThrow('fetch failed')
  })

  // A read that is not on the offline critical path is passed straight through and never
  // cached — so offline it fails honestly rather than serving stale data.
  it('passes a non-allowlisted query through and does not cache it', async () => {
    const c = await cache()
    const op: TrpcOp = { path: 'notes.backrefs', type: 'query', input: { vaultId: 'v', path: 'a' } }
    expect(await readThrough(op, async () => [{ srcDocId: 'x' }], c)).toEqual([{ srcDocId: 'x' }])
    await expect(readThrough(op, async () => { throw transportErr() }, c)).rejects.toThrow('fetch failed')
  })

  // Mutations must NEVER be cached: a stale success replayed offline would be a phantom
  // write. Even a mutation on an allowlisted path must not seed the query cache.
  it('never caches a mutation, even on an allowlisted path', async () => {
    const c = await cache()
    await readThrough({ path: 'vaults.list', type: 'mutation', input: undefined }, async () => ['written'], c)
    await expect(readThrough(listOp, async () => { throw transportErr() }, c)).rejects.toThrow('fetch failed')
  })

  // A coded error means the server DID answer (auth expired, not found, …). Masking it
  // with stale data is the class of lie this whole cluster exists to kill — surface it.
  it('does not mask a coded server error with stale cache', async () => {
    const c = await cache()
    await readThrough(listOp, async () => [{ id: 'v1' }], c)
    await expect(
      readThrough(listOp, async () => { throw codedErr('UNAUTHORIZED') }, c),
    ).rejects.toMatchObject({ data: { code: 'UNAUTHORIZED' } })
  })

  // A cache write failing (disk full, permissions) must never fail an otherwise-live query.
  it('a cache-write failure does not fail a live query', async () => {
    const broken = {
      save: async () => { throw new Error('disk full') },
      load: async () => null,
    } as unknown as TrpcCache
    expect(await readThrough(listOp, async () => [{ id: 'v1' }], broken)).toEqual([{ id: 'v1' }])
  })
})
