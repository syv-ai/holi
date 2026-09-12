/**
 * A label on the left, its control on the right, wrapping when it must.
 *
 * The wrapping rule is `SettingRow`'s, deliberately: the top line is a wrap
 * container and the label column has a real `basis`, so a control drops to its
 * own line exactly when its natural width stops fitting beside the label. No
 * breakpoint and no container query — a frontmatter block renders in a pane
 * that can be any width at all, including a narrow split beside a board, and
 * each row then answers for itself rather than all of them switching at one
 * number somebody had to pick.
 *
 * `basis-24` rather than the settings row's `basis-48`: a frontmatter key is one
 * word, not a question with a sentence underneath it.
 */
import { Tooltip } from '@/primitives'

/**
 * What every control in a field row looks like.
 *
 * A row is a label and an answer, and the answers only read as one column when
 * they are the same shape: same height, same type size, same edge, same inset.
 * They were not — a `Select` came out of its primitive at 14px and 32px tall, a
 * date picker at 12px and 32px, and the tag field at 14px, 24px and no edge at
 * all, which made a block of six rows look like six different kinds of control.
 *
 * A constant rather than a wrapper component: `Select`, `Button` and `Input`
 * each need it on a different element (a trigger, a trigger, the input itself),
 * so the shared thing is the treatment, not a box to put them in.
 */
export const FIELD_CONTROL =
  'h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-3 text-xs font-normal'

/** The same, for a value that is read rather than edited: no edge, no height of
 *  its own, but the same inset so it lines up with the fields above and below. */
export const FIELD_READONLY = 'truncate px-3 text-xs text-muted-foreground'

export function FieldRow({
  label,
  title,
  children,
}: {
  label: string
  /** Tooltip text, when the label alone does not say enough. Defaults to it. */
  title?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 py-0.5">
      <Tooltip content={title ?? label}>
        <span className="min-w-0 shrink-0 basis-24 truncate text-xs text-muted-foreground">
          {label}
        </span>
      </Tooltip>
      {/* **The control column grows, the label does not.** With the label
          growing instead, every control was only as wide as its own contents,
          so a block of six rows had six different box widths all ending at the
          same right edge and starting wherever their text happened to begin.
          `flex-1` gives them one width, which is what makes them read as a
          column of answers.

          `min-w-32` is what still makes the row wrap: below it the control goes
          to its own line rather than being squeezed to something unusable — the
          `SettingRow` rule, with a floor instead of a breakpoint. */}
      <div className="flex min-w-32 flex-1 items-center justify-end gap-1">{children}</div>
    </div>
  )
}
