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
export const HOST_HINT_SURFACE = 'holi:vim-host-hint-surface'

interface OwnedHintSurface {
  root: ShadowRoot
  owner: HTMLElement
}

const ownedSurfaces = new Set<OwnedHintSurface>()

/** Register one explicitly owned open shadow root; its returned disposer is idempotent. */
export function registerHostHintSurface(root: ShadowRoot, owner: HTMLElement): () => void {
  const surface = { root, owner }
  ownedSurfaces.add(surface)
  return () => ownedSurfaces.delete(surface)
}

/** A request-scoped target source. It exists only for the active hint session. */
export interface HostHintAdapter {
  /** This source is a guest surface; its request must never enumerate host chrome. */
  guestOnly?: boolean
  discover(): readonly HostHintAdapterTarget[]
  /** Validate the request lifetime as well as target geometry; called even with no links. */
  unchanged(targets: readonly HostHintTarget[]): boolean
  /** Capture the current terminal revision for this hint request. */
  capture?(): void
  /** Cancel the owning hint session immediately when its surface changes. */
  subscribe?(invalidate: () => void, routeKey?: (event: KeyboardEvent) => boolean): () => void
  /** Signal a synchronous ownership transition before a source is removed. */
  invalidate?(): void
  activate(target: HostHintTarget): boolean
}

export interface HostHintAdapterTarget {
  element: Element
  label: string
  x: number
  y: number
  token: unknown
}

const registeredAdapters = new Map<HTMLElement, HostHintAdapter>()

/** Register an explicitly owned target source for the pane containing `owner`. */
export function registerHostHintAdapter(owner: HTMLElement, adapter: HostHintAdapter): () => void {
  registeredAdapters.set(owner, adapter)
  return () => {
    adapter.invalidate?.()
    if (registeredAdapters.get(owner) === adapter) registeredAdapters.delete(owner)
  }
}

function adapterParticipates(owner: HTMLElement, root: HTMLElement): boolean {
  if (!owner.isConnected || owner.closest<HTMLElement>('[data-pane]') !== root) return false
  for (let current: Element | null = owner; current; current = current.parentElement) {
    const style = current.ownerDocument.defaultView?.getComputedStyle(current)
    if (
      current.matches('[hidden],[inert],[aria-hidden="true"],[aria-disabled="true"]') ||
      style?.display === 'none' ||
      style?.visibility === 'hidden' ||
      style?.visibility === 'collapse' ||
      style?.opacity === '0'
    )
      return false
  }
  return true
}

function adaptersFor(root: HTMLElement): HostHintAdapter[] {
  return [...registeredAdapters]
    .filter(([owner]) => adapterParticipates(owner, root))
    .map(([, adapter]) => adapter)
}

export function captureHostHintAdapters(root: HTMLElement): HostHintAdapter[] {
  const adapters = adaptersFor(root)
  for (const adapter of adapters) adapter.capture?.()
  return adapters
}

/** The editor requests hints without depending on the shell that presents them. */
export function requestHostHints(source: HTMLElement): void {
  window.dispatchEvent(new CustomEvent(HOST_HINT_REQUEST, { detail: { source } }))
}

/** Explicitly request hints for a shell surface, independent of document focus. */
export function requestAdaptedHostHints(
  source: HTMLElement,
  adapter: HostHintAdapter,
  options: { guestOnly?: boolean } = {},
): void {
  adapter.capture?.()
  window.dispatchEvent(
    new CustomEvent(HOST_HINT_REQUEST, {
      detail: { source, adapter, scoped: true, guestOnly: options.guestOnly === true },
    }),
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
  surface: ShadowRoot | null
}

/** Shell chrome and the focused pane, or only the foremost interactive overlay. */
export function discoverHostHintTargets(
  root: HTMLElement,
  adapter?: HostHintAdapter,
  guestOnly = false,
): HostHintTarget[] {
  const hostOverlay = topOverlay()
  const ownedOverlay = hostOverlay ? null : topOwnedOverlay(root)
  const overlay = hostOverlay ?? ownedOverlay?.element ?? null
  const targets: HostHintTarget[] = []
  if (guestOnly && overlay) return targets
  const collect = (candidate: ParentNode, surface: ShadowRoot | null) => {
    for (const element of candidate.querySelectorAll<Element>(PRESSABLE)) {
      const owner = surface ? [...ownedSurfaces].find((item) => item.root === surface)?.owner : null
      const pane = owner
        ? owner.closest<HTMLElement>('[data-pane]')
        : element.closest<HTMLElement>('[data-pane]')
      if (!overlay && pane !== null && pane !== root) continue
      if (surface && (!owner?.isConnected || !root.contains(owner))) continue
      if (!eligible(element)) continue
      const point = hitPoint(element, true, surface)
      if (point === null) continue
      targets.push({
        element,
        label: accessibleLabel(element),
        ...point,
        key: '',
        root,
        overlay,
        surface,
        scopeAdapter: adapter,
      })
    }
  }
  if (hostOverlay) collect(hostOverlay, null)
  else if (ownedOverlay) collect(ownedOverlay.element, ownedOverlay.surface)
  else {
    if (!guestOnly) {
      collect(document.body, null)
      for (const surface of ownedSurfaces) {
        if (surface.owner.closest('[data-pane]') !== root) continue
        collect(surface.root, surface.root)
      }
    }
    const sources = guestOnly
      ? adapter
        ? [adapter]
        : []
      : [...new Set([...adaptersFor(root), ...(adapter ? [adapter] : [])])]
    for (const source of sources) {
      for (const target of source.discover()) {
        if (!target.element.isConnected || target.element.closest('[hidden],[inert]')) continue
        targets.push({
          ...target,
          root,
          overlay,
          adapter: source,
          scopeAdapter: source,
          token: target.token,
          key: '',
          surface: null,
        })
      }
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
  const adapters = new Set(targets.flatMap((target) => (target.adapter ? [target.adapter] : [])))
  for (const source of adapters) {
    const adapted = targets.filter((target) => target.adapter === source)
    if (!source.unchanged(adapted)) return false
  }
  const ordinary = targets.filter((target) => !target.adapter)
  const next = discoverHostHintTargets(root, requestAdapter, requestAdapter?.guestOnly === true)
  const ordinaryNext = next.filter((target) => !target.adapter)
  if (
    ordinaryNext.length !== ordinary.length ||
    !ordinaryNext.every((target, i) => sameTarget(target, ordinary[i]!))
  )
    return false
  for (const source of adapters) {
    const previous = targets.filter((target) => target.adapter === source)
    const current = next.filter((target) => target.adapter === source)
    if (
      current.length !== previous.length ||
      !current.every((target, i) => sameTarget(target, previous[i]!))
    )
      return false
  }
  return true
}

function sameTarget(target: HostHintTarget, previous: HostHintTarget): boolean {
  return (
    target.element === previous.element &&
    target.overlay === previous.overlay &&
    target.surface === previous.surface &&
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
  const hit = deepHitTest(target.x, target.y, target.surface)
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
      .map((id) => {
        const tree = element.getRootNode() as Document | ShadowRoot
        return tree.getElementById(id)?.textContent ?? ''
      })
      .join(' ')
      .trim() ||
    element.textContent?.trim() ||
    (element instanceof HTMLInputElement ? element.value : '') ||
    element.getAttribute('data-slot') ||
    element.tagName.toLowerCase()
  )
}

export function hostHintElementEligible(element: Element): boolean {
  for (let current: Element | null = element; current; current = composedParent(current)) {
    if (
      current.matches(
        ':disabled,[disabled],[data-disabled],[inert],[hidden],[aria-hidden="true"],[aria-disabled="true"],.xterm,iframe,webview',
      )
    )
      return false
    const style = current.ownerDocument.defaultView?.getComputedStyle(current)
    if (
      style?.display === 'none' ||
      style?.visibility === 'hidden' ||
      style?.visibility === 'collapse' ||
      style?.opacity === '0'
    )
      return false
  }
  return true
}

function eligible(element: Element): boolean {
  return hostHintElementEligible(element)
}

function composedParent(element: Element): Element | null {
  return element.parentElement ?? (element.getRootNode() as ShadowRoot).host ?? null
}

function composedContains(parent: Element, child: Element): boolean {
  for (let current: Element | null = child; current; current = composedParent(current))
    if (current === parent) return true
  return false
}

function deepHitTest(x: number, y: number, surface: ShadowRoot | null): Element | null {
  const documentHit = document.elementFromPoint(x, y)
  // The document hit test sees host overlays and other light-DOM occluders,
  // while a shadow-root hit test alone would incorrectly see through them.
  if (surface) {
    const owned = [...ownedSurfaces].find((item) => item.root === surface)
    if (!owned?.owner.isConnected || !documentHit || !composedContains(owned.owner, documentHit))
      return documentHit
    return (
      (
        surface as ShadowRoot & { elementFromPoint?: (x: number, y: number) => Element | null }
      ).elementFromPoint?.(x, y) ?? null
    )
  }
  // Descend only through an explicitly registered PDF root, never arbitrary
  // open roots. The document hit test above remains authoritative for occlusion.
  for (const owned of ownedSurfaces) {
    if (owned.owner !== documentHit && !composedContains(owned.owner, documentHit ?? owned.owner))
      continue
    const inner = (
      owned.root as ShadowRoot & { elementFromPoint?: (x: number, y: number) => Element | null }
    ).elementFromPoint?.(x, y)
    if (inner) return inner
  }
  return documentHit
}

/** Clip before hit-testing: a visible edge still counts when a centre is covered. */
function hitPoint(
  element: Element,
  pressable = true,
  surface: ShadowRoot | null = null,
): { x: number; y: number } | null {
  if (!element.isConnected) return null
  const rect = element.getBoundingClientRect()
  let left = Math.max(0, rect.left),
    right = Math.min(innerWidth, rect.right)
  let top = Math.max(0, rect.top),
    bottom = Math.min(innerHeight, rect.bottom)
  for (let parent: Element | null = element; parent; parent = composedParent(parent)) {
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
    const hit = deepHitTest(x!, y!, surface)
    // An interactive child owns its own target, not its parent's activation.
    if (hit && composedContains(element, hit) && (!pressable || hit.closest(PRESSABLE) === element))
      return { x: x!, y: y! }
  }
  return null
}

function topOwnedOverlay(root: HTMLElement): { element: HTMLElement; surface: ShadowRoot } | null {
  const candidates: { element: HTMLElement; surface: ShadowRoot }[] = []
  for (const owned of ownedSurfaces) {
    if (owned.owner.closest('[data-pane]') !== root) continue
    for (const element of owned.root.querySelectorAll<HTMLElement>(OVERLAY)) {
      if (
        eligible(element) &&
        hitPoint(element, false, owned.root) !== null &&
        element.getAttribute('data-state') !== 'closed'
      )
        candidates.push({ element, surface: owned.root })
    }
  }
  const focused = candidates.find(
    ({ element, surface }) => surface.activeElement?.closest(OVERLAY) === element,
  )
  return (
    focused ??
    candidates.sort((a, b) => stackingOrder(a.element) - stackingOrder(b.element)).at(-1) ??
    null
  )
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
