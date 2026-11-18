import type { HostHintAdapter, HostHintAdapterTarget, HostHintTarget } from '@/plugin-api'

const REQUEST = 'holi:vim-app-hints'
const MAX_TARGETS = 80
const MAX_LABEL = 160

type HintEntry = { id: string; label: string; x: number; y: number }
type Message = {
  nonce?: unknown
  type?: unknown
  requestId?: unknown
  targets?: unknown
  key?: unknown
  shift?: unknown
  repeat?: unknown
  composing?: unknown
  modified?: unknown
}
type AppHintOptions = { current: () => boolean; authorize: () => Promise<boolean> }

/** Request-scoped advisory targets from one leased, opaque app document. */
export type AppHintAdapter = HostHintAdapter & { dispose(): void }

export function createAppHintAdapter(
  frame: HTMLIFrameElement,
  nonce: string,
  options: AppHintOptions = { current: () => true, authorize: async () => true },
): AppHintAdapter {
  let targets: HintEntry[] = []
  let requestId = ''
  let disposed = false
  let invalidateCurrent: (() => void) | null = null
  let routeKey: ((event: KeyboardEvent) => boolean) | null = null
  let resolvePrepare: (() => void) | null = null
  let rejectPrepare: ((reason: Error) => void) | null = null
  let timeout: number | null = null
  let busy = false
  let activated = false
  let gotTargets = false
  let before: HostHintAdapterTarget[] = []
  let geometryObserver: MutationObserver | null = null
  let geometryFrame: number | null = null
  const rect = () => frame.getBoundingClientRect()
  const resultFor = (entry: HintEntry): HostHintAdapterTarget => {
    const box = rect()
    const sx = frame.clientWidth ? box.width / frame.clientWidth : 0
    const sy = frame.clientHeight ? box.height / frame.clientHeight : 0
    return {
      element: frame,
      label: entry.label,
      x: box.left + entry.x * sx,
      y: box.top + entry.y * sy,
      token: entry.id,
    }
  }
  const samePoint = (a: HostHintAdapterTarget, b: HostHintAdapterTarget) =>
    a.x === b.x && a.y === b.y
  const painted = (entry: HintEntry): boolean => {
    if (!current()) return false
    const point = resultFor(entry)
    if (frame.clientWidth <= 0 || frame.clientHeight <= 0) return false
    for (let node: Element | null = frame; node; node = node.parentElement) {
      if (node.matches('[hidden],[inert],[aria-hidden="true"],[aria-disabled="true"],[disabled]'))
        return false
      const style = getComputedStyle(node)
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        Number(style.opacity || 1) === 0
      )
        return false
      if (node !== frame) {
        const clip = node.getBoundingClientRect()
        if (
          /(hidden|clip|auto|scroll)/.test(style.overflowX) &&
          (point.x < clip.left || point.x > clip.right)
        )
          return false
        if (
          /(hidden|clip|auto|scroll)/.test(style.overflowY) &&
          (point.y < clip.top || point.y > clip.bottom)
        )
          return false
      }
    }
    const hit = document.elementFromPoint(point.x, point.y)
    return hit === frame
  }
  const stop = (notifyGuest: boolean) => {
    if (timeout !== null) window.clearTimeout(timeout)
    timeout = null
    const old = requestId
    requestId = ''
    geometryObserver?.disconnect()
    geometryObserver = null
    if (geometryFrame !== null) window.cancelAnimationFrame(geometryFrame)
    geometryFrame = null
    targets = []
    gotTargets = false
    activated = false
    busy = false
    before = []
    rejectPrepare?.(new Error('App hint request was cancelled'))
    resolvePrepare = null
    rejectPrepare = null
    if (notifyGuest && old)
      frame.contentWindow?.postMessage({ type: 'cancel', nonce, requestId: old }, '*')
  }
  const current = () =>
    !disposed && frame.isConnected && frame.contentWindow !== null && options.current()
  const onMessage = async (event: MessageEvent<Message>) => {
    if (event.source !== frame.contentWindow || !current()) return
    const data = event.data
    if (!data || typeof data !== 'object' || data.nonce !== nonce) return
    if (data.type === 'request') {
      if (!requestId && current())
        window.dispatchEvent(
          new CustomEvent('holi:vim-host-hints', {
            detail: { source: frame, adapter, scoped: true },
          }),
        )
      return
    }
    if (data.requestId !== requestId) return
    if (data.type === 'key') {
      if (
        typeof data.key !== 'string' ||
        data.key.length > 16 ||
        typeof data.shift !== 'boolean' ||
        typeof data.repeat !== 'boolean' ||
        typeof data.composing !== 'boolean' ||
        typeof data.modified !== 'boolean'
      )
        return
      if (data.modified || data.composing) return
      const event = new KeyboardEvent('keydown', {
        key: data.key,
        shiftKey: data.shift,
        repeat: data.repeat,
        isComposing: data.composing,
        bubbles: true,
        cancelable: true,
      })
      if (data.key === 'Escape' && !data.shift) {
        event.preventDefault()
        stop(true)
        invalidateCurrent?.()
        frame.contentWindow?.postMessage(
          { type: 'key-result', nonce, requestId: data.requestId, handled: true },
          '*',
        )
        return
      }
      if (routeKey?.(event))
        frame.contentWindow?.postMessage(
          { type: 'key-result', nonce, requestId: data.requestId, handled: true },
          '*',
        )
      return
    }
    if (data.type === 'invalidate') {
      stop(true)
      invalidateCurrent?.()
      return
    }
    if (
      data.type !== 'targets' ||
      gotTargets ||
      !Array.isArray(data.targets) ||
      data.targets.length > MAX_TARGETS
    )
      return
    const id = requestId
    const accepted: HintEntry[] = []
    const seen = new Set<string>()
    for (const item of data.targets) {
      if (
        !item ||
        typeof item.id !== 'string' ||
        !item.id ||
        item.id.length > 80 ||
        seen.has(item.id) ||
        typeof item.label !== 'string' ||
        item.label.length > MAX_LABEL ||
        !Number.isFinite(item.x) ||
        !Number.isFinite(item.y) ||
        item.x < 0 ||
        item.y < 0 ||
        item.x > frame.clientWidth ||
        item.y > frame.clientHeight
      )
        continue
      seen.add(item.id)
      accepted.push({ id: item.id, label: item.label, x: item.x, y: item.y })
    }
    gotTargets = true
    let authorized = false
    try {
      authorized = await options.authorize()
    } catch {
      authorized = false
    }
    if (!authorized || !current() || requestId !== id || !id) {
      if (requestId === id) gotTargets = false
      return
    }
    targets = accepted
    if (timeout !== null) window.clearTimeout(timeout)
    timeout = null
    const resolve = resolvePrepare
    resolvePrepare = null
    rejectPrepare = null
    resolve?.()
    before = targets.map(resultFor)
    if (targets.length) {
      geometryObserver = new MutationObserver(onGeometry)
      geometryObserver.observe(document.body, {
        attributes: true,
        childList: true,
        subtree: true,
        attributeFilter: ['style', 'class', 'hidden', 'inert', 'aria-hidden'],
      })
      const monitor = () => {
        geometryFrame = null
        if (!requestId || !targets.length) return
        onGeometry()
        if (requestId) geometryFrame = window.requestAnimationFrame(monitor)
      }
      geometryFrame = window.requestAnimationFrame(monitor)
    }
  }
  const onGeometry = () => {
    if (
      requestId &&
      targets.some((entry, i) => !painted(entry) || !samePoint(resultFor(entry), before[i]!))
    ) {
      stop(true)
      invalidateCurrent?.()
    }
  }
  window.addEventListener('message', onMessage)
  window.addEventListener('resize', onGeometry)
  window.addEventListener('scroll', onGeometry, true)
  let adapter: AppHintAdapter
  adapter = {
    exclusive: true,
    prepare: () => {
      stop(true)
      if (!current()) return Promise.resolve()
      requestId = crypto.randomUUID()
      const id = requestId
      return new Promise<void>((resolve, reject) => {
        resolvePrepare = resolve
        rejectPrepare = reject
        timeout = window.setTimeout(() => {
          if (requestId === id) stop(true)
        }, 1500)
        frame.contentWindow?.postMessage({ type: REQUEST, nonce, requestId: id }, '*')
      })
    },
    cancelPrepare: () => stop(true),
    discover: () => targets.map(resultFor),
    // A visible app frame can be registered while unfocused. Until it owns an
    // active request it has no claim on ordinary host hints; an active request
    // still validates both its lifetime and every adapted target.
    unchanged: () => (!requestId && targets.length === 0) || (current() && targets.every(painted)),
    subscribe: (invalidate, route) => {
      invalidateCurrent = invalidate
      routeKey = route ?? null
      return () => {
        if (invalidateCurrent === invalidate) invalidateCurrent = null
        if (routeKey === route) routeKey = null
        stop(true)
      }
    },
    invalidate: () => {
      stop(true)
      invalidateCurrent?.()
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      stop(true)
      invalidateCurrent = null
      routeKey = null
      window.removeEventListener('message', onMessage)
      window.removeEventListener('resize', onGeometry)
      window.removeEventListener('scroll', onGeometry, true)
    },
    activate: async (target: HostHintTarget) => {
      const id = target.token
      const request = requestId
      if (
        busy ||
        activated ||
        typeof id !== 'string' ||
        !request ||
        !targets.some((entry) => entry.id === id && painted(entry))
      )
        return false
      busy = true
      try {
        if (
          !current() ||
          !(await options.authorize()) ||
          !current() ||
          request !== requestId ||
          !targets.some((entry) => entry.id === id && painted(entry)) ||
          targets.some((entry, index) => !samePoint(resultFor(entry), before[index]!))
        )
          return false
        frame.contentWindow?.postMessage(
          { type: 'activate', nonce, requestId: request, targetId: id },
          '*',
        )
        activated = true
        return true
      } catch {
        return false
      } finally {
        if (request === requestId) busy = false
      }
    },
  }
  return adapter
}
