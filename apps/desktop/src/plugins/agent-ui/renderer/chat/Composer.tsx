/**
 * The chat's composer: a rounded box that grows with what is written, and one
 * round button that sends, or stops the turn while one runs and nothing is
 * written. After Fisher UI's prompt input (jakobfisker.dk/en/ui), on Holi's
 * primitives.
 */
import { ArrowUp, Paperclip, Square } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button, Icon, IconButton, Input } from '@/primitives'
import { cn } from '@/plugin-api'
import { filesOf, pastedFiles } from '../../../agent/renderer/chat/attachments'
import { RichInput, type RichInputHandle } from './RichInput'

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  working,
  disabled = false,
  placeholder,
  hint,
  inputRef,
  markers,
  attached = 0,
  onAttach,
  uploading = false,
}: {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  /** Interrupt the running turn. */
  onStop: () => void
  working: boolean
  /** Nothing can be sent now (the session waits on an answer). */
  disabled?: boolean
  placeholder: string
  hint?: string
  /** The box, so the caller can put an attachment's marker at the cursor. */
  inputRef: React.Ref<RichInputHandle>
  /** The attachments' markers, which the field draws as icon chips. */
  markers: readonly string[]
  /** How many files wait to go with the message. */
  attached?: number
  /** Files picked or dropped: the caller keeps them and marks the text. */
  onAttach: (files: File[]) => void
  /** Files are being written into the vault: nothing more is sent yet. */
  uploading?: boolean
}): React.JSX.Element {
  const empty = value.trim() === ''
  const stops = working && empty
  const picker = useRef<HTMLInputElement | null>(null)
  /** Something is held over the box. */
  const [over, setOver] = useState(false)
  return (
    <div
      data-chat-composer=""
      data-over={over ? '' : undefined}
      className={cn(
        'w-full rounded-3xl border border-border/60 bg-card p-2 shadow-sm motion-respond focus-within:border-ring/60 data-[over]:border-ring',
        disabled && 'opacity-60',
      )}
      onDragOver={(event) => {
        if (disabled || !Array.from(event.dataTransfer.items).some((i) => i.kind === 'file')) return
        event.preventDefault()
        setOver(true)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false)
      }}
      onDrop={(event) => {
        setOver(false)
        const files = filesOf(event.dataTransfer)
        if (disabled || files.length === 0) return
        event.preventDefault()
        onAttach(files)
      }}
    >
      <RichInput
        handle={inputRef}
        value={value}
        markers={markers}
        onChange={onChange}
        disabled={disabled}
        label="Message"
        placeholder={placeholder}
        className="max-h-40 min-h-8 px-2 pt-1.5 text-sm leading-6"
        // A paste of files is the chat's to attach (`ChatView`), not the field's.
        onPasteText={(event) => {
          const pasted = pastedFiles(event.clipboardData)
          return pasted.files.length > 0 || pasted.unreadable
        }}
        onEnter={() => {
          if (!empty && !uploading) onSend()
        }}
      />
      <div className="mt-1 flex min-h-8 items-center gap-1">
        <IconButton
          icon={Paperclip}
          label="Attach files"
          size="sm"
          disabled={disabled}
          onClick={() => picker.current?.click()}
        />
        <Input
          ref={picker}
          type="file"
          multiple
          tabIndex={-1}
          aria-hidden="true"
          className="hidden"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? [])
            // Cleared, so picking the same file again is a change.
            event.target.value = ''
            if (files.length > 0) onAttach(files)
          }}
        />
        {(attached > 0 || hint !== undefined) && (
          <span className="min-w-0 truncate px-2 text-xs text-muted-foreground">
            {attached > 0 && `${attached} attached · delete its icon to remove it`}
            {attached > 0 && hint !== undefined && ' · '}
            {hint}
          </span>
        )}
        {/* A filled round button, so the primary Button rather than an
            IconButton, whose look is its own. */}
        <Button
          size="sm"
          aria-label={stops ? 'Stop the turn' : 'Send'}
          disabled={disabled || uploading || (empty && !working)}
          className="ml-auto size-8 rounded-full px-0"
          onClick={() => (stops ? onStop() : onSend())}
        >
          <Icon icon={stops ? Square : ArrowUp} />
        </Button>
      </div>
    </div>
  )
}
