/** The pieces the wizard's steps share: a captioned field, the step heading, a fact row. */
import { Clock } from 'lucide-react'
import { cloneElement, isValidElement, useId } from 'react'
import { Badge } from '@/components/ui/badge'
import { FramePanel } from '@/components/ui/frame'
import { IconTile } from '@/components/ui/icon-tile'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'

/** A captioned control. The caption names the control: `Input`, `Textarea` and
 *  `Switch` are linked to it by id, the rest carry their own `aria-label`. */
export function FormField({
  label,
  required,
  error,
  orientation = 'vertical',
  children,
}: {
  label: string
  required?: boolean
  error?: string
  orientation?: 'vertical' | 'horizontal'
  children: React.ReactElement<{ id?: string }>
}): React.JSX.Element {
  const id = useId()
  const linkable =
    isValidElement(children) && [Input, Textarea, Switch].includes(children.type as never)
  const control = linkable ? cloneElement(children, { id }) : children
  const caption = (
    <>
      {label}
      {required === true && <span className="text-destructive"> *</span>}
    </>
  )
  return (
    <Field orientation={orientation}>
      <FieldLabel
        htmlFor={linkable ? id : undefined}
        className="text-xs font-normal text-muted-foreground"
      >
        {caption}
      </FieldLabel>
      {orientation === 'horizontal' ? (
        <div className="flex flex-1 justify-end">{control}</div>
      ) : (
        control
      )}
      {error !== undefined && <FieldError>{error}</FieldError>}
    </Field>
  )
}

/** The heading every step opens with, as the block's `StepHeading`. */
export function StepHeading({
  title,
  description,
}: {
  title: string
  description: string
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5" aria-live="polite">
      <h2 className="text-xl font-semibold tracking-tight text-balance text-foreground">{title}</h2>
      <p className="text-sm text-pretty text-muted-foreground">{description}</p>
    </div>
  )
}

/** One row of an explaining list: its mark, a title, a line, and maybe the
 *  file it lives in. */
export function Fact({
  icon: Glyph,
  title,
  file,
  children,
}: {
  icon: typeof Clock
  title: string
  file?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <FramePanel>
      <div className="flex items-start gap-3">
        <IconTile size="sm">
          <Glyph className="size-3.5" />
        </IconTile>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{title}</span>
            {file !== undefined && <Badge variant="outline">{file}</Badge>}
          </div>
          <p className="text-xs text-pretty text-muted-foreground">{children}</p>
        </div>
      </div>
    </FramePanel>
  )
}

// ── 1. What a Holi is ─────────────────────────────────────────────────────

/** A caption over a group of controls, where a wrapping label would steal
 *  their presses. */
export function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

// ── 3. Who it is ──────────────────────────────────────────────────────────
