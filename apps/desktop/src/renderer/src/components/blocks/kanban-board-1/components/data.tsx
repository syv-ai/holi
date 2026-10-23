import type { StatusCategory } from "@holi/shared"

/** A column's tint, by what its status means: the block's six stage looks,
 *  narrowed to Holi's five categories. */
export interface ColumnLook {
  surfaceClassName: string
  borderClassName: string
  addClassName: string
}

export const COLUMN_LOOKS: Record<StatusCategory, ColumnLook> = {
  backlog: {
    surfaceClassName: "bg-muted/25 dark:bg-muted/10",
    borderClassName: "border-border",
    addClassName: "hover:border-muted-foreground/40 hover:bg-muted/35",
  },
  unstarted: {
    surfaceClassName: "bg-warning/[0.045] dark:bg-warning/10",
    borderClassName: "border-warning/20 dark:border-warning/25",
    addClassName: "hover:border-warning/35 hover:bg-warning/[0.06]",
  },
  started: {
    surfaceClassName: "bg-sky-500/[0.045] dark:bg-sky-400/10",
    borderClassName: "border-sky-500/20 dark:border-sky-400/25",
    addClassName: "hover:border-sky-500/35 hover:bg-sky-500/[0.06]",
  },
  review: {
    surfaceClassName: "bg-info/[0.045] dark:bg-info/10",
    borderClassName: "border-info/20 dark:border-info/25",
    addClassName: "hover:border-info/35 hover:bg-info/[0.06]",
  },
  completed: {
    surfaceClassName: "bg-success/[0.045] dark:bg-success/10",
    borderClassName: "border-success/20 dark:border-success/25",
    addClassName: "hover:border-success/35 hover:bg-success/[0.06]",
  },
}
