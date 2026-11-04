/**
 * The pieces a Holi's settings sections share: a framed group, a row, a lines
 * field, and the loading and read-error states.
 */
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Frame, FramePanel } from '@/components/ui/frame'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'

/** A group heading and its blurb, then its rows in one frame. */
export function Group({
  title,
  blurb,
  children,
}: {
  title: string
  blurb?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5 px-1">
        <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
        {blurb !== undefined && <p className="text-xs text-muted-foreground">{blurb}</p>}
      </div>
      <Frame stacked spacing="sm">
        {children}
      </Frame>
    </section>
  )
}

/** One row of a group: its label and hint, its control on the right. */
export function Row({
  label,
  hint,
  control,
  children,
}: {
  label: string
  hint?: string
  control?: React.ReactNode
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <FramePanel>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm font-medium">{label}</span>
            {hint !== undefined && <span className="text-xs text-muted-foreground">{hint}</span>}
          </div>
          {control}
        </div>
        {children}
      </div>
    </FramePanel>
  )
}

/** A list of rules or globs, one a line, saved when the field is left. */
export function LinesField({
  label,
  value,
  placeholder,
  onSave,
}: {
  label: string
  value: readonly string[]
  placeholder: string
  onSave: (lines: string[]) => void
}): React.JSX.Element {
  const [text, setText] = useState(value.join('\n'))
  useEffect(() => setText(value.join('\n')), [value])
  return (
    <Textarea
      aria-label={label}
      className="min-h-20 font-mono text-xs"
      placeholder={placeholder}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const lines = text
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l !== '')
        if (lines.join('\n') !== value.join('\n')) onSave(lines)
      }}
    />
  )
}

export function Loading(): React.JSX.Element {
  return (
    <div role="status" aria-label="Loading" className="flex flex-col gap-2">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-40" />
    </div>
  )
}

export function ReadError({ retry }: { retry: () => void }): React.JSX.Element {
  return (
    <div role="alert" className="flex items-center gap-2 text-sm text-muted-foreground">
      Could not read its files.
      <Button size="xs" variant="secondary" onClick={retry}>
        Retry
      </Button>
    </div>
  )
}
