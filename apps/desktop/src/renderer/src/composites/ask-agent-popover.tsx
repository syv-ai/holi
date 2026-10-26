import { useEffect, useMemo, useRef, useState } from 'react'
import type { AskResult, AskTargets } from '@/lib/ask-agent'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { InputGroup, InputGroupTextarea } from '@/components/ui/input-group'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

/** What a new session is called in the picker, as in the note popover. */
const NEW_SESSION = 'New session'

/**
 * An ask for the agent, opened against a point on the screen rather than a
 * trigger it owns: the PDF viewer's top-bar button lives in the viewer's shadow
 * root, where Radix cannot reach, so the caller hands over that button's box.
 *
 * The same shape as the note popover: the sessions to
 * send to (live ones in tab order, then New session), one field, ⌘↵ to send,
 * and a refusal kept under the field with the text still in it. The caller
 * builds the message; `instruction` is what was typed, possibly empty.
 */
export function AskAgentPopover({
  anchor,
  label,
  targets,
  onSend,
  onClose,
}: {
  /** Where to open, or null for closed. */
  anchor: DOMRect | null
  /** Says what the ask is about, for a screen reader. */
  label: string
  targets: AskTargets
  onSend: (instruction: string, target: string | 'new') => Promise<AskResult>
  onClose: () => void
}): React.JSX.Element {
  const virtualRef = useMemo(
    () => ({ current: { getBoundingClientRect: () => anchor ?? new DOMRect() } }),
    [anchor],
  )
  const open = anchor !== null
  const [text, setText] = useState('')
  const [notice, setNotice] = useState('')
  const [target, setTarget] = useState<string | 'new'>('new')
  const sending = useRef(false)

  // Chosen as it opens; a default that has ended falls back to a new session.
  useEffect(() => {
    if (!open) return
    const { sessions, initial } = targets
    setTarget(initial !== 'new' && sessions.some((s) => s.id === initial) ? initial : 'new')
    setText('')
    setNotice('')
    // Only on opening: a session list that moves while it is open keeps the choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const send = async () => {
    if (sending.current) return
    sending.current = true
    setNotice('')
    let res: AskResult
    try {
      res = await onSend(text, target)
    } catch {
      res = { ok: false }
    } finally {
      sending.current = false
    }
    if (res.ok) onClose()
    else setNotice(res.message ?? 'That could not be sent.')
  }

  const choices = [
    ...targets.sessions.map((s) => ({ value: s.id, label: s.name })),
    { value: 'new' as const, label: NEW_SESSION },
  ]

  return (
    <Popover open={open} onOpenChange={(next) => !next && onClose()}>
      <PopoverAnchor virtualRef={virtualRef} />
      <PopoverContent
        align="end"
        aria-label={label}
        className="w-104"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          ;(e.currentTarget as HTMLElement).querySelector('textarea')?.focus()
        }}
      >
        <ToggleGroup
          type="single"
          size="sm"
          spacing={0.5}
          aria-label="Which session to ask"
          value={target}
          onValueChange={(next) => next !== '' && setTarget(next)}
          className="w-full overflow-x-auto"
        >
          {choices.map((choice) => (
            <ToggleGroupItem
              key={choice.value}
              value={choice.value}
              className="max-w-36 font-normal"
              // Picking keeps the caret in the field.
              onMouseDown={(e) => e.preventDefault()}
            >
              <span className="truncate">{choice.label}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <InputGroup>
          <InputGroupTextarea
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Ask the agent, ⌘↵ to send"
            aria-label="Instructions for the agent, Command Enter to send"
            className="max-h-40 min-h-0"
            onKeyDown={(e) => {
              // ⌘/Ctrl + Enter, so a plain Enter is still a newline.
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void send()
              }
            }}
          />
        </InputGroup>
        {notice !== '' && (
          <p role="alert" className="text-xs text-destructive">
            {notice}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
