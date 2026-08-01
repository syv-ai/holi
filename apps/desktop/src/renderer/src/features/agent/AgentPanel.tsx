import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { History, RotateCw, X } from 'lucide-react'
import { useAtom, useAtomValue } from 'jotai'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ResizablePanel, Tooltip, type PanelImperativeHandle } from '@/primitives'
import { PanelHeader } from '@/composites'
import { cn } from '@/lib/cn'
import { DEFAULT_AGENT_PANEL_WIDTH, MIN_AGENT_PANEL_WIDTH } from '@/lib/agent-panel-geometry'
import { agentPanelOpenAtom, agentSeedPromptAtom, agentStatusAtom } from '@/state/agent'
import { activeRemoteAtom } from '@/state/vaults'

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
  // A vault's identity is its remote (D60); it is the id the manager matches
  // against `host.active().remote`.
  const activeRemote = useAtomValue(activeRemoteAtom)
  const [seedPrompt, setSeedPrompt] = useAtom(agentSeedPromptAtom)
  /** Imperative handle on the collapsible group panel — driven by `open` (below),
   *  so ⌘J and the reconcile trigger expand/collapse the panel instead of a bespoke
   *  width. The panel stays mounted while collapsed, so the PTY + scrollback live on. */
  const panelRef = useRef<PanelImperativeHandle | null>(null)
  /** True once the xterm is built and painted, so the reconcile-seed effect knows
   *  it can (re)start a session. A ref is not reactive — this state is. */
  const [terminalReady, setTerminalReady] = useState(false)
  /** Read by the open-effect's rAF so it skips its own auto-start when a reconcile
   *  seed is pending (the seed effect owns that start). */
  const seedPromptRef = useRef<string | null>(null)
  seedPromptRef.current = seedPrompt

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
    setTerminalReady(true) // the reconcile-seed effect waits on this

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
    async (resume: boolean, prompt?: string) => {
      const term = termRef.current
      if (!activeRemote || !term) return
      attachedRef.current = false
      // Spawn at the terminal's current (already-fitted) geometry, not a seed
      // size — Claude's TUI is then drawn at the pane's dimensions immediately,
      // with no gutter and no resize-to-catch-up. `prompt` seeds turn one (reconcile).
      const res = await window.holi.agent.start({
        vaultId: activeRemote,
        resume,
        cols: term.cols,
        rows: term.rows,
        prompt,
      })
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
    [activeRemote, setStatus],
  )

  // opening the drawer builds the terminal (first time) and starts a session
  useEffect(() => {
    if (!open) return
    initTerminal() // no-op after the first show
    const term = termRef.current
    term?.write(DISABLE_FOCUS_REPORTING)
    term?.focus()
    // The aside just flipped hidden→flex, so the host has no final size this
    // tick. Wait for flex layout to resolve (two rAFs), fit the terminal to the
    // real box, THEN start — so the PTY is born at the pane's geometry and fills
    // it from the first paint, rather than spawning small and resizing to catch up.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        syncSize()
        if (seedPromptRef.current !== null) {
          // A reconcile seed is pending — the seed effect owns the (re)start so
          // the prompt lands on turn one. Don't race it with a bare session.
        } else if (!runningRef.current) {
          void startSession(false)
        } else if (!attachedRef.current) {
          // a session that outlived this terminal (renderer reload) or was
          // started while the drawer was shut — replay it from main's mirror
          void (async () => {
            const state = await window.holi.agent.attach()
            if (state && term) term.write(state + HIDE_CURSOR)
            attachedRef.current = true
          })()
        }
      }),
    )
  }, [open, initTerminal, startSession, syncSize])

  // Reconcile: the "Ask Claude to reconcile" button set a seed prompt (and opened
  // the drawer). Once the terminal is built, (re)start the session so the merge
  // instruction is turn one — restarting even if one is already running, because
  // the seed cannot be injected into a session mid-conversation. Then clear it.
  useEffect(() => {
    if (seedPrompt === null || !terminalReady) return
    const term = termRef.current
    if (!term) return
    void (async () => {
      if (runningRef.current) await window.holi.agent.kill()
      term.reset()
      attachedRef.current = false
      await startSession(false, seedPrompt)
      setSeedPrompt(null)
    })()
  }, [seedPrompt, terminalReady, startSession, setSeedPrompt])

  // `open` is the source of truth; drive the panel to match. Deferred a frame:
  // the panel's imperative API throws "Group not found" if touched during the
  // mount commit (a child's effect runs before the parent Group has registered
  // itself), so rAF puts every collapse/expand safely after the group is live.
  // The panel mounts at its defaultSize, so the first frame collapses it closed.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const p = panelRef.current
      if (!p) return
      if (open && p.isCollapsed()) p.expand()
      else if (!open && !p.isCollapsed()) p.collapse()
    })
    return () => cancelAnimationFrame(id)
  }, [open])

  // Reconcile a *drag past the collapse threshold* back into `open`, so ⌘J and the
  // drawer never disagree (the actual TUI refit is the host ResizeObserver's job).
  // The mount call (prev === undefined) is skipped: the panel mounts at its
  // defaultSize, but `open` (closed) is what drives the initial collapse below —
  // acting on the mount size would spuriously open the drawer on every launch.
  const onPanelResize = (
    size: { inPixels: number },
    _id: string | number | undefined,
    prev: { inPixels: number } | undefined,
  ) => {
    if (prev === undefined) return
    const collapsed = size.inPixels < MIN_FITTABLE_PX
    if (collapsed && open) setOpen(false)
    else if (!collapsed && !open) setOpen(true)
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
      : 'bg-muted-foreground'
  // Spell out what the dot means — green alone is ambiguous. Driven by the
  // hook-server turn signal now (reliable), so the word is back.
  const state = status.working ? 'working…' : status.running ? 'running' : 'idle'
  const stateTitle = status.working
    ? 'Claude is working on your turn'
    : status.running
      ? 'session running — the vault assistant is live'
      : 'no session — opens when you show the drawer (⌘J)'

  return (
    <ResizablePanel
      id="agent"
      collapsible
      collapsedSize={0}
      defaultSize={DEFAULT_AGENT_PANEL_WIDTH}
      minSize={MIN_AGENT_PANEL_WIDTH}
      panelRef={panelRef}
      onResize={onPanelResize}
    >
      {/* Kept `hidden` when closed so the terminal is never built against a
          display:none host, and no stray content shows while the panel is a
          0-width sliver. The panel stays mounted either way. */}
      <aside
        className={cn('flex h-full min-w-0 flex-col border-l border-border', !open && 'hidden')}
      >
      {/* The shared panel bar. The agent's leading region is richer than a title —
          a status dot + state + config/auth notices — so it composes PanelHeader
          directly rather than via SidePanel. ⌘J lives on the close action here
          (bound while mounted), so it toggles the drawer from anywhere. */}
      <PanelHeader
        actions={[
          { icon: <History />, label: 'Resume a past session', onSelect: () => void history() },
          { icon: <RotateCw />, label: 'Restart session', onSelect: () => void restart() },
        ]}
        close={{
          icon: <X />,
          label: 'Hide agent panel',
          hotkey: '⌘J',
          onSelect: () => setOpen((o) => !o),
        }}
      >
        <Tooltip content={stateTitle}>
          <span className={cn('h-2 w-2 shrink-0 rounded-full', dot)} />
        </Tooltip>
        <span className="text-foreground">Claude</span>
        <Tooltip content={stateTitle}>
          <span className="text-muted-foreground">{state}</span>
        </Tooltip>
        {status.configStale && (
          <span className="truncate text-amber-400/80">shared config changed; restart to pick it up</span>
        )}
        {!status.authenticated && (
          <span className="truncate text-muted-foreground">not logged in (run /login below)</span>
        )}
      </PanelHeader>
      <div ref={hostRef} className="min-h-0 flex-1 bg-background px-2 py-1" />
      </aside>
    </ResizablePanel>
  )
}
