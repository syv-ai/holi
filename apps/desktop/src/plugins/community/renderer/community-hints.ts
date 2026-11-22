import {
  isFrameHintsMessage,
  type FrameHintTarget,
  type FrameHintsMessage,
} from '../shared/frame-hints'
import {
  requestAdaptedHostHints,
  type HostHintAdapter,
  type HostHintAdapterTarget,
  type HostHintTarget,
} from '@/plugin-api'

/** Own one opt-in guest document; this adapter never reads cross-origin DOM. */
export function communityFramePaneFocused(frame: HTMLIFrameElement): boolean {
  const pane = frame.closest<HTMLElement>('[data-pane]')
  if (!pane) return false
  const visiblePanes = [...document.querySelectorAll<HTMLElement>('[data-pane]')].filter(
    (candidate) => {
      if (candidate.hidden || candidate.closest('[hidden],[inert]')) return false
      for (let node: HTMLElement | null = candidate; node; node = node.parentElement) {
        const style = getComputedStyle(node)
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          (style.opacity !== '' && Number(style.opacity) === 0)
        )
          return false
      }
      return true
    },
  )
  return visiblePanes.length <= 1 || pane.getAttribute('data-pane-focused') === 'true'
}

export function createCommunityHintAdapter(
  frame: HTMLIFrameElement,
  request: typeof requestAdaptedHostHints = requestAdaptedHostHints,
): HostHintAdapter {
  const origin = new URL(frame.src, window.location.href).origin
  const targetOrigin = origin === 'null' ? '*' : origin
  const nonce = crypto.randomUUID()
  const parentWindow = frame.contentWindow
  let revision = -1
  let snapshot: FrameHintTarget[] | null = null
  let tokens = new Map<string, { id: string; revision: number }>()
  let live = true
  let session = false
  let initialized = false
  let invalidateSession: (() => void) | null = null
  let latestKeyRoute: ((event: KeyboardEvent) => boolean) | null = null
  let subscriptionGeneration = 0
  const invalidate = () => {
    if (!live) return
    snapshot = null
    tokens.clear()
    session = false
    if (invalidateSession) {
      const cancel = invalidateSession
      invalidateSession = null
      cancel()
    }
  }
  const post = (message: FrameHintsMessage) => {
    if (live && frame.contentWindow === parentWindow)
      parentWindow?.postMessage(message, targetOrigin)
  }
  const frameVisible = () => {
    if (!live || !frame.isConnected || frame.inert || frame.closest('[hidden],[inert]'))
      return false
    for (let node: HTMLElement | null = frame; node; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        (style.opacity !== '' && Number(style.opacity) === 0)
      )
        return false
    }
    const rect = frame.getBoundingClientRect()
    const viewport = window.visualViewport
    const left = viewport?.offsetLeft ?? 0
    const top = viewport?.offsetTop ?? 0
    const right = left + (viewport?.width ?? window.innerWidth)
    const bottom = top + (viewport?.height ?? window.innerHeight)
    const focused = communityFramePaneFocused(frame)
    return (
      focused &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > left &&
      rect.left < right &&
      rect.bottom > top &&
      rect.top < bottom
    )
  }
  const frameFocused = () => frameVisible() && document.activeElement === frame
  const onFrameLoad = () => thisAdapter.invalidate?.()
  const receive = (event: MessageEvent<unknown>) => {
    if (!live || event.source !== parentWindow || event.origin !== origin) return
    if (!isFrameHintsMessage(event.data) || event.data.nonce !== nonce) return
    const data = event.data
    if (data.type === 'holi-hints:snapshot') {
      if (data.revision <= revision) return
      revision = data.revision
      snapshot = data.targets
      tokens = new Map(data.targets.map((target) => [target.id, { id: target.id, revision }]))
      return
    }
    if (data.type === 'holi-hints:invalidated') {
      if (data.revision <= revision) return
      revision = data.revision
      invalidate()
      return
    }
    if (data.type === 'holi-hints:start') {
      if (snapshot === null || data.revision !== revision || !frameFocused()) return
      session = true
      request(frame, thisAdapter)
      if (
        !live ||
        snapshot === null ||
        data.revision !== revision ||
        thisAdapter.discover().length === 0
      ) {
        session = false
        post({ type: 'holi-hints:session', nonce, revision: data.revision, active: false })
        return
      }
      post({ type: 'holi-hints:session', nonce, revision: data.revision, active: true })
      return
    }
    if (data.type === 'holi-hints:clear') {
      if (data.revision !== revision || !session) return
      session = false
      invalidateSession?.()
      invalidateSession = null
      return
    }
    if (data.type === 'holi-hints:key') {
      if (!session) return
      if (data.key.length !== 1 && data.key !== 'Escape' && data.key !== 'Backspace') {
        session = false
        post({ type: 'holi-hints:clear', nonce })
        invalidateSession?.()
        invalidateSession = null
        return
      }
      const event = new KeyboardEvent('keydown', { key: data.key, bubbles: true, cancelable: true })
      if (latestKeyRoute?.(event)) {
        if (data.key === 'Escape') {
          session = false
          post({ type: 'holi-hints:clear', nonce })
        }
        return
      }
      session = false
      post({ type: 'holi-hints:clear', nonce })
      invalidateSession?.()
      invalidateSession = null
    }
  }
  const thisAdapter: HostHintAdapter = {
    exclusive: true,
    discover(): readonly HostHintAdapterTarget[] {
      if (!frameFocused() || snapshot === null) return []
      const rect = frame.getBoundingClientRect()
      // The frame's own layout viewport is host-readable; never inspect its document/window.
      const guestWidth = frame.clientWidth || rect.width
      const guestHeight = frame.clientHeight || rect.height
      const scaleX = rect.width / guestWidth
      const scaleY = rect.height / guestHeight
      const viewport = window.visualViewport
      const clipLeft = Math.max(rect.left, viewport?.offsetLeft ?? 0)
      const clipTop = Math.max(rect.top, viewport?.offsetTop ?? 0)
      const clipRight = Math.min(
        rect.right,
        (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth),
      )
      const clipBottom = Math.min(
        rect.bottom,
        (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight),
      )
      return snapshot.flatMap((target) => {
        const x = rect.left + target.x * scaleX
        const y = rect.top + target.y * scaleY
        const right = x + target.width * scaleX
        const bottom = y + target.height * scaleY
        if (x < clipLeft || y < clipTop || right > clipRight || bottom > clipBottom) return []
        const centerX = (x + right) / 2
        const centerY = (y + bottom) / 2
        if (document.elementFromPoint(centerX, centerY) !== frame) return []
        return [
          {
            element: frame,
            label: target.label,
            x: centerX,
            y: centerY,
            token: tokens.get(target.id),
          },
        ]
      })
    },
    unchanged(targets: readonly HostHintTarget[]) {
      return (
        frameVisible() &&
        (snapshot === null ||
          targets.every((target) => {
            const token = target.token as { id?: unknown; revision?: unknown } | undefined
            return token?.revision === revision && snapshot?.some((item) => item.id === token.id)
          }))
      )
    },
    capture() {
      if (!frameVisible() || initialized) return
      initialized = true
      post({ type: 'holi-hints:init', nonce, enabled: true })
    },
    subscribe(cancel, routeKey) {
      if (!live) return () => undefined
      const subscription = ++subscriptionGeneration
      invalidateSession = cancel
      latestKeyRoute = routeKey ?? null
      const cancelForChange = () => {
        if (session) post({ type: 'holi-hints:clear', nonce })
        invalidate()
        if (live) {
          initialized = false
          thisAdapter.capture?.()
        }
      }
      const observer = new MutationObserver((records) => {
        const relevant = records.some((record) => {
          const target =
            record.target instanceof Element ? record.target : record.target.parentElement
          if (target?.closest('[data-host-hints],[data-host-hint-presentation]')) return false
          if (record.type !== 'childList') return true
          return [...record.addedNodes, ...record.removedNodes].some(
            (node) =>
              !(
                node instanceof Element &&
                node.closest('[data-host-hints],[data-host-hint-presentation]')
              ),
          )
        })
        if (relevant) cancelForChange()
      })
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
      })
      window.addEventListener('scroll', cancelForChange, true)
      window.addEventListener('resize', cancelForChange)
      window.addEventListener('focusin', cancelForChange, true)
      window.addEventListener('blur', cancelForChange)
      window.visualViewport?.addEventListener('scroll', cancelForChange)
      window.visualViewport?.addEventListener('resize', cancelForChange)
      return () => {
        invalidateSession = null
        latestKeyRoute = null
        observer.disconnect()
        window.removeEventListener('scroll', cancelForChange, true)
        window.removeEventListener('resize', cancelForChange)
        window.removeEventListener('focusin', cancelForChange, true)
        window.removeEventListener('blur', cancelForChange)
        window.visualViewport?.removeEventListener('scroll', cancelForChange)
        window.visualViewport?.removeEventListener('resize', cancelForChange)
        // Unsubscribing ends the current session but preserves this document's
        // snapshot so Escape can be followed by a fresh guest request.
        queueMicrotask(() => {
          if (subscriptionGeneration !== subscription) return
          if (session) post({ type: 'holi-hints:clear', nonce })
          session = false
        })
      }
    },
    invalidate() {
      if (!live) return
      if (invalidateSession) {
        const cancel = invalidateSession
        invalidateSession = null
        cancel()
      }
      post({ type: 'holi-hints:disable', nonce })
      snapshot = null
      tokens.clear()
      session = false
      live = false
      window.removeEventListener('message', receive)
      frame.removeEventListener('load', onFrameLoad)
    },
    activate(target) {
      if (!this.unchanged([]) || !session) return false
      const token = target.token as { id?: unknown; revision?: unknown } | undefined
      if (typeof token?.id !== 'string' || token.revision !== revision) return false
      post({ type: 'holi-hints:activate', nonce, revision, id: token.id })
      session = false
      return true
    },
  }
  window.addEventListener('message', receive)
  frame.addEventListener('load', onFrameLoad)
  return thisAdapter
}
