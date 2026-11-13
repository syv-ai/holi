/**
 * One of Holi's terminals onto Claude Code: the agents list or one
 * background session, an ordinary tab with its own xterm, scrollback, data tap
 * and geometry.
 *
 * It stays **mounted for as long as its terminal exists** and is merely hidden
 * when another tab is showing: unmounting would throw away the scrollback and
 * replaying main's mirror to get it back is a visible repaint. When its client
 * exits (a detach, or its session stopped) the tab closes.
 */
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import './terminal.css'
import { useAtomValue, useSetAtom } from 'jotai'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { agentCap } from './agent-cap'
import { terminalKeyAction } from './lib/terminal-keys'
import { createPiMouseSelectionFilter } from './lib/pi-mouse-selection'
import { createPiWheelRouter } from './lib/pi-wheel-routing'
import { vaultLinks } from './lib/terminal-links'
import { terminalTheme, watchTerminalTheme, suppressTerminalColorQueries } from '@/plugin-api'
import {
  registerSessionTerminal,
  resizeTerminal,
  typeIntoTerminal,
  updateTerminalAppearance,
} from './lib/session-terminals'
import {
  activeRemoteAtom,
  activeSurfaceIdAtom,
  cn,
  openDocumentAtom,
  snapshotAtom,
  vaultsAtom,
} from '@/plugin-api'

/** Claude Code is an Ink TUI: it draws its own cursor, so xterm's would blink a
 * second one at the buffer end. Ink's init re-enables it (`\x1b[?25h`), hence
 * the re-apply after the first output. `?1004l` kills focus reporting, whose
 * `\x1b[I` would otherwise land in Claude's input box as stray characters. */
const HIDE_CURSOR = '\x1b[?25l'
const DISABLE_FOCUS_REPORTING = '\x1b[?1004l'

/** A hidden container measures 0×0, and FitAddon clamps that to its 2×1 minimum
 * instead of bailing: fitting there would SIGWINCH the PTY into a 2-column
 * sliver. */
const MIN_FITTABLE_PX = 10

export function SessionTerminal({
  terminalId,
  visible,
  onGeometry,
  provider,
  focusId = terminalId,
}: {
  terminalId: string
  /** The owning tab, when its selection names a session rather than a terminal. */
  focusId?: string
  /** This terminal's tab is the one showing. Drives the deferred build and the
   *  refit; the host is hidden rather than unmounted when false. */
  visible: boolean
  provider?: 'pi' | 'claude' | 'codex'
  /** Every fit, so the panel can spawn the next session at a geometry that has
   *  actually been measured — a tab that has never been shown has none. */
  onGeometry?: (cols: number, rows: number) => void
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  /** Where xterm actually opens: the box INSIDE the gutter. FitAddon sizes the
   *  terminal from its parent's computed size, which under `border-box` includes
   *  padding, so a padded host would draw rows and columns into the gutter. The
   *  gutter is the inset between the two boxes. */
  const mountRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const disposeRef = useRef<(() => void) | null>(null)
  /** Claude's TUI rewrites cells constantly and drops xterm's live selection
   * before the user can reach for copy — keep the last one. */
  const selectionRef = useRef('')
  const lastSizeRef = useRef({ cols: 0, rows: 0 })
  const geometryRef = useRef(onGeometry)
  geometryRef.current = onGeometry
  // The vault this terminal is in: every byte and resize says which, so main
  // can drop one that outlived a vault switch.
  const remote = useAtomValue(activeRemoteAtom)
  const focused = useAtomValue(activeSurfaceIdAtom('agent')) === focusId
  const focusedRef = useRef(focused)
  focusedRef.current = focused
  const lifetimeRef = useRef<{ remote: string; live: boolean } | null>(null)
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const remoteRef = useRef(remote)
  remoteRef.current = remote
  // What a path in the output may link to: the vault's files, and its clone's
  // root for an absolute path. Read through refs, so the provider registered
  // once sees the vault as it is now.
  const snapshot = useAtomValue(snapshotAtom)
  const root = useAtomValue(vaultsAtom).find((v) => v.remote === remote)?.path ?? null
  const paths = useMemo(
    () => new Set([...snapshot.docs.map((d) => d.path), ...snapshot.files.map((f) => f.path)]),
    [snapshot],
  )
  const linkRef = useRef({ paths, root })
  linkRef.current = { paths, root }
  const openDocument = useSetAtom(openDocumentAtom)
  const openRef = useRef(openDocument)
  openRef.current = openDocument
  /** Refit and tell the PTY the new geometry — xterm's cols/rows are the truth. */
  const syncSize = useCallback(
    (lifetime = lifetimeRef.current) => {
      if (
        !lifetime?.live ||
        lifetimeRef.current !== lifetime ||
        remoteRef.current !== lifetime.remote ||
        !visibleRef.current
      )
        return
      const term = termRef.current
      const fit = fitRef.current
      const mount = mountRef.current
      if (!term || !fit || !mount?.isConnected) return
      if (mount.clientWidth < MIN_FITTABLE_PX || mount.clientHeight < MIN_FITTABLE_PX) return
      try {
        fit.fit()
      } catch {
        return // not laid out yet
      }
      const { cols, rows } = term
      if (cols === lastSizeRef.current.cols && rows === lastSizeRef.current.rows) return // a redundant resize is a SIGWINCH → full TUI redraw
      lastSizeRef.current = { cols, rows }
      geometryRef.current?.(cols, rows)
      resizeTerminal(lifetime.remote, terminalId, cols, rows)
    },
    [terminalId],
  )

  /**
   * Build the terminal on FIRST SHOW, not on mount.
   *
   * `term.open()` against a `display:none` host leaves xterm's renderer with
   * no measurements, and everything written afterwards silently fails to
   * paint: a live session in a blank panel. Main's mirror is what makes
   * deferring safe: whatever the PTY printed before this terminal existed is
   * replayed by `attach()`.
   *
   * Once built it lives for this session's lifetime, so scrollback survives a
   * tab switch with no replay and no repaint.
   */
  const build = useCallback(() => {
    const mount = mountRef.current
    if (!mount || termRef.current || remote === null) return
    const lifetime = { remote, live: true }
    lifetimeRef.current = lifetime
    const isLive = () =>
      lifetime.live && lifetimeRef.current === lifetime && remoteRef.current === remote
    // onData includes xterm's automatic protocol replies. Keep those flowing
    // while hidden; disable only the textarea and our native input shortcuts.
    const sendData = (data: string) => {
      if (isLive()) typeIntoTerminal(remote, terminalId, data)
    }
    const type = (data: string) => {
      if (visibleRef.current) sendData(data)
    }
    selectionRef.current = ''
    lastSizeRef.current = { cols: 0, rows: 0 }
    const term = new Terminal({
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
      scrollback: 10_000,
      cursorBlink: false, // Ink owns the cursor
      // Native providers can cache explicit RGB text across appearance changes.
      // xterm adjusts glyph contrast without rewriting their cells or prompts.
      minimumContrastRatio: 4.5,
      // Inherit the pane's surface while using the same token-backed ANSI
      // palette as Holi's other terminal.
      allowTransparency: true,
      theme: terminalTheme(mount),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(mount)
    // The WebGL renderer, after `open` (it needs the element). The DOM one
    // corrects each glyph to the cell with a letter-spacing under 1/64px,
    // which Chromium rounds to nothing, so a full row drew a few px past the
    // grid and its last column was clipped. WebGL draws on the grid. A lost
    // context (the GPU reset, or too many terminals) falls back to DOM.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // No WebGL2 here: the DOM renderer stays.
    }
    termRef.current = term
    fitRef.current = fit
    // Its output, and, so a paste into this session can be followed by the
    // keyboard, its focus: see `session-terminals.ts` for the case the
    // visible effect below misses.
    const filterPiOutput = provider === 'pi' ? createPiMouseSelectionFilter() : undefined
    const wheelRouter = provider === 'pi' ? createPiWheelRouter(sendData) : undefined
    const writeOutput = (data: string) => {
      if (!isLive()) return
      wheelRouter?.observeOutput(data)
      const filtered = filterPiOutput ? filterPiOutput(data) : data
      if (filtered) term.write(filtered)
    }
    const unregister = registerSessionTerminal(terminalId, {
      focus: () => {
        if (isLive() && visibleRef.current) term.focus()
      },
      write: writeOutput,
    })

    const selection = term.onSelectionChange(() => {
      if (!isLive()) return
      const selected = term.getSelection()
      if (selected) selectionRef.current = selected
    })

    /**
     * The panel's one key hook: see `agent-terminal-keys.ts` for which chords
     * it claims and why.
     *
     * `preventDefault()` is load-bearing, not decoration: xterm returns early
     * from its own keydown when this handler answers `false`, WITHOUT
     * preventing the default, so the browser would go on to raise `keypress`
     * on the hidden textarea and the key would be sent a second time.
     */
    term.attachCustomKeyEventHandler((e) => {
      if (!isLive() || !visibleRef.current) return false
      const selected = term.getSelection() || selectionRef.current
      const action = terminalKeyAction(e, Boolean(selected), provider)
      if (!action) return true
      e.preventDefault()
      switch (action.kind) {
        case 'write':
          type(action.seq)
          break
        case 'scroll':
          if (action.to === 'top') term.scrollToTop()
          else term.scrollToBottom()
          break
        case 'copy':
          void navigator.clipboard.writeText(selected)
          break
        case 'paste':
          void navigator.clipboard.readText().then((text) => {
            if (text) type(text)
          })
          break
      }
      return false
    })

    const routeWheel = (event: WheelEvent) => {
      if (!isLive() || !visibleRef.current || !wheelRouter || !mount.isConnected) return
      // PTY observation leads xterm's asynchronous write queue. The live buffer
      // is authoritative: don't capture native wheel scrolling until xterm has
      // actually entered the alternate screen.
      if (term.buffer.active.type !== 'alternate') return
      const screen = mount.querySelector<HTMLElement>('.xterm-screen')
      if (!screen) return
      wheelRouter.onWheel(event, screen.getBoundingClientRect(), term.cols, term.rows)
    }
    mount.addEventListener('wheel', routeWheel, { capture: true, passive: false })

    const stopColorQueries = suppressTerminalColorQueries(term)
    const typed = term.onData(sendData)

    // A vault path in the output opens the file in a pane.
    const links = term.registerLinkProvider({
      provideLinks(y, callback) {
        const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? ''
        const { paths: known, root: clone } = linkRef.current
        const found = vaultLinks(text, (path) => known.has(path), clone)
        callback(
          found.length === 0
            ? undefined
            : found.map((link) => ({
                range: { start: { x: link.start + 1, y }, end: { x: link.end, y } },
                text: link.path,
                activate: () => openRef.current(link.path),
              })),
        )
      },
    })

    // Replay what main's mirror recorded (output from before this terminal
    // existed), THEN start taking live data.
    void (async () => {
      const state = await agentCap.attach(remote, { id: terminalId })
      if (!isLive()) return
      if (state) writeOutput(state)
      term.write(HIDE_CURSOR)
    })()

    // Ink's startup re-enables the cursor, so hiding it once is not enough for a
    // session that has only just spawned: its mirror is empty, the replay above
    // writes nothing, and Ink's `\x1b[?25h` arrives afterwards. Without this a
    // fresh tab shows xterm's cursor beside Claude's for the life of the session.
    const reHide = setTimeout(() => {
      if (isLive()) term.write(HIDE_CURSOR)
    }, 500)

    const observer = new ResizeObserver(() => syncSize(lifetime))
    observer.observe(mount)
    const syncAppearance = (theme: ReturnType<typeof terminalTheme>): void => {
      if (!isLive()) return
      term.options.theme = theme
      const { foreground, background, ...palette } = theme
      updateTerminalAppearance(remote, terminalId, {
        foreground,
        background,
        ...palette,
      })
    }
    syncAppearance(terminalTheme(mount))
    const stopWatchingTheme = watchTerminalTheme(mount, syncAppearance)

    disposeRef.current = () => {
      lifetime.live = false
      clearTimeout(reHide)
      unregister()
      mount.removeEventListener('wheel', routeWheel, true)
      typed.dispose()
      stopColorQueries()
      links.dispose()
      selection.dispose()
      observer.disconnect()
      stopWatchingTheme()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      disposeRef.current = null
    }
  }, [terminalId, provider, syncSize, remote])

  useEffect(() => () => disposeRef.current?.(), [remote, terminalId, provider])

  // Becoming visible is what builds it the first time and refits it every time:
  // the host was `display:none` a tick ago and has no final size yet, so wait
  // for flex layout to resolve (two rAFs) before measuring.
  useEffect(() => {
    if (!visible) {
      if (termRef.current?.textarea) termRef.current.textarea.disabled = true
      return
    }
    const initiatingControl = document.activeElement
    build()
    if (termRef.current?.textarea) termRef.current.textarea.disabled = false
    const term = termRef.current
    term?.write(DISABLE_FOCUS_REPORTING)
    const lifetime = lifetimeRef.current
    let live = true
    const refit = () => {
      if (live) syncSize(lifetime)
    }
    let innerFrame = 0
    const id = requestAnimationFrame(() => {
      if (!live) return
      innerFrame = requestAnimationFrame(() => {
        refit()
        // A newly shown active tab gets the keyboard, unless the person has
        // already focused a foreground control while layout was settling.
        const active = document.activeElement
        // Radix selects during mouse-down, before native focus reaches the
        // selected shell-tab trigger. That is still the opening gesture.
        const selectedTab = active?.closest('[role="tab"][aria-selected="true"]')
        const tabHandoff = Boolean(selectedTab?.closest('[data-slot="site-header"]'))
        if (
          live &&
          lifetime?.live &&
          remoteRef.current === lifetime.remote &&
          visibleRef.current &&
          focusedRef.current &&
          (active === initiatingControl ||
            tabHandoff ||
            active === document.body ||
            hostRef.current?.contains(active))
        )
          term?.focus()
      })
    })
    // A fit before xterm has measured its cells (a just-built terminal, a font
    // still loading) does nothing, and a pane that keeps its size never fires
    // the observer again: the program would stay at the 80×24 it opened at.
    // So fit again once the fonts are in and after the first output. A fit
    // that changes nothing sends nothing.
    void document.fonts?.ready.then(refit)
    const firstOutput = term?.onWriteParsed(() => {
      firstOutput?.dispose()
      refit()
    })
    const late = window.setTimeout(refit, 500)
    return () => {
      live = false
      cancelAnimationFrame(id)
      cancelAnimationFrame(innerFrame)
      window.clearTimeout(late)
      firstOutput?.dispose()
    }
  }, [visible, build, syncSize])

  return (
    // `hidden`, never unmounted: the scrollback and the scroll position are in
    // this xterm, and rebuilding them from the mirror is a repaint you can see.
    <div
      ref={hostRef}
      data-session-terminal={terminalId}
      className={cn('relative min-h-0 flex-1', !visible && 'hidden')}
    >
      {/* The gutter is the inset, not padding: xterm measures the box it is
          opened in, and an inset box measures what it is. 16px either side,
          the plugin panes' one left edge (`PaneToolbar`), 12px above and
          below. */}
      <div ref={mountRef} className="text-foreground absolute inset-x-4 inset-y-3" />
    </div>
  )
}
