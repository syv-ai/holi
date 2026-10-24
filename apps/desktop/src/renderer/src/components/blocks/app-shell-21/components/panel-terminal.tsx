import { useCallback, useEffect, useRef } from "react"
import { useAtomValue } from "jotai"
import { FitAddon } from "@xterm/addon-fit"
import { WebglAddon } from "@xterm/addon-webgl"
import { Terminal } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"

import { cn } from "@/lib/cn"
import { matchShortcutKey } from "@/lib/hotkey"
import { trpc } from "@/lib/trpc"
import { activeModeAtom } from "@/state/color-scheme"
import { registerTerminalSink } from "@/state/panel-terminals"
import { isMac } from "@/state/shortcuts"
import { activeRemoteAtom } from "@/state/vaults"

/**
 * One of the bottom panel's shells in an xterm (docs/features/status-bar.md).
 *
 * Mounted for as long as its shell exists and hidden while another is in
 * front or the panel is closed, so its scrollback survives both; built on
 * first show, because xterm opened in a `display:none` box never paints.
 * Its colours are the agent terminal's (`SessionTerminal.tsx`): no ground
 * of its own, in the view's text colour, re-read when light and dark swap.
 */

/** A hidden box measures 0×0, and fitting there would shrink the shell to
 *  two columns. */
const MIN_FITTABLE_PX = 10

/** The panel's own keys pass through xterm to the shell's dispatcher, or
 *  ⌃` would be typed into the shell and the panel could not close. */
const PANEL_KEYS = ["⌃`", "⇧⌘U"]

function themeFor(mount: HTMLElement) {
  return {
    background: "#00000000",
    foreground: getComputedStyle(mount).color,
    cursor: getComputedStyle(mount).color,
  }
}

export function PanelTerminal({
  id,
  visible,
}: {
  id: string
  /** In front, with the panel open. */
  visible: boolean
}) {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const disposeRef = useRef<(() => void) | null>(null)
  const lastSize = useRef({ cols: 0, rows: 0 })
  const remote = useAtomValue(activeRemoteAtom)
  const remoteRef = useRef(remote)
  remoteRef.current = remote
  const mode = useAtomValue(activeModeAtom)

  const syncSize = useCallback(() => {
    const term = termRef.current
    const fit = fitRef.current
    const mount = mountRef.current
    if (!term || !fit || !mount?.isConnected) return
    if (
      mount.clientWidth < MIN_FITTABLE_PX ||
      mount.clientHeight < MIN_FITTABLE_PX
    ) {
      return
    }
    try {
      fit.fit()
    } catch {
      return
    }
    const { cols, rows } = term
    if (cols === lastSize.current.cols && rows === lastSize.current.rows) {
      return
    }
    lastSize.current = { cols, rows }
    const at = remoteRef.current
    if (at !== null) {
      void trpc.terminal.resize
        .mutate({ remote: at, id, cols, rows })
        .catch(() => {})
    }
  }, [id])

  const build = useCallback(() => {
    const mount = mountRef.current
    if (!mount || termRef.current) return
    const term = new Terminal({
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
      scrollback: 10_000,
      allowTransparency: true,
      theme: themeFor(mount),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(mount)
    // WebGL draws on the cell grid (see SessionTerminal); a lost context
    // falls back to the DOM renderer.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // No WebGL2: the DOM renderer stays.
    }
    termRef.current = term
    fitRef.current = fit

    term.attachCustomKeyEventHandler(
      (e) => !PANEL_KEYS.some((spec) => matchShortcutKey(e, spec, isMac()))
    )
    const typed = term.onData((data) => {
      const at = remoteRef.current
      if (at !== null) {
        void trpc.terminal.write
          .mutate({ remote: at, id, data })
          .catch(() => {})
      }
    })

    // What it printed before this xterm existed, then live output. Pushes
    // that land before the replay answers are in it (see panel-terminals).
    let live = false
    const unregister = registerTerminalSink(id, (data) => {
      if (live) term.write(data)
    })
    const at = remoteRef.current
    void (
      at === null
        ? Promise.resolve("")
        : trpc.terminal.replay.query({ remote: at, id }).catch(() => "")
    ).then((text) => {
      if (text) term.write(text)
      live = true
    })

    const observer = new ResizeObserver(() => syncSize())
    observer.observe(mount)

    disposeRef.current = () => {
      unregister()
      typed.dispose()
      observer.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      disposeRef.current = null
    }
  }, [id, syncSize])

  useEffect(() => () => disposeRef.current?.(), [])

  // Shown: build the first time, refit and focus every time, once flex
  // layout has resolved (two frames).
  useEffect(() => {
    if (!visible) return
    build()
    termRef.current?.focus()
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => syncSize())
    )
    return () => cancelAnimationFrame(frame)
  }, [visible, build, syncSize])

  // Light and dark swap the text colour the terminal draws in.
  useEffect(() => {
    // A frame later: the theme's class lands on the root in its own effect.
    const frame = requestAnimationFrame(() => {
      const term = termRef.current
      const mount = mountRef.current
      if (term && mount) term.options.theme = themeFor(mount)
    })
    return () => cancelAnimationFrame(frame)
  }, [mode])

  return (
    <div
      data-panel-terminal={id}
      className={cn("relative min-h-0 flex-1", !visible && "hidden")}
    >
      {/* The gutter is an inset, not padding: xterm measures the box it
          opens in. */}
      <div
        ref={mountRef}
        className="text-foreground absolute inset-x-3 inset-y-2"
      />
    </div>
  )
}
