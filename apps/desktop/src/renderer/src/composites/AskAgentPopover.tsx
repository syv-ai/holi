import { useEffect, useMemo, useRef, useState } from 'react'
import type { AskResult, AskTargets } from '@/editor/askAgent'
import { cn } from '@/lib/cn'
import { Button, Popover, PopoverAnchor, PopoverContent, Textarea } from '@/primitives'

/** What a new session is called in the picker, as in the note popover. */
const NEW_SESSION = 'New session'

/**
 * An ask for the agent, opened against a point on the screen rather than a
 * trigger it owns: the PDF viewer's top-bar button lives in the viewer's shadow
 * root, where Radix cannot reach, so the caller hands over that button's box.
 *
 * The same shape as the note popover (`editor/askAgent.ts`): the sessions to
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

  // Chosen as it opens: sessions come and go between two asks, and a default
  // that has ended is a new session rather than a name pointing at nothing.
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
    const res = await onSend(text, target)
    sending.current = false
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
        className="w-[26rem] max-w-[60vw] p-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          ;(e.currentTarget as HTMLElement).querySelector('textarea')?.focus()
        }}
      >
        <div
          role="radiogroup"
          aria-label="Which session to ask"
          className="flex items-center gap-0.5 overflow-x-auto px-2 pt-1.5 [scrollbar-width:none]"
        >
          {choices.map((choice) => (
            <Button
              key={choice.value}
              type="button"
              role="radio"
              aria-checked={choice.value === target}
              variant="ghost"
              size="xs"
              className={cn(
                'h-auto max-w-36 shrink-0 truncate rounded-full px-2 py-0.5 text-[0.6875rem] font-normal text-muted-foreground hover:bg-transparent hover:text-foreground',
                choice.value === target && 'bg-secondary text-foreground hover:bg-secondary',
              )}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setTarget(choice.value)}
            >
              {choice.label}
            </Button>
          ))}
        </div>
        <Textarea
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask the agent, ⌘↵ to send"
          aria-label="Instructions for the agent, Command Enter to send"
          className="max-h-[40vh] min-h-0 resize-none rounded-none border-none bg-transparent px-3 py-2 shadow-none focus-visible:border-none dark:bg-transparent"
          onKeyDown={(e) => {
            // ⌘/Ctrl + Enter, so a plain Enter is still a newline.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void send()
            }
          }}
        />
        {notice !== '' && (
          <p role="alert" className="px-3 pb-2 text-[0.6875rem] text-destructive">
            {notice}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
