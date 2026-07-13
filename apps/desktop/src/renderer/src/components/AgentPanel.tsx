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
  const runningRef = useRef(false)

  runningRef.current = status.running

  /** Refit and tell the PTY the new geometry — xterm's cols/rows are the truth. */
  const syncSize = useCallback(() => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit || !hostRef.current?.isConnected) return
    try {
      fit.fit()
    } catch {
      return // host not laid out yet (hidden panel)
    }
    if (runningRef.current) void window.holi.agent.resize(term.cols, term.rows)
  }, [])

  // ONE terminal for the panel's lifetime — the panel stays mounted when
  // hidden, so scrollback survives a close/reopen.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
      scrollback: 10_000,
      cursorBlink: true,
      theme: { background: '#0a0a0a', foreground: '#e5e5e5' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    fitRef.current = fit

    const offData = window.holi.agent.onData((data) => term.write(data))
    const offExit = window.holi.agent.onExit(({ code }) => notice(term, `[session ended (code ${code})]`))
    const offStatus = window.holi.agent.onStatus((next) => setStatus(next))
    const typed = term.onData((data) => void window.holi.agent.write(data))

    void window.holi.agent.status().then(setStatus)

    const observer = new ResizeObserver(() => syncSize())
    observer.observe(host)

    return () => {
      offData()
      offExit()
      offStatus()
      typed.dispose()
      observer.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [setStatus, syncSize])

  const startSession = useCallback(
    async (resume: boolean) => {
      if (!activeVaultId) return
      const res = await window.holi.agent.start({ vaultId: activeVaultId, resume })
      if (!res.ok && termRef.current) {
        termRef.current.write(`\r\n\x1b[31m${res.message}\x1b[0m\r\n`)
      }
      setStatus(await window.holi.agent.status())
    },
    [activeVaultId, setStatus],
  )

  // opening the drawer is what starts a session
  useEffect(() => {
    if (!open) return
    syncSize()
    termRef.current?.focus()
    if (!runningRef.current) void startSession(false)
  }, [open, startSession, syncSize])

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
    await startSession(false)
  }

  const history = async () => {
    await window.holi.agent.kill()
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
