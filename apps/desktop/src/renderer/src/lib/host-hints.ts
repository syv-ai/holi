import { flushSync } from 'react-dom'

const PRESSABLE = [
  'button',
  'a[href]',
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

/** The editor requests hints without depending on the shell that presents them. */
export function requestHostHints(source: HTMLElement): void {
  window.dispatchEvent(new CustomEvent(HOST_HINT_REQUEST, { detail: source }))
}

export interface HostHintTarget {
  element: HTMLElement
  label: string
  x: number
  y: number
  key: string
  /** Captured scope: activation cannot follow the person into another surface. */
  root: HTMLElement
  overlay: HTMLElement | null
}

/** Shell chrome and the focused pane, or only the foremost interactive overlay. */
export function discoverHostHintTargets(root: HTMLElement): HostHintTarget[] {
  const overlay = topOverlay()
  const scope = overlay ?? document.body
  const targets: HostHintTarget[] = []
  for (const element of scope.querySelectorAll<HTMLElement>(PRESSABLE)) {
    const pane = element.closest('[data-pane]')
    if (!overlay && pane !== null && pane !== root) continue
    if (!eligible(element)) continue
    const point = hitPoint(element)
    if (point === null) continue
    targets.push({ element, label: accessibleLabel(element), ...point, key: '', root, overlay })
  }
  targets.sort((a, b) => a.y - b.y || a.x - b.x)
  return targets.map((target, index) => ({ ...target, key: hintLabel(index, targets.length) }))
}

const alphabet = 'asdfghjklqwertyuiopzxcvbnm'
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
export function hostHintsUnchanged(targets: readonly HostHintTarget[]): boolean {
  const first = targets[0]
  if (!first || !first.root.isConnected) return false
  const next = discoverHostHintTargets(first.root)
  return (
    next.length === targets.length &&
    next.every((target, i) => {
      const previous = targets[i]!
      return (
        target.element === previous.element &&
        target.overlay === previous.overlay &&
        target.label === previous.label &&
        target.x === previous.x &&
        target.y === previous.y
      )
    })
  )
}

/** Send a mouse press through the control's own handlers and native default action. */
export function activateHostHint(target: HostHintTarget): boolean {
  const live = discoverHostHintTargets(target.root).find(
    ({ element }) => element === target.element,
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
  const pressed = hit instanceof HTMLElement ? hit : (hit?.parentElement ?? element)
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
    element.focus({ preventScroll: true })
  }
  pressed.dispatchEvent(new PointerEvent('pointerup', { ...pointer, buttons: 0 }))
  pressed.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }))
  // click() supplies native defaults (checkboxes, anchors, form buttons). A Radix
  // select item selects on mouse pointerup and ignores its mouse click itself.
  if (pressed.isConnected) pressed.click()
  return true
}

function accessibleLabel(element: HTMLElement): string {
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

function eligible(element: HTMLElement): boolean {
  return (
    !element.matches(':disabled,[disabled],[data-disabled]') &&
    element.closest(
      '[inert],[hidden],[aria-hidden="true"],[aria-disabled="true"],.xterm,iframe,webview',
    ) === null
  )
}

/** Clip before hit-testing: a visible edge still counts when a centre is covered. */
function hitPoint(element: HTMLElement, pressable = true): { x: number; y: number } | null {
  if (!element.isConnected) return null
  const rect = element.getBoundingClientRect()
  let left = Math.max(0, rect.left),
    right = Math.min(innerWidth, rect.right)
  let top = Math.max(0, rect.top),
    bottom = Math.min(innerHeight, rect.bottom)
  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
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
