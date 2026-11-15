import type { HostHintAdapter, HostHintAdapterTarget, HostHintTarget } from '@/plugin-api'

interface MailHintScope {
  frame: HTMLIFrameElement
  generation: () => number
  scope: () => string
}

/** The one explicitly owned mail document target source; it never walks frames. */
export function createMailHintAdapter({
  frame,
  generation,
  scope,
}: MailHintScope): HostHintAdapter {
  let captured: { document: Document; generation: number; scope: string } | null = null
  const listeners = new Set<() => void>()
  const invalidate = () => {
    captured = null
    for (const listener of listeners) listener()
  }
  const liveDocument = (): Document | null => {
    try {
      return frame.isConnected ? frame.contentDocument : null
    } catch {
      return null
    }
  }
  const current = () => {
    const document = liveDocument()
    return (
      document !== null &&
      captured !== null &&
      document === captured.document &&
      generation() === captured.generation &&
      scope() === captured.scope &&
      frame.isConnected &&
      !frame.closest('[hidden],[inert]')
    )
  }
  const visibleElements = (document: Document) =>
    [...document.querySelectorAll('a[href], summary')].filter((element) => {
      if (element.closest('[hidden],[inert],[aria-hidden="true"]')) return false
      if (element.tagName === 'SUMMARY' && element.closest('details') === null) return false
      if (element.tagName === 'A' && element.getAttribute('href') === null) return false
      const rect = element.getBoundingClientRect()
      const style = document.defaultView?.getComputedStyle(element)
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style?.visibility !== 'hidden' &&
        style?.display !== 'none' &&
        style?.pointerEvents !== 'none'
      )
    })
  const discover = (): readonly HostHintAdapterTarget[] => {
    if (!current() || captured === null) return []
    const document = captured.document
    const bounds = frame.getBoundingClientRect()
    const view = document.defaultView
    if (!view) return []
    const clipLeft = Math.max(0, bounds.left)
    const clipTop = Math.max(0, bounds.top)
    const clipRight = Math.min(window.innerWidth, bounds.right)
    const clipBottom = Math.min(window.innerHeight, bounds.bottom)
    if (clipRight <= clipLeft || clipBottom <= clipTop) return []
    const candidates = visibleElements(document)
    return candidates.flatMap((element) => {
      const rect = element.getBoundingClientRect()
      const left = Math.max(rect.left, 0, clipLeft - bounds.left)
      const right = Math.min(rect.right, frame.clientWidth, clipRight - bounds.left)
      const top = Math.max(rect.top, 0, clipTop - bounds.top)
      const bottom = Math.min(rect.bottom, frame.clientHeight, clipBottom - bounds.top)
      if (right <= left || bottom <= top) return []
      const localX = (left + right) / 2
      const localY = (top + bottom) / 2
      const x = bounds.left + localX
      const y = bounds.top + localY
      const frameHit = document.elementFromPoint(localX, localY)
      if (!frameHit || (frameHit !== element && !element.contains(frameHit))) return []
      const hostHit = window.document.elementFromPoint(x, y)
      if (hostHit !== frame) return []
      const label =
        element.getAttribute('aria-label')?.trim() ||
        element.getAttribute('title')?.trim() ||
        element.textContent?.replace(/\s+/g, ' ').trim() ||
        (element.tagName === 'A' ? (element as HTMLAnchorElement).href : 'Details')
      if (!label) return []
      return [{ element, label: label.slice(0, 120), x, y, token: element }]
    })
  }
  return {
    capture() {
      const document = liveDocument()
      captured = document === null ? null : { document, generation: generation(), scope: scope() }
    },
    discover,
    unchanged(targets) {
      if (!current()) return false
      if (targets.length === 0) return true
      const live = discover()
      return (
        live.length === targets.length &&
        live.every((target, index) => {
          const previous = targets[index]!
          return (
            target.element === previous.element &&
            target.label === previous.label &&
            target.x === previous.x &&
            target.y === previous.y &&
            target.token === previous.token
          )
        })
      )
    },
    subscribe(listener, routeKey) {
      listeners.add(listener)
      const document = captured?.document
      const view = document?.defaultView
      const mutation = document && new MutationObserver(invalidate)
      mutation?.observe(document!.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      })
      const observedSizes = new Map<Element, { width: number; height: number }>()
      const resize = new ResizeObserver((entries) => {
        let changed = false
        for (const entry of entries) {
          const size = { width: entry.contentRect.width, height: entry.contentRect.height }
          const previous = observedSizes.get(entry.target)
          observedSizes.set(entry.target, size)
          if (previous && (previous.width !== size.width || previous.height !== size.height))
            changed = true
        }
        if (changed) invalidate()
      })
      resize.observe(frame)
      if (document?.body) resize.observe(document.body)
      const onFrameKeyDown = (event: KeyboardEvent) => {
        const target = event.target
        if (
          !routeKey ||
          event.isComposing ||
          event.key === 'Process' ||
          (target instanceof document!.defaultView!.Element &&
            target.closest('input,textarea,select,[contenteditable]') !== null)
        )
          return
        routeKey(event)
      }
      document?.addEventListener('keydown', onFrameKeyDown, true)
      document?.addEventListener('pointerdown', invalidate, true)
      document?.addEventListener('focusin', invalidate, true)
      document?.addEventListener('compositionstart', invalidate, true)
      view?.addEventListener('scroll', invalidate, true)
      window.addEventListener('resize', invalidate)
      window.addEventListener('scroll', invalidate, true)
      return () => {
        listeners.delete(listener)
        mutation?.disconnect()
        resize.disconnect()
        document?.removeEventListener('keydown', onFrameKeyDown, true)
        document?.removeEventListener('pointerdown', invalidate, true)
        document?.removeEventListener('focusin', invalidate, true)
        document?.removeEventListener('compositionstart', invalidate, true)
        view?.removeEventListener('scroll', invalidate, true)
        window.removeEventListener('resize', invalidate)
        window.removeEventListener('scroll', invalidate, true)
      }
    },
    invalidate,
    activate(target: HostHintTarget) {
      if (!current() || !target.element.isConnected) return false
      const live = discover().find((candidate) => candidate.element === target.element)
      if (!live || live.x !== target.x || live.y !== target.y || live.label !== target.label)
        return false
      if (live.element.tagName === 'A') {
        if (live.element.getAttribute('href') === null) return false
      } else if (live.element.tagName !== 'SUMMARY') return false
      ;(live.element as HTMLElement).click()
      return true
    },
  }
}
