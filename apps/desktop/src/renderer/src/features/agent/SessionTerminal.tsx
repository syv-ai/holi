/**
 * One agent session's terminal (D100).
 *
 * A vault runs several sessions and each is an ordinary tab (D100, D101), so the
 * xterm that was the drawer's single child is now one of N, each owning its own
 * scrollback, its own data tap and its own geometry. Every component here is
 * **mounted for as long as its session exists** and merely hidden when another
 * tab is showing: a terminal unmounted on tab switch would throw away its
 * scrollback and have to replay main's mirror to get it back, which is a repaint
 * the user can see.
 *
 * Every gotcha in here was paid for once already in `AgentPanel` and is kept
 * verbatim. They are each commented where they sit.
 */
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useCallback, useEffect, useRef } from 'react'
import { cn } from '@/lib/cn'
import { terminalKeyAction } from '@/lib/agent-terminal-keys'

/** Claude Code is an Ink TUI: it draws its own cursor, so xterm's would blink a
 * second one at the buffer end. Ink's init re-enables it (`\x1b[?25h`), hence
 * the re-apply after the first output. `?1004l` kills focus reporting, whose
 * `\x1b[I` would otherwise land in Claude's input box as stray characters. */
const HIDE_CURSOR = '\x1b[?25l'
const DISABLE_FOCUS_REPORTING = '\x1b[?1004l'

/** A hidden container measures 0×0, and FitAddon clamps that to its 2×1 minimum
 * instead of bailing — fitting there would SIGWINCH the PTY into a 2-column
 * sliver. (Today `display:none` doesn't even fire the observer, but that's one
 * CSS change away from being untrue.) */
const MIN_FITTABLE_PX = 10

/** Dim, italic line — session lifecycle notices printed into the scrollback. */
function notice(term: Terminal, text: string) {
  term.write(`\r\n\x1b[2;3m${text}\x1b[0m\r\n`)
}

export function SessionTerminal({
  sessionId,
  visible,
  onGeometry,
}: {
  sessionId: string
  /** This session's tab is the one showing. Drives the deferred build and the
   *  refit; the host is hidden rather than unmounted when false. */
  visible: boolean
  /** Every fit, so the panel can spawn the next session at a geometry that has
   *  actually been measured — a tab that has never been shown has none. */
  onGeometry?: (cols: number, rows: number) => void
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const disposeRef = useRef<(() => void) | null>(null)
  /** Claude's TUI rewrites cells constantly and drops xterm's live selection
   * before the user can reach for copy — keep the last one. */
  const selectionRef = useRef('')
  const lastSizeRef = useRef({ cols: 0, rows: 0 })
  const geometryRef = useRef(onGeometry)
  geometryRef.current = onGeometry

  /** Refit and tell the PTY the new geometry — xterm's cols/rows are the truth. */
  const syncSize = useCallback(() => {
    const term = termRef.current
    const fit = fitRef.current
    const host = hostRef.current
    if (!term || !fit || !host?.isConnected) return
    if (host.clientWidth < MIN_FITTABLE_PX || host.clientHeight < MIN_FITTABLE_PX) return
    try {
      fit.fit()
    } catch {
      return // not laid out yet
    }
    const { cols, rows } = term
    if (cols === lastSizeRef.current.cols && rows === lastSizeRef.current.rows) return // a redundant resize is a SIGWINCH → full TUI redraw
    lastSizeRef.current = { cols, rows }
    geometryRef.current?.(cols, rows)
    window.holi.agent.resize(sessionId, cols, rows)
  }, [sessionId])

  /**
   * Build the terminal on FIRST SHOW, not on mount.
   *
   * `term.open()` against a `display:none` host leaves xterm's renderer with
   * no measurements, and everything written afterwards silently fails to
   * paint — a live session in a blank panel. Main's mirror is what makes
   * deferring safe: whatever the PTY printed before this terminal existed is
   * replayed by `attach()`.
   *
   * Once built it lives for this session's lifetime, so scrollback survives a
   * tab switch with no replay and no repaint.
   */
  const build = useCallback(() => {
    const host = hostRef.current
    if (!host || termRef.current) return
    const term = new Terminal({
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
      scrollback: 10_000,
      cursorBlink: false, // Ink owns the cursor
      theme: { background: '#0a0a0a', foreground: '#e5e5e5' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    fitRef.current = fit

    const selection = term.onSelectionChange(() => {
      const selected = term.getSelection()
      if (selected) selectionRef.current = selected
    })

    /**
     * The panel's one key hook — see `agent-terminal-keys.ts` for which chords
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
          window.holi.agent.write(sessionId, action.seq)
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
            if (text) window.holi.agent.write(sessionId, text)
          })
          break
      }
      return false
    })

    // Filtered by session: every session's bytes arrive on one channel, and a
    // tab that wrote another tab's output would be the whole point of the ids
    // thrown away at the last step.
    const offData = window.holi.agent.onData((e) => {
      if (e.id === sessionId) term.write(e.data)
    })
    const offExit = window.holi.agent.onExit((e) => {
      if (e.id === sessionId) notice(term, `[session ended (code ${e.code})]`)
    })
    const typed = term.onData((data) => window.holi.agent.write(sessionId, data))

    // Replay what main's mirror recorded — output from before this terminal
    // existed, which for a session started in another tab is all of it — THEN
    // start taking live data.
    void (async () => {
      const state = await window.holi.agent.attach(sessionId)
      if (state) term.write(state)
      term.write(HIDE_CURSOR)
    })()

    // Ink's startup re-enables the cursor, so hiding it once is not enough for a
    // session that has only just spawned: its mirror is empty, the replay above
    // writes nothing, and Ink's `\x1b[?25h` arrives afterwards. Without this a
    // fresh tab shows xterm's cursor beside Claude's for the life of the session.
    const reHide = setTimeout(() => term.write(HIDE_CURSOR), 500)

    const observer = new ResizeObserver(() => syncSize())
    observer.observe(host)

    disposeRef.current = () => {
      clearTimeout(reHide)
      offData()
      offExit()
      typed.dispose()
      selection.dispose()
      observer.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      disposeRef.current = null
    }
  }, [sessionId, syncSize])

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
      data-session-terminal={sessionId}
      className={cn('min-h-0 flex-1 bg-background px-4 py-2', !visible && 'hidden')}
    />
  )
}
