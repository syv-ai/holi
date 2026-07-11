import { desc, eq } from 'drizzle-orm'
import { config } from '../config'
import type { Db } from '../db/client'
import { yjsSnapshots } from '../db/schema'

export type SnapshotReason =
  | 'interval'
  | 'manual'
  | 'pre-rename'
  | 'pre-agent-write'
  | 'pre-offline-merge'
  | 'pre-reconcile'
  | 'pre-restore'

export interface SnapshotArgs {
  docId: string
  state: Uint8Array
  reason: SnapshotReason
  label?: string
  authorId?: string
}

/** Risky-op snapshots are unconditional (D26) — always call this directly for those. */
export async function takeSnapshot(db: Db, args: SnapshotArgs): Promise<void> {
  await db.insert(yjsSnapshots).values({
    docId: args.docId,
    state: args.state,
    reason: args.reason,
    label: args.label,
    authorId: args.authorId,
  })
}

/** Interval policy (documented stub #3): snapshot on store iff the newest
 * snapshot is older than snapshotIntervalMs. */
export async function maybeIntervalSnapshot(
  db: Db,
  docId: string,
  state: Uint8Array,
  authorId?: string,
  now = new Date(),
): Promise<boolean> {
  const [latest] = await db
    .select({ takenAt: yjsSnapshots.takenAt })
    .from(yjsSnapshots)
    .where(eq(yjsSnapshots.docId, docId))
    .orderBy(desc(yjsSnapshots.takenAt))
    .limit(1)
  if (latest && now.getTime() - latest.takenAt.getTime() < config.snapshotIntervalMs) return false
  await takeSnapshot(db, { docId, state, reason: 'interval', authorId })
  return true
}
