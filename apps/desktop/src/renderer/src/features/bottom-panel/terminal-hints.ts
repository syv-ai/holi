import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import type { HostHintAdapter, HostHintTarget } from '@/lib/host-hints'

type LinkTarget = { link: ILink; x: number; y: number; text: string; revision: number }

/** Owns request-local link recognition, visibility geometry, and terminal freshness. */
export function createTerminalHintAdapter({
  term,
  mount,
  providers,
  isVisible,
  isCurrent,
}: {
  term: Terminal
  mount: HTMLElement
  providers: readonly ILinkProvider[]
  isVisible(): boolean
  isCurrent(): boolean
}): {
  adapter: HostHintAdapter
  invalidate(): void
  dispose(): void
  write(data: string): Promise<void>
} {
  let revision = 0
  let epoch = 0
  let pendingWrites = 0
  let disposed = false
  const listeners = new Set<() => void>()
  const invalidate = () => {
    revision++
    epoch++
    listeners.forEach((listener) => listener())
  }
  const links = (): LinkTarget[] => {
    const screen = mount.querySelector<HTMLElement>('.xterm-screen')
    if (disposed || !screen || !mount.isConnected || !isVisible() || !isCurrent() || pendingWrites)
      return []
    const viewportY = term.buffer.active.viewportY
    const screenRect = screen.getBoundingClientRect()
    if (screenRect.width <= 0 || screenRect.height <= 0 || term.cols <= 0 || term.rows <= 0)
      return []
    const clip = visibleRect(screen, screenRect)
    if (!clip) return []
    const cellWidth = screenRect.width / term.cols
    const cellHeight = screenRect.height / term.rows
    const found: LinkTarget[] = []
    const seen = new Set<string>()
    for (let row = viewportY + 1; row <= viewportY + term.rows; row++) {
      for (const provider of providers) {
        provider.provideLinks(row, (provided) => {
          for (const link of provided ?? []) {
            const text = link.text
            if (!/^https?:\/\//i.test(text)) continue
            const key = terminalHintToken(link, revision)
            if (seen.has(key)) continue
            const point = visibleLinkPoint(
              link,
              viewportY,
              term.cols,
              term.rows,
              cellWidth,
              cellHeight,
              screenRect,
              clip,
              mount,
            )
            if (!point) continue
            seen.add(key)
            found.push({ link, ...point, text, revision })
          }
        })
      }
    }
    return found
  }
  let snapshot = epoch
  const adapter: HostHintAdapter = {
    capture: () => {
      snapshot = epoch
    },
    discover: () =>
      links().map(({ link, x, y, text }) => ({
        element: mount.querySelector<HTMLElement>('.xterm-screen')!,
        label: text,
        x,
        y,
        token: terminalHintToken(link, revision),
      })),
    unchanged: (targets) => {
      if (disposed || snapshot !== epoch || !isVisible() || !isCurrent() || pendingWrites)
        return false
      const live = links()
      return targets.every((target) =>
        live.some(
          (item) =>
            item.text === target.label &&
            item.x === target.x &&
            item.y === target.y &&
            terminalHintToken(item.link, item.revision) === target.token,
        ),
      )
    },
    subscribe: (listener) => {
      if (disposed || snapshot !== epoch) listener()
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    activate: (target: HostHintTarget) => {
      if (!adapter.unchanged([target])) return false
      const link = links().find(
        (item) =>
          item.text === target.label &&
          item.x === target.x &&
          item.y === target.y &&
          terminalHintToken(item.link, item.revision) === target.token,
      )
      if (!link) return false
      link.link.activate(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          clientX: link.x,
          clientY: link.y,
          button: 0,
        }),
        link.text,
      )
      return true
    },
  }
  const write = (data: string) => {
    if (disposed) return Promise.resolve()
    revision++
    epoch++
    pendingWrites++
    listeners.forEach((listener) => listener())
    return new Promise<void>((resolve) =>
      term.write(data, () => {
        pendingWrites--
        listeners.forEach((listener) => listener())
        resolve()
      }),
    )
  }
  return {
    adapter,
    invalidate,
    write,
    dispose: () => {
      if (disposed) return
      disposed = true
      epoch++
      listeners.forEach((listener) => listener())
      listeners.clear()
    },
  }
}

function visibleLinkPoint(
  link: ILink,
  viewportY: number,
  cols: number,
  rows: number,
  cellWidth: number,
  cellHeight: number,
  screen: DOMRect,
  clip: { left: number; right: number; top: number; bottom: number },
  mount: HTMLElement,
): { x: number; y: number } | null {
  const start = link.range.start
  const end = link.range.end
  const firstRow = Math.max(start.y, viewportY + 1, 1)
  const lastRow = Math.min(end.y, viewportY + rows, viewportY + rows)
  for (let bufferRow = firstRow; bufferRow <= lastRow; bufferRow++) {
    const visualRow = bufferRow - viewportY - 1
    if (visualRow < 0 || visualRow >= rows) continue
    const from = Math.max(1, bufferRow === start.y ? start.x : 1)
    const to = Math.min(cols, bufferRow === end.y ? end.x : cols)
    for (let column = from; column <= to; column++) {
      const x = screen.left + (column - 0.5) * cellWidth
      const y = screen.top + (visualRow + 0.5) * cellHeight
      if (x < clip.left || x > clip.right || y < clip.top || y > clip.bottom) continue
      const hit = document.elementFromPoint(x, y)
      if (hit && mount.contains(hit) && hit.closest('.xterm-screen')) return { x, y }
    }
  }
  return null
}

function visibleRect(element: HTMLElement, rect: DOMRect) {
  let { left, right, top, bottom } = rect
  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent)
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      (style.opacity !== '' && Number(style.opacity) === 0)
    )
      return null
    if (parent === element) continue
    const bounds = parent.getBoundingClientRect()
    if (/(hidden|clip|auto|scroll)/.test(style.overflowX || style.overflow)) {
      left = Math.max(left, bounds.left)
      right = Math.min(right, bounds.right)
    }
    if (/(hidden|clip|auto|scroll)/.test(style.overflowY || style.overflow)) {
      top = Math.max(top, bounds.top)
      bottom = Math.min(bottom, bounds.bottom)
    }
  }
  left = Math.max(0, left)
  right = Math.min(innerWidth, right)
  top = Math.max(0, top)
  bottom = Math.min(innerHeight, bottom)
  return right > left && bottom > top ? { left, right, top, bottom } : null
}

function terminalHintToken(link: ILink, revision: number): string {
  const { start, end } = link.range
  return `${revision}:${start.y}:${start.x}:${end.y}:${end.x}:${link.text}`
}
