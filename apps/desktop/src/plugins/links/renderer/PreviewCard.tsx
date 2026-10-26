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
import { ArrowUpRight, Globe } from 'lucide-react'
import { cn } from '@/plugin-api'
import { Icon } from '@/primitives'
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

/** The site's mark: its favicon, or a globe without one. Bare, since a
 *  favicon is drawn for whatever background a browser's tab has. */
function SiteMark({ icon }: { icon: string | undefined }) {
  const [failed, setFailed] = useState<string | null>(null)
  if (icon === undefined || failed === icon) {
    return <Icon icon={Globe} size="sm" tone="muted" />
  }
  return (
    <img
      src={icon}
      alt=""
      referrerPolicy="no-referrer"
      draggable={false}
      onError={() => setFailed(icon)}
      className="size-4 shrink-0 rounded-[4px]"
    />
  )
}

/** Lines standing in for the text while the page is asked. */
function Waiting() {
  return (
    <div className="mt-3 flex animate-pulse flex-col gap-2" aria-hidden="true">
      <div className="h-3.5 w-3/4 rounded-full bg-muted" />
      <div className="h-3 w-full rounded-full bg-muted/70" />
      <div className="h-3 w-2/3 rounded-full bg-muted/70" />
    </div>
  )
}

/**
 * `url`'s card, image above, inset within the card. The whole card is the
 * link: a click anywhere opens the page in the browser, and the card answers
 * the pointer (a lift of its surface, the image easing in, the arrow
 * nudging out). `floating` is a hover's, drawn on the surface of the popover
 * it is put in; otherwise it sits in a page (a link file's tab), centred and
 * wider, on a muted surface of its own, with the address in full. `title` is
 * what the vault calls it, shown when the page names nothing.
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
  const heading = preview?.title ?? title ?? hostOf(url)
  return (
    <a
      href={url}
      // Holi opens it: the window itself never navigates.
      onClick={(e) => {
        e.preventDefault()
        void window.holi.openExternal(url)
      }}
      draggable={false}
      className={cn(
        // The app's face, not the editor's it may sit in.
        'group/card flex cursor-pointer flex-col p-1.5 font-sans no-underline outline-none',
        'motion-respond active:scale-[0.99] focus-visible:ring-1 focus-visible:ring-ring',
        floating
          ? 'w-[22rem] hover:bg-accent/40'
          : 'mx-auto max-w-lg rounded-2xl bg-muted/50 hover:bg-muted/80',
      )}
    >
      <div className="overflow-hidden rounded-[10px]">
        <Picture
          src={preview?.image}
          className="motion-respond aspect-[1.91/1] w-full bg-muted object-cover group-hover/card:scale-[1.02]"
        />
      </div>
      <div className={cn('flex min-w-0 flex-col', floating ? 'px-3 pt-3 pb-3' : 'px-4 pt-4 pb-4')}>
        <div className="flex min-w-0 items-center gap-2">
          <SiteMark icon={preview?.icon} />
          <span className="truncate text-xs font-medium text-muted-foreground">
            {preview?.siteName ?? hostOf(url)}
          </span>
        </div>
        <div
          className={cn(
            'mt-2.5 line-clamp-2 leading-snug font-semibold tracking-tight text-foreground',
            floating ? 'text-[15px]' : 'text-base',
          )}
        >
          {heading}
        </div>
        {preview === null ? (
          <Waiting />
        ) : (
          preview.description !== undefined && (
            <p className="mt-1.5 line-clamp-3 text-[13px] leading-relaxed text-muted-foreground">
              {preview.description}
            </p>
          )
        )}
        <div className="mt-3 flex min-w-0 items-start gap-1.5 text-xs text-muted-foreground/70 group-hover/card:text-muted-foreground">
          <span className={cn('min-w-0', floating ? 'truncate' : 'break-all')}>
            {floating ? shownUrl(url) : url}
          </span>
          <Icon
            icon={ArrowUpRight}
            size="sm"
            className="motion-respond shrink-0 group-hover/card:translate-x-0.5 group-hover/card:-translate-y-0.5"
          />
        </div>
      </div>
    </a>
  )
}
