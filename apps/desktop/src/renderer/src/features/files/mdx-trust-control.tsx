import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { atom, useAtom, useAtomValue, useStore } from 'jotai'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { trpc } from '@/lib/trpc'
import { sessionAtom } from '@/state/session'
import { activeRemoteAtom, activeRemoteRevisionValueAtom } from '@/state/vaults'

// Every source view in this renderer refreshes after a vault-wide change.
const trustRevisionAtom = atom(0)
type TrustStatus = Awaited<ReturnType<typeof trpc.mdxTrust.status.query>>
type Load =
  | { owner: object; kind: 'ready'; result: TrustStatus }
  | { owner: object; kind: 'error'; message: string }

type Props = { remote: string; path: string; visible: boolean; focused: boolean }

/** Explicit account/vault consent; source editing never depends on approval. */
export function MdxTrustControl({ remote, path, visible, focused }: Props) {
  const store = useStore()
  const activeRemote = useAtomValue(activeRemoteAtom)
  const revision = useAtomValue(activeRemoteRevisionValueAtom)
  const viewer = useAtomValue(sessionAtom)
  const [trustRevision, refresh] = useAtom(trustRevisionAtom)
  const owner = useMemo(
    () => ({ remote, path, revision, viewer, visible, focused }),
    [remote, path, revision, viewer, visible, focused],
  )
  const liveOwner = useRef<typeof owner | null>(owner)
  liveOwner.current = owner
  useEffect(() => {
    liveOwner.current = owner
    return () => {
      if (liveOwner.current === owner) liveOwner.current = null
    }
  }, [owner])
  const [load, setLoad] = useState<Load | null>(null)
  const [confirmation, setConfirmation] = useState<{ owner: object; context: string } | null>(null)
  const [failure, setFailure] = useState<{ owner: object; message: string } | null>(null)
  const [pendingOwner, setPendingOwner] = useState<object | null>(null)
  const request = useRef<{ owner: object } | null>(null)
  const current = useCallback(
    () =>
      liveOwner.current === owner &&
      store.get(activeRemoteAtom) === remote &&
      store.get(activeRemoteRevisionValueAtom) === revision &&
      store.get(sessionAtom) === viewer &&
      visible,
    [owner, store, remote, revision, viewer, visible],
  )

  useEffect(() => {
    if (!current()) return
    let live = true
    setLoad(null)
    if (viewer == null) {
      setLoad({
        owner,
        kind: 'ready',
        result: { trusted: false, identityAvailable: false, context: null },
      })
      return
    }
    void trpc.mdxTrust.status.query({ remote }).then(
      (result) => {
        if (live && current()) {
          setLoad({ owner, kind: 'ready', result })
          setConfirmation((previous) =>
            previous?.owner === owner && previous.context !== result.context ? null : previous,
          )
        }
      },
      (error: unknown) => {
        if (live && current()) {
          setLoad({ owner, kind: 'error', message: errorMessage(error) })
          setConfirmation(null)
        }
      },
    )
    return () => {
      live = false
    }
  }, [owner, current, viewer, remote, trustRevision])

  const state = load?.owner === owner ? load : null
  const ready = state?.kind === 'ready' ? state.result : null
  const pending = pendingOwner === owner
  const error = failure?.owner === owner ? failure.message : null
  const dialogOpen = confirmation?.owner === owner && current() && focused
  const allowed = current() && focused && !pending && ready?.context != null

  async function change(approve: boolean, context: string) {
    if (!current() || !focused || request.current?.owner === owner) return
    const pendingRequest = { owner }
    request.current = pendingRequest
    setPendingOwner(owner)
    setFailure(null)
    try {
      if (approve) await trpc.mdxTrust.approve.mutate({ remote, context })
      else await trpc.mdxTrust.revoke.mutate({ remote, context })
      if (current()) setConfirmation(null)
    } catch (cause) {
      if (current()) setFailure({ owner, message: errorMessage(cause) })
    } finally {
      // A committed change is vault-wide even if its originating source view
      // lost focus, changed paths or unmounted while the request was pending.
      refresh((value) => value + 1)
      if (request.current === pendingRequest) {
        request.current = null
        setPendingOwner(null)
      }
    }
  }

  if (!visible || activeRemote !== remote) return null
  return (
    <div className="flex flex-wrap items-center gap-2">
      {state === null ? (
        <>
          <span role="status" className="sr-only">
            Checking MDX trust…
          </span>
          <Skeleton className="h-4 w-24" />
        </>
      ) : state.kind === 'error' ? (
        <>
          <Alert variant="destructive">
            <AlertDescription>MDX trust unavailable. {state.message}</AlertDescription>
          </Alert>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => refresh((value) => value + 1)}
          >
            Retry
          </Button>
        </>
      ) : (
        <>
          <Badge variant={ready?.trusted ? 'success' : 'secondary'}>
            {ready?.trusted
              ? 'Approved'
              : ready?.identityAvailable
                ? 'Not approved'
                : 'Sign in required'}
          </Badge>
          {ready?.trusted ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!allowed}
              onClick={() => ready.context && void change(false, ready.context)}
            >
              {error ? 'Retry revoke' : 'Revoke MDX trust'}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!allowed}
              onClick={() => {
                if (allowed && ready?.context) {
                  setFailure(null)
                  setConfirmation({ owner, context: ready.context })
                }
              }}
            >
              Review MDX trust
            </Button>
          )}
        </>
      )}
      {error && !dialogOpen ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open && !pending) {
            setConfirmation(null)
            setFailure(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve MDX source</DialogTitle>
            <DialogDescription>
              This grants trust to all MDX in {remote}, including future documents and synced
              changes, until revoked. It does not enable preview or grant network, dependency,
              filesystem, shell, or other capabilities.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => setConfirmation(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!allowed}
              onClick={() => {
                if (confirmation?.owner === owner) void change(true, confirmation.context)
              }}
            >
              {pending ? 'Approving…' : error ? 'Retry approval' : 'Approve vault'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
