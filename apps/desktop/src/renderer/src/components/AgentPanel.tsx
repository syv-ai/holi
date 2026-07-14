import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useAtom, useAtomValue } from 'jotai'
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import {
  clampPanelWidth,
  DEFAULT_AGENT_PANEL_WIDTH,
  MIN_AGENT_PANEL_WIDTH,
} from '../lib/agent-panel-geometry'
import { agentPanelOpenAtom, agentStatusAtom } from '../state/agent'
import { activeVaultIdAtom } from '../state/vaults'

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

export function AgentPanel() {
  const [open, setOpen] = useAtom(agentPanelOpenAtom)
  const [status, setStatus] = useAtom(agentStatusAtom)
  const activeVaultId = useAtomValue(activeVaultIdAtom)
  const [width, setWidth] = useState(DEFAULT_AGENT_PANEL_WIDTH)

  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const disposeRef = useRef<(() => void) | null>(null)
  const runningRef = useRef(false)
  /** Has THIS terminal taken main's mirror for the CURRENT session? Main only
   * streams to an attached renderer, so an unattached panel would sit dead. */
  const attachedRef = useRef(false)
  /** Claude's TUI rewrites cells constantly and drops xterm's live selection
   * before the user can reach for copy — keep the last one. */
  const selectionRef = useRef('')
  const lastSizeRef = useRef({ cols: 0, rows: 0 })

  runningRef.current = status.running

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
    if (runningRef.current) void window.holi.agent.resize(cols, rows)
  }, [])

  /**
   * Build the terminal on FIRST SHOW, not on mount.
   *
   * `term.open()` against a `display:none` host leaves xterm's renderer with
   * no measurements, and everything written afterwards silently fails to
   * paint — a live session in a blank panel. Main's mirror is what makes
   * deferring safe: whatever the PTY printed before this terminal existed is
   * replayed by `attach()`.
   *
   * Once built it lives for the panel's lifetime, so scrollback survives
   * hide/show.
   */
  const initTerminal = useCallback(() => {
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

    // Cmd/Ctrl+C with a selection copies (like a native terminal); without one
    // it must fall through to the PTY as SIGINT.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return true
      const selected = term.getSelection() || selectionRef.current
      if (e.code === 'KeyC' && selected) {
        void navigator.clipboard.writeText(selected)
        return false
      }
      if (e.code === 'KeyV') {
        void navigator.clipboard.readText().then((text) => {
          if (text) void window.holi.agent.write(text)
        })
        return false
      }
      return true
    })

    const offData = window.holi.agent.onData((data) => term.write(data))
    const offExit = window.holi.agent.onExit(({ code }) => notice(term, `[session ended (code ${code})]`))
    const offStatus = window.holi.agent.onStatus((next) => setStatus(next))
    const typed = term.onData((data) => void window.holi.agent.write(data))

    // Replay what main's mirror recorded (a live session from before this
    // mount — e.g. across a renderer reload), THEN start taking live data.
    void (async () => {
      const state = await window.holi.agent.attach()
      if (state) {
        term.write(state + HIDE_CURSOR)
        attachedRef.current = true
      }
      setStatus(await window.holi.agent.status())
    })()

    const observer = new ResizeObserver(() => syncSize())
    observer.observe(host)

    disposeRef.current = () => {
      offData()
      offExit()
      offStatus()
      typed.dispose()
      selection.dispose()
      observer.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      disposeRef.current = null
    }
  }, [setStatus, syncSize])

  // status still tracks without a terminal (the header dot works before the
  // drawer has ever been opened); the terminal itself is torn down on unmount.
  useEffect(() => {
    const offStatus = window.holi.agent.onStatus(setStatus)
    void window.holi.agent.status().then(setStatus)
    return () => {
      offStatus()
      disposeRef.current?.()
    }
  }, [setStatus])

  const startSession = useCallback(
    async (resume: boolean) => {
      const term = termRef.current
      if (!activeVaultId || !term) return
      attachedRef.current = false
      const res = await window.holi.agent.start({ vaultId: activeVaultId, resume })
      if (!res.ok) {
        term.write(`\r\n\x1b[31m${res.message}\x1b[0m\r\n`)
        return
      }
      await window.holi.agent.attach() // open the data tap for the new PTY
      attachedRef.current = true
      // Ink's startup re-enables the cursor; hide it again once it has drawn.
      setTimeout(() => term.write(HIDE_CURSOR), 500)
      setStatus(await window.holi.agent.status())
    },
    [activeVaultId, setStatus],
  )

  // opening the drawer builds the terminal (first time) and starts a session
  useEffect(() => {
    if (!open) return
    initTerminal() // no-op after the first show
    const term = termRef.current
    syncSize()
    term?.write(DISABLE_FOCUS_REPORTING)
    term?.focus()
    if (!runningRef.current) {
      void startSession(false)
    } else if (!attachedRef.current) {
      // a session that outlived this terminal (renderer reload) or was started
      // while the drawer was shut — replay it from main's mirror
      void (async () => {
        const state = await window.holi.agent.attach()
        if (state && term) term.write(state + HIDE_CURSOR)
        attachedRef.current = true
      })()
    }
  }, [open, initTerminal, startSession, syncSize])

  const onDragStart = (e: MouseEvent) => {
    e.preventDefault()
    const move = (ev: globalThis.MouseEvent) => {
      setWidth(clampPanelWidth(window.innerWidth - ev.clientX, window.innerWidth))
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      syncSize()
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const restart = async () => {
    await window.holi.agent.kill()
    termRef.current?.reset()
    await startSession(false)
  }

  const history = async () => {
    await window.holi.agent.kill()
    termRef.current?.reset()
    await startSession(true) // bare --resume: the CLI shows its own picker
  }

  const dot = status.working
    ? 'animate-pulse bg-amber-400'
    : status.running
      ? 'bg-green-500'
      : 'bg-neutral-600'

  return (
    <aside
      className={`${open ? 'flex' : 'hidden'} relative min-w-0 flex-col border-l border-neutral-900`}
      style={{ width, minWidth: MIN_AGENT_PANEL_WIDTH }}
    >
      <span
        className="absolute inset-y-0 left-0 w-1 cursor-col-resize hover:bg-neutral-700"
        onMouseDown={onDragStart}
        title="drag to resize"
      />
      <div className="flex items-center gap-2 border-b border-neutral-900 px-3 py-1.5 text-xs">
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
        <span className="text-neutral-300">Claude</span>
        {status.configStale && (
          <span className="truncate text-amber-400/80">shared config changed; restart to pick it up</span>
        )}
        {!status.authenticated && (
          <span className="truncate text-neutral-500">not logged in (run /login below)</span>
        )}
        <span className="flex-1" />
        <button
          className="rounded px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
          title="history (resume a past session)"
          onClick={() => void history()}
        >
          ⟲
        </button>
        <button
          className="rounded px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
          title="restart session"
          onClick={() => void restart()}
        >
          ↻
        </button>
        <button
          className="rounded px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
          title="hide (⌘J) — the session keeps running"
          onClick={() => setOpen(false)}
        >
          ✕
        </button>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 bg-neutral-950 px-2 py-1" />
    </aside>
  )
}
