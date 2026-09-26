import { vaultAssetUrl } from '@/lib/vault-asset'

/**
 * Full-frame view for an image file opened from the tree. Fit-to-window
 * (`object-contain`), no zoom/pan.
 *
 * The image sits on a checkerboard plate (`.holi-image-plate`, index.css)
 * because an alpha channel is otherwise invisible (a black logo on
 * transparency renders as an empty pane). The plate is on the `<img>`, so an
 * opaque photo covers it.
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
