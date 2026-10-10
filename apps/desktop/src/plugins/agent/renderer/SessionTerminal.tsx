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
import { useAtomValue } from 'jotai'
import { useCallback, useEffect, useRef } from 'react'
import { agentCap } from './agent-cap'
import { terminalKeyAction } from './lib/terminal-keys'
import { registerSessionTerminal, resizeTerminal, typeIntoTerminal } from './lib/session-terminals'
import { activeRemoteAtom, cn } from '@/plugin-api'

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
  glass = false,
}: {
  terminalId: string
  /** This terminal's tab is the one showing. Drives the deferred build and the
   *  refit; the host is hidden rather than unmounted when false. */
  visible: boolean
  /** Every fit, so the panel can spawn the next session at a geometry that has
   *  actually been measured — a tab that has never been shown has none. */
  onGeometry?: (cols: number, rows: number) => void
  /** Drawn on the quick panel's glass: no background of its own, and no
   *  gutter, since the panel frames it. */
  glass?: boolean
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
  const remoteRef = useRef(remote)
  remoteRef.current = remote
  const type = useCallback(
    (data: string) => {
      if (remoteRef.current !== null) typeIntoTerminal(remoteRef.current, terminalId, data)
    },
    [terminalId],
  )

  /** Refit and tell the PTY the new geometry — xterm's cols/rows are the truth. */
  const syncSize = useCallback(() => {
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
    if (remoteRef.current !== null) resizeTerminal(remoteRef.current, terminalId, cols, rows)
  }, [terminalId])

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
    if (!mount || termRef.current) return
    const term = new Terminal({
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
      scrollback: 10_000,
      cursorBlink: false, // Ink owns the cursor
      ...(glass
        ? {
            allowTransparency: true,
            // On glass the dim greys Claude Code draws in would sink into the
            // tint behind them: xterm lifts any colour below this contrast.
            minimumContrastRatio: 4.5,
            theme: { background: '#00000000', foreground: '#e5e5e5' },
          }
        : { theme: { background: '#0a0a0a', foreground: '#e5e5e5' } }),
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
    const unregister = registerSessionTerminal(terminalId, {
      focus: () => term.focus(),
      write: (data) => term.write(data),
    })

    const selection = term.onSelectionChange(() => {
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
      const selected = term.getSelection() || selectionRef.current
      const action = terminalKeyAction(e, Boolean(selected))
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

    const typed = term.onData(type)

    // Replay what main's mirror recorded (output from before this terminal
    // existed), THEN start taking live data.
    void (async () => {
      const state =
        remoteRef.current === null
          ? ''
          : await agentCap.attach(remoteRef.current, { id: terminalId })
      if (state) term.write(state)
      term.write(HIDE_CURSOR)
    })()

    // Ink's startup re-enables the cursor, so hiding it once is not enough for a
    // session that has only just spawned: its mirror is empty, the replay above
    // writes nothing, and Ink's `\x1b[?25h` arrives afterwards. Without this a
    // fresh tab shows xterm's cursor beside Claude's for the life of the session.
    const reHide = setTimeout(() => term.write(HIDE_CURSOR), 500)

    const observer = new ResizeObserver(() => syncSize())
    observer.observe(mount)

    disposeRef.current = () => {
      clearTimeout(reHide)
      unregister()
      typed.dispose()
      selection.dispose()
      observer.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      disposeRef.current = null
    }
  }, [terminalId, syncSize, type, glass])

  useEffect(() => () => disposeRef.current?.(), [])

  // Becoming visible is what builds it the first time and refits it every time:
  // the host was `display:none` a tick ago and has no final size yet, so wait
  // for flex layout to resolve (two rAFs) before measuring.
  useEffect(() => {
    if (!visible) return
    build()
    const term = termRef.current
    term?.write(DISABLE_FOCUS_REPORTING)
    term?.focus()
    const id = requestAnimationFrame(() => requestAnimationFrame(() => syncSize()))
    return () => cancelAnimationFrame(id)
  }, [visible, build, syncSize])

  return (
    // `hidden`, never unmounted: the scrollback and the scroll position are in
    // this xterm, and rebuilding them from the mirror is a repaint you can see.
    <div
      ref={hostRef}
      data-session-terminal={terminalId}
      className={cn('relative min-h-0 flex-1', !glass && 'bg-background', !visible && 'hidden')}
    >
      {/* The gutter is the inset, not padding: xterm measures the box it is
          opened in, and an inset box measures what it is. 24px either side,
          16px above and below; 8px on the quick panel, which frames it. */}
      <div ref={mountRef} className={glass ? 'absolute inset-2' : 'absolute inset-x-6 inset-y-4'} />
    </div>
  )
}
