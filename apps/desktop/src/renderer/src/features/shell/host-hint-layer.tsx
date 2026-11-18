import { isHintPresentation, type HintPresentation } from '@holi/shared'
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

const ASYNC_HINT_DEADLINE_MS = 120
const MAX_PENDING_HINT_KEYS = 8

function withinDeadline<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(fallback), ASYNC_HINT_DEADLINE_MS)
    void promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      () => {
        window.clearTimeout(timer)
        resolve(fallback)
      },
    )
  })
}

function resolvedPresentation(): HintPresentation | undefined {
  const kbd = document.querySelector('[data-host-hint-presentation]')
  if (!kbd) return undefined
  const style = getComputedStyle(kbd)
  const presentation = {
    backgroundColor: style.backgroundColor,
    color: style.color,
    fontFamily: style.fontFamily,
    fontSize: parseFloat(style.fontSize),
    fontWeight: parseFloat(style.fontWeight),
    lineHeight: parseFloat(style.lineHeight),
    height: parseFloat(style.height),
    minWidth: parseFloat(style.minWidth),
    paddingInline: parseFloat(style.paddingLeft),
    paddingBlock: parseFloat(style.paddingTop),
    borderRadius: parseFloat(style.borderRadius),
    letterSpacing: style.letterSpacing === 'normal' ? 0 : parseFloat(style.letterSpacing),
  }
  return isHintPresentation(presentation) ? presentation : undefined
}

function presentWithinDeadline(
  source: AsyncHostHintAdapter,
  request: number,
  revision: number,
  labels: readonly { id: string; key: string }[],
): Promise<boolean> {
  return withinDeadline(
    Promise.resolve().then(() => source.present(request, revision, labels, resolvedPresentation())),
    false,
  )
}

interface HintSession {
  targets: HostHintTarget[]
  discoveryTargets: HostHintTarget[]
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
  const activations = useRef(new Set<() => void>())
  const preparation = useRef(0)
  const pendingPreparation = useRef<HostHintAdapter[]>([])
  const activating = useRef<number | null>(null)
  const requestNumber = useRef(0)
  const revisionNumber = useRef(0)
  const change = useCallback(
    (next: HintSession | null) => {
      const previous = current.current
      if (!next) for (const retire of [...activations.current]) retire()
      if (next?.request !== previous?.request) {
        preparation.current += 1
        for (const source of pendingPreparation.current) source.cancelPrepare?.()
        pendingPreparation.current = []
        unsubscribe.current?.()
        unsubscribe.current = null
        const lifetime = asyncLifetime.current
        if (lifetime) {
          lifetime.controller.abort()
          for (const source of previous?.asyncAdapters ?? []) source.clear(lifetime.request)
          asyncLifetime.current = null
        }
        for (const retire of [...activations.current]) retire()
      }
      current.current = next
      if (next && previous?.request === next.request && previous.prefix !== next.prefix) {
        const revision = ++revisionNumber.current
        const request = next.request
        for (const [source, labels] of next.asyncLabels) {
          void presentWithinDeadline(
            source,
            request,
            revision,
            labels.filter((label) => label.key.startsWith(next.prefix)),
          ).then((ok) => {
            if (!ok && current.current?.request === request && revisionNumber.current === revision)
              change(null)
          })
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
      if (activations.current.size > 0 || activating.current !== null) return
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
      const pending = adapters.filter((candidate) => candidate.prepare)
      const request = ++requestNumber.current
      const targets = pending.length ? [] : discoverHostHintTargets(root, adapter)
      if (!targets.length && !adapters.length && !asyncAdapters.length) {
        change(null)
        return
      }
      const controller = new AbortController()
      const next: HintSession = {
        targets: asyncAdapters.length ? [] : targets,
        discoveryTargets: targets,
        prefix: '',
        adapter,
        root,
        adapters,
        asyncAdapters,
        asyncTargets: new Map(),
        request,
        pending: asyncAdapters.length > 0 || pending.length > 0,
        buffered: '',
        asyncLabels: new Map(),
      }
      change(next)
      asyncLifetime.current = { request, controller }
      const preparationRequest = ++preparation.current
      pendingPreparation.current = pending
      const preparationPromise = Promise.all(pending.map((candidate) => candidate.prepare!()))
      if (asyncAdapters.length || pending.length) {
        const discoveries = Promise.all(
          asyncAdapters.map(
            async (source) =>
              [
                source,
                await withinDeadline(
                  Promise.resolve().then(() => source.discover(request, controller.signal)),
                  null,
                ),
              ] as const,
          ),
        )
        void Promise.all([discoveries, preparationPromise])
          .then(async ([results]) => {
            if (
              controller.signal.aborted ||
              current.current?.request !== request ||
              preparation.current !== preparationRequest ||
              !root.isConnected
            )
              return
            pendingPreparation.current = []
            const native = discoverHostHintTargets(root, adapter)
            const asyncTargets = new Map(
              results.filter(
                (entry): entry is readonly [AsyncHostHintAdapter, readonly AsyncHostHintTarget[]] =>
                  Boolean(entry[1]),
              ),
            )
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
            const initialRevision = ++revisionNumber.current
            const presented = await Promise.all(
              [...asyncTargets.keys()].map(
                async (source) =>
                  [
                    source,
                    await presentWithinDeadline(
                      source,
                      request,
                      initialRevision,
                      labelsBySource.get(source) ?? [],
                    ),
                  ] as const,
              ),
            )
            if (controller.signal.aborted || current.current?.request !== request) return
            const available = new Set(presented.filter(([, ok]) => ok).map(([source]) => source))
            const usableTargets = new Map(
              [...asyncTargets].filter(([source]) => available.has(source)),
            )
            for (const source of asyncAdapters) {
              if (!available.has(source)) {
                source.clear(request)
                labelsBySource.delete(source)
              }
            }
            const buffered = current.current.buffered
            const populated: HintSession = {
              ...current.current,
              targets: revisedTargets,
              discoveryTargets: native,
              asyncAdapters: asyncAdapters.filter((source) => available.has(source)),
              asyncTargets: usableTargets,
              asyncLabels: labelsBySource,
              pending: false,
              buffered: '',
            }
            change(populated)
            for (const key of buffered) {
              window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
            }
          })
          .catch(() => {
            if (current.current?.request === request) change(null)
          })
      } else {
        void preparationPromise.catch(() => {
          if (current.current?.request === request) change(null)
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
      if (active && !hostHintsUnchanged(active.discoveryTargets, active.adapter, active.root))
        change(null)
      if (!active) for (const retire of [...activations.current]) retire()
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
          else for (const retire of [...activations.current]) retire()
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
    const activationSet = activations.current
    change(null)
    if (!enabled) return
    const cancel = () => {
      change(null)
      for (const retire of [...activationSet]) retire()
    }
    const onRequest = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          source?: HTMLElement
          adapter?: HostHintAdapter
          scoped?: boolean
        }>
      ).detail
      cancel()
      start(detail?.source ?? null, detail?.adapter, detail?.scoped)
    }
    const onKey = (event: KeyboardEvent): boolean => {
      if (event.key === 'Escape' && activations.current.size > 0) {
        cancel()
        return true
      }
      const active = current.current
      if (!active) return false
      if (!hostHintsUnchanged(active.discoveryTargets, active.adapter, active.root)) {
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
      if (activating.current === active.request) {
        cancel()
        return true
      }
      if (active.pending) {
        if (event.key === 'Escape') {
          cancel()
          return true
        }
        if (event.key === 'Backspace') {
          change({ ...active, buffered: active.buffered.slice(0, -1) })
          return true
        }
        if (event.key.length === 1 && !event.shiftKey) {
          if (active.buffered.length >= MAX_PENDING_HINT_KEYS) {
            cancel()
            return true
          }
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
      const asyncMatches = [...active.asyncTargets].flatMap(([source, targets]) => {
        const labels = active.asyncLabels.get(source) ?? []
        return targets.flatMap((target) => {
          const label = labels.find((entry) => entry.id === target.id)
          return label?.key.startsWith(prefix) ? [{ source, target, key: label.key }] : []
        })
      })
      const matches = active.targets.filter((target) => target.key.startsWith(prefix))
      const found = matches.find((target) => target.key === prefix)
      const asyncFound = asyncMatches.find((entry) => entry.key === prefix)
      if (found) {
        activating.current = active.request
        void Promise.resolve(activateHostHint(found)).then(
          () => {
            if (current.current?.request === active.request) change(null)
            if (activating.current === active.request) activating.current = null
          },
          () => {
            if (current.current?.request === active.request) change(null)
            if (activating.current === active.request) activating.current = null
          },
        )
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
        let cleared = false
        const clearSelected = () => {
          if (cleared) return
          cleared = true
          activations.current.delete(clearSelected)
          unsubscribe.current?.()
          unsubscribe.current = null
          selected.clear(active.request)
        }
        activations.current.add(clearSelected)
        unsubscribe.current =
          selected.subscribe?.(
            active.request,
            () => cancel(),
            (event) => {
              if (event.key !== 'Escape' || activations.current.size === 0) return false
              event.preventDefault()
              event.stopImmediatePropagation()
              cancel()
              return true
            },
          ) ?? null
        void selected
          .activate(active.request, asyncFound.target.id)
          .catch(() => undefined)
          .finally(clearSelected)
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
    document.addEventListener('visibilitychange', cancel)
    window.addEventListener('resize', cancel)
    window.addEventListener('scroll', cancel, true)
    const observer = new MutationObserver((records) => {
      if (
        (!current.current && !activationSet.size) ||
        records.every((record) => {
          const element =
            record.target instanceof Element ? record.target : record.target.parentElement
          if (element?.closest('[data-host-hints],[data-host-hint-presentation]')) return true
          return (
            record.type === 'childList' &&
            [...record.addedNodes, ...record.removedNodes].every(
              (node) =>
                node instanceof Element &&
                node.matches('[data-host-hints],[data-host-hint-presentation]'),
            )
          )
        })
      )
        return
      const active = current.current
      if (active && !hostHintsUnchanged(active.discoveryTargets, active.adapter, active.root))
        cancel()
      else if (!active) cancel()
    })
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    })
    return () => {
      change(null)
      for (const clear of activationSet) clear()
      store.set(hostHintKeyAtom, null)
      observer.disconnect()
      window.removeEventListener(HOST_HINT_REQUEST, onRequest)
      window.removeEventListener('pointerdown', cancel, true)
      window.removeEventListener('focusin', cancel, true)
      window.removeEventListener('compositionstart', cancel, true)
      window.removeEventListener('blur', cancel)
      document.removeEventListener('visibilitychange', cancel)
      window.removeEventListener('resize', cancel)
      window.removeEventListener('scroll', cancel, true)
    }
  }, [enabled, scopeKey, store, change, start])

  if (!enabled) return null
  // A fixed, pointer-transparent annotation layer, not a modal or focus trap.
  return createPortal(
    <>
      <Kbd data-host-hint-presentation aria-hidden="true" className="invisible absolute">
        a
      </Kbd>
      {session ? (
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
                style={
                  { '--hint-x': `${target.x}px`, '--hint-y': `${target.y}px` } as CSSProperties
                }
              >
                {target.key}
              </Kbd>
            ))}
        </div>
      ) : null}
    </>,
    document.body,
  )
}
