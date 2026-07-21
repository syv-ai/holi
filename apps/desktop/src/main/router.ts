/**
 * The router — main's typed API, and the seam the renderer calls.
 *
 * It used to proxy to the Syv server; it now reads and writes the clone. The
 * *shape* survives that change on purpose (architecture §9): the renderer keeps
 * calling a typed router over IPC, so the pivot is an implementation swap rather
 * than a rewrite of every call site. The signatures do change — identity is a
 * path now, not a `docId` — and that is the part call sites feel.
 *
 * There is deliberately **no authorization here**, and there must never be one:
 * with no server, a check running on the machine of the person it restricts is
 * theatre. GitHub decides what leaves, at push time (auth PRD §Access model).
 */
import { readFile } from 'node:fs/promises'
import { initTRPC, TRPCError } from '@trpc/server'
import { vaultRelPath, type VaultEntry, type VaultRelPath } from '@holi/shared'
import { removeDocFile, writeAtomic, absPathFor } from './vault/vault-files'
import { scanVault, type VaultSnapshot } from './vault/vault-store'
import type { VaultRegistry } from './vault/registry'

const t = initTRPC.create()

export interface RouterDeps {
  registry: VaultRegistry
  /** Wall-clock, injected so `lastOpenedAt` is testable. */
  now?: () => string
}

/** A tiny validator, so the router keeps its input contract without pulling in a
 * schema library for four shapes. Each one throws on anything it did not ask
 * for; tRPC turns that into a BAD_REQUEST. */
function fields<T extends Record<string, 'string' | 'string?'>>(spec: T) {
  return (raw: unknown): { [K in keyof T]: T[K] extends 'string?' ? string | undefined : string } => {
    if (raw === null || typeof raw !== 'object') throw new Error('input must be an object')
    const input = raw as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, kind] of Object.entries(spec)) {
      const value = input[key]
      if (value === undefined || value === null) {
        if (kind === 'string?') continue
        throw new Error(`${key} is required`)
      }
      if (typeof value !== 'string') throw new Error(`${key} must be a string`)
      out[key] = value
    }
    return out as never
  }
}

export function createRouter(deps: RouterDeps) {
  const now = deps.now ?? (() => new Date().toISOString())

  /** remote -> the clone's root on this machine. Every path-taking procedure
   * goes through here, so an unknown vault fails once, in one place. */
  async function rootFor(remote: string): Promise<string> {
    const entry = (await deps.registry.list()).find((e) => e.remote === remote)
    if (!entry) throw new TRPCError({ code: 'NOT_FOUND', message: `no such vault: ${remote}` })
    return entry.path
  }

  /** Every path from the renderer or the agent re-validates here. This is the
   * only thing between an input and the user's filesystem now that server-side
   * authorization is gone (architecture §10). */
  function safe(path: string): VaultRelPath {
    try {
      return vaultRelPath(path)
    } catch (err) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message })
    }
  }

  const vaults = t.router({
    list: t.procedure.query((): Promise<VaultEntry[]> => deps.registry.list()),

    open: t.procedure
      .input(fields({ remote: 'string' }))
      .mutation(async ({ input }): Promise<VaultSnapshot> => {
        const root = await rootFor(input.remote)
        await deps.registry.touch(input.remote, now())
        return scanVault(root)
      }),

    snapshot: t.procedure
      .input(fields({ remote: 'string' }))
      .query(async ({ input }): Promise<VaultSnapshot> => scanVault(await rootFor(input.remote))),

    remove: t.procedure
      .input(fields({ remote: 'string' }))
      // Deregisters the vault; the clone stays on disk. Deleting someone's files
      // — which may hold unpublished commits — is never a side effect here.
      .mutation(({ input }) => deps.registry.remove(input.remote)),
  })

  const notes = t.router({
    read: t.procedure
      .input(fields({ remote: 'string', path: 'string' }))
      .query(async ({ input }): Promise<string> => {
        const abs = absPathFor(await rootFor(input.remote), safe(input.path))
        const text = await readFile(abs, 'utf8').catch(() => null)
        if (text === null) throw new TRPCError({ code: 'NOT_FOUND', message: input.path })
        return text
      }),

    write: t.procedure
      .input(fields({ remote: 'string', path: 'string', text: 'string' }))
      .mutation(async ({ input }) => {
        await writeAtomic(await rootFor(input.remote), safe(input.path), input.text)
        return { ok: true as const }
      }),

    create: t.procedure
      .input(fields({ remote: 'string', path: 'string', text: 'string?' }))
      .mutation(async ({ input }) => {
        const root = await rootFor(input.remote)
        const rel = safe(input.path)
        // Refuse rather than overwrite: "create" that clobbers an existing note
        // is indistinguishable from losing it.
        const existing = await readFile(absPathFor(root, rel), 'utf8').catch(() => null)
        if (existing !== null) {
          throw new TRPCError({ code: 'CONFLICT', message: `already exists: ${rel}` })
        }
        await writeAtomic(root, rel, input.text ?? '')
        return { path: rel }
      }),

    delete: t.procedure
      .input(fields({ remote: 'string', path: 'string' }))
      .mutation(async ({ input }) => {
        await removeDocFile(await rootFor(input.remote), safe(input.path))
        return { ok: true as const }
      }),
  })

  return t.router({ vaults, notes })
}

export type AppRouter = ReturnType<typeof createRouter>
