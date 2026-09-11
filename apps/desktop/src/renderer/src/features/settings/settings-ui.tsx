/**
 * The settings tab's shared vocabulary: one heading, one row, one list, one
 * note, one link.
 *
 * **Why this file exists.** The tab grew out of six surfaces written at
 * different times — the descriptor rows, the theme tokens, the icon map, and
 * three sections ported out of the legacy vault panel — and it showed. Five type
 * sizes for the same job (`text-sm`, `text-xs`, `text-[11px]`, `text-[10px]`,
 * `text-base`), two button sizes for the same weight of action, two idioms for a
 * row separator, and section wrappers that each supplied their own padding, so
 * a section boundary drew a rule twice.
 *
 * A section should now be able to render without choosing a single size,
 * spacing or colour of its own. Where one still does, it says why on the line.
 *
 * **The scale, decided once here:**
 *
 * | | |
 * |---|---|
 * | section title (the view's `h2`) | `text-sm font-medium` |
 * | group heading | `text-[10px] uppercase tracking-wider text-muted-foreground` |
 * | group blurb | `text-[11px] text-muted-foreground` |
 * | row label | `text-xs font-medium` |
 * | row description | `text-[11px] text-muted-foreground` |
 * | badges and other meta | `text-[10px]` |
 *
 * A group heading is *smaller* than the rows it introduces, which is the
 * settings idiom (and already the app's: `VaultSection`'s "Remote"/"Local" and
 * the collaborator permission are the same micro-label). Weight and case carry
 * the hierarchy instead of size, so a heading cannot be mistaken for a row.
 *
 * **Buttons: `xs` in content, `sm` in a dialog footer.** Both are common in the
 * app; the split is by where they sit, not by taste. A dialog's footer is the
 * one place a settings action is the primary thing on screen.
 *
 * **Separators are `--divider`, not `--border`.** `index.css` is explicit that
 * `--divider` is the hairline between pieces of chrome (the sidebar's edge, a
 * footer's top rule) and `--border` is the edge of an object (a card, a chip, a
 * popover). Half this tab had it the other way round. The `Layer` badge keeps
 * `--border`, correctly: it is a chip.
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Button, Tooltip } from '@/primitives'

/** A title to its anchor id. Lowercase, non-alphanumerics collapsed to `-`. */
export function headingId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * A heading inside a settings section, and the rail's jump target for it.
 *
 * **The rail declares headings, the section renders them, and this is the one
 * place the id is written.** The rail scrolls by `[data-heading="<id>"]`, so a
 * section writing its own markup could silently stop being reachable while
 * still looking correct. `headingId` is exported so a registry entry derives its
 * ids from the same titles rather than restating them, and a test asserts every
 * declared heading actually renders.
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
    <div data-heading={headingId(title)} className="scroll-mt-14 pb-1 pt-5 first:pt-1">
      <h3 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      {blurb !== undefined && <p className="mt-0.5 text-[11px] text-muted-foreground">{blurb}</p>}
    </div>
  )
}

/**
 * A run of rows that read as one list.
 *
 * The separator lives here rather than on each row, which is what removes the
 * `last:border-b-0` dance and the double rule where a list met a section
 * boundary that drew its own.
 */
export function SettingsList({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="divide-y divide-divider">{children}</div>
}

/**
 * One row: a label, an optional description, a control on the right, and
 * anything that needs the row's full width underneath.
 *
 * Every section's rows go through this, so the vertical rhythm and the
 * label/description pairing are decided once.
 *
 * **The control belongs on the right, and `children` is the exception.** A
 * settings row is a question and an answer, and the answer reads as one when it
 * is pinned to the right edge of every row in the list. `children` is for a
 * control that is not one answer at all: the commit transforms are five
 * labelled switches, each with its own sentence, and a stack of those is a list
 * that happens to live in a row.
 *
 * **Wrapping decides when a wide control drops below, not a breakpoint.** The
 * top line is a wrap container: the label column has a real flex-basis, so when
 * the label minimum plus the control natural width exceed the row, the control
 * moves to a second line and `justify-end` keeps it right. The switch is then a
 * property of the control own width, so a four-option radio group drops below
 * far earlier than a checkbox does, where one container-query breakpoint would
 * have had to be wrong for one of them. It also holds at every pane width,
 * including the 240px minimum, with no new class to verify in a running window.
 *
 * `basis-48` is that minimum: a label column narrower than 192px stops being a
 * column and starts being a hyphenation exercise. It only decides where the
 * wrap happens; `grow` hands the label everything left over once the control
 * fits.
 */
export function SettingsRow({
  label,
  description,
  meta,
  control,
  children,
  className,
  ...rest
}: {
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
    <div className={cn('flex flex-col gap-2 py-3', className)} {...rest}>
      <div className="flex flex-wrap items-start justify-end gap-x-3 gap-y-2">
        <div className="min-w-0 grow basis-48">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium">{label}</span>
            {meta}
          </div>
          {description !== undefined && (
            <p className="mt-0.5 text-[11px] text-muted-foreground">{description}</p>
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
  return <p className={cn('text-[11px] text-muted-foreground', className)}>{children}</p>
}

/**
 * A link inside a sentence.
 *
 * A `Button` rather than an `<a>` because every one of these *acts* — it opens
 * a tab, reveals a folder, or jumps to the OS browser — and none of them has an
 * href to follow. `variant="link"` is the app's existing shape for that
 * (`VaultSection`'s remote and clone path are the same control), and the size
 * override is what lets it sit on the text baseline instead of as a chip.
 */
export function SettingsLink({
  onClick,
  className,
  children,
}: {
  onClick: () => void
  className?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <Button
      variant="link"
      onClick={onClick}
      className={cn(
        'h-auto max-w-full justify-start truncate p-0 align-baseline text-[11px] font-normal',
        className,
      )}
    >
      {children}
    </Button>
  )
}

/**
 * A link that leaves the app: a GitHub page, a folder in Finder.
 *
 * Distinct from `SettingsLink` only in that the destination is worth showing
 * before you commit to it, so it carries a tooltip with the full URL or path.
 * A `Button` for the same reason: `openExternal` is an act, not an href.
 */
export function ExternalLink({
  url,
  onOpen,
  block,
  children,
}: {
  url: string
  onOpen: () => void
  block?: boolean
  children: ReactNode
}): React.JSX.Element {
  return (
    <Tooltip content={url}>
      <Button
        variant="link"
        onClick={onOpen}
        className={cn(
          'h-auto max-w-full justify-start truncate p-0 text-xs font-normal text-muted-foreground hover:text-brand',
          block && 'block',
        )}
      >
        {children}
      </Button>
    </Tooltip>
  )
}

/**
 * A key/value pair shown as a stacked micro-label over its value.
 *
 * The shape `VaultSection` uses for the remote and the clone path: the value
 * gets the full width before it truncates, which a side-by-side row would not
 * give a long path.
 */
export function SettingsField({
  label,
  children,
}: {
  label: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="space-y-0.5">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  )
}
