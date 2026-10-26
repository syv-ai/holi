/**
 * Where a comment or a reply is written: a text box that completes `@login`
 * from the vault's members (a mention reaches them with their next pull,
 * docs/features/note-comments.md), sent with ⌘Enter or its button.
 */
import { useId, useRef, useState } from "react"
import { useAtomValue } from "jotai"

import { Button } from "@/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/cn"
import { memberLoginsAtom } from "@/state/members"
import { PersonAvatar } from "@/composites/person-avatar"

/** The `@word` the caret is at the end of, or null. */
function mentionAt(
  text: string,
  caret: number
): { start: number; query: string } | null {
  const match = /(^|[\s(])@([A-Za-z0-9-]*)$/.exec(text.slice(0, caret))
  if (!match) return null
  return { start: caret - match[2]!.length - 1, query: match[2]!.toLowerCase() }
}

const MAX_SUGGESTIONS = 5

export function CommentField({
  label,
  placeholder,
  submitLabel,
  autoFocus = false,
  onSubmit,
  onCancel,
}: {
  label: string
  placeholder: string
  submitLabel: string
  autoFocus?: boolean
  /** Rejects to keep the text, so nothing typed is lost. */
  onSubmit: (body: string) => Promise<void>
  onCancel?: () => void
}) {
  const members = useAtomValue(memberLoginsAtom)
  const [text, setText] = useState("")
  const [caret, setCaret] = useState(0)
  const [picked, setPicked] = useState(0)
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  const listId = useId()

  const mention = mentionAt(text, caret)
  const suggestions =
    mention === null
      ? []
      : members
          .filter((login) => login.toLowerCase().startsWith(mention.query))
          .slice(0, MAX_SUGGESTIONS)
  const open = suggestions.length > 0
  const current = Math.min(picked, suggestions.length - 1)

  const complete = (login: string) => {
    if (mention === null) return
    const next = `${text.slice(0, mention.start)}@${login} ${text.slice(caret)}`
    const at = mention.start + login.length + 2
    setText(next)
    setCaret(at)
    setPicked(0)
    requestAnimationFrame(() => {
      box.current?.focus()
      box.current?.setSelectionRange(at, at)
    })
  }

  const submit = async () => {
    const body = text.trim()
    if (body === "" || busy) return
    setBusy(true)
    try {
      await onSubmit(body)
      setText("")
      setCaret(0)
    } catch {
      // The caller says what went wrong; the text stays to send again.
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Popover open={open}>
        <PopoverAnchor asChild>
          <Textarea
            ref={box}
            aria-label={label}
            placeholder={placeholder}
            autoFocus={autoFocus}
            value={text}
            disabled={busy}

            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-activedescendant={open ? `${listId}-${current}` : undefined}
            onChange={(event) => {
              setText(event.target.value)
              setCaret(event.target.selectionStart)
              setPicked(0)
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onKeyDown={(event) => {
              if (
                open &&
                (event.key === "ArrowDown" || event.key === "ArrowUp")
              ) {
                event.preventDefault()
                const step = event.key === "ArrowDown" ? 1 : -1
                setPicked(
                  (current + step + suggestions.length) % suggestions.length
                )
              } else if (
                open &&
                (event.key === "Enter" || event.key === "Tab")
              ) {
                event.preventDefault()
                complete(suggestions[current]!)
              } else if (
                event.key === "Enter" &&
                (event.metaKey || event.ctrlKey)
              ) {
                event.preventDefault()
                void submit()
              } else if (event.key === "Escape") {
                if (open) {
                  event.preventDefault()
                  setCaret(-1)
                } else if (onCancel) {
                  event.preventDefault()
                  onCancel()
                }
              }
            }}
          />
        </PopoverAnchor>
        <PopoverContent
          align="start"
          className="w-56"
          // The text box keeps focus: the keys above drive the list.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <ul
            id={listId}
            role="listbox"
            aria-label="Mention"
            className="flex flex-col gap-0.5"
          >
            {suggestions.map((login, i) => (
              <li
                key={login}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === current}
                className={cn(
                  "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
                  i === current && "bg-accent text-accent-foreground"
                )}
                onMouseDown={(event) => {
                  // Keep the text box's focus and caret.
                  event.preventDefault()
                  complete(login)
                }}
              >
                <PersonAvatar login={login} />
                {login}
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
      <div className="flex items-center justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          disabled={busy || text.trim() === ""}
          onClick={() => void submit()}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  )
}
