/**
 * An external write the editor could not merge, and the two ways out of it.
 *
 * It sits above the footer, beside the sync state it qualifies. Its own colours
 * come from `destructive` rather than a hardcoded palette, so a vault theme
 * reaches it like every other surface (D64) — it used to be literal ambers,
 * which is why it read as belonging to a different application.
 *
 * **The buttons are the point.** This banner used to name the problem and stop
 * there, leaving the user holding two versions of their file and no gesture for
 * either. Both choices destroy *something*, so neither is styled as the default
 * and both say which side they keep rather than "OK"/"Cancel".
 */
import { Button } from '@/primitives'
import type { ConflictResolvers } from '@/lib/editor-reload'

export function ConflictBanner({
  path,
  resolve,
  onDismiss,
}: {
  path: string
  resolve: ConflictResolvers
  onDismiss: () => void
}): React.JSX.Element {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-destructive/50 bg-destructive/15 px-3 py-1.5 text-[11px] text-foreground"
    >
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{path}</span> changed underneath your edit and could not be
        merged
      </span>
      <Button
        variant="outline"
        className="h-6 px-2 text-[11px]"
        onClick={() => {
          void resolve.keepMine()
          onDismiss()
        }}
      >
        Keep mine
      </Button>
      <Button
        variant="outline"
        className="h-6 px-2 text-[11px]"
        onClick={() => {
          resolve.takeDisk()
          onDismiss()
        }}
      >
        Use the file on disk
      </Button>
      {/* Dismiss resolves nothing, on purpose: it puts the banner away and leaves
          both versions where they are, which is the honest answer when you want
          to look at the file before choosing. */}
      <Button
        variant="ghost"
        className="h-6 px-2 text-[11px] text-muted-foreground"
        onClick={onDismiss}
      >
        Dismiss
      </Button>
    </div>
  )
}
