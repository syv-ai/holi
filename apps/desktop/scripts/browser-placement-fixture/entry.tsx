import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { Provider, createStore } from 'jotai'
import { TooltipProvider } from '../../src/renderer/src/components/ui/tooltip'
import { BrowserSurface } from '../../src/plugins/browser/renderer/browser-surface'
import { browserEvents } from '../../src/plugins/browser/renderer/state'
import { activeRemoteAtom } from '../../src/renderer/src/plugin-api/index'
import '../../src/renderer/src/index.css'

const store = createStore()
store.set(activeRemoteAtom, 'bench')
window.qaPlatform.onEvent((event) => browserEvents[event.name]?.(event, store))

function Fixture() {
  const [visible, setVisible] = useState(true)
  const [twoPane, setTwoPane] = useState(false)
  const [overlay, setOverlay] = useState(false)
  const [transform, setTransform] = useState(false)
  const [animate, setAnimate] = useState(false)
  const [overlap, setOverlap] = useState(true)
  const [imperative, setImperative] = useState(false)
  const [split, setSplit] = useState(50)
  const [workload, setWorkload] = useState<string | null>(null)
  useEffect(() => {
    if (!imperative) return
    const host = document.querySelector('[data-browser-tab] > div:last-child')?.parentElement
    if (!(host instanceof HTMLElement))
      throw new Error('imperative placement animation host missing')
    const animation = host.animate(
      [{ transform: 'translateX(0px)' }, { transform: 'translateX(24px)' }],
      { duration: 1000, iterations: Infinity, direction: 'alternate' },
    )
    return () => animation.cancel()
  }, [imperative])
  useEffect(() => {
    if (!workload) return
    let step = 0
    const timer = window.setInterval(() => {
      step++
      if (workload === 'ancestor-scroll') window.scrollTo(0, (step % 8) * 80)
      if (workload === 'split-resize') setSplit(step % 2 ? 35 : 65)
    }, 250)
    return () => window.clearInterval(timer)
  }, [workload])
  window.bench = {
    setVisible,
    setTwoPane,
    setOverlay,
    setTransform,
    setAnimate,
    setOverlap,
    setImperative,
    startWorkload: setWorkload,
    stopWorkload: () => setWorkload(null),
    reset: () => {
      setVisible(true)
      setTwoPane(false)
      setOverlay(false)
      setTransform(false)
      setAnimate(false)
      setOverlap(true)
      setImperative(false)
      setSplit(50)
      setWorkload(null)
      window.scrollTo(0, 0)
    },
  }
  return (
    <Provider store={store}>
      <TooltipProvider>
        <main
          style={{
            display: 'flex',
            width: '100%',
            height: '200vh',
            transform: transform ? 'translateX(1px)' : undefined,
            animation: animate ? 'placement-drift 2s linear infinite alternate' : undefined,
          }}
        >
          <section style={{ flex: twoPane ? `${split} 1 0%` : 1, minWidth: 0 }}>
            <BrowserSurface id="bench-a" visible={visible} />
          </section>
          {twoPane ? (
            <section style={{ flex: `${100 - split} 1 0%`, minWidth: 0 }}>
              <BrowserSurface id="bench-b" visible={visible} />
            </section>
          ) : null}
        </main>
        <style>
          {
            '@keyframes placement-drift { from { transform: translateX(0) } to { transform: translateX(3px) } } @keyframes placement-overlay-move { from { transform: translateX(-8px) } to { transform: translateX(8px) } }'
          }
        </style>
        {overlay
          ? createPortal(
              <div
                role="dialog"
                aria-label="Benchmark overlay"
                style={{
                  position: 'fixed',
                  inset: overlap ? '20% 20%' : 'auto',
                  left: overlap ? undefined : '1400px',
                  top: overlap ? undefined : '900px',
                  width: overlap ? '60%' : '80px',
                  height: overlap ? '60%' : '80px',
                  zIndex: 9999,
                  background: 'white',
                  animation: overlap
                    ? 'placement-overlay-move 2s linear infinite alternate'
                    : undefined,
                }}
              >
                Overlay
              </div>,
              document.body,
            )
          : null}
      </TooltipProvider>
    </Provider>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)

declare global {
  interface Window {
    bench: {
      setVisible(value: boolean): void
      setTwoPane(value: boolean): void
      setOverlay(value: boolean): void
      setTransform(value: boolean): void
      setAnimate(value: boolean): void
      setOverlap(value: boolean): void
      setImperative(value: boolean): void
      startWorkload(name: string): void
      stopWorkload(): void
      reset(): void
    }
  }
}
