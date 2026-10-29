import { useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import type { ClaimCreate } from '@/plugin-api/types'

/**
 * The name a New menu item asks for before it makes anything (a link's
 * address), in a field that says the item's placeholder. A refusal stays in
 * the dialog, under the field, with what was typed.
 */
export function AskNameDialog({
  asking,
  onClose,
  onMake,
}: {
  asking: { create: ClaimCreate; parent: string } | null
  onClose: () => void
  onMake: (name: string) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = () => {
    setName('')
    setError(null)
    onClose()
  }
  const label = asking?.create.label ?? ''
  const submit = () => {
    if (name.trim() === '' || busy) return
    setBusy(true)
    setError(null)
    onMake(name.trim())
      .then(close, (err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }
  return (
    <Dialog open={asking !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-md">
        <div className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>
              {asking?.parent ? `In ${asking.parent}.` : 'At the vault’s top.'}
            </DialogDescription>
          </DialogHeader>
          <Field data-invalid={error !== null || undefined}>
            <FieldLabel htmlFor="ask-name" className="sr-only">
              {label}
            </FieldLabel>
            <Input
              id="ask-name"
              autoFocus
              value={name}
              placeholder={asking?.create.placeholder}
              spellCheck={false}
              aria-invalid={error !== null || undefined}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                event.preventDefault()
                submit()
              }}
            />
            {error !== null ? <FieldError>{error}</FieldError> : null}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="button" disabled={busy || name.trim() === ''} onClick={submit}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
