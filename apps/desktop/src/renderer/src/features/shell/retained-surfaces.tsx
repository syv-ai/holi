import { useAtomValue } from 'jotai'
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { surfacesAtom } from '@/state/plugins'
import { shellWorkspaceAtom } from '@/state/shell-tabs'
import { allTabs } from '@/state/shell-workspace'
import { parseTabKey } from '@/state/tab-descriptor'
import { activeRemoteAtom } from '@/state/vaults'
import { useSidebarApps } from '@/features/sidebar/sidebar-apps'

/** One vault's visited surfaces, behind stable, connected portal hosts.
 * Slots may change with the shell layout; the iframe's document must not. */
export function useRetainedSurfaces(
  visibleKeys: readonly string[],
  render: (key: string, visible: boolean) => ReactNode,
  retainKey: (key: string) => boolean = () => false,
): { slot: (key: string) => ReactNode; content: ReactNode } {
  const remote = useAtomValue(activeRemoteAtom)
  const workspace = useAtomValue(shellWorkspaceAtom)
  const surfaces = useAtomValue(surfacesAtom)
  const parking = useRef<HTMLDivElement>(null)
  const focusGuard = useRef<{
    release(host: HTMLElement): void
    parked(): void
  } | null>(null)
  const hosts = useRef(new Map<string, HTMLDivElement>())
  const releaseFocus = useCallback(
    (host: HTMLElement, parked = false) =>
      parked ? focusGuard.current?.parked() : focusGuard.current?.release(host),
    [],
  )
  const [visited, setVisited] = useState({ remote, keys: [] as string[] })
  const visible = new Set(visibleKeys)
  const apps = useSidebarApps()
  const open = new Set(allTabs(workspace))
  const retained = (key: string) => {
    const tab = parseTabKey(key)
    return (
      tab?.kind === 'graph' ||
      (tab?.kind === 'surface' && surfaces.get(tab.surface)?.keepMounted === true) ||
      (tab?.kind === 'vault-app' && surfaces.get('app')?.keepMounted === true) ||
      (tab?.kind === 'app' && apps.find((app) => app.id === tab.id)?.keepMounted === true) ||
      retainKey(key)
    )
  }
  const keep = new Set(
    visited.remote === remote ? visited.keys.filter((key) => open.has(key) && retained(key)) : [],
  )
  for (const key of visibleKeys) if (retained(key)) keep.add(key)
  const keys = [...keep]
  if (
    visited.remote !== remote ||
    keys.length !== visited.keys.length ||
    keys.some((key, i) => key !== visited.keys[i])
  ) {
    setVisited({ remote, keys })
  }
  // Keep retained portals in a stable sibling order as focus moves between tabs.
  // Their physical hosts move into visible slots below; React need not reorder them.
  const displayed = [...new Set([...keys, ...visibleKeys])]
  const identity = (key: string) => JSON.stringify([remote, key])
  function hostFor(key: string): HTMLDivElement {
    const id = identity(key)
    let host = hosts.current.get(id)
    if (host === undefined) {
      host = document.createElement('div')
      host.className = 'flex h-full min-h-0 w-full min-w-0 flex-col'
      host.dataset.paneHost = key
      hosts.current.set(id, host)
    }
    return host
  }
  useLayoutEffect(() => {
    const home = parking.current
    if (home === null) return
    const ownerDocument = home.ownerDocument
    const ownerWindow = ownerDocument.defaultView
    if (ownerWindow === null) return
    let lastOutside: HTMLElement | null = null
    let queued = false
    let timer: number | null = null
    let disposed = false
    const outside = (element: Element | null): element is HTMLElement =>
      element instanceof ownerWindow.HTMLElement &&
      !home.contains(element) &&
      element !== ownerDocument.body
    const focusBody = () => {
      const body = ownerDocument.body
      const original = body.getAttribute('tabindex')
      body.setAttribute('tabindex', '-1')
      try {
        body.focus({ preventScroll: true })
      } finally {
        if (original === null) body.removeAttribute('tabindex')
        else body.setAttribute('tabindex', original)
      }
    }
    const focusFallback = () => {
      const target = lastOutside
      if (target?.isConnected && outside(target) && target.closest('[inert]') === null) {
        target.focus({ preventScroll: true })
        if (ownerDocument.activeElement === target) return
      }
      focusBody()
    }
    const check = () => {
      if (disposed) return
      const active = ownerDocument.activeElement
      if (home.contains(active)) focusFallback()
      else if (outside(active)) lastOutside = active
    }
    const schedule = () => {
      if (queued) return
      queued = true
      queueMicrotask(() => {
        queued = false
        check()
      })
    }
    // A remote document can change frame focus without a parent DOM event.
    // Watch only while hosts are parked; no layout reads are needed.
    const watch = () => {
      if (disposed || timer !== null || home.querySelector('iframe') === null) return
      timer = ownerWindow.setTimeout(() => {
        timer = null
        check()
        watch()
      }, 250)
    }
    const syncWatch = () => {
      if (home.querySelector('iframe') === null) {
        if (timer !== null) ownerWindow.clearTimeout(timer)
        timer = null
      } else {
        watch()
      }
    }
    const observer = new ownerWindow.MutationObserver(syncWatch)
    observer.observe(home, { childList: true, subtree: true })
    const focusIn = (event: FocusEvent) => {
      if (outside(event.target as Element | null)) lastOutside = event.target as HTMLElement
      schedule()
    }
    const initial = ownerDocument.activeElement
    if (outside(initial)) lastOutside = initial
    ownerDocument.addEventListener('focusin', focusIn, true)
    ownerDocument.addEventListener('focus', schedule, true)
    ownerWindow.addEventListener('blur', schedule)
    ownerWindow.addEventListener('focus', schedule)
    const guard = {
      release(host: HTMLElement) {
        // A layout move can adopt this host into another visible slot in
        // this commit. Only reject focus if it ends up parked.
        if (host.contains(ownerDocument.activeElement)) schedule()
      },
      parked() {
        syncWatch()
      },
    }
    focusGuard.current = guard
    return () => {
      disposed = true
      queued = false
      if (timer !== null) ownerWindow.clearTimeout(timer)
      observer.disconnect()
      ownerDocument.removeEventListener('focusin', focusIn, true)
      ownerDocument.removeEventListener('focus', schedule, true)
      ownerWindow.removeEventListener('blur', schedule)
      ownerWindow.removeEventListener('focus', schedule)
      if (focusGuard.current === guard) focusGuard.current = null
    }
  }, [])
  useLayoutEffect(() => {
    const live = new Set(displayed.map(identity))
    for (const [id, host] of hosts.current) {
      if (!live.has(id)) {
        host.remove()
        hosts.current.delete(id)
      }
    }
  })
  return {
    slot: (key) => (
      <SurfaceSlot
        key={identity(key)}
        host={hostFor(key)}
        parking={parking}
        releaseFocus={releaseFocus}
      />
    ),
    content: (
      <>
        <div
          ref={parking}
          data-retained-parking=""
          aria-hidden="true"
          inert
          className="invisible pointer-events-none absolute left-0 top-0 h-0 w-0 overflow-hidden"
        />
        {displayed.map((key) =>
          createPortal(render(key, visible.has(key)), hostFor(key), identity(key)),
        )}
      </>
    ),
  }
}

/** Chromium's state-preserving move keeps a connected iframe alive. A new,
 * disconnected host has no browsing context to preserve on its first mount. */
function moveHost(parent: HTMLElement, host: HTMLElement): void {
  if (host.parentElement === parent) return
  if (host.isConnected && parent.isConnected) {
    const destination = parent as HTMLElement & {
      moveBefore(node: Node, before: Node | null): void
    }
    // Flush size/inert changes before the state-preserving move. Otherwise
    // Chromium can apply pending responsive layout in the new parent and clamp
    // an embedded document's scroll even though its browsing context survives.
    host.getBoundingClientRect()
    destination.moveBefore(host, null)
  } else {
    parent.appendChild(host)
  }
}

function SurfaceSlot({
  host,
  parking,
  releaseFocus,
}: {
  host: HTMLDivElement
  parking: React.RefObject<HTMLDivElement | null>
  releaseFocus(host: HTMLElement, parked?: boolean): void
}) {
  const slot = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const destination = slot.current
    const home = parking.current
    if (destination === null || home === null) return
    moveHost(destination, host)
    host.style.removeProperty('width')
    host.style.removeProperty('height')
    host.inert = false
    return () => {
      if (host.parentElement === destination) {
        const bounds = host.getBoundingClientRect()
        host.style.width = `${bounds.width}px`
        host.style.height = `${bounds.height}px`
        releaseFocus(host)
        host.inert = true
        moveHost(home, host)
        releaseFocus(host, true)
      }
    }
  }, [host, parking, releaseFocus])
  return <div ref={slot} className="flex h-full min-h-0 w-full min-w-0 flex-1" />
}
