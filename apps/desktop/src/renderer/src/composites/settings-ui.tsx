/**
 * The settings tab's shared vocabulary: one heading, one row, one list, one
 * note, one link. A section should render without choosing a size, spacing or
 * colour of its own; where one still does, it says why on the line.
 *
 * **The scale:**
 *
 * | | |
 * |---|---|
 * | page title (the view's `h1`) | `text-2xl font-semibold tracking-tight` |
 * | group heading | `text-xs font-medium text-muted-foreground` |
 * | group blurb | `text-xs text-muted-foreground` |
 * | row label | `text-sm font-medium` |
 * | row description | `text-sm text-muted-foreground` |
 * | notes, badges and other meta | `text-xs` |
 *
 * Body is `text-sm` and meta `text-xs`, as everywhere else, and nothing is
 * smaller (docs/ui-system.md, Type). A group heading is the sidebar's section
 * label: smaller and muted, so it cannot read as a row.
 *
 * **Buttons: `xs` in content, `sm` in a dialog footer**, where a settings
 * action is the primary thing on screen.
 *
 * **Separators are `--divider`, not `--border`.** `--divider` is the hairline
 * between pieces of chrome; `--border` is the edge of an object. The `Layer`
 * badge keeps `--border` because it is a chip.
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** A title to its anchor id. Lowercase, non-alphanumerics collapsed to `-`. */
function headingId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * A heading inside a settings section, and the rail's jump target for it.
 *
 * **This is the one place the id is written.** The rail scrolls by
 * `[data-heading="<id>"]`, so a section writing its own markup could silently
 * become unreachable. A test asserts every declared heading renders.
 */
export function SettingsHeading({
  title,
  blurb,
}: {
  title: string
  blurb?: string
}): React.JSX.Element {
  return (
    // `scroll-mt` because the theme's mode and layer switches are sticky above
    // this: without it a jump parks the heading underneath them.
    <div
      data-heading={headingId(title)}
      className="flex scroll-mt-14 flex-col gap-0.5 pt-6 pb-1 first:pt-1"
    >
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {blurb !== undefined && <p className="text-xs text-muted-foreground">{blurb}</p>}
    </div>
  )
}

/**
 * A run of rows that read as one list. The separator lives here rather than
 * on each row, so a list never draws a double rule where it meets a section
 * boundary.
 */
export function SettingsList({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="divide-y divide-divider">{children}</div>
}

/**
 * One row: a label, an optional description, a control on the right, and
 * anything that needs the row's full width underneath.
 *
 * **The control belongs on the right, and `children` is the exception**: for a
 * control that is not one answer, like the commit transforms' stack of
 * labelled switches.
 *
 * **Wrapping decides when a wide control drops below, not a breakpoint.** The
 * label column has a real flex-basis, so the control moves to a second line
 * when label minimum plus control width exceed the row, and `justify-end` keeps
 * it right. A single container-query breakpoint would be wrong for either a
 * four-option radio group or a checkbox. `basis-48` is the label minimum: below
 * 192px it stops being a column.
 */
export function SettingsRow({
  label,
  description,
  meta,
  control,
  children,
  className,
  ref,
  ...rest
}: {
  /** React 19 takes `ref` as an ordinary prop; it is not in HTMLAttributes, so
   *  it has to be declared to be passed through. */
  ref?: React.Ref<HTMLDivElement>
  label: ReactNode
  description?: ReactNode
  /** Badges and notes beside the label. */
  meta?: ReactNode
  /** Right-aligned, on the label's line. */
  control?: ReactNode
  children?: ReactNode
  className?: string
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'children'>): React.JSX.Element {
  return (
    <div ref={ref} className={cn('flex flex-col gap-2 py-3', className)} {...rest}>
      <div className="flex flex-wrap items-start justify-end gap-x-3 gap-y-2">
        <div className="flex min-w-0 grow basis-48 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{label}</span>
            {meta}
          </div>
          {description !== undefined && (
            <p className="text-sm text-pretty text-muted-foreground">{description}</p>
          )}
        </div>
        {/* Shrinkable, not `shrink-0`: once it is alone on the second line and
            still too wide, its own wrapping is the last thing left. */}
        {control !== undefined && <div className="min-w-0">{control}</div>}
      </div>
      {children}
    </div>
  )
}

/** A muted aside: an empty state, a caveat, a sentence about a file. */
export function SettingsNote({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return <p className={cn('text-xs text-muted-foreground', className)}>{children}</p>
}
