import { useAtomValue } from 'jotai'
import { useEffect, useRef, useState } from 'react'
import type { PanelImperativeHandle } from 'react-resizable-panels'

import { foldSidebarForAppsAtom } from '@/state/fold-sidebar'
import { leadWidth } from './title-bar'

/** Expanded width in pixels, and the drag point below which the rail takes over. */
export const SIDEBAR_WIDTH = 248
const RAIL_THRESHOLD = 190
/** Matches the panel transition, so state lands after the motion finishes. */
const SETTLE_MS = 280

/**
 * The sidebar's panel: open or folded to its rail, its width, and the
 * imperative parts of moving between them.
 *
 * The motion is driven by hand during a gesture: a React render there
 * re-renders the whole shell, and a flex transition cannot draw behind that.
 * So `toggleSidebar` and a drag set the fade, the pinned width and the title
 * band's lead on their elements directly, and React state (`sidebarOpen`,
 * `sidebarWidth`) catches up once the motion has finished.
 *
 * An app in front (`app`: Mail, Calendar) folds the files to the rail, unless
 * this machine's `foldSidebarForApps` is off; leaving it for any other tab
 * gives them back as they were.
 */
export function useSidebarFold(app: string | null) {
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_WIDTH)
  /** Armed on the first resize: any earlier and the first layout animates in. */
  const [animate, setAnimate] = useState(false)
  const sidebarPanel = useRef<PanelImperativeHandle>(null)
  const fadeRef = useRef<HTMLDivElement>(null)
  const pinRef = useRef<HTMLDivElement>(null)
  /** The title band's sidebar half, kept to the sidebar's width the same way. */
  const leadRef = useRef<HTMLDivElement>(null)
  const widthRef = useRef(SIDEBAR_WIDTH)
  const settling = useRef(false)
  const settleTimer = useRef<number | null>(null)
  const foldForApps = useAtomValue(foldSidebarForAppsAtom)
  /** Whether the files sidebar was open when an app came forward, so leaving
   *  the app gives it back as it was. */
  const openBeforeApp = useRef(false)
  const appBefore = useRef<string | null>(null)

  useEffect(() => {
    return () => {
      if (settleTimer.current) window.clearTimeout(settleTimer.current)
    }
  }, [])

  /** React state catches up only after the motion has finished. */
  function settleOpen(next: boolean) {
    if (settleTimer.current) window.clearTimeout(settleTimer.current)
    settling.current = true
    settleTimer.current = window.setTimeout(() => {
      settling.current = false
      setSidebarWidth(widthRef.current)
      setSidebarOpen(next)
    }, SETTLE_MS)
  }

  function toggleSidebar() {
    const panel = sidebarPanel.current
    if (!panel) return
    const next = panel.isCollapsed()
    fadeRef.current?.setAttribute('data-state', next ? 'open' : 'collapsed')
    // Guard first: collapse()/expand() fire onResize synchronously, and that
    // callback must not re-render the shell while the motion runs.
    settleOpen(next)
    if (next) panel.expand()
    else panel.collapse()
  }

  /** Open the sidebar if it is folded. */
  function showSidebar() {
    if (sidebarPanel.current?.isCollapsed()) toggleSidebar()
  }

  /** The panel's `onResize`, every frame of a drag or of the animated toggle. */
  function onPanelResize(size: { inPixels: number }) {
    // The band's divider follows the panel every frame, the animated toggle
    // included, so the two never part.
    const lead = leadRef.current
    if (lead) {
      const wide = size.inPixels > RAIL_THRESHOLD
      lead.style.setProperty('--lead-width', wide ? `${leadWidth(size.inPixels)}px` : '')
      lead.toggleAttribute('data-open', wide)
    }
    // Drags update everything else live too; the animated toggle updates
    // nothing else until it settles.
    if (!settling.current) {
      const open = size.inPixels > RAIL_THRESHOLD
      fadeRef.current?.setAttribute('data-state', open ? 'open' : 'collapsed')
      if (open && pinRef.current) {
        widthRef.current = size.inPixels
        pinRef.current.style.setProperty('--sidebar-pin', `${size.inPixels}px`)
      }
      setSidebarOpen(open)
    }
    setAnimate(true)
  }

  useEffect(() => {
    const was = appBefore.current
    appBefore.current = app
    const panel = sidebarPanel.current
    if (was === null && app !== null) {
      openBeforeApp.current = foldForApps && !!panel && !panel.isCollapsed()
      if (openBeforeApp.current) toggleSidebar()
    } else if (was !== null && app === null) {
      if (openBeforeApp.current && panel?.isCollapsed()) toggleSidebar()
    }
    // Only the app changing folds; the toggle reads the latest state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app])

  return {
    sidebarOpen,
    sidebarWidth,
    animate,
    sidebarPanel,
    fadeRef,
    pinRef,
    leadRef,
    toggleSidebar,
    showSidebar,
    onPanelResize,
  }
}
