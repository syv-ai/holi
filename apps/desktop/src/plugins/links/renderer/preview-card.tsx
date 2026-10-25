/**
 * A web page's card: its image, site, title and what it says about itself,
 * with a way to open it (docs/features/links.md). The one card every place
 * shows: the tree's hover and the top of a link file's tab.
 *
 * Images load straight from the page's site, never through the vault, with
 * no referrer. One that will not load is left out, and so is its slot: a
 * page that says nothing is its site and address alone.
 */
import { useState } from 'react'
import { ArrowUpRightIcon, GlobeIcon } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/plugin-api'
import { hostOf } from '../shared/preview'
import { usePreview } from './use-preview'

/** An image that leaves itself out when it will not load. */
function Picture({ src }: { src: string | undefined }) {
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
      className="bg-muted aspect-[1.91/1] w-full rounded-md object-cover"
    />
  )
}

/** The site's mark: its favicon, or a globe without one. */
function SiteMark({ icon }: { icon: string | undefined }) {
  const [failed, setFailed] = useState<string | null>(null)
  if (icon === undefined || failed === icon) {
    return <GlobeIcon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
  }
  return (
    <img
      src={icon}
      alt=""
      referrerPolicy="no-referrer"
      draggable={false}
      onError={() => setFailed(icon)}
      className="size-4 shrink-0 rounded-sm"
    />
  )
}

/** The address as a person reads it: host and path, no scheme, no `www.`. */
function shownUrl(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')
    return `${hostOf(url)}${path}`
  } catch {
    return url
  }
}

/**
 * `url`'s card. The whole card is the link: a click anywhere opens the page
 * in the browser. `floating` is a hover's, drawn on the hover card's own
 * surface; otherwise it sits on a tab, on a muted surface of its own, with
 * the address in full. `title` is what the vault calls it, shown when the
 * page names nothing.
 */
export function PreviewCard({
  url,
  title,
  floating = false,
}: {
  url: string
  title?: string
  floating?: boolean
}) {
  const preview = usePreview(url)
  const heading = preview?.title ?? title ?? hostOf(url)
  return (
    <a
      href={url}
      // Holi opens it: the window itself never navigates.
      onClick={(event) => {
        event.preventDefault()
        void window.holi.openExternal(url)
      }}
      draggable={false}
      data-link-card={url}
      className={cn(
        'group/card motion-respond focus-visible:ring-ring flex cursor-pointer flex-col gap-3 p-3 no-underline outline-none focus-visible:ring-1',
        floating ? 'hover:bg-accent/40 rounded-md' : 'bg-muted/50 hover:bg-muted rounded-xl',
      )}
    >
      <Picture src={preview?.image} />
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <SiteMark icon={preview?.icon} />
          <span className="text-muted-foreground truncate text-xs font-medium">
            {preview?.siteName ?? hostOf(url)}
          </span>
        </div>
        <span className="text-foreground line-clamp-2 text-sm font-semibold">{heading}</span>
        {preview === null ? (
          <div className="flex flex-col gap-1.5" aria-hidden="true">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ) : preview.description !== undefined ? (
          <p className="text-muted-foreground line-clamp-3 text-sm">{preview.description}</p>
        ) : null}
        <span className="text-muted-foreground flex min-w-0 items-start gap-1.5 text-xs">
          <span className={cn('min-w-0', floating ? 'truncate' : 'break-all')}>
            {floating ? shownUrl(url) : url}
          </span>
          <ArrowUpRightIcon
            className="motion-respond size-3.5 shrink-0 group-hover/card:translate-x-0.5 group-hover/card:-translate-y-0.5"
            aria-hidden="true"
          />
        </span>
      </div>
    </a>
  )
}
