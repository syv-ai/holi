import { isOneEmoji } from '@holi/shared'
import { useState } from 'react'
import { trpc } from '@/lib/trpc'
import { Button, Dialog, Input } from '@/primitives'

/**
 * Set or clear a path's icon in `.holi/icons.json` (D82).
 *
 * The map is the only place an icon lives, so this is the only gesture that sets
 * one and it works the same on a note, a folder and a PDF. There is no second
 * source to lose to, which is why nothing here has to explain a precedence.
 *
 * The explorer-domain content block: it fills a Dialog's slots and knows nothing
 * about overlays or sizing (the registry summons it at `size: 'sm'`).
 */
export function EditIcon({
  remote,
  path,
  current,
  onClose,
}: {
  remote: string
  path: string
  /** The map's current entry, or null. */
  current: string | null
  onClose: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(current ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trimmed = value.trim()
  const valid = trimmed === '' || isOneEmoji(trimmed)
  const name = path.split('/').at(-1) ?? path

  const write = async (emoji: string | null): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await trpc.notes.setIcon.mutate({ remote, path, emoji: emoji ?? undefined })
      onClose()
    } catch (err) {
      // Kept open on failure: closing would look like it worked.
      setError(err instanceof Error ? err.message : 'could not write .holi/icons.json')
      setBusy(false)
    }
  }

  return (
    <>
      <Dialog.Header>
        Icon for <span className="font-mono text-foreground">{name}</span>
      </Dialog.Header>

      <Dialog.Body>
        <div className="flex items-center gap-3">
          {/* The same slot size the tree row uses, so what you see here is what
              lands there rather than a larger preview that flatters it. */}
          <span className="flex size-8 shrink-0 items-center justify-center rounded border border-divider text-sm leading-none">
            {valid && trimmed !== '' ? trimmed : null}
          </span>
          <Input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && valid && !busy) void write(trimmed === '' ? null : trimmed)
            }}
            placeholder="Paste or type one emoji"
            aria-label="Icon"
            aria-invalid={!valid}
          />
        </div>

        {/* ⌃⌘Space is how you get an emoji on macOS, and it is not discoverable
            from a text field that just says "type one emoji". */}
        <p className="text-xs text-muted-foreground">
          One emoji. Press <span className="font-mono">⌃⌘Space</span> for the picker, or leave it
          empty to clear.
        </p>

        {!valid && (
          <p className="text-xs text-destructive">
            That is not a single emoji, so it would not show.
          </p>
        )}

        {error !== null && <p className="text-xs text-destructive">{error}</p>}
      </Dialog.Body>

      <Dialog.Footer>
        {current !== null && (
          <Button
            variant="ghost"
            size="sm"
            className="mr-auto"
            disabled={busy}
            onClick={() => void write(null)}
          >
            Clear
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={busy || !valid}
          onClick={() => void write(trimmed === '' ? null : trimmed)}
        >
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </Dialog.Footer>
    </>
  )
}
