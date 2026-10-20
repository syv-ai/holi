/**
 * Where you write to Claude Code in a chat: the text, and under it the model
 * and how much it may do without asking. Enter sends, Shift+Enter starts a new
 * line, and while a turn runs the send button stops it.
 *
 * After MonoCode's `Composer` and `ModelPicker` (MIT, Copyright (c) 2026 Nick;
 * see NOTICE.md), cut to the two choices Claude Code takes. The permission
 * choices are Claude Code's own modes, every one of which still asks.
 */
import { ArrowUp, ChevronDown, ShieldCheck, Square } from 'lucide-react'
import { useEffect, useRef } from 'react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Icon,
  Textarea,
  Tooltip,
} from '@/primitives'
import { cn } from '@/plugin-api'
import { PERMISSION_MODES, type PermissionMode } from '../shared/chat'

/** The models offered: Claude Code's own aliases, which follow its releases
 *  without Holi keeping a list of ids. */
const MODELS: readonly { value: string | null; label: string }[] = [
  { value: null, label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
]

export interface ComposerChoice {
  model: string | null
  mode: PermissionMode
}

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  placeholder,
  choice,
  onChoice,
  autoFocus,
  error,
}: {
  value: string
  onChange(value: string): void
  onSend(): void
  onStop?(): void
  /** A turn is running: the button stops it. */
  busy: boolean
  placeholder: string
  choice: ComposerChoice
  onChoice?(choice: ComposerChoice): void
  autoFocus?: boolean
  error?: string | null
}): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  const send = () => {
    if (value.trim() === '' || busy) return
    onSend()
  }
  const set = (next: Partial<ComposerChoice>) => onChoice?.({ ...choice, ...next })
  const modelLabel =
    MODELS.find((m) => m.value === choice.model)?.label ?? choice.model ?? 'Default'
  const modeLabel = PERMISSION_MODES.find((m) => m.value === choice.mode)?.label ?? 'Ask first'
  const pickable = onChoice !== undefined

  return (
    <div className="flex flex-col gap-2">
      <div
        className="flex flex-col gap-2.5 rounded-2xl bg-foreground/[0.03] p-3 ring-1 ring-foreground/[0.09] ring-inset motion-respond focus-within:ring-foreground/[0.18]"
        data-composer=""
      >
        <Textarea
          ref={ref}
          variant="bare"
          rows={1}
          value={value}
          placeholder={placeholder}
          aria-label={placeholder}
          className="max-h-56 min-h-6 text-sm"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
        />
        <div className="flex items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={!pickable}>
              <Button size="xs" variant="secondary" aria-label={`Model: ${modelLabel}`}>
                {modelLabel}
                {pickable && <Icon icon={ChevronDown} size="sm" />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Model</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={choice.model ?? ''}
                onValueChange={(v) => set({ model: v === '' ? null : v })}
              >
                {MODELS.map((m) => (
                  <DropdownMenuRadioItem key={m.label} value={m.value ?? ''}>
                    {m.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          {
            <DropdownMenu>
              <DropdownMenuTrigger asChild disabled={!pickable}>
                <Button size="xs" variant="secondary" aria-label={`Permissions: ${modeLabel}`}>
                  <Icon icon={ShieldCheck} size="sm" />
                  {modeLabel}
                  {pickable && <Icon icon={ChevronDown} size="sm" />}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>Before it acts</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={choice.mode}
                  onValueChange={(v) => set({ mode: v as PermissionMode })}
                >
                  {PERMISSION_MODES.map((m) => (
                    <DropdownMenuRadioItem key={m.value} value={m.value}>
                      <span className="flex flex-col">
                        {m.label}
                        <span className="text-xs text-muted-foreground">{m.hint}</span>
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          }

          <span className="flex-1" />
          <Tooltip content={busy ? 'Stop' : 'Send'}>
            {busy && onStop !== undefined ? (
              <Button size="xs" variant="secondary" aria-label="Stop" onClick={onStop}>
                <Icon icon={Square} size="sm" />
              </Button>
            ) : (
              <Button
                size="xs"
                aria-label="Send"
                disabled={value.trim() === '' || busy}
                onClick={send}
              >
                <Icon icon={ArrowUp} size="sm" />
              </Button>
            )}
          </Tooltip>
        </div>
      </div>
      {error != null && error !== '' && (
        <p className={cn('px-1 text-xs text-destructive')}>{error}</p>
      )}
    </div>
  )
}
