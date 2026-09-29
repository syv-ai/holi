/**
 * Leaving, deleting, or letting go of a vault that is gone.
 *
 * - **Leave** drops your own access on GitHub, then the clone. Not for an owner.
 * - **Delete** is GitHub's to do: this sends you to the repo's settings and
 *   removes the clone only once GitHub answers that the repo is gone.
 * - **Forget** is for a vault GitHub no longer shows you: only the clone is left.
 *
 * Confirmed at the start, naming what is lost. Leave and Delete then push
 * first; work that still will not reach GitHub blocks the removal and goes to
 * a new assistant session instead. A clone always goes to the Trash.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState } from 'react'
import type { VaultMembership } from '../../../../main/router'
import { Button, Dialog } from '@/primitives'
import { trpc } from '@/lib/trpc'
import type { RemoveVaultIntent } from '@/state/dialogs'
import { investigateStuckPushAtom, vaultRemovedAtom } from '@/state/vault-removal'
import { vaultsAtom } from '@/state/vaults'

/** How often the delete step asks GitHub whether the repo is gone yet. */
const POLL_MS = 3000

type Step =
  | { kind: 'confirm' }
  | { kind: 'pushing' }
  | { kind: 'stuck'; ahead: number; dirty: boolean }
  | { kind: 'working' }
  | { kind: 'waiting' }
  | { kind: 'kept'; org: string }

/** "ada-holm", "ada-holm and bo", "ada-holm, bo and 3 others". */
export function namePeople(logins: string[]): string {
  if (logins.length <= 2) return logins.join(' and ')
  const rest = logins.length - 2
  return `${logins[0]}, ${logins[1]} and ${rest} other${rest === 1 ? '' : 's'}`
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function RemoveVault({
  remote,
  intent,
  onClose,
}: {
  remote: string
  intent: RemoveVaultIntent
  onClose: () => void
}): React.JSX.Element {
  const name = useAtomValue(vaultsAtom).find((v) => v.remote === remote)?.name ?? remote
  const removed = useSetAtom(vaultRemovedAtom)
  const investigate = useSetAtom(investigateStuckPushAtom)
  const [membership, setMembership] = useState<VaultMembership | null>(null)
  const [step, setStep] = useState<Step>({ kind: 'confirm' })
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void trpc.vaults.membership
      .query({ remote })
      .then(setMembership)
      .catch((err: unknown) => setError(messageOf(err)))
  }, [remote])

  // The delete step: GitHub does the deleting, so ask it until the repo is gone.
  // Main checks again before it trashes anything.
  useEffect(() => {
    if (step.kind !== 'waiting') return
    let stopped = false
    const tick = async () => {
      try {
        const { gone } = await trpc.vaults.forgetDeleted.mutate({ remote })
        if (stopped) return
        if (gone) {
          await removed(remote)
          onClose()
          return
        }
      } catch (err) {
        if (!stopped) setError(messageOf(err))
      }
      if (!stopped) timer = setTimeout(() => void tick(), POLL_MS)
    }
    let timer = setTimeout(() => void tick(), POLL_MS)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [step.kind, remote, removed, onClose])

  const live = membership?.kind === 'live' ? membership : null

  /** Push first. Anything still only here blocks the removal and goes to a new
   *  assistant session in this vault. */
  async function pushFirst(): Promise<boolean> {
    setStep({ kind: 'pushing' })
    const { ahead, dirty } = await trpc.vaults.settle.mutate({ remote })
    if (ahead === 0 && !dirty) return true
    setStep({ kind: 'stuck', ahead, dirty })
    void investigate({ remote, intent: intent === 'delete' ? 'delete' : 'leave' })
    return false
  }

  async function proceed() {
    setError(null)
    try {
      if (intent === 'forget') {
        setStep({ kind: 'working' })
        const { gone } = await trpc.vaults.forgetDeleted.mutate({ remote })
        if (!gone) throw new Error(`${remote} is still on GitHub, so its clone stays.`)
        await removed(remote)
        onClose()
        return
      }
      if (!(await pushFirst())) return
      if (intent === 'delete') {
        await trpc.vaults.openRepoSettings.mutate({ remote })
        setStep({ kind: 'waiting' })
        return
      }
      setStep({ kind: 'working' })
      const { accessVia } = await trpc.vaults.leave.mutate({ remote })
      await removed(remote)
      if (accessVia === null) onClose()
      else setStep({ kind: 'kept', org: accessVia })
    } catch (err) {
      setError(messageOf(err))
      setStep({ kind: 'confirm' })
    }
  }

  const title =
    step.kind === 'stuck'
      ? 'Work has not reached GitHub'
      : step.kind === 'kept'
        ? `Left ${name}`
        : intent === 'leave'
          ? `Leave ${name}?`
          : intent === 'delete'
            ? `Delete ${name}?`
            : `${name} is gone from GitHub`

  const allowed =
    intent === 'forget' || (live !== null && (intent === 'leave' ? !live.owned : live.canAdmin))
  const busy = step.kind === 'pushing' || step.kind === 'working'

  return (
    <>
      <Dialog.Header>{title}</Dialog.Header>
      <Dialog.Body>
        <div className="grid gap-3 text-xs text-muted-foreground">
          {step.kind === 'stuck' ? (
            <>
              <p>
                {step.ahead > 0
                  ? `${step.ahead} commit${step.ahead === 1 ? '' : 's'} could not be pushed`
                  : 'There are changes Holi has not committed'}
                , so nothing was removed.
              </p>
              <p>A new assistant session is looking into why. Try again once it is sorted.</p>
            </>
          ) : step.kind === 'kept' ? (
            <p>
              The clone is gone from this machine. Your access comes through the {step.org}{' '}
              organization, which Holi cannot drop, so you can still join it again.
            </p>
          ) : step.kind === 'waiting' ? (
            <>
              <p>
                In the repository settings that just opened, scroll to Danger Zone and choose Delete
                this repository.
              </p>
              <p>Holi removes the clone from this machine as soon as GitHub says it is gone.</p>
            </>
          ) : intent === 'forget' ? (
            <p>
              GitHub no longer shows {remote} to you: it was deleted, or your access was removed.
              The clone on this machine moves to the Trash.
            </p>
          ) : live === null ? (
            error === null && <p>Reading the vault on GitHub…</p>
          ) : intent === 'leave' ? (
            live.owned ? (
              <p>You own this vault, so you cannot leave it. Delete it instead.</p>
            ) : (
              <>
                <p>
                  {live.accessVia === null
                    ? `You lose access to ${remote} on GitHub. To come back, someone has to invite you again.`
                    : `Your access comes through the ${live.accessVia} organization, which Holi cannot drop. You keep it on GitHub.`}
                </p>
                <p>The clone on this machine moves to the Trash. Your work is pushed first.</p>
              </>
            )
          ) : !live.canAdmin ? (
            <p>Only an admin of {remote} can delete it on GitHub.</p>
          ) : (
            <>
              <p className="text-destructive">
                This deletes {remote} on GitHub, with its whole history, for everyone. It cannot be
                undone.
              </p>
              {live.others.length > 0 && <p>{namePeople(live.others)} also lose it.</p>}
              <p>
                Your work is pushed first. Then GitHub asks you to confirm the delete, and Holi
                moves the clone on this machine to the Trash once it is gone.
              </p>
            </>
          )}
          {step.kind === 'pushing' && <p>Pushing your work to GitHub…</p>}
          {error !== null && <p className="text-destructive">{error}</p>}
        </div>
      </Dialog.Body>
      <Dialog.Footer>
        {step.kind === 'stuck' || step.kind === 'kept' ? (
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        ) : step.kind === 'waiting' ? (
          <>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void trpc.vaults.openRepoSettings.mutate({ remote })}
            >
              Open GitHub again
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={!allowed || busy}
              onClick={() => void proceed()}
            >
              {intent === 'leave'
                ? 'Leave'
                : intent === 'delete'
                  ? 'Continue to GitHub'
                  : 'Remove from this machine'}
            </Button>
          </>
        )}
      </Dialog.Footer>
    </>
  )
}
