import { isOneEmoji } from '@holi/shared'
import { useState } from 'react'
import { trpc } from '@/lib/trpc'
import { Button, Dialog, Input } from '@/primitives'

/** Graphemes, not code points: `⭐️` is two code points and `👩‍💻` is five, and
 *  slicing either by length cuts an emoji in half. */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * The last grapheme of whatever was typed, if it is an emoji — otherwise
 * nothing.
 *
 * The field holds one emoji and refuses to hold anything else, so there is no
 * invalid state to render and no validation message to write. Taking the *last*
 * grapheme is what makes a second pick replace the first instead of being
 * rejected: picking again is the obvious way to change your mind, and a field
 * that ignored it would read as broken.
 */
function lastEmojiOf(raw: string): string {
  const graphemes = [...GRAPHEMES.segment(raw)].map((g) => g.segment)
  const last = graphemes.at(-1)
  return last !== undefined && isOneEmoji(last) ? last : ''
}

/**
 * Set or clear a path's icon in `.holi/icons.json` (D82).
 *
 * The map is the only place an icon lives, so this is the only gesture that
 * sets one and it works the same on a note, a folder and a PDF. There is no
 * second source to lose to, which is why nothing here explains a precedence.
 *
 * There is no Clear button either: an empty field already means "no entry", and
 * a button that did the same thing would be a second way to say it.
 *
 * The explorer-domain content block: it fills a Dialog's slots and knows nothing
 * about overlays or sizing (the registry summons it at `size: 'sm'`).
 */
export function EditIcon({
  remote,
  path,
  current,
  onOpenMap,
  onClose,
}: {
  remote: string
  path: string
  /** The map's current entry, or null. */
  current: string | null
  /** Open `.holi/icons.json` itself. A closure rather than a path because only
   *  the tree holds the opener — the dialog is mounted in `DialogHost`, a
   *  sibling of the pane state that owns tabs. */
  onOpenMap: () => void
  onClose: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(current ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await trpc.notes.setIcon.mutate({ remote, path, emoji: value === '' ? undefined : value })
      onClose()
    } catch (err) {
      // Kept open on failure: closing would look like it worked.
      setError(err instanceof Error ? err.message : 'could not write .holi/icons.json')
      setBusy(false)
    }
  }

  return (
    <>
      <Dialog.Header>Edit Icon</Dialog.Header>

      <Dialog.Body>
        <div className="flex items-center gap-2.5">
          {/* Sized to its content — one emoji — rather than stretching across the
              dialog, which made a one-character field look like a text box. */}
          <Input
            autoFocus
            value={value}
            onChange={(e) => setValue(lastEmojiOf(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) void save()
            }}
            aria-label="Icon"
            className="h-8 w-10 shrink-0 px-0 text-center text-sm"
          />
          {/* The subject of the dialog, so it reads at body weight rather than
              as a caption — and in the UI font: this is a path, but every other
              path the app shows a person (the tree row, the tab) is in the UI
              font too, and monospacing it here made one dialog look borrowed. */}
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{path}</span>
        </div>

        <p className="text-xs text-muted-foreground">
          Set a custom icon. Leave it empty to revert to standard icon. See icon overwrites in{' '}
          {/* The `link` variant, sized to sit in running text: `h-auto p-0` so it
              takes the paragraph's line box rather than a button's, and
              `text-xs` so it matches the sentence around it. */}
          <Button
            variant="link"
            className="h-auto p-0 align-baseline text-xs"
            onClick={() => {
              onOpenMap()
              onClose()
            }}
          >
            .holi/icons.json
          </Button>
          .
        </p>

        {error !== null && <p className="text-xs text-destructive">{error}</p>}
      </Dialog.Body>

      <Dialog.Footer>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </Dialog.Footer>
    </>
  )
}
