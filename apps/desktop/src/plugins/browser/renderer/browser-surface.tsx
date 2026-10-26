/**
 * A browser tab (docs/features/browser.md): its address bar and buttons,
 * and the place its page is drawn. The page itself is main's, laid over
 * that place: this tells main where it is, every frame it moves, and takes
 * it away while the tab is hidden.
 *
 * Nothing of Holi's can draw over a page, so while a menu, popover or
 * dialog overlaps it, the page is swapped for a still of itself and laid
 * back once the overlay has gone.
 */
import { useAtomValue } from 'jotai'
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  GlobeIcon,
  RotateCwIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/reui/alert'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { IconButton } from '@/composites/icon-button'
import { activeRemoteAtom, openExternal } from '@/plugin-api'
import { addressFor, type PageInfo } from '../shared/page'
import { browserCap } from './browser-cap'
import { addressAskAtom, BROWSER, pagesAtom } from './state'

/** What of Holi's can be drawn over a page: Radix's floating content and
 *  every dialog, each a child of `<body>` through its portal. */
const OVERLAY =
  '[data-radix-popper-content-wrapper], [role="dialog"], [role="alertdialog"], [data-slot$="-overlay"]'

/** How long a still may take before the page is moved aside without one. */
const STILL_MS = 120

interface Box {
  x: number
  y: number
  width: number
  height: number
}

const sameBox = (a: Box | null, b: Box | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height)

/** Whether anything in `OVERLAY` is drawn over `box`. */
function overlaid(box: Box): boolean {
  for (const el of document.body.children) {
    if (!el.matches(OVERLAY)) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    if (
      r.left < box.x + box.width &&
      r.right > box.x &&
      r.top < box.y + box.height &&
      r.bottom > box.y
    ) {
      return true
    }
  }
  return false
}

function place(remote: string, id: string, rect: Box | null): void {
  window.holi.plugin.send(BROWSER, { remote, name: 'place', payload: { id, rect } })
}

/**
 * Keep main's page over `host` while `on`: placed where `host` is drawn,
 * moved as it moves, swapped for a still while an overlay covers it, and
 * taken away when `on` turns off or the tab unmounts. The still, or null.
 */
function usePlacement(
  remote: string | null,
  id: string | undefined,
  on: boolean,
  host: React.RefObject<HTMLDivElement | null>,
): string | null {
  const [still, setStill] = useState<string | null>(null)
  useEffect(() => {
    if (!on || remote === null || id === undefined) return
    let frame = 0
    let sent: Box | null = null
    let covered = false
    let asking = 0
    const tick = (): void => {
      frame = requestAnimationFrame(tick)
      const el = host.current
      if (el === null) return
      const r = el.getBoundingClientRect()
      const box: Box | null =
        r.width < 1 || r.height < 1
          ? null
          : { x: r.left, y: r.top, width: r.width, height: r.height }
      const over = box !== null && overlaid(box)
      if (over && !covered) {
        covered = true
        const ask = ++asking
        // The still first, so the page is not missing while it is taken.
        const aside = (): void => {
          if (ask !== asking || !covered) return
          sent = null
          place(remote, id, null)
        }
        const late = setTimeout(aside, STILL_MS)
        void browserCap
          .still(remote, { tab: id })
          .then((image) => {
            if (ask === asking && covered) setStill(image)
          })
          .catch(() => {})
          .finally(() => {
            clearTimeout(late)
            aside()
          })
        return
      }
      if (over) return
      if (covered) {
        covered = false
        asking++
        setStill(null)
      }
      if (!sameBox(box, sent)) {
        sent = box
        place(remote, id, box)
      }
    }
    tick()
    return () => {
      cancelAnimationFrame(frame)
      asking++
      setStill(null)
      place(remote, id, null)
    }
  }, [on, remote, id, host])
  return still
}

/** The site's icon in the address bar, a spinner while it loads. */
function SiteMark({ page }: { page: PageInfo | undefined }) {
  const [failed, setFailed] = useState<string | null>(null)
  if (page?.loading) return <Spinner className="size-4" />
  const icon = page?.favicon ?? null
  if (icon === null || failed === icon) return <GlobeIcon aria-hidden="true" />
  return (
    <img
      src={icon}
      alt=""
      referrerPolicy="no-referrer"
      draggable={false}
      onError={() => setFailed(icon)}
      className="size-4 rounded-sm"
    />
  )
}

export function BrowserSurface({ id, visible }: { id?: string; visible: boolean }) {
  const remote = useAtomValue(activeRemoteAtom)
  const page = useAtomValue(pagesAtom).find((p) => p.id === id)
  const ask = useAtomValue(addressAskAtom)
  const host = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [typed, setTyped] = useState<string | null>(null)

  const showsPage = page !== undefined && page.url !== '' && page.error === null
  const still = usePlacement(remote, id, visible && showsPage, host)

  // ⌘L in the page: the address bar, its text selected.
  useEffect(() => {
    if (ask === null || ask.id !== id || !visible) return
    input.current?.focus()
    input.current?.select()
  }, [ask, id, visible])

  // A new tab starts in its address bar.
  const blank = page !== undefined && page.url === ''
  useEffect(() => {
    if (visible && blank) input.current?.focus()
  }, [visible, blank])

  if (id === undefined || remote === null) return null
  const tab = { tab: id }
  const run = (call: Promise<unknown>): void => void call.catch(() => {})

  const go = (): void => {
    const url = addressFor(typed ?? page?.url ?? '')
    if (url === null) return
    setTyped(null)
    input.current?.blur()
    run(browserCap.open(remote, { ...tab, url }))
  }

  return (
    <div className="bg-background flex h-full min-h-0 flex-col" data-browser-tab={id}>
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <IconButton
          type="button"
          label="Back"
          disabled={!page?.canGoBack}
          onClick={() => run(browserCap.back(remote, tab))}
        >
          <ArrowLeftIcon />
        </IconButton>
        <IconButton
          type="button"
          label="Forward"
          disabled={!page?.canGoForward}
          onClick={() => run(browserCap.forward(remote, tab))}
        >
          <ArrowRightIcon />
        </IconButton>
        {page?.loading ? (
          <IconButton type="button" label="Stop" onClick={() => run(browserCap.stop(remote, tab))}>
            <XIcon />
          </IconButton>
        ) : (
          <IconButton
            type="button"
            label="Reload"
            disabled={page === undefined || page.url === ''}
            onClick={() => run(browserCap.reload(remote, tab))}
          >
            <RotateCwIcon />
          </IconButton>
        )}
        <InputGroup className="flex-1">
          <InputGroupAddon>
            <SiteMark page={page} />
          </InputGroupAddon>
          <InputGroupInput
            ref={input}
            aria-label="Address"
            placeholder="Search or type an address"
            spellCheck={false}
            autoComplete="off"
            value={typed ?? page?.url ?? ''}
            onChange={(e) => setTyped(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={() => setTyped(null)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                go()
                return
              }
              if (e.key !== 'Escape') return
              setTyped(null)
              e.currentTarget.blur()
            }}
          />
          {page !== undefined && page.url !== '' ? (
            <InputGroupAddon align="inline-end">
              <Tooltip>
                <TooltipTrigger asChild>
                  <InputGroupButton
                    size="icon-xs"
                    aria-label="Open in your browser"
                    onClick={() => openExternal(page.url)}
                  >
                    <ExternalLinkIcon />
                  </InputGroupButton>
                </TooltipTrigger>
                <TooltipContent>Open in your browser</TooltipContent>
              </Tooltip>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
      </div>
      <div ref={host} className="relative min-h-0 flex-1">
        {page === undefined ? (
          <div className="flex flex-col gap-3 p-6" aria-label="Opening the page">
            <Skeleton className="h-6 w-1/3" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : page.error !== null ? (
          <div className="p-6">
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>This page didn’t load</AlertTitle>
              <AlertDescription>
                {page.error.description} {page.error.url}
              </AlertDescription>
              <AlertAction>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => run(browserCap.reload(remote, tab))}
                >
                  Retry
                </Button>
              </AlertAction>
            </Alert>
          </div>
        ) : page.url === '' ? (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <GlobeIcon />
              </EmptyMedia>
              <EmptyTitle>Go anywhere</EmptyTitle>
              <EmptyDescription>
                Search or type an address. The agent can use this tab too.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => input.current?.focus()}
              >
                Type an address
              </Button>
            </EmptyContent>
          </Empty>
        ) : still !== null ? (
          <img
            src={still}
            alt=""
            draggable={false}
            className="size-full object-cover object-left-top"
          />
        ) : null}
      </div>
    </div>
  )
}
