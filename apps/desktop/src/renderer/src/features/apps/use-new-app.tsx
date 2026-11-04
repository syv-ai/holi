import { useAtomValue, useSetAtom } from 'jotai'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { claimsAtom } from '@/state/plugins'
import { useAgentService } from '@/state/agent-service'
import { openDialogAtom } from '@/state/dialogs'
import { activeRemoteAtom } from '@/state/vaults'

function NewAppRequestDialog({
  close,
  onSubmit,
}: {
  close: () => void
  onSubmit: (request: string) => Promise<void>
}) {
  const [request, setRequest] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    const value = request.trim()
    if (value === '' || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(value)
      close()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <DialogHeader>
        <DialogTitle>New app</DialogTitle>
        <DialogDescription>Tell the agent what you want this app to do.</DialogDescription>
      </DialogHeader>
      <Field data-invalid={error !== null || undefined}>
        <FieldLabel htmlFor="new-app-request">What should the app do?</FieldLabel>
        <Input
          id="new-app-request"
          autoFocus
          value={request}
          placeholder="What should the app do?"
          spellCheck={false}
          aria-invalid={error !== null || undefined}
          onChange={(event) => setRequest(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            event.preventDefault()
            void submit()
          }}
        />
        {error !== null ? <FieldError>{error}</FieldError> : null}
      </Field>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={close}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={busy || request.trim() === ''}
          onClick={() => void submit()}
        >
          {busy ? 'Starting…' : 'Ask agent'}
        </Button>
      </DialogFooter>
    </div>
  )
}

/** `create` is undefined while the apps plugin is off or no vault is open. */
export function useNewApp(): {
  create: (() => void) | undefined
  creating: boolean
} {
  const remote = useAtomValue(activeRemoteAtom)
  const claim = useAtomValue(claimsAtom).find((c) => c.create?.id === 'app')
  const agent = useAgentService()
  const openDialog = useSetAtom(openDialogAtom)
  const [creating, setCreating] = useState(false)

  if (remote === null || claim?.create === undefined || agent === null) {
    return { create: undefined, creating }
  }
  const vaultRemote = remote
  const createClaim = claim.create
  const vaultAgent = agent

  function create() {
    openDialog({
      id: 'plugin',
      size: 'md',
      render: (close) => (
        <NewAppRequestDialog
          close={close}
          onSubmit={async (request) => {
            setCreating(true)
            try {
              await createClaim.run({
                remote: vaultRemote,
                parent: '',
                name: request,
                agent: vaultAgent,
              })
            } finally {
              setCreating(false)
            }
          }}
        />
      ),
    })
  }

  return { create, creating }
}
