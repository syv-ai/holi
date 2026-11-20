import {
  UnconfirmedOwnedProgramError,
  type OwnedProgramCleanupLease,
} from '../../../../main/plugin-api'
import type { ClaudeCli } from '../claude/cli'
import type { ClaudeRow } from '../claude/listing'
import type { createLateSessionCleanup } from './late-session-cleanup'
import type { AgentTerminals } from './terminals'

export type CliCreation = Awaited<ReturnType<ClaudeCli['startBg']>>
type CreatedSession = Extract<CliCreation, { ok: true }>
export type Failure = { ok: false; message: string; error?: Error; cleanupUnconfirmed?: never }
export type Unconfirmed = {
  ok: false
  message: string
  cleanupUnconfirmed: true
  error: Error
  sessionId?: string
  missingProviderReceipt?: true
}

/** The session host's inventory, not a second listing or a current-vault lookup. */
interface LaunchInventory {
  rows: readonly ClaudeRow[]
  listed: ReadonlySet<string>
  pending: Set<string>
  uncertain: Map<string, Unconfirmed>
  acting: ReadonlySet<string>
  unpublished: Set<string>
  unprompted: Set<string>
  revision: number
}

export function unconfirmed(
  cause: unknown,
  sessionId: string,
  lease?: CreatedSession['lease'],
  commandError?: Error,
): Unconfirmed {
  const error =
    cause instanceof UnconfirmedOwnedProgramError && (lease === undefined || lease === cause.lease)
      ? cause
      : lease === undefined
        ? cause instanceof Error
          ? cause
          : new Error(String(cause))
        : new UnconfirmedOwnedProgramError(cause, lease, commandError)
  return {
    ok: false,
    message: `Cleanup unconfirmed: session ${sessionId} may still be running.`,
    cleanupUnconfirmed: true,
    sessionId,
    error,
  }
}

/** Admission policy for receipts from one provider and one vault activation.
 * The host owns discovery, reservation and publication. This module queues
 * discovery, rejects collisions on their own lease and fences uncertainty. */
export function createClaudeLaunchAdmission(
  inventory: LaunchInventory,
  lateCleanup: ReturnType<typeof createLateSessionCleanup>,
  terminals: Pick<AgentTerminals, 'launchedFor'>,
  signal: AbortSignal,
) {
  type Release = () => void
  const waiters = new Set<(release: Release | null) => void>()
  let admitting = false
  signal.addEventListener(
    'abort',
    () => {
      for (const waiter of waiters) waiter(null)
      waiters.clear()
    },
    { once: true },
  )

  function release(): void {
    const next = waiters.values().next().value
    if (next === undefined) {
      admitting = false
      return
    }
    waiters.delete(next)
    next(release)
  }

  /** Take a turn until the receipt is published or cleanup has settled. A
   * waiting request owns no process and can leave without joining the holder. */
  async function acquire(): Promise<Release | null> {
    if (signal.aborted) return null
    if (admitting) return new Promise((resolve) => waiters.add(resolve))
    admitting = true
    return release
  }

  // The CLI may have already joined revocation before rejecting its receipt.
  const receiptRevocations = new WeakSet<OwnedProgramCleanupLease>()
  // This ledger belongs to the admitting activation, not the displayed vault
  // or its transient listing. Host teardown retains the original errors.
  let creationFailure: Unconfirmed | undefined
  let occupiedReceiptFailure: Unconfirmed | undefined
  let listingFailure: Unconfirmed | undefined

  function inventoryFailure(): Unconfirmed | undefined {
    // A collision must not transfer a new process into the existing inventory.
    if (occupiedReceiptFailure) return listingFailure ?? occupiedReceiptFailure
    // An unconfirmed launch with no verified id may appear in a later
    // listing. Without knowing which row is still native-owned, keep the
    // preexisting inventory and join cleanup on the original lease alone for
    // the failed launch. Neither the candidate id nor a new listing can
    // transfer that ownership.
    if (
      creationFailure?.sessionId === undefined &&
      creationFailure?.error instanceof UnconfirmedOwnedProgramError
    )
      return creationFailure
    return listingFailure
  }

  function retainFailure(failure: Unconfirmed, creation = false): Unconfirmed {
    lateCleanup.recordFailure(failure.error)
    if (creation) creationFailure ??= failure
    if (failure.sessionId !== undefined) {
      if (!inventory.uncertain.has(failure.sessionId))
        inventory.uncertain.set(failure.sessionId, failure)
      if (creation && failure.error instanceof UnconfirmedOwnedProgramError)
        inventory.unpublished.add(failure.sessionId)
    }
    return failure
  }

  async function revokeUnconfirmed(error: Error): Promise<void> {
    if (
      !(error instanceof UnconfirmedOwnedProgramError) ||
      error.lease === undefined ||
      receiptRevocations.has(error.lease)
    )
      return
    try {
      await lateCleanup.revoke(error.lease)
    } catch {
      // Keep the first uncertainty and its lease, not a later revoke error.
    }
  }

  function retainFailedReceipt(
    result: Extract<CliCreation, { cleanupUnconfirmed: true }>,
  ): Unconfirmed {
    const { error, message } = result
    if (
      'revokeAttempted' in result &&
      result.revokeAttempted &&
      error instanceof UnconfirmedOwnedProgramError &&
      error.lease !== undefined
    )
      receiptRevocations.add(error.lease)
    // A failing adapter's candidate cannot quarantine a session: it may
    // name an existing shutdown owner. Record only the launch uncertainty.
    return retainFailure(
      {
        ok: false,
        message,
        error,
        cleanupUnconfirmed: true,
        ...('missingProviderReceipt' in result ? { missingProviderReceipt: true as const } : {}),
      },
      true,
    )
  }

  function retainListingFailure(error: UnconfirmedOwnedProgramError): void {
    listingFailure ??= retainFailure({
      ok: false,
      message: error.message,
      cleanupUnconfirmed: true,
      error,
    })
  }

  /** A past row still owns its id, but is not shutdown work. Check again
   * after any host preparation, before the receipt can reserve its id. */
  function rejectCollision({
    id,
    lease,
  }: CreatedSession): Promise<Failure | Unconfirmed> | undefined {
    if (
      inventory.rows.some((row) => row.id === id) ||
      inventory.listed.has(id) ||
      inventory.pending.has(id) ||
      inventory.uncertain.has(id) ||
      inventory.acting.has(id) ||
      terminals.launchedFor(id) !== null
    )
      return rejectOccupiedReceipt(
        new Error(`Claude Code reported an already owned background session: ${id}.`),
        lease,
      )
    return undefined
  }

  async function rejectOccupiedReceipt(
    error: Error,
    lease: CreatedSession['lease'],
  ): Promise<Failure | Unconfirmed> {
    // The id is already someone else's. The new launch has only its own
    // lease: never issue a provider verb or attribute uncertainty to this id.
    let failure = error
    if (lease !== undefined) {
      try {
        await lateCleanup.revoke(lease)
        return { ok: false, message: error.message, error }
      } catch (cause) {
        failure = new UnconfirmedOwnedProgramError(cause, lease, error)
      }
    }
    occupiedReceiptFailure = retainFailure(
      {
        ok: false,
        cleanupUnconfirmed: true,
        error: failure,
        message: lease === undefined ? `${error.message} Cleanup unconfirmed.` : failure.message,
      },
      true,
    )
    return occupiedReceiptFailure
  }

  /** The host must first join revocation of the receipt's own lease. Only
   * confirmed cleanup frees this reservation; always reject with the commit error. */
  function rejectCommit(
    id: string,
    lease: NonNullable<CreatedSession['lease']>,
    cause: unknown,
    revoked: PromiseSettledResult<void>,
  ): never {
    if (revoked.status === 'fulfilled') {
      inventory.revision++
      inventory.pending.delete(id)
      inventory.unpublished.delete(id)
      inventory.unprompted.delete(id)
    } else {
      retainFailure(unconfirmed(cause, id, lease), true)
      lateCleanup.recordFailure(
        new Error(`Could not revoke uncommitted session ${id}`, {
          cause: revoked.reason,
        }),
      )
    }
    throw cause
  }

  return {
    acquire,
    creationBlock: () => creationFailure ?? listingFailure,
    inventoryFailure,
    canResume: (blocked: Unconfirmed, id: string) =>
      blocked === occupiedReceiptFailure && inventory.rows.some((row) => row.id === id),
    rejectCollision,
    rejectCommit,
    retainFailedReceipt,
    retainFailure,
    retainListingFailure,
    revokeUnconfirmed,
  }
}
