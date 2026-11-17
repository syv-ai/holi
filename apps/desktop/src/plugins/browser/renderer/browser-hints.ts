const HOST_HINT_REQUEST = 'holi:vim-host-hints'
import { requestHostHints, type AsyncHostHintAdapter } from '@/plugin-api'
import type { PageHintEvent, PageHintOwner, PageHintScope, PageHintSnapshot } from '../shared/page'
import { browserHintCap } from './browser-cap'

export interface BrowserHintContext {
  remote: string
  tab: string
  nonce: string
  attachment: string
  origin: string
  ownerElement: HTMLElement
  current(): boolean
}

interface Pending {
  wire: PageHintScope
  generation: number
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
    !['request', 'key', 'revoke'].includes(event.type)
  )
    return
  for (const listener of listeners.get(idFor(remote, event.tab)) ?? []) listener(event)
}

/** Bridges the page-owned hint protocol to the shell's request-scoped host-hint coordinator. */
export function createBrowserHintAdapter(
  context: BrowserHintContext,
): AsyncHostHintAdapter & { dispose(): void } {
  const key = idFor(context.remote, context.tab)
  const subscriptions = new Set<() => void>()
  const pending = new Map<number, Pending>()
  const controllers = new Map<number, AbortController>()
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
  const clearCurrent = () => {
    const old = [...pending.values()]
    pending.clear()
    snapshot = null
    for (const item of old) clearWire(item.wire)
  }
  const onPageEvent = (event: PageHintEvent) => {
    if (
      !alive() ||
      event.tab !== context.tab ||
      event.nonce !== context.nonce ||
      event.attachment !== context.attachment ||
      event.origin !== context.origin
    )
      return
    wireRequest = Math.max(wireRequest, event.request)
    requestHighWater.set(requestScopeKey, wireRequest)
    if (event.type === 'revoke') {
      generation++
      clearCurrent()
      for (const controller of controllers.values()) controller.abort()
      controllers.clear()
      return
    }
    if (event.type === 'request') {
      pending.set(-event.request, {
        wire: {
          tab: context.tab,
          nonce: context.nonce,
          attachment: context.attachment,
          request: event.request,
        },
        generation,
      })
      requestHostHints(context.ownerElement)
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
      if (pagePending) pending.delete(pagePending[0])
      wireRequest = Math.max(wireRequest, wire.request)
      requestHighWater.set(requestScopeKey, wireRequest)
      const gen = generation
      const controller = new AbortController()
      controllers.set(request, controller)
      signal.addEventListener('abort', () => controller.abort(), { once: true })
      pending.set(request, { wire, generation: gen })
      try {
        const found = await browserHintCap['hints-discover'](context.remote, wire)
        if (
          !alive(gen) ||
          signal.aborted ||
          controller.signal.aborted ||
          pending.get(request)?.wire !== wire ||
          found === null
        )
          return null
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
        !alive(item.generation) ||
        found.owner.request !== item.wire.request ||
        nextRevision <= revision
      )
        return false
      revision = nextRevision
      try {
        const presented = await browserHintCap['hints-present'](context.remote, {
          owner: found.owner as PageHintOwner,
          p: {
            revision: nextRevision,
            labels,
            theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
          },
        })
        return presented && alive(item.generation)
      } catch {
        return false
      }
    },
    clear(request) {
      const item = pending.get(request)
      if (!item) return
      pending.delete(request)
      if (snapshot?.owner.request === item.wire.request) snapshot = null
      clearWire(item.wire)
    },
    async activate(request, id) {
      const item = pending.get(request)
      const found = snapshot
      if (
        !item ||
        !found ||
        !alive(item.generation) ||
        found.owner.request !== item.wire.request ||
        !found.targets.some((target) => target.id === id)
      )
        return false
      pending.delete(request)
      snapshot = null
      try {
        const generationAtActivation = item.generation
        const activated = await browserHintCap['hints-activate'](context.remote, {
          owner: found.owner as PageHintOwner,
          p: { id },
        })
        return activated && alive(generationAtActivation)
      } catch {
        return false
      }
    },
    subscribe(request, invalidate, routeKey) {
      const handler = (event: PageHintEvent) => {
        const item = pending.get(request)
        if (
          !item ||
          event.tab !== context.tab ||
          event.nonce !== context.nonce ||
          event.attachment !== context.attachment ||
          event.origin !== context.origin ||
          event.request !== item.wire.request
        )
          return
        if (event.type === 'revoke') {
          invalidate()
          return
        }
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
      const eventSet = listeners.get(key) ?? new Set()
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
      for (const off of subscriptions) off()
      subscriptions.clear()
      set.delete(onPageEvent)
      if (set.size === 0) listeners.delete(key)
      clearCurrent()
    },
  }
  return adapter
}
