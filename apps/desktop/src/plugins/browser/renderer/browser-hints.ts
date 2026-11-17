const HOST_HINT_REQUEST = 'holi:vim-host-hints'
import { requestHostHints, type AsyncHostHintAdapter } from '@/plugin-api'
import type { PageHintEvent, PageHintOwner, PageHintScope, PageHintSnapshot } from '../shared/page'
import { browserHintCap } from './browser-cap'

export interface BrowserHintContext {
  remote: string
  tab: string
  nonce: string
  attachment: string
  ownerElement: HTMLElement
  current(): boolean
}

interface Pending {
  wire: PageHintScope
  generation: number
  requestOrigin?: string
  owner?: PageHintOwner
}

const listeners = new Map<string, Set<(event: PageHintEvent) => void>>()
const requestHighWater = new Map<string, number>()
const idFor = (remote: string, tab: string) => `${remote}\u0000${tab}`
const requestKey = (context: BrowserHintContext) =>
  `${context.remote}\u0000${context.tab}\u0000${context.nonce}\u0000${context.attachment}`

export function dispatchBrowserHintEvent(remote: string, value: unknown): void {
  if (typeof value !== 'object' || value === null) return
  const event = value as PageHintEvent
  if (
    typeof event.tab !== 'string' ||
    typeof event.nonce !== 'string' ||
    typeof event.attachment !== 'string' ||
    typeof event.origin !== 'string' ||
    !Number.isSafeInteger(event.request) ||
    !['request', 'key', 'revoke'].includes(event.type) ||
    (event.type !== 'request' &&
      (!Number.isSafeInteger(event.snapshot) ||
        !Number.isSafeInteger(event.geometry) ||
        event.snapshot < 1 ||
        event.geometry < 0))
  )
    return
  for (const listener of listeners.get(idFor(remote, event.tab)) ?? []) listener(event)
}

/** Bridges page-owned requests to the shell coordinator without treating opaque owner origins as URLs. */
export function createBrowserHintAdapter(
  context: BrowserHintContext,
): AsyncHostHintAdapter & { dispose(): void } {
  const key = idFor(context.remote, context.tab)
  const subscriptions = new Set<() => void>()
  const pending = new Map<number, Pending>()
  const controllers = new Map<number, AbortController>()
  const invalidators = new Map<number, () => void>()
  const retired = new WeakSet<Pending>()
  let generation = 0
  const requestScopeKey = requestKey(context)
  let wireRequest = requestHighWater.get(requestScopeKey) ?? 0
  let snapshot: PageHintSnapshot | null = null
  let revision = 0
  let dead = false

  const alive = (gen = generation) => !dead && gen === generation && context.current()
  const clearWire = (wire: PageHintScope) => {
    void browserHintCap['hints-clear'](context.remote, wire).catch(() => undefined)
  }
  const retire = (request: number, item: Pending, clear = true) => {
    if (retired.has(item)) return
    retired.add(item)
    if (pending.get(request) === item) pending.delete(request)
    if (item.owner !== undefined && snapshot?.owner === item.owner) snapshot = null
    invalidators.delete(request)
    if (clear) clearWire(item.wire)
  }
  const matches = (event: PageHintEvent, item: Pending) => {
    if (event.request !== item.wire.request) return false
    if (event.type === 'request') return item.requestOrigin === event.origin
    const owner = item.owner
    return owner
      ? owner.tab === event.tab &&
          owner.nonce === event.nonce &&
          owner.attachment === event.attachment &&
          owner.request === event.request &&
          owner.origin === event.origin &&
          owner.snapshot === event.snapshot &&
          owner.geometry === event.geometry
      : item.requestOrigin === event.origin
  }
  const onPageEvent = (event: PageHintEvent) => {
    if (
      !alive() ||
      event.tab !== context.tab ||
      event.nonce !== context.nonce ||
      event.attachment !== context.attachment
    )
      return
    wireRequest = Math.max(wireRequest, event.request)
    requestHighWater.set(requestScopeKey, wireRequest)
    if (event.type === 'request') {
      const item: Pending = {
        wire: {
          tab: context.tab,
          nonce: context.nonce,
          attachment: context.attachment,
          request: event.request,
        },
        generation,
        requestOrigin: event.origin,
      }
      pending.set(-event.request, item)
      requestHostHints(context.ownerElement)
      return
    }
    const match = [...pending.entries()].find(([request, item]) => {
      return (event.type === 'revoke' || request > 0) && matches(event, item)
    })
    if (!match) return
    const [request, item] = match
    if (event.type === 'revoke') {
      // Let the owning coordinator observe this request while its scope is still live.
      if (request > 0) invalidators.get(request)?.()
      retire(request, item)
      return
    }
  }
  const set = listeners.get(key) ?? new Set<(event: PageHintEvent) => void>()
  set.add(onPageEvent)
  listeners.set(key, set)

  const adapter: AsyncHostHintAdapter & { dispose(): void } = {
    async discover(request, signal) {
      if (!alive()) return null
      const pagePending = [...pending.entries()].find(([n]) => n < 0)
      const wire = pagePending?.[1].wire ?? {
        tab: context.tab,
        nonce: context.nonce,
        attachment: context.attachment,
        request: (wireRequest = wireRequest + 1),
      }
      const requestOrigin = pagePending?.[1].requestOrigin
      if (pagePending) pending.delete(pagePending[0])
      wireRequest = Math.max(wireRequest, wire.request)
      requestHighWater.set(requestScopeKey, wireRequest)
      const gen = generation
      const controller = new AbortController()
      controllers.set(request, controller)
      signal.addEventListener('abort', () => controller.abort(), { once: true })
      const item: Pending = { wire, generation: gen, requestOrigin }
      pending.set(request, item)
      try {
        const found = await browserHintCap['hints-discover'](context.remote, wire)
        if (
          !alive(gen) ||
          signal.aborted ||
          controller.signal.aborted ||
          pending.get(request) !== item ||
          found === null
        )
          return null
        item.owner = found.owner as PageHintOwner
        snapshot = found
        revision = 0
        return found.targets.map(({ id, label, x, y }) => ({ id, label, x, y }))
      } catch {
        return null
      } finally {
        controllers.delete(request)
      }
    },
    async present(request, nextRevision, labels) {
      const item = pending.get(request)
      const found = snapshot
      if (
        !item ||
        !found ||
        !item.owner ||
        !alive(item.generation) ||
        found.owner !== item.owner ||
        nextRevision <= revision
      )
        return false
      revision = nextRevision
      try {
        const presented = await browserHintCap['hints-present'](context.remote, {
          owner: item.owner,
          p: {
            revision: nextRevision,
            labels,
            theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
          },
        })
        return presented && alive(item.generation) && pending.get(request) === item
      } catch {
        return false
      }
    },
    clear(request) {
      const item = pending.get(request)
      if (item) retire(request, item)
    },
    async activate(request, id) {
      const item = pending.get(request)
      const found = snapshot
      if (
        !item ||
        !found ||
        !item.owner ||
        !alive(item.generation) ||
        found.owner !== item.owner ||
        !found.targets.some((target) => target.id === id)
      )
        return false
      try {
        const activated = await browserHintCap['hints-activate'](context.remote, {
          owner: item.owner,
          p: { id },
        })
        return activated && alive(item.generation) && pending.get(request) === item
      } catch {
        return false
      } finally {
        // Keep the captured wire alive until settlement; a rotated request must not
        // prevent cleanup of this one, including when activation rejects.
        retire(request, item)
      }
    },
    subscribe(request, invalidate, routeKey) {
      invalidators.set(request, invalidate)
      const handler = (event: PageHintEvent) => {
        const item = pending.get(request)
        if (!item || !matches(event, item)) return
        if (event.type !== 'key' || !event.key) return
        const keyEvent = new KeyboardEvent('keydown', {
          key: event.key,
          code: event.code,
          repeat: event.repeat,
          isComposing: event.isComposing,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          bubbles: true,
          cancelable: true,
        })
        routeKey(keyEvent)
      }
      const eventSet = listeners.get(key) ?? new Set<(event: PageHintEvent) => void>()
      eventSet.add(handler)
      listeners.set(key, eventSet)
      const requestHandler = (event: Event) => {
        const detail = (event as CustomEvent<{ source?: HTMLElement }>).detail
        if (detail?.source === context.ownerElement) invalidate()
      }
      window.addEventListener(HOST_HINT_REQUEST, requestHandler)
      const off = () => {
        eventSet.delete(handler)
        window.removeEventListener(HOST_HINT_REQUEST, requestHandler)
        if (invalidators.get(request) === invalidate) invalidators.delete(request)
      }
      subscriptions.add(off)
      return () => {
        off()
        subscriptions.delete(off)
      }
    },
    dispose() {
      if (dead) return
      dead = true
      generation++
      for (const controller of controllers.values()) controller.abort()
      controllers.clear()
      // Unmounting this source can remove the page before its revoke event reaches us.
      // Retire the latest subscribed request while its coordinator callback is still
      // registered; unrelated host sessions have no callback here.
      const activeRequest = [...invalidators.keys()]
        .filter((request) => request > 0 && pending.has(request))
        .sort((a, b) => b - a)[0]
      if (activeRequest !== undefined) invalidators.get(activeRequest)?.()
      for (const [request, item] of [...pending]) {
        if (request > 0) retire(request, item)
      }
      for (const off of subscriptions) off()
      subscriptions.clear()
      set.delete(onPageEvent)
      if (set.size === 0) listeners.delete(key)
      pending.clear()
      snapshot = null
    },
  }
  return adapter
}
