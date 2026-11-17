;(function installHoliHintBridge() {
  const SLOT = '__holiHintBridgeV1__'
  const previous = window[SLOT]
  if (previous && typeof previous.dispose === 'function') previous.dispose()

  const MAX_TARGETS = 100
  const MAX_LABEL = 160
  const KEY_ALPHABET = 'asdfghjklqwertyuiopzxcvbnm'
  let nonce = null
  let hostOrigin = null
  let hostWindow = null
  let enabled = false
  let sessionActive = false
  let revision = 0
  let targets = new Map()
  let composing = false
  let disposed = false

  const send = (message) => {
    if (!enabled || !nonce || !hostWindow || disposed) return
    hostWindow.postMessage({ ...message, nonce }, hostOrigin ?? '*')
  }
  const editable = () => {
    const node = document.activeElement
    return !!node && (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName))
  }
  const visiblyActive = (element) => {
    if (!element.isConnected || element.closest('[hidden],[inert],[aria-hidden="true"]'))
      return false
    for (let node = element; node instanceof Element; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        (style.opacity !== '' && Number(style.opacity) === 0)
      )
        return false
    }
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const overlay = () =>
    [
      ...document.querySelectorAll(
        'dialog[open], [role="menu"], [role="listbox"], [role="alertdialog"], [role="dialog"], [aria-modal="true"], [data-holi-overlay]',
      ),
    ].some(visiblyActive)
  const eligible = () => enabled && !document.hidden && !editable() && !composing && !overlay()
  const labelFor = (element) => {
    const labelledBy = element.getAttribute('aria-labelledby')
    const referenced = labelledBy
      ? labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent || '')
          .join(' ')
      : ''
    const imageAlt = [...element.querySelectorAll('img[alt]')].map((image) => image.alt).join(' ')
    const text =
      element.getAttribute('aria-label') ||
      referenced ||
      element.innerText ||
      element.textContent ||
      imageAlt ||
      element.getAttribute('title') ||
      ''
    return text.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL)
  }
  const visible = (element) => {
    if (
      !element.isConnected ||
      element.matches(':disabled,[aria-disabled="true"]') ||
      element.closest('[hidden], [inert], [aria-disabled="true"]')
    )
      return false
    const rect = element.getBoundingClientRect()
    let left = 0
    let top = 0
    let right = innerWidth
    let bottom = innerHeight
    for (let node = element; node instanceof Element; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        (style.opacity !== '' && Number(style.opacity) === 0) ||
        (node === element && style.pointerEvents === 'none')
      )
        return false
      if (
        node !== element &&
        /(hidden|clip|scroll|auto)/.test(`${style.overflow}${style.overflowX}${style.overflowY}`)
      ) {
        const clip = node.getBoundingClientRect()
        left = Math.max(left, clip.left)
        top = Math.max(top, clip.top)
        right = Math.min(right, clip.right)
        bottom = Math.min(bottom, clip.bottom)
      }
    }
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > left &&
      rect.left < right &&
      rect.bottom > top &&
      rect.top < bottom
    )
  }
  const collect = () => {
    const result = []
    const identities = new Map()
    let next = 0
    for (const element of document.querySelectorAll('button, a[href], summary')) {
      if (!visible(element)) continue
      const label = labelFor(element)
      if (!label) continue
      const rect = element.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      if (!hit || (hit !== element && !element.contains(hit))) continue
      const id = `target-${++next}`
      const target = {
        element,
        geometry: [rect.x, rect.y, rect.width, rect.height],
      }
      identities.set(id, target)
      result.push({
        id,
        kind:
          element.tagName === 'BUTTON' ? 'button' : element.tagName === 'A' ? 'link' : 'summary',
        label,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      })
      if (result.length >= MAX_TARGETS) break
    }
    targets = identities
    return result
  }
  const snapshot = () => {
    if (!eligible()) return
    revision += 1
    send({ type: 'holi-hints:snapshot', revision, targets: collect() })
  }
  const invalidate = () => {
    if (!enabled) return
    revision += 1
    targets.clear()
    sessionActive = false
    send({ type: 'holi-hints:invalidated', revision })
    snapshot()
  }
  const invalidateDepartingDocument = () => {
    if (!enabled) return
    revision += 1
    targets.clear()
    sessionActive = false
    send({ type: 'holi-hints:invalidated', revision })
  }
  let navigationFrame = 0
  const invalidateNavigation = () => {
    invalidateDepartingDocument()
    cancelAnimationFrame(navigationFrame)
    navigationFrame = requestAnimationFrame(snapshot)
  }
  const keydown = (event) => {
    if (
      !eligible() ||
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      event.key === 'Process'
    )
      return
    if (event.altKey || event.ctrlKey || event.metaKey) {
      if (sessionActive) {
        event.preventDefault()
        sessionActive = false
        send({ type: 'holi-hints:clear' })
      }
      return
    }
    if (!sessionActive) {
      if (event.key !== 'f') return
      event.preventDefault()
      send({ type: 'holi-hints:start', revision })
      return
    }
    if (
      event.key !== 'Escape' &&
      event.key !== 'Backspace' &&
      (event.key.length !== 1 || !KEY_ALPHABET.includes(event.key))
    ) {
      event.preventDefault()
      sessionActive = false
      send({ type: 'holi-hints:clear' })
      return
    }
    event.preventDefault()
    send({ type: 'holi-hints:key', key: event.key })
  }
  const exact = (data, keys) =>
    Object.keys(data).length === keys.length && keys.every((key) => key in data)
  const message = (event) => {
    const data = event.data
    if (event.source !== window.parent || !data || typeof data !== 'object' || Array.isArray(data))
      return
    if (
      data.type === 'holi-hints:init' &&
      exact(data, ['type', 'nonce', 'enabled']) &&
      data.enabled === true &&
      typeof data.nonce === 'string' &&
      data.nonce.length > 0 &&
      data.nonce.length <= 128 &&
      event.source === window.parent &&
      (!enabled ||
        (event.source === hostWindow &&
          (hostOrigin === null || event.origin === hostOrigin) &&
          data.nonce === nonce))
    ) {
      nonce = data.nonce
      hostWindow = window.parent
      hostOrigin = event.origin === 'null' ? null : event.origin
      enabled = true
      sessionActive = false
      targets.clear()
      snapshot()
      return
    }
    if (
      !enabled ||
      event.source !== hostWindow ||
      (hostOrigin !== null && event.origin !== hostOrigin) ||
      data.nonce !== nonce
    )
      return
    if (data.type === 'holi-hints:disable' && exact(data, ['type', 'nonce'])) {
      enabled = false
      sessionActive = false
      targets.clear()
      nonce = null
      hostOrigin = null
      hostWindow = null
      return
    }
    if (data.type === 'holi-hints:clear' && exact(data, ['type', 'nonce'])) {
      sessionActive = false
      return
    }
    if (
      data.type === 'holi-hints:session' &&
      exact(data, ['type', 'nonce', 'revision', 'active']) &&
      Number.isSafeInteger(data.revision) &&
      data.revision === revision &&
      typeof data.active === 'boolean'
    ) {
      sessionActive = data.active
      return
    }
    if (
      data.type === 'holi-hints:activate' &&
      exact(data, ['type', 'nonce', 'revision', 'id']) &&
      sessionActive &&
      Number.isSafeInteger(data.revision) &&
      data.revision === revision &&
      typeof data.id === 'string' &&
      data.id.length <= 80
    ) {
      const item = targets.get(data.id)
      if (!eligible() || !item || !visible(item.element)) {
        invalidate()
        return
      }
      const rect = item.element.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      if (!hit || (hit !== item.element && !item.element.contains(hit))) {
        invalidate()
        return
      }
      const now = [rect.x, rect.y, rect.width, rect.height]
      if (now.some((coordinate, index) => coordinate !== item.geometry[index])) {
        invalidate()
        return
      }
      sessionActive = false
      targets.clear()
      item.element.click()
    }
  }
  const compositionStart = () => {
    composing = true
    if (enabled) invalidate()
  }
  const compositionEnd = () => {
    composing = false
    if (enabled) invalidate()
  }
  const historyMethods = ['pushState', 'replaceState'].map((name) => {
    const original = history[name]
    const wrapped = function (...args) {
      const result = original.apply(this, args)
      invalidateNavigation()
      return result
    }
    history[name] = wrapped
    return { name, original, wrapped }
  })
  const listeners = [
    [window, 'message', message],
    [window, 'keydown', keydown],
    [window, 'scroll', invalidate, true],
    [window, 'resize', invalidate],
    [document, 'visibilitychange', invalidate],
    [document, 'compositionstart', compositionStart, true],
    [document, 'compositionend', compositionEnd, true],
    [document, 'focusin', invalidate, true],
    [document, 'focusout', invalidate, true],
    [window, 'pagehide', invalidateDepartingDocument],
    [window, 'popstate', invalidateNavigation],
    [window, 'hashchange', invalidateNavigation],
    [window, 'beforeunload', invalidateDepartingDocument],
    ...(window.visualViewport
      ? [
          [window.visualViewport, 'resize', invalidate],
          [window.visualViewport, 'scroll', invalidate],
        ]
      : []),
  ]
  for (const [target, type, handler, capture] of listeners)
    target.addEventListener(type, handler, capture)
  const observer = new MutationObserver(invalidate)
  observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  })

  const dispose = () => {
    if (disposed) return
    disposed = true
    observer.disconnect()
    cancelAnimationFrame(navigationFrame)
    for (const { name, original, wrapped } of historyMethods)
      if (history[name] === wrapped) history[name] = original
    for (const [target, type, handler, capture] of listeners)
      target.removeEventListener(type, handler, capture)
    targets.clear()
    enabled = false
    sessionActive = false
  }
  window[SLOT] = { dispose }
})()
