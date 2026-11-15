import { flushSync } from 'react-dom'

const PRESSABLE = [
  'button',
  'a[href]',
  '[role="link"]',
  'summary',
  'input[type="button"]',
  'input[type="submit"]',
  'input[type="reset"]',
  'input[type="checkbox"]',
  'input[type="radio"]',
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="treeitem"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="combobox"]:not(input)',
  '[role="option"]',
  '[cmdk-item]',
].join(',')
const OVERLAY =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-slot="popover-content"], [data-slot="hover-card-content"]'
export const HOST_HINT_REQUEST = 'holi:vim-host-hints'

/** A request-scoped target source. It exists only for the active hint session. */
export interface HostHintAdapter {
  discover(): readonly HostHintAdapterTarget[]
  /** Validate the request lifetime as well as target geometry; called even with no links. */
  unchanged(targets: readonly HostHintTarget[]): boolean
  /** Capture the current terminal revision for this hint request. */
  capture?(): void
  /** Cancel the owning hint session immediately when its surface changes. */
  subscribe?(invalidate: () => void): () => void
  activate(target: HostHintTarget): boolean
}

interface HostHintAdapterTarget {
  element: Element
  label: string
  x: number
  y: number
  token: unknown
}

/** The editor requests hints without depending on the shell that presents them. */
export function requestHostHints(source: HTMLElement): void {
  window.dispatchEvent(new CustomEvent(HOST_HINT_REQUEST, { detail: { source } }))
}

/** Explicitly request hints for a shell surface, independent of document focus. */
export function requestAdaptedHostHints(source: HTMLElement, adapter: HostHintAdapter): void {
  adapter.capture?.()
  window.dispatchEvent(
    new CustomEvent(HOST_HINT_REQUEST, { detail: { source, adapter, scoped: true } }),
  )
}

export interface HostHintTarget {
  element: Element
  label: string
  x: number
  y: number
  key: string
  /** Captured scope: activation cannot follow the person into another surface. */
  root: HTMLElement
  overlay: HTMLElement | null
  adapter?: HostHintAdapter
  /** Request lifetime applies to native controls as well as adapted links. */
  scopeAdapter?: HostHintAdapter
  token?: unknown
}

/** Shell chrome and the focused pane, or only the foremost interactive overlay. */
export function discoverHostHintTargets(
  root: HTMLElement,
  adapter?: HostHintAdapter,
): HostHintTarget[] {
  const overlay = topOverlay()
  const scope = overlay ?? document.body
  const targets: HostHintTarget[] = []
  for (const element of scope.querySelectorAll<Element>(PRESSABLE)) {
    const pane = element.closest('[data-pane]')
    if (!overlay && pane !== null && pane !== root) continue
    if (!eligible(element)) continue
    const point = hitPoint(element)
    if (point === null) continue
    targets.push({
      element,
      label: accessibleLabel(element),
      ...point,
      key: '',
      root,
      overlay,
      scopeAdapter: adapter,
    })
  }
  if (adapter && !overlay) {
    for (const target of adapter.discover()) {
      if (!target.element.isConnected || target.element.closest('[hidden],[inert]')) continue
      targets.push({
        ...target,
        root,
        overlay,
        adapter,
        scopeAdapter: adapter,
        token: target.token,
        key: '',
      })
    }
  }
  targets.sort((a, b) => a.y - b.y || a.x - b.x)
  return targets.map((target, index) => ({ ...target, key: hintLabel(index, targets.length) }))
}

const alphabet = 'asdfghjklqwertyuiopzxcvbnm'
/** Prefix-free label allocation, exported for its test. @public */
export function hintLabel(index: number, targetCount = index + 1): string {
  let width = 1
  while (alphabet.length ** width < targetCount) width++
  let label = ''
  for (let place = width - 1; place >= 0; place--) {
    label += alphabet[Math.floor(index / alphabet.length ** place) % alphabet.length]!
  }
  return label
}

/** Invalidation and activation share discovery, so neither trusts stale geometry. */
export function hostHintsUnchanged(
  targets: readonly HostHintTarget[],
  requestAdapter?: HostHintAdapter,
  root = targets[0]?.root,
): boolean {
  if (!root?.isConnected) return false
  const adapter = requestAdapter ?? targets.find((target) => target.adapter)?.adapter
  const adapted = targets.filter((target) => target.adapter === adapter)
  if (adapter && !adapter.unchanged(adapted)) return false
  const ordinary = targets.filter((target) => !target.adapter)
  const next = discoverHostHintTargets(root, adapter)
  const ordinaryNext = next.filter((target) => !target.adapter)
  const adaptedNext = next.filter((target) => target.adapter === adapter)
  const oldAdapted = targets.filter((target) => target.adapter === adapter)
  return (
    ordinaryNext.length === ordinary.length &&
    ordinaryNext.every((target, i) => sameTarget(target, ordinary[i]!)) &&
    adaptedNext.length === oldAdapted.length &&
    adaptedNext.every((target, i) => sameTarget(target, oldAdapted[i]!))
  )
}

function sameTarget(target: HostHintTarget, previous: HostHintTarget): boolean {
  return (
    target.element === previous.element &&
    target.overlay === previous.overlay &&
    target.label === previous.label &&
    target.x === previous.x &&
    target.y === previous.y &&
    target.token === previous.token
  )
}

/** Send a mouse press through the control's own handlers and native default action. */
export function activateHostHint(target: HostHintTarget): boolean {
  if (target.scopeAdapter && !target.scopeAdapter.unchanged([])) return false
  if (target.adapter) {
    const live = discoverHostHintTargets(target.root, target.adapter).find(
      (candidate) => candidate.adapter === target.adapter && sameTarget(candidate, target),
    )
    return live ? target.adapter.activate(live) : false
  }
  const live = discoverHostHintTargets(target.root, target.scopeAdapter).find(
    ({ element, adapter }) => !adapter && element === target.element,
  )
  if (
    !live ||
    live.overlay !== target.overlay ||
    live.x !== target.x ||
    live.y !== target.y ||
    live.label !== target.label
  )
    return false
  const element = target.element
  const hit = document.elementFromPoint(target.x, target.y)
  const pressed = hit ?? element
  const init = {
    bubbles: true,
    cancelable: true,
    clientX: target.x,
    clientY: target.y,
    button: 0,
    buttons: 1,
  }
  const pointer = { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }
  let down = false
  // A real press and release are separate browser events. Flush the press so
  // newly opened Radix layers can install their release/focus handlers first.
  flushSync(() => {
    down = pressed.dispatchEvent(new PointerEvent('pointerdown', pointer))
  })
  if (down && pressed.dispatchEvent(new MouseEvent('mousedown', init))) {
    if (element instanceof HTMLElement || element instanceof SVGElement)
      element.focus({ preventScroll: true })
  }
  pressed.dispatchEvent(new PointerEvent('pointerup', { ...pointer, buttons: 0 }))
  pressed.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }))
  // A dispatched click still runs native defaults (checkboxes, anchors, form
  // buttons), while retaining the painted hit point. Radix select items select
  // on pointerup and ignore their mouse click itself.
  if (pressed.isConnected) pressed.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }))
  return true
}

function accessibleLabel(element: Element): string {
  return (
    element.getAttribute('aria-label') ||
    element
      .getAttribute('aria-labelledby')
      ?.split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim() ||
    element.textContent?.trim() ||
    (element instanceof HTMLInputElement ? element.value : '') ||
    element.getAttribute('data-slot') ||
    element.tagName.toLowerCase()
  )
}

function eligible(element: Element): boolean {
  return (
    !element.matches(':disabled,[disabled],[data-disabled]') &&
    element.closest(
      '[inert],[hidden],[aria-hidden="true"],[aria-disabled="true"],.xterm,iframe,webview',
    ) === null
  )
}

/** Clip before hit-testing: a visible edge still counts when a centre is covered. */
function hitPoint(element: Element, pressable = true): { x: number; y: number } | null {
  if (!element.isConnected) return null
  const rect = element.getBoundingClientRect()
  let left = Math.max(0, rect.left),
    right = Math.min(innerWidth, rect.right)
  let top = Math.max(0, rect.top),
    bottom = Math.min(innerHeight, rect.bottom)
  for (let parent: Element | null = element; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent)
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      (style.opacity !== '' && Number(style.opacity) === 0)
    )
      return null
    if (parent === element) continue
    const clip = parent.getBoundingClientRect()
    if (/(hidden|clip|auto|scroll)/.test(style.overflowX || style.overflow)) {
      left = Math.max(left, clip.left)
      right = Math.min(right, clip.right)
    }
    if (/(hidden|clip|auto|scroll)/.test(style.overflowY || style.overflow)) {
      top = Math.max(top, clip.top)
      bottom = Math.min(bottom, clip.bottom)
    }
  }
  if (right - left < 1 || bottom - top < 1) return null
  const points = [
    [(left + right) / 2, (top + bottom) / 2],
    [left + 0.5, top + 0.5],
    [right - 0.5, top + 0.5],
    [left + 0.5, bottom - 0.5],
    [right - 0.5, bottom - 0.5],
  ]
  for (const [x, y] of points) {
    const hit = document.elementFromPoint(x!, y!)
    // An interactive child owns its own target, not its parent's activation.
    if (hit && element.contains(hit) && (!pressable || hit.closest(PRESSABLE) === element))
      return { x: x!, y: y! }
  }
  return null
}

function topOverlay(): HTMLElement | null {
  const overlays = [...document.querySelectorAll<HTMLElement>(OVERLAY)].filter(
    (element) =>
      eligible(element) &&
      hitPoint(element, false) !== null &&
      element.getAttribute('data-state') !== 'closed',
  )
  const focused = document.activeElement?.closest<HTMLElement>(OVERLAY)
  // Focus is authoritative for nested Radix menus, whose z-indices are equal.
  if (focused && overlays.includes(focused)) return focused
  return overlays.sort((a, b) => stackingOrder(a) - stackingOrder(b)).at(-1) ?? null
}

function stackingOrder(element: HTMLElement): number {
  let order = 0
  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
    order = Math.max(order, Number.parseInt(getComputedStyle(parent).zIndex, 10) || 0)
  }
  return order
}
