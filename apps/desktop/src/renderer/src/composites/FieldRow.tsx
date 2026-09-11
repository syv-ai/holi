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
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 px-1 py-0.5">
      <Tooltip content={title ?? label}>
        <span className="min-w-0 grow basis-24 truncate text-xs text-muted-foreground">{label}</span>
      </Tooltip>
      {/* No `shrink-0`: alone on a second line in a narrow pane the control is
          often still too wide, and its own wrapping is the last thing left. */}
      <div className="flex min-w-0 items-center gap-1">{children}</div>
    </div>
  )
}
