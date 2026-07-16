/**
 * The one place a membership changes (the `tasks/mutations.ts` shape, D35).
 *
 * Every mutation here takes a **`SharedVaultId`** — a brand only `sharedVaultProcedure`
 * can produce (D49). That is the point of this module existing at all: with the logic
 * inline in the router, "did you remember the vault-kind check?" was a code-review
 * question, and the answer was no twice — `invite` and `transferOwnership` shipped
 * without it, so you could invite a stranger into your personal vault or hand it away.
 * Now an op that skips the check cannot call these functions.
 *
 * The logic itself is unchanged and was already correct; only its reachability was wrong.
 */
import { and, eq, ne } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'
import type { Bus } from '../bus'
import { config } from '../config'
import type { Db } from '../db/client'
import { memberships, users, vaults } from '../db/schema'
import type { SharedVaultId } from '../trpc'
import type { Role } from '@holi/shared'

/**
 * The only place a `memberships` row appears or disappears (D51) — including from
 * `vaults.create` and `provisionPersonalVault`, which write one without going near the
 * rest of this module.
 *
 * Both return the affected userId, or **null when the table did not actually change**:
 * a re-invite hits `onConflictDoNothing`, and a frame saying "you joined" when you were
 * already a member is a frame that lies. (Same rule `getOrCreateDaily` follows before
 * emitting `docs:created` — only on a real mint.)
 *
 * **They take no `Bus`, and must not.** The caller emits, *after* its transaction
 * commits: the bus is an in-process EventEmitter with no transactional semantics, so an
 * emit inside a tx announces a membership that can still roll back — and worse, a
 * listener that reacts by reading the user's vaults (which is exactly what the SSE
 * handler does, to re-key) would not see the uncommitted row and would skip the vault it
 * was just told about. `await db.transaction(...)` resolving *is* the commit, so
 * emitting on the far side of it is correct by construction. That is the whole reason
 * the emit lives in the callers and not in here, and why adding a `Bus` parameter to
 * these two would be a mistake rather than a tidy-up.
 */
export async function insertMembershipRow(
  db: Pick<Db, 'insert'>,
  values: { vaultId: string; userId: string; role: Role; invitedBy?: string },
): Promise<string | null> {
  const [row] = await db
    .insert(memberships)
    .values(values)
    .onConflictDoNothing()
    .returning({ userId: memberships.userId })
  return row?.userId ?? null
}

export async function deleteMembershipRow(
  db: Pick<Db, 'delete'>,
  vaultId: string,
  userId: string,
): Promise<string | null> {
  const [row] = await db
    .delete(memberships)
    .where(and(eq(memberships.vaultId, vaultId), eq(memberships.userId, userId)))
    .returning({ userId: memberships.userId })
  return row?.userId ?? null
}

/** FR-10: invites are domain-restricted, to the *same* workspace sign-in enforces via
 * `assertWorkspace` — one knob, so the two can never disagree about who is allowed in.
 * Unset ⇒ unrestricted, matching `assertWorkspace`: the var is unset in dev by design,
 * and a hardcoded `@syv.ai` would fail every local invite while reading as correct. */
function assertInvitableEmail(email: string): void {
  const domain = config.google.workspaceDomain
  if (!domain) return
  if (email.toLowerCase().split('@')[1] !== domain.toLowerCase()) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `invites are restricted to @${domain} — Holi is Syv-only`,
    })
  }
}

/**
 * Invite by email. Idempotent: re-inviting an existing member is a no-op, not a duplicate.
 *
 * The `pending:` stub user is load-bearing, not a shortcut — someone who has never signed
 * in gets a `users` row now, claimed by email on their first Google sign-in
 * (`upsertGoogleUser`). It is what makes "invite someone who has never opened Holi" work
 * without a separate invites table and a second claim path.
 */
export async function inviteMember(
  db: Db,
  bus: Bus,
  args: { vaultId: SharedVaultId; email: string; role: Role; invitedBy: string },
): Promise<{ userId: string }> {
  assertInvitableEmail(args.email)
  const { userId, joined } = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(users).where(eq(users.email, args.email))
    const user =
      existing ??
      (await tx
        .insert(users)
        .values({ googleSub: `pending:${args.email}`, email: args.email })
        .returning())[0]!
    const joined = await insertMembershipRow(tx, {
      vaultId: args.vaultId,
      userId: user.id,
      role: args.role,
      invitedBy: args.invitedBy,
    })
    return { userId: user.id, joined }
  })
  // After the commit, and only on a real insert — re-inviting an existing member is a
  // documented no-op, not a re-join.
  if (joined) bus.emitMembership(joined, { type: 'joined', vaultId: args.vaultId })
  return { userId }
}

/** Takes no `Bus` on purpose (D51): a role change is neither a join nor a leave, the
 * vault *list* does not render role, and the Members panel refetches on its own
 * mutations. The absent parameter is the statement — there is nothing here to forget. */
export async function setMemberRole(
  db: Db,
  args: { vaultId: SharedVaultId; userId: string; role: Role },
): Promise<void> {
  if (args.role === 'member') await assertNotLastOwner(db, args.vaultId, args.userId)
  await db
    .update(memberships)
    .set({ role: args.role })
    .where(and(eq(memberships.vaultId, args.vaultId), eq(memberships.userId, args.userId)))
}

export async function removeMember(
  db: Db,
  bus: Bus,
  args: { vaultId: SharedVaultId; userId: string },
): Promise<void> {
  await assertNotLastOwner(db, args.vaultId, args.userId)
  const left = await deleteMembershipRow(db, args.vaultId, args.userId)
  if (left) bus.emitMembership(left, { type: 'left', vaultId: args.vaultId })
}

export async function leaveVault(
  db: Db,
  bus: Bus,
  args: { vaultId: SharedVaultId; userId: string; role: Role },
): Promise<void> {
  if (args.role === 'owner') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'owner must transfer ownership first' })
  }
  const left = await deleteMembershipRow(db, args.vaultId, args.userId)
  if (left) bus.emitMembership(left, { type: 'left', vaultId: args.vaultId })
}

/** One-way: the outgoing owner is demoted in the same transaction, so the vault is never
 * ownerless and never briefly has two owners.
 *
 * No `Bus` either (D51) — this only ever *updates* rows. Both parties are members before
 * and after; nobody's vault list changes. */
export async function transferOwnership(
  db: Db,
  args: { vaultId: SharedVaultId; fromUserId: string; toUserId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.vaultId, args.vaultId), eq(memberships.userId, args.toUserId)))
    if (!target) throw new TRPCError({ code: 'BAD_REQUEST', message: 'target is not a member' })
    await tx
      .update(memberships)
      .set({ role: 'owner' })
      .where(and(eq(memberships.vaultId, args.vaultId), eq(memberships.userId, args.toUserId)))
    await tx
      .update(memberships)
      .set({ role: 'member' })
      .where(and(eq(memberships.vaultId, args.vaultId), eq(memberships.userId, args.fromUserId)))
    await tx.update(vaults).set({ ownerId: args.toUserId }).where(eq(vaults.id, args.vaultId))
  })
}

/** Not the personal-vault guard, though it has been mistaken for one: this blocks
 * removing or demoting the last owner of *any* vault, and must survive independently
 * of D49. */
async function assertNotLastOwner(db: Db, vaultId: string, userId: string): Promise<void> {
  const others = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(
      and(eq(memberships.vaultId, vaultId), eq(memberships.role, 'owner'), ne(memberships.userId, userId)),
    )
  if (others.length === 0) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'cannot remove the last owner' })
  }
}
