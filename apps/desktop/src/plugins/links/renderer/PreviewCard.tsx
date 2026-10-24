/**
 * A web page's card: its image, site, title and what it says about itself,
 * with a way to open it (docs/features/links.md). The one card every place
 * shows: the tree's hover, the editor's hover over an address or a saved
 * link, and the top of a link file's tab.
 *
 * Images load straight from the page's site, never through the vault, with
 * no referrer. One that will not load is left out, and so is the image
 * slot: a page that says nothing is its site and address alone.
 */
import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { cn } from '@/plugin-api'
import { Button, Icon } from '@/primitives'
import { hostOf, type LinkPreview } from '../shared/preview'
import { usePreview } from './use-preview'

/** An image that leaves itself out when it will not load. */
function Picture({ src, className }: { src: string | undefined; className: string }) {
  const [failed, setFailed] = useState<string | null>(null)
  if (src === undefined || failed === src) return null
  return (
    <img
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      loading="lazy"
      draggable={false}
      onError={() => setFailed(src)}
      className={className}
    />
  )
}

function Body({
  url,
  preview,
  title,
  open,
}: {
  url: string
  preview: LinkPreview | null
  title: string | undefined
  open: boolean
}) {
  const heading = title ?? preview?.title ?? hostOf(url)
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1 p-3 pl-3.5">
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <Picture src={preview?.icon} className="size-3.5 shrink-0 rounded-sm" />
        <span className="truncate">{preview?.siteName ?? hostOf(url)}</span>
      </div>
      <div className="line-clamp-2 text-sm font-medium text-foreground">{heading}</div>
      {preview?.description !== undefined && (
        <p className="line-clamp-3 text-xs text-muted-foreground">{preview.description}</p>
      )}
      {open && (
        <Button
          variant="secondary"
          size="sm"
          className="mt-1.5 self-start pl-3"
          onClick={() => void window.holi.openExternal(url)}
        >
          Open
          <Icon icon={ExternalLink} size="sm" />
        </Button>
      )}
    </div>
  )
}

/**
 * `url`'s card, image above. `floating` is a hover's, drawn on the surface of
 * the popover it is put in. Otherwise it sits in a page (a link file's tab),
 * wider, on a muted surface of its own, with Open. `title` is what the vault
 * calls it, which wins over what the page says.
 */
export function PreviewCard({
  url,
  title,
  floating = false,
}: {
  url: string
  title?: string
  floating?: boolean
}): React.JSX.Element {
  const preview = usePreview(url)
  return (
    <div
      className={cn(
        // The app's face, not the editor's it may sit in.
        'font-sans',
        floating ? 'w-80' : 'max-w-md overflow-hidden rounded-lg bg-muted/60',
        preview === null && 'motion-respond opacity-70',
      )}
    >
      <Picture src={preview?.image} className="aspect-[1.91/1] w-full bg-muted object-cover" />
      <Body url={url} preview={preview} title={title} open={!floating} />
    </div>
  )
}
