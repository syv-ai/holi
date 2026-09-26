/**
 * An external write the editor could not merge, and the two ways out of it.
 * Sits above the footer; colours from `destructive` so a vault theme reaches it
 * (D64). Both choices destroy something, so neither is styled as the default
 * and each says which side it keeps.
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
      {/* Dismiss resolves nothing, on purpose: both versions stay put so you
          can look before choosing. */}
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
