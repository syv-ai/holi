/**
 * The quick agents' dock (docs/features/quick-agent.md): the page of the
 * agent's slim window at the right edge of the screen
 * (`RendererPlugin.pages.dock`). One dot per quick agent in its light's
 * colour, oldest at the top, so how many are working, waiting on you and done
 * reads at a glance.
 *
 * It shows what main says (`dock-view`), and answers with requests (`dock`):
 * the pointer on a dot brings that agent's panel out beside it, a click brings
 * it out with the keyboard. It reports its size and where each dot sits, so
 * main fits the window to it and sets a panel level with its dot.
 *
 * The window is the same HUD glass as the panels, and never has the keyboard;
 * the page paints only what sits on it, always in the dark scheme.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DockRequest, DockView } from '../../shared/quick'
import { LIGHT, STATE_WORDS } from './lights'
import './quick.css'
import { activeRemoteAtom, useVaultTheme } from '@/plugin-api'
import { Button } from '@/primitives'

const send = (request: DockRequest): void => window.holi.page.send('dock', request)

const NONE: ReadonlySet<string> = new Set()

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i])

/**
 * The dots new since the last list, which arrive. The first list main sends
 * is the window's own arrival, so nothing in it does (`null` until then).
 * Kept until the list changes again, so a re-render mid-arrival does not cut
 * it short, and committed in an effect, so StrictMode's second render
 * compares against the same list (as core's `useArrivals`).
 */
function useArriving(ids: readonly string[] | null): ReadonlySet<string> {
  const previous = useRef<readonly string[] | null>(null)
  const arriving = useRef<ReadonlySet<string>>(NONE)
  if (ids !== null && previous.current !== null && !sameIds(previous.current, ids)) {
    const before = new Set(previous.current)
    arriving.current = new Set(ids.filter((id) => !before.has(id)))
  }
  useEffect(() => {
    if (ids !== null) previous.current = ids
  })
  return arriving.current
}

export function QuickDock(): React.JSX.Element {
  const [view, setView] = useState<DockView | null>(null)
  const setRemote = useSetAtom(activeRemoteAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const dots = view?.dots ?? []
  const ids = dots.map((d) => d.id)
  const arriving = useArriving(view === null ? null : ids)
  const layout = ids.join('\n')

  // Dark HUD glass, as the panels are, wearing the open vault's dark colours:
  // its theme can recolour the lights, and a dot and its panel agree.
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = 'dark'
    document.documentElement.dataset.page = 'dock'
  }, [])
  useVaultTheme({ fill: false })
  useEffect(() => {
    const next = view?.remote ?? null
    if (next !== remote) setRemote(next)
  }, [view, remote, setRemote])

  // What main says, and then that the page is listening.
  useEffect(() => {
    const off = window.holi.page.on(({ name, payload }) => {
      if (name === 'dock-view') setView(payload as DockView)
    })
    send({ kind: 'ready' })
    return off
  }, [])

  // Its size, and each dot's centre measured down from its top: main fits the
  // window to it and brings a panel out level with its dot. Measured on the
  // slots, which never move, rather than the dots, which arrive.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (root === null) return
    const report = () => {
      const box = root.getBoundingClientRect()
      if (box.width <= 0 || box.height <= 0) return
      const centres = [...root.querySelectorAll<HTMLElement>('[data-dot]')].map((slot) => {
        const at = slot.getBoundingClientRect()
        return at.top + at.height / 2 - box.top
      })
      send({ kind: 'size', width: box.width, height: box.height, dots: centres })
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(root)
    return () => observer.disconnect()
  }, [layout])

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label="Quick agents"
      className="quick-dock"
      // Off the dock: the panel the pointer brought out goes, unless the
      // pointer went onto it.
      onMouseLeave={() => send({ kind: 'hover', id: null })}
    >
      {dots.map((dot) => {
        const selected = dot.id === view?.selected
        return (
          <Button
            key={dot.id}
            variant="ghost"
            // Driven by the pointer; the keyboard steps through the agents
            // from their panels.
            tabIndex={-1}
            data-dot={dot.id}
            data-light={LIGHT[dot.state]}
            data-selected={selected}
            aria-label={`${dot.name}, ${STATE_WORDS[dot.state]}`}
            aria-current={selected ? 'true' : undefined}
            onMouseEnter={() => send({ kind: 'hover', id: dot.id })}
            onClick={() => send({ kind: 'pick', id: dot.id })}
            className="quick-slot h-[18px] w-full rounded-none p-0 hover:bg-transparent focus-visible:ring-0 active:scale-100 dark:hover:bg-transparent"
          >
            <span className="quick-dot" data-arriving={arriving.has(dot.id)} aria-hidden>
              <span className="quick-dot-light" />
            </span>
          </Button>
        )
      })}
    </div>
  )
}
