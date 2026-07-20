/**
 * Renderer read-through cache (D59, slice 2b) — the last mile of offline.
 *
 * Slice 2a made main's *mirror* survive offline: it persists every doc's Yjs state and can
 * `start()` with no relay. But the renderer never gets that far, because every query it
 * makes — the vault switcher, the file tree — goes over tRPC to the server. Offline,
 * `vaults.list` throws `fetch failed`, so no vault is ever activated, the mirror never
 * starts, and the tree reads "no notes yet". Persistence alone could not be reached from
 * the UI. (Unit tests could not catch this: they call `mirror.start()` directly and skip
 * the renderer path entirely. Only live verification found it.)
 *
 * Every renderer query already routes through main (`ipc.ts` `holi:trpc` → `callProcedure`),
 * so main is the natural place for a read-through cache: on a successful query, cache the
 * answer; when the server is unreachable, serve the last cached answer instead of throwing.
 *
 * **Deliberately tiny surface (Nicolai, 2026-07-20).** Only the two queries on the offline
 * critical path are cached — `vaults.list` (the switcher) and `vaults.listDocs` (the tree).
 * A blanket "cache every query" was rejected: mutations must never be cached (a replayed
 * stale success is a phantom write), and other reads are meaningless or misleading offline.
 *
 * **Staleness is not marked in the envelope.** The sync indicator already reads "offline"
 * from main's relay status (slice 1); that is the single source of truth. Cached data flows
 * in silently and the indicator tells the user why it might be stale — one signal, not two
 * that can drift.
 *
 * Same fs discipline as its sibling `doc-store.ts`: one file per key, tmp+rename so a crash
 * mid-write can never tear a file, and `null`/passthrough on any failure — a broken cache
 * degrades to "the query failed", never takes anything down.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TrpcOp } from './server-client'

/** The offline critical path, and nothing else. Both are pure reads that render the shell:
 * the switcher and the file tree. Everything else fails honestly offline. */
const CACHEABLE = new Set(['vaults.list', 'vaults.listDocs'])

/** Logical cache key: path + input. `vaults.listDocs` is keyed per vaultId by its input;
 * `vaults.list` takes none. Inputs on the allowlist are shallow, so `JSON.stringify` is a
 * stable key here — the store hashes it into a filesystem-safe name. */
export function cacheKey(op: TrpcOp): string {
  return `${op.path}:${JSON.stringify(op.input ?? null)}`
}

export class TrpcCache {
  constructor(private readonly dir: string) {}

  private file(key: string): string {
    return join(this.dir, `${createHash('sha1').update(key).digest('hex')}.json`)
  }

  /** `null` = miss OR unreadable. Neither cached payload (Vault[] / {docs,folders}) is ever
   * legitimately `null`, and the cache is only consulted after a live call already failed,
   * so conflating the two is safe — and matches DocStore/DocListStore's null-on-any-failure. */
  async load(key: string): Promise<unknown | null> {
    try {
      const raw = JSON.parse(await readFile(this.file(key), 'utf8')) as { data: unknown }
      return raw.data ?? null
    } catch {
      return null
    }
  }

  async save(key: string, data: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const tmp = join(this.dir, `.tmp-${randomBytes(6).toString('hex')}`)
    await writeFile(tmp, JSON.stringify({ data }), 'utf8')
    await rename(tmp, this.file(key))
  }
}

/** A tRPC error that reached the server carries a `data.code` (UNAUTHORIZED, NOT_FOUND, …);
 * `toEnvelope` reads the same field. Its ABSENCE means the request got no answer at all —
 * the server is unreachable, the one case the cache exists for. A coded error is real and
 * must be surfaced, never masked with stale data. */
function isTransportFailure(err: unknown): boolean {
  return (err as { data?: { code?: string } } | null)?.data?.code == null
}

/**
 * Read-through: cache the two critical queries on success, serve them on a transport
 * failure. Everything else — mutations, non-allowlisted reads — passes straight through.
 *
 * `call` is injected (the bound `callProcedure`) so this stays a pure, headless-testable
 * unit: the whole offline win is one branch here, and it must be able to fail a test.
 */
export async function readThrough(
  op: TrpcOp,
  call: (op: TrpcOp) => Promise<unknown>,
  cache: TrpcCache,
): Promise<unknown> {
  if (op.type !== 'query' || !CACHEABLE.has(op.path)) return call(op)
  const key = cacheKey(op)
  try {
    const data = await call(op)
    try {
      await cache.save(key, data)
    } catch {
      // A cache write must never fail a live query. Worst case: the next offline read is
      // one revision staler than it could have been.
    }
    return data
  } catch (err) {
    if (isTransportFailure(err)) {
      const cached = await cache.load(key)
      if (cached !== null) return cached
    }
    throw err
  }
}
