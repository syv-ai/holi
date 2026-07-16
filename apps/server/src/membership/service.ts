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
import { config } from '../config'
import type { Db } from '../db/client'
import { memberships, users, vaults } from '../db/schema'
import type { SharedVaultId } from '../trpc'
import type { Role } from '@holi/shared'

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
  args: { vaultId: SharedVaultId; email: string; role: Role; invitedBy: string },
): Promise<{ userId: string }> {
  assertInvitableEmail(args.email)
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(users).where(eq(users.email, args.email))
    const user =
      existing ??
      (await tx
        .insert(users)
        .values({ googleSub: `pending:${args.email}`, email: args.email })
        .returning())[0]!
    await tx
      .insert(memberships)
      .values({ vaultId: args.vaultId, userId: user.id, role: args.role, invitedBy: args.invitedBy })
      .onConflictDoNothing()
    return { userId: user.id }
  })
}

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
  args: { vaultId: SharedVaultId; userId: string },
): Promise<void> {
  await assertNotLastOwner(db, args.vaultId, args.userId)
  await db
    .delete(memberships)
    .where(and(eq(memberships.vaultId, args.vaultId), eq(memberships.userId, args.userId)))
}

export async function leaveVault(
  db: Db,
  args: { vaultId: SharedVaultId; userId: string; role: Role },
): Promise<void> {
  if (args.role === 'owner') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'owner must transfer ownership first' })
  }
  await db
    .delete(memberships)
    .where(and(eq(memberships.vaultId, args.vaultId), eq(memberships.userId, args.userId)))
}

/** One-way: the outgoing owner is demoted in the same transaction, so the vault is never
 * ownerless and never briefly has two owners. */
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
