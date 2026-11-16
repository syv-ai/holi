import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useAtomValue, useStore } from 'jotai'
import { Kbd } from '@/components/ui/kbd'
import {
  activateHostHint,
  discoverHostHintTargets,
  HOST_HINT_REQUEST,
  HOST_HINT_SURFACE,
  captureHostHintAdapters,
  hostHintsUnchanged,
  registerHostHintSurface,
  type HostHintAdapter,
  type HostHintTarget,
} from '@/lib/host-hints'
import { vimCodeEditingAtom } from '@/state/preferences'
import { hostHintKeyAtom } from '@/state/shortcuts'
import { useShortcutHandlers } from '@/hooks/use-shortcuts'

interface HintSession {
  targets: HostHintTarget[]
  prefix: string
  adapter?: HostHintAdapter
  root: HTMLElement
  adapters: HostHintAdapter[]
}

/** The shell owns transient input; editors only request it through the library seam. */
export function HostHintLayer({ scopeKey }: { scopeKey: string }) {
  const enabled = useAtomValue(vimCodeEditingAtom)
  const store = useStore()
  const [session, setSession] = useState<HintSession | null>(null)
  const current = useRef<HintSession | null>(null)
  const unsubscribe = useRef<(() => void) | null>(null)
  const change = useCallback(
    (next: HintSession | null) => {
      if (next !== current.current) {
        unsubscribe.current?.()
        unsubscribe.current = null
      }
      current.current = next
      const sources = new Set([
        ...(next?.adapters ?? []),
        ...(next?.adapter ? [next.adapter] : []),
        ...(next?.targets.flatMap((target) => (target.adapter ? [target.adapter] : [])) ?? []),
      ])
      const disposers = [...sources]
        .filter((source) => source.subscribe)
        .map((source) =>
          source.subscribe!(
            () => change(null),
            (event) => {
              const route = store.get(hostHintKeyAtom)
              if (!route?.(event)) return false
              event.preventDefault()
              event.stopImmediatePropagation()
              return true
            },
          ),
        )
      if (disposers.length) unsubscribe.current = () => disposers.forEach((dispose) => dispose())
      setSession(next)
    },
    [store],
  )
  const start = useCallback(
    (
      source: Element | null = document.activeElement,
      adapter?: HostHintAdapter,
      scoped = false,
    ) => {
      const root =
        (scoped ? source?.closest<HTMLElement>('[data-panel-terminal]') : null) ??
        source?.closest<HTMLElement>('[data-pane]') ??
        document.querySelector<HTMLElement>('[data-pane-focused]') ??
        [...document.querySelectorAll<HTMLElement>('[data-pane]')].find(
          (pane) => !pane.closest('[inert],[hidden]'),
        ) ??
        document.body
      const adapters = adapter === undefined ? captureHostHintAdapters(root) : [adapter]
      const targets = discoverHostHintTargets(root, adapter)
      change(
        targets.length || adapters.length ? { targets, prefix: '', adapter, root, adapters } : null,
      )
    },
    [change],
  )
  useShortcutHandlers({
    'vim.hints': enabled
      ? () => {
          start()
        }
      : undefined,
  })

  useLayoutEffect(() => {
    const registered = new Map<
      ShadowRoot,
      { unregister: () => void; observer: MutationObserver; onScroll: () => void }
    >()
    const invalidate = () => {
      const active = current.current
      if (active && !hostHintsUnchanged(active.targets, active.adapter, active.root)) change(null)
    }
    const onSurface = (event: Event) => {
      const detail = (
        event as CustomEvent<{ root: ShadowRoot; owner: HTMLElement; registered: boolean }>
      ).detail
      if (!detail?.root || !detail.owner) return
      const previous = registered.get(detail.root)
      previous?.observer.disconnect()
      if (previous) detail.root.removeEventListener('scroll', previous.onScroll, true)
      previous?.unregister()
      if (detail.registered) {
        const observer = new MutationObserver(() => {
          if (current.current) change(null)
        })
        observer.observe(detail.root, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        })
        const onScroll = invalidate
        detail.root.addEventListener('scroll', onScroll, true)
        registered.set(detail.root, {
          unregister: registerHostHintSurface(detail.root, detail.owner),
          observer,
          onScroll,
        })
      } else registered.delete(detail.root)
      invalidate()
    }
    window.addEventListener(HOST_HINT_SURFACE, onSurface)
    window.dispatchEvent(new Event('holi:vim-host-hint-surface-request'))
    return () => {
      window.removeEventListener(HOST_HINT_SURFACE, onSurface)
      for (const [root, surface] of registered) {
        surface.observer.disconnect()
        root.removeEventListener('scroll', surface.onScroll, true)
        surface.unregister()
      }
      registered.clear()
    }
  }, [change])

  useLayoutEffect(() => {
    change(null)
    if (!enabled) return
    const cancel = () => change(null)
    const onRequest = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          source?: HTMLElement
          adapter?: HostHintAdapter
          scoped?: boolean
        }>
      ).detail
      start(detail?.source ?? null, detail?.adapter, detail?.scoped)
    }
    const onKey = (event: KeyboardEvent): boolean => {
      const active = current.current
      if (!active) return false
      if (!hostHintsUnchanged(active.targets, active.adapter, active.root)) {
        cancel()
        return (
          !event.isComposing &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          event.key !== '?'
        )
      }
      if (
        event.isComposing ||
        event.key === 'Process' ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.key === '?'
      ) {
        cancel()
        return false
      }
      if (event.key === 'Escape') {
        cancel()
        return true
      }
      if (event.repeat) return true
      if (event.key === 'Backspace') {
        change({ ...active, prefix: active.prefix.slice(0, -1) })
        return true
      }
      if (event.key.length !== 1 || event.shiftKey) {
        cancel()
        return false
      }
      const prefix = active.prefix + event.key
      const matches = active.targets.filter((target) => target.key.startsWith(prefix))
      const found = matches.find((target) => target.key === prefix)
      if (found) {
        cancel()
        activateHostHint(found)
      } else if (matches.length) change({ ...active, prefix })
      else cancel()
      return true
    }
    store.set(hostHintKeyAtom, () => onKey)
    window.addEventListener(HOST_HINT_REQUEST, onRequest)
    // Hints never move focus: cancellation leaves the original caret/control intact.
    window.addEventListener('pointerdown', cancel, true)
    window.addEventListener('focusin', cancel, true)
    window.addEventListener('compositionstart', cancel, true)
    window.addEventListener('blur', cancel)
    window.addEventListener('resize', cancel)
    window.addEventListener('scroll', cancel, true)
    const observer = new MutationObserver((records) => {
      if (
        !current.current ||
        records.every((record) => {
          const element =
            record.target instanceof Element ? record.target : record.target.parentElement
          if (element?.closest('[data-host-hints]')) return true
          return (
            record.type === 'childList' &&
            [...record.addedNodes, ...record.removedNodes].every(
              (node) => node instanceof Element && node.matches('[data-host-hints]'),
            )
          )
        })
      )
        return
      if (!hostHintsUnchanged(current.current.targets)) cancel()
    })
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    })
    return () => {
      unsubscribe.current?.()
      unsubscribe.current = null
      current.current = null
      store.set(hostHintKeyAtom, null)
      observer.disconnect()
      window.removeEventListener(HOST_HINT_REQUEST, onRequest)
      window.removeEventListener('pointerdown', cancel, true)
      window.removeEventListener('focusin', cancel, true)
      window.removeEventListener('compositionstart', cancel, true)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('resize', cancel)
      window.removeEventListener('scroll', cancel, true)
    }
  }, [enabled, scopeKey, store, change, start])

  if (!enabled || !session) return null
  // A fixed, pointer-transparent annotation layer, not a modal or focus trap.
  return createPortal(
    <div
      data-host-hints
      aria-label="Vim host hints"
      className="pointer-events-none fixed inset-0 z-60"
    >
      {session.targets
        .filter((target) => target.key.startsWith(session.prefix))
        .map((target) => (
          <Kbd
            key={target.key}
            aria-hidden="true"
            data-hint-key={target.key}
            data-hint-target={target.label}
            className="absolute top-(--hint-y) left-(--hint-x) -translate-x-1/2 -translate-y-1/2"
            style={{ '--hint-x': `${target.x}px`, '--hint-y': `${target.y}px` } as CSSProperties}
          >
            {target.key}
          </Kbd>
        ))}
    </div>,
    document.body,
  )
}
