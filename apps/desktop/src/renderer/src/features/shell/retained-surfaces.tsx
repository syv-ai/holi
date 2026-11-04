import { useAtomValue } from 'jotai'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { surfacesAtom } from '@/state/plugins'
import { shellWorkspaceAtom } from '@/state/shell-tabs'
import { allTabs } from '@/state/shell-workspace'
import { parseTabKey } from '@/state/tab-descriptor'
import { activeRemoteAtom } from '@/state/vaults'

/** One vault's visited surfaces, behind stable, connected portal hosts.
 * Slots may change with the shell layout; the iframe's document must not. */
export function useRetainedSurfaces(
  visibleKeys: readonly string[],
  render: (key: string, visible: boolean) => ReactNode,
): { slot: (key: string) => ReactNode; content: ReactNode } {
  const remote = useAtomValue(activeRemoteAtom)
  const workspace = useAtomValue(shellWorkspaceAtom)
  const surfaces = useAtomValue(surfacesAtom)
  const parking = useRef<HTMLDivElement>(null)
  const hosts = useRef(new Map<string, HTMLDivElement>())
  const [visited, setVisited] = useState({ remote, keys: [] as string[] })
  const visible = new Set(visibleKeys)
  const open = new Set(allTabs(workspace))
  const retained = (key: string) => {
    const tab = parseTabKey(key)
    return tab?.kind === 'surface' && surfaces.get(tab.surface)?.keepMounted === true
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
  const displayed = [...new Set([...visibleKeys, ...keys])]
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
    const live = new Set(displayed.map(identity))
    for (const [id, host] of hosts.current) {
      if (!live.has(id)) {
        host.remove()
        hosts.current.delete(id)
      }
    }
  })
  return {
    slot: (key) => <SurfaceSlot key={identity(key)} host={hostFor(key)} parking={parking} />,
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
    destination.moveBefore(host, null)
  } else {
    parent.appendChild(host)
  }
}

function SurfaceSlot({
  host,
  parking,
}: {
  host: HTMLDivElement
  parking: React.RefObject<HTMLDivElement | null>
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
        host.inert = true
        moveHost(home, host)
      }
    }
  }, [host, parking])
  return <div ref={slot} className="flex h-full min-h-0 w-full min-w-0 flex-1" />
}
