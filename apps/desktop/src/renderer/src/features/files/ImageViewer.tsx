import { vaultAssetUrl } from '@/lib/vault-asset'

/**
 * Full-frame view for an image file opened from the tree. Fit-to-window
 * (`object-contain`), no zoom/pan (spec §Scope). Replaces FilePlaceholder's
 * `image` case; text/pdf/doc still go to the placeholder.
 *
 * The image sits on a checkerboard plate (`.holi-image-plate`, index.css)
 * because an alpha channel is otherwise invisible: this viewer's first real
 * subject was a black-ink logo on transparency, which rendered as an empty pane
 * with a filename under it. The plate is on the `<img>`, so it is exactly the
 * image's footprint — an opaque photo covers it and you never see it.
 */
export function ImageViewer({ path }: { path: string }) {
  const name = path.split('/').at(-1) ?? path
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-background p-6">
      <img
        src={vaultAssetUrl(path)}
        alt={name}
        className="holi-image-plate max-h-[calc(100%-2rem)] max-w-full rounded-sm object-contain"
      />
      <span className="text-sm text-muted-foreground">{name}</span>
    </div>
  )
}
