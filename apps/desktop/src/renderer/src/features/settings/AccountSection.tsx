/**
 * Who you are signed in as, and how to stop being.
 *
 * Its own section rather than a footer on the Vault one: identity is not a
 * property of the vault you happen to have open, and sign-out is the one
 * destructive control in the whole tab. The old panel put it last behind a
 * divider for the same reason, which a rail says more plainly.
 *
 * Ported out of `features/vault/VaultSettings.tsx` unchanged, dialog included.
 */
import { useEffect, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Button, Checkbox, Dialog } from '@/primitives'
import { trpc } from '@/lib/trpc'
import { unpushedWarning } from '@/lib/unpushed-warning'
import { sessionAtom, signOutAtom } from '@/state/session'
import { ExternalLink } from './VaultSection'

const userUrl = (login: string) => `https://github.com/${login}`

export function AccountSection(): React.JSX.Element {
  const session = useAtomValue(sessionAtom)
  const signOut = useSetAtom(signOutAtom)
  /** Whether the confirm is open, whether to also delete the local clones, and
   *  the unpushed-work warning fetched when it opens (`null` = none, or not yet
   *  fetched). */
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const [alsoDeleteClones, setAlsoDeleteClones] = useState(false)
  const [unpushedText, setUnpushedText] = useState<string | null>(null)

  // Ask what deleting the clones would cost, but only when the dialog opens —
  // this walks every clone's git status, so it is not worth doing on every
  // render. Reset the choice each time it opens.
  useEffect(() => {
    if (!confirmSignOut) return
    setAlsoDeleteClones(false)
    setUnpushedText(null)
    void trpc.vaults.unpushed.query().then((s) => setUnpushedText(unpushedWarning(s)))
  }, [confirmSignOut])

  return (
    <div className="pt-4 text-sm">
      <div className="flex items-center justify-between">
        {/* The signed-in user, linked to their GitHub profile. */}
        {session?.login ? (
          <ExternalLink
            url={userUrl(session.login)}
            onOpen={() => void window.holi.openExternal(userUrl(session.login))}
          >
            {session.login}
          </ExternalLink>
        ) : (
          <p className="text-muted-foreground">not signed in</p>
        )}
        <Button variant="secondary" size="sm" onClick={() => setConfirmSignOut(true)}>
          Sign out
        </Button>
      </div>

      {confirmSignOut && (
        <Dialog open onClose={() => setConfirmSignOut(false)} size="sm">
          <div className="grid gap-4">
            <Dialog.Header>Sign out?</Dialog.Header>
            <Dialog.Body>
              <div className="grid gap-3 text-xs text-muted-foreground">
                <p>
                  Removes your GitHub credential and stops all sync. Your local clones stay on disk
                  unless you choose to delete them below.
                </p>
                <label className="flex items-start gap-2">
                  <Checkbox
                    className="mt-0.5"
                    checked={alsoDeleteClones}
                    onCheckedChange={(v) => setAlsoDeleteClones(v === true)}
                  />
                  <span>
                    Also delete local clones on this machine. They&rsquo;re moved to the Trash, so
                    you can restore them.
                  </span>
                </label>
                {/* FR-15: warn when a clone still holds commits that never
                    reached the remote. Advisory — and the Trash makes it
                    recoverable — so the copy cautions rather than blocks. */}
                {unpushedText !== null && (
                  <p className="text-destructive">
                    {unpushedText}. Deleting the clones moves them to the Trash, where you can still
                    recover that work.
                  </p>
                )}
              </div>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="ghost" size="sm" onClick={() => setConfirmSignOut(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  setConfirmSignOut(false)
                  void signOut({ deleteClones: alsoDeleteClones })
                }}
              >
                Sign out
              </Button>
            </Dialog.Footer>
          </div>
        </Dialog>
      )}
    </div>
  )
}
