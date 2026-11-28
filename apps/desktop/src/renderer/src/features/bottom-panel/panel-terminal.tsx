import { useCallback, useEffect, useRef } from 'react'
import { useAtomValue } from 'jotai'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal, type ILinkProvider } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

import { cn } from '@/lib/cn'
import { matchShortcutKey } from '@/lib/hotkey'
import { terminalFont, terminalTheme, watchTerminalTheme } from '@/lib/terminal-theme'
import { requestAdaptedHostHints, type HostHintAdapter } from '@/lib/host-hints'
import { vimCodeEditingAtom } from '@/state/preferences'
import { trpc } from '@/lib/trpc'
import { registerTerminalSink, type TerminalContext } from '@/state/panel-terminals'
import { isMac } from '@/lib/platform'
import { activeRemoteAtom } from '@/state/vaults'

import { TerminalContextChips } from './terminal-context-chips'
import { openExternal } from '@/lib/open-external'
import { createTerminalHintAdapter } from '@/lib/terminal-hints'

/**
 * One of the bottom panel's shells in an xterm (docs/features/status-bar.md).
 *
 * Mounted for as long as its shell exists and hidden while another is in
 * front or the panel is closed, so its scrollback survives both; built on
 * first show, because xterm opened in a `display:none` box never paints.
 * Above it, the context chips (where the shell is, its branch, its changes);
 * its colours are the app's tokens (`lib/terminal-theme.ts`): no ground of
 * its own, the view's text colour and a tuned ANSI palette, read again when
 * light and dark swap.
 */

/** A hidden box measures 0×0, and fitting there would shrink the shell to
 *  two columns. */
const MIN_FITTABLE_PX = 10

/** The panel's own keys pass through xterm to the shell's dispatcher, or
 *  ⌃` would be typed into the shell and the panel could not close. */
const PANEL_KEYS = ['⌃`', '⇧⌘U']

export function PanelTerminal({
  id,
  visible,
  context,
  exitCode,
}: {
  id: string
  /** In front, with the panel open. */
  visible: boolean
  /** Where it is and the git work there; null until main first reads it. */
  context: TerminalContext | null
  /** A stopped shell keeps its scrollback but cannot start link hints. */
  exitCode: number | null
}) {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const disposeRef = useRef<(() => void) | null>(null)
  const lastSize = useRef({ cols: 0, rows: 0 })
  const hintAdapterRef = useRef<HostHintAdapter | null>(null)
  const invalidateHintsRef = useRef<(() => void) | null>(null)
  const vimEnabled = useAtomValue(vimCodeEditingAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const previousRemote = useRef(remote)
  const remoteRef = useRef(remote)
  remoteRef.current = remote
  const remoteGeneration = useRef({ remote, generation: 0 })
  if (remoteGeneration.current.remote !== remote) {
    remoteGeneration.current = { remote, generation: remoteGeneration.current.generation + 1 }
  }
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const exitCodeRef = useRef(exitCode)
  exitCodeRef.current = exitCode

  const syncSize = useCallback(() => {
    const term = termRef.current
    const fit = fitRef.current
    const mount = mountRef.current
    if (!term || !fit || !mount?.isConnected) return
    if (mount.clientWidth < MIN_FITTABLE_PX || mount.clientHeight < MIN_FITTABLE_PX) {
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
      void trpc.terminal.resize.mutate({ remote: at, id, cols, rows }).catch(() => {})
    }
  }, [id])

  const build = useCallback(() => {
    const mount = mountRef.current
    if (!mount || termRef.current) return
    const term = new Terminal({
      fontSize: 12,
      lineHeight: 1.3,
      fontFamily: terminalFont(mount),
      cursorStyle: 'bar',
      cursorWidth: 2,
      cursorBlink: true,
      scrollback: 10_000,
      allowTransparency: true,
      theme: terminalTheme(mount),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // A URL in the output opens in the browser, through main.
    // Capture the addon's public provider registration. Hints and mouse use
    // this same recognizer and activation callback; no second URL parser.
    const registerLinkProvider = term.registerLinkProvider.bind(term)
    const linkProviders: ILinkProvider[] = []
    term.registerLinkProvider = ((provider: ILinkProvider) => {
      linkProviders.push(provider)
      return registerLinkProvider(provider)
    }) as Terminal['registerLinkProvider']
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault()
        openExternal(uri)
      }),
    )
    term.registerLinkProvider = registerLinkProvider
    let disposed = false
    let replayPending = true
    const boundRemote = remoteGeneration.current
    const terminalHints = createTerminalHintAdapter({
      term,
      mount,
      providers: linkProviders,
      isVisible: () => visibleRef.current,
      isCurrent: () =>
        !disposed &&
        !replayPending &&
        exitCodeRef.current === null &&
        remoteRef.current === boundRemote.remote &&
        remoteGeneration.current.generation === boundRemote.generation,
    })
    const adapter: HostHintAdapter = terminalHints.adapter
    hintAdapterRef.current = adapter
    invalidateHintsRef.current = terminalHints.invalidate
    const scroll = term.onScroll(terminalHints.invalidate)
    const resize = term.onResize(terminalHints.invalidate)
    const bufferChange = term.buffer.onBufferChange(terminalHints.invalidate)
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
      (e) => !PANEL_KEYS.some((spec) => matchShortcutKey(e, spec, isMac())),
    )
    const typed = term.onData((data) => {
      const at = remoteRef.current
      if (at !== null) {
        void trpc.terminal.write.mutate({ remote: at, id, data }).catch(() => {})
      }
    })

    // What it printed before this xterm existed, then live output. Pushes
    // that land before the replay answers are in it (see panel-terminals).
    let live = false
    const unregister = registerTerminalSink(id, (data) => {
      if (live && !disposed) void terminalHints.write(data)
    })
    const at = remoteRef.current
    void (
      at === null
        ? Promise.resolve('')
        : trpc.terminal.replay.query({ remote: at, id }).catch(() => '')
    ).then((text) => {
      if (disposed) return
      live = true
      const replay = text ? terminalHints.write(text) : Promise.resolve()
      void replay.then(() => {
        if (disposed) return
        replayPending = false
        terminalHints.invalidate()
      })
    })

    const stopWatchingTheme = watchTerminalTheme(mount, (theme) => {
      const current = termRef.current
      if (current) current.options.theme = theme
    })
    const observer = new ResizeObserver(() => syncSize())
    observer.observe(mount)

    disposeRef.current = () => {
      unregister()
      typed.dispose()
      disposed = true
      terminalHints.dispose()
      invalidateHintsRef.current = null
      scroll.dispose()
      resize.dispose()
      bufferChange.dispose()
      hintAdapterRef.current = null
      observer.disconnect()
      stopWatchingTheme()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      disposeRef.current = null
    }
  }, [id, syncSize])

  useEffect(() => {
    if (!visible || previousRemote.current !== remote) invalidateHintsRef.current?.()
    previousRemote.current = remote
  }, [visible, remote])

  useEffect(() => {
    invalidateHintsRef.current?.()
  }, [exitCode])

  useEffect(() => {
    const onHintRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string }>).detail
      if (
        detail?.id !== id ||
        !visibleRef.current ||
        exitCodeRef.current !== null ||
        !vimEnabled ||
        !termRef.current
      )
        return
      const terminal = mountRef.current?.querySelector<HTMLElement>('.xterm-helper-textarea')
      terminal?.focus()
      const root = mountRef.current?.closest<HTMLElement>('[data-panel-terminal]')
      if (root && hintAdapterRef.current) requestAdaptedHostHints(root, hintAdapterRef.current)
    }
    window.addEventListener('holi:show-panel-terminal-hints', onHintRequest)
    return () => window.removeEventListener('holi:show-panel-terminal-hints', onHintRequest)
  }, [id, visible, vimEnabled])

  useEffect(() => () => disposeRef.current?.(), [])

  // Shown: build the first time, refit and focus every time, once flex
  // layout has resolved (two frames). The first build waits for the mono
  // font, or xterm measures its cells in the fallback's.
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let frame = 0
    const show = () => {
      if (cancelled) return
      build()
      termRef.current?.focus()
      frame = requestAnimationFrame(() => requestAnimationFrame(() => syncSize()))
    }
    const mount = mountRef.current
    if (termRef.current || !mount || !document.fonts) show()
    else {
      void document.fonts
        .load(`12px ${terminalFont(mount)}`)
        .catch(() => [])
        .then(show)
    }
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [visible, build, syncSize])

  return (
    <div
      data-panel-terminal={id}
      className={cn('flex min-h-0 flex-1 flex-col', !visible && 'hidden')}
    >
      <TerminalContextChips context={context} className="px-3 pt-2.5" />
      <div className="relative min-h-0 flex-1">
        {/* The gutter is an inset, not padding: xterm measures the box it
            opens in. */}
        <div ref={mountRef} className="text-foreground absolute inset-3" />
      </div>
    </div>
  )
}
