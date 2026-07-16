/**
 * Daily notes — get-or-create, and the archive/GC sweep.
 *
 * A daily note is a Doc, not a file write, so "make today's daily note" is an
 * idempotent server-arbitrated upsert. The unique `(vault_id, path)` index
 * (`docs_vault_path_idx`) **is** the idempotency guarantee: the path is deterministic
 * per date, so two of your devices activating at 09:00 race on the index and the loser
 * reads the winner's row. The old repo's `readFile`-then-`writeFile` was a TOCTOU that
 * survived only because vaults were single-device; its client-side promise cache is kept
 * as a round-trip optimization but is no longer the correctness boundary.
 *
 * Both ops take the caller's `localDate` (D44) — the server never computes "today",
 * because it cannot know the caller's timezone. A personal vault has exactly one owner
 * and therefore exactly one clock, and that clock is on the device.
 */
import { and, eq } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'
import * as Y from 'yjs'
import {
  YDOC_TEXT_KEY,
  buildDailyNoteContent,
  dailyNoteFilename,
  isUntouchedDailyNote,
  type VaultRelPath,
} from '@holi/shared'
import type { Db } from '../db/client'
import { toDocMeta } from '../db/mappers'
import { docs, linkIndex, vaults, yjsDocs } from '../db/schema'
import { safePath } from '../paths'
import { docFromState, docText, loadDocState } from '../yjs/doc-store'
import { renameNote, type RenameDeps } from '../yjs/rename'

/** Daily notes are personal-vault-only by design. The guard is what makes "one owner,
 * one clock" true rather than aspirational: in a shared vault, whose midnight is it? */
async function assertPersonalVault(db: Db, vaultId: string): Promise<void> {
  const [vault] = await db.select({ kind: vaults.kind }).from(vaults).where(eq(vaults.id, vaultId))
  if (!vault) throw new TRPCError({ code: 'NOT_FOUND', message: 'no such vault' })
  if (vault.kind !== 'personal') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'daily notes exist only in a personal vault',
    })
  }
}

/** `dailyNoteFilename` throws on a date that isn't real; surface that as BAD_REQUEST
 * rather than a 500 — the date is client input. */
function dailyPath(localDate: string): VaultRelPath {
  try {
    return safePath(dailyNoteFilename(localDate))
  } catch (err) {
    if (err instanceof TRPCError) throw err
    throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message })
  }
}

function seedState(localDate: string): Uint8Array {
  const ydoc = new Y.Doc()
  ydoc.getText(YDOC_TEXT_KEY).insert(0, buildDailyNoteContent(localDate))
  return Y.encodeStateAsUpdate(ydoc)
}

export async function getOrCreateDaily(
  deps: Pick<RenameDeps, 'db' | 'bus'>,
  args: { vaultId: string; localDate: string },
): Promise<{ docId: string; path: string; created: boolean }> {
  const { db, bus } = deps
  await assertPersonalVault(db, args.vaultId)
  const path = dailyPath(args.localDate)

  const { row, created } = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(docs)
      .values({ vaultId: args.vaultId, path, kind: 'daily' })
      .onConflictDoNothing()
      .returning()
    if (!inserted) {
      // The index arbitrated and we lost (or it simply already existed) — adopt the
      // winner's row. Deliberately NOT re-seeded: it may be a note you wrote in, and
      // a doc a native tool created at this path is adopted as-is.
      //
      // This SELECT is guaranteed to find the row only under READ COMMITTED (the
      // default): a losing ON CONFLICT DO NOTHING blocks on the conflicting key until
      // the winner commits, and the SELECT then takes a *fresh* snapshot that includes
      // it. Under REPEATABLE READ the statement would reuse the transaction's opening
      // snapshot, miss the winner, and return nothing. Don't raise the isolation here.
      const [existing] = await tx
        .select()
        .from(docs)
        .where(and(eq(docs.vaultId, args.vaultId), eq(docs.path, path)))
      if (!existing) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `lost ${path} after conflict` })
      }
      return { row: existing, created: false }
    }
    // The seed is the Doc's initial CRDT state, not a post-create edit. No
    // link_index refresh: the seed is a constant and contains no [[links]].
    await tx.insert(yjsDocs).values({ docId: inserted.id, state: seedState(args.localDate) })
    return { row: inserted, created: true }
  })

  if (created) bus.emitDocs(args.vaultId, { type: 'created', doc: toDocMeta(row) })
  return { docId: row.id, path: row.path, created }
}

async function hasBackrefs(db: Db, vaultId: string, path: string): Promise<boolean> {
  const [ref] = await db
    .select({ srcDocId: linkIndex.srcDocId })
    .from(linkIndex)
    .where(and(eq(linkIndex.vaultId, vaultId), eq(linkIndex.targetPath, path)))
    .limit(1)
  return ref !== undefined
}

/**
 * Archive prior-day dailies into `journal/` and delete untouched stubs. Idempotent —
 * it runs on every activation, and the root-level filter is what makes a re-run a no-op
 * (anything already under `journal/` is skipped).
 *
 * Selects on `kind='daily'`, never on filename shape (D46): `kind` is written only by
 * `getOrCreateDaily`, so a hand-authored note that merely looks like a date is never
 * swept — and never deleted as an "untouched stub".
 */
export async function sweepDaily(
  deps: RenameDeps,
  args: { vaultId: string; localDate: string; authorId: string },
): Promise<{ archived: number; deleted: number }> {
  const { db, bus } = deps
  await assertPersonalVault(db, args.vaultId)
  const todayFile = dailyPath(args.localDate)

  const candidates = await db
    .select()
    .from(docs)
    .where(and(eq(docs.vaultId, args.vaultId), eq(docs.kind, 'daily')))

  let archived = 0
  let deleted = 0
  for (const doc of candidates) {
    if (doc.path.includes('/')) continue // already archived
    if (doc.path === todayFile) continue // today's note is never swept
    try {
      // The stub test compares against *this note's own* seeded title, not today's.
      const stem = doc.path.replace(/\.md$/, '')
      const text = docText(docFromState(await loadDocState(db, doc.id)))

      // The backref guard is load-bearing and new: the old sweep deleted stubs freely
      // because an orphan-rescue dialog healed the dangling refs afterwards. That
      // machinery is not ported (it served `source_file`), so there is no net — a
      // referenced-but-empty daily note is kept, and archived like any other.
      if (isUntouchedDailyNote(text, stem) && !(await hasBackrefs(db, args.vaultId, doc.path))) {
        const [row] = await db.delete(docs).where(eq(docs.id, doc.id)).returning()
        if (row) {
          bus.emitDocs(args.vaultId, { type: 'deleted', doc: toDocMeta(row) })
          deleted++
        }
        continue
      }

      // Reuse the one rename op: it rewrites every [[link]] to follow the move,
      // snapshots, refreshes link_index and creates `journal/`. No bespoke path.
      await renameNote(deps, {
        vaultId: args.vaultId,
        docId: doc.id,
        newPath: safePath(`journal/${doc.path}`),
        authorId: args.authorId,
      })
      archived++
    } catch (err) {
      // One unsweepable note must not abort the sweep for the rest (ported ergonomics).
      // The next activation retries it — the whole op is idempotent.
      console.warn(`[daily] best-effort sweep failed for ${doc.path}:`, err)
    }
  }
  return { archived, deleted }
}
