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
  captureAsyncHostHintAdapters,
  hintLabel,
  type AsyncHostHintAdapter,
  type AsyncHostHintTarget,
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
  asyncAdapters: AsyncHostHintAdapter[]
  asyncTargets: Map<AsyncHostHintAdapter, readonly AsyncHostHintTarget[]>
  request: number
  pending: boolean
  buffered: string
  asyncLabels: Map<AsyncHostHintAdapter, { id: string; key: string }[]>
}

/** The shell owns transient input; editors only request it through the library seam. */
export function HostHintLayer({ scopeKey }: { scopeKey: string }) {
  const enabled = useAtomValue(vimCodeEditingAtom)
  const store = useStore()
  const [session, setSession] = useState<HintSession | null>(null)
  const current = useRef<HintSession | null>(null)
  const unsubscribe = useRef<(() => void) | null>(null)
  const asyncLifetime = useRef<{ request: number; controller: AbortController } | null>(null)
  const requestNumber = useRef(0)
  const revisionNumber = useRef(0)
  const change = useCallback(
    (next: HintSession | null) => {
      const previous = current.current
      if (next?.request !== previous?.request) {
        unsubscribe.current?.()
        unsubscribe.current = null
        const lifetime = asyncLifetime.current
        if (lifetime) {
          lifetime.controller.abort()
          for (const source of previous?.asyncAdapters ?? []) source.clear(lifetime.request)
          asyncLifetime.current = null
        }
      }
      current.current = next
      if (next && previous?.request === next.request && previous.prefix !== next.prefix) {
        const revision = ++revisionNumber.current
        for (const [source, labels] of next.asyncLabels) {
          void source
            .present(
              next.request,
              revision,
              labels.filter((label) => label.key.startsWith(next.prefix)),
            )
            .catch(() => undefined)
        }
      }
      const sources = new Set([
        ...(next?.adapters ?? []),
        ...(next?.adapter ? [next.adapter] : []),
        ...(next?.targets.flatMap((target) => (target.adapter ? [target.adapter] : [])) ?? []),
      ])
      if (next?.request !== previous?.request) {
        const routeKey = (event: KeyboardEvent) => {
          const route = store.get(hostHintKeyAtom)
          if (!route?.(event)) return false
          event.preventDefault()
          event.stopImmediatePropagation()
          return true
        }
        const disposers = [...sources]
          .filter((source) => source.subscribe)
          .map((source) => source.subscribe!(() => change(null), routeKey))
        if (next) {
          for (const source of next.asyncAdapters) {
            disposers.push(source.subscribe(next.request, () => change(null), routeKey))
          }
        }
        if (disposers.length) unsubscribe.current = () => disposers.forEach((dispose) => dispose())
      }
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
      const asyncAdapters = captureAsyncHostHintAdapters(root)
      const targets = discoverHostHintTargets(root, adapter)
      const request = ++requestNumber.current
      if (!targets.length && !adapters.length && !asyncAdapters.length) {
        change(null)
        return
      }
      const controller = new AbortController()
      asyncLifetime.current = { request, controller }
      const next: HintSession = {
        targets,
        prefix: '',
        adapter,
        root,
        adapters,
        asyncAdapters,
        asyncTargets: new Map(),
        request,
        pending: asyncAdapters.length > 0,
        buffered: '',
        asyncLabels: new Map(),
      }
      change(next)
      if (asyncAdapters.length) {
        const discoveries = Promise.all(
          asyncAdapters.map(async (source) => {
            try {
              return [source, await source.discover(request, controller.signal)] as const
            } catch {
              return [source, null] as const
            }
          }),
        )
        void Promise.race([
          discoveries,
          new Promise<NonNullable<Awaited<typeof discoveries>>>((resolve) =>
            window.setTimeout(() => resolve([]), 120),
          ),
        ]).then((results) => {
          if (controller.signal.aborted || current.current?.request !== request) return
          const asyncTargets = new Map(
            results.filter(
              (entry): entry is readonly [AsyncHostHintAdapter, readonly AsyncHostHintTarget[]] =>
                Boolean(entry[1]),
            ),
          )
          const native = current.current.targets
          const entries = [
            ...native.map((target) => ({ x: target.x, y: target.y, target })),
            ...[...asyncTargets].flatMap(([source, items]) =>
              items.map((target) => ({ x: target.x, y: target.y, source, target })),
            ),
          ].sort((a, b) => a.y - b.y || a.x - b.x)
          const count = entries.length
          const labelsBySource = new Map<AsyncHostHintAdapter, { id: string; key: string }[]>()
          const revisedTargets = native.map((target) => ({ ...target, key: '' }))
          for (const entry of entries) {
            const key = hintLabel(entries.indexOf(entry), count)
            if ('source' in entry) {
              const labels = labelsBySource.get(entry.source) ?? []
              labels.push({ id: (entry.target as AsyncHostHintTarget).id, key })
              labelsBySource.set(entry.source, labels)
            } else {
              const target = entry.target as HostHintTarget
              const index = native.indexOf(target)
              if (index >= 0) revisedTargets[index] = { ...target, key }
            }
          }
          const populated = {
            ...current.current,
            targets: revisedTargets,
            asyncTargets,
            asyncLabels: labelsBySource,
            pending: false,
          }
          change(populated)
          void Promise.all(
            asyncAdapters.map(async (source) => {
              const labels = labelsBySource.get(source) ?? []
              try {
                await source.present(request, ++revisionNumber.current, labels)
              } catch {
                // An unavailable source should not take away hints from other sources.
              }
            }),
          )
          const lifetimePrefix = populated.buffered
          if (lifetimePrefix) {
            const latest = current.current
            if (latest?.request === request)
              change({ ...latest, prefix: lifetimePrefix, buffered: '' })
          }
        })
      }
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
      if (active.pending) {
        if (event.key === 'Backspace') {
          change({ ...active, buffered: active.buffered.slice(0, -1) })
          return true
        }
        if (event.key.length === 1 && !event.shiftKey) {
          change({ ...active, buffered: active.buffered + event.key })
          return true
        }
        cancel()
        return false
      }
      if (event.key === 'Backspace') {
        change({ ...active, prefix: active.prefix.slice(0, -1) })
        return true
      }
      if (event.key.length !== 1 || event.shiftKey) {
        cancel()
        return false
      }
      const prefix = active.prefix + event.key
      const asyncMatches = [...active.asyncTargets]
        .flatMap(([source, targets]) =>
          targets.map((target) => ({
            source,
            target,
            key: hintLabel(
              [...active.targets, ...[...active.asyncTargets.values()].flat()]
                .sort((a, b) => a.y - b.y || a.x - b.x)
                .findIndex((item) => item === target),
              active.targets.length +
                [...active.asyncTargets.values()].reduce((n, items) => n + items.length, 0),
            ),
          })),
        )
        .filter((entry) => entry.key.startsWith(prefix))
      const matches = active.targets.filter((target) => target.key.startsWith(prefix))
      const found = matches.find((target) => target.key === prefix)
      const asyncFound = asyncMatches.find((entry) => entry.key === prefix)
      if (found) {
        cancel()
        activateHostHint(found)
      } else if (asyncFound) {
        const selected = asyncFound.source
        unsubscribe.current?.()
        unsubscribe.current = null
        const lifetime = asyncLifetime.current
        asyncLifetime.current = null
        if (lifetime) {
          lifetime.controller.abort()
          for (const source of active.asyncAdapters)
            if (source !== selected) source.clear(active.request)
        }
        current.current = null
        setSession(null)
        void selected
          .activate(active.request, asyncFound.target.id)
          .catch(() => undefined)
          .finally(() => selected.clear(active.request))
      } else if (matches.length || asyncMatches.length) change({ ...active, prefix })
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
