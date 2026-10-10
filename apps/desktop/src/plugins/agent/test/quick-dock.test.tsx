import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickDock } from '../renderer/quick/QuickDock'
import type { DockRequest, DockView } from '../shared/quick'

let listener: ((event: { name: string; payload: unknown }) => void) | null = null
let sent: DockRequest[] = []
/** Core's API, which only the vault's theme reads here: it never answers. */
let trpc = vi.fn((_op: { path: string; input: unknown }) => new Promise<never>(() => {}))

beforeEach(() => {
  listener = null
  sent = []
  trpc = vi.fn(() => new Promise<never>(() => {}))
  window.holi = {
    trpc: (op: { path: string; input: unknown }) => trpc(op),
    page: {
      on: (cb: (event: { name: string; payload: unknown }) => void) => {
        listener = cb
        return () => {
          listener = null
        }
      },
      send: (name: string, payload: unknown) => {
        if (name === 'dock') sent.push(payload as DockRequest)
      },
    },
  } as never
})

afterEach(() => vi.restoreAllMocks())

const VIEW: DockView = {
  remote: null,
  dots: [
    { id: '1', name: 'Rename the meeting notes', state: 'working' },
    { id: '2', name: 'Pick a tag scheme', state: 'question' },
    { id: '3', name: 'Summarise the week', state: 'done' },
    { id: '4', name: 'Fix the broken links', state: 'failed' },
  ],
  selected: null,
}

const tell = (view: DockView) => act(() => listener?.({ name: 'dock-view', payload: view }))
const dots = () => [...document.querySelectorAll<HTMLElement>('[data-dot]')]

describe('the dock', () => {
  it('says it is listening, then shows a dot per agent, oldest first, in its light', () => {
    render(<QuickDock />)
    expect(sent[0]).toEqual({ kind: 'ready' })
    expect(document.documentElement.dataset.page).toBe('dock')
    expect(document.documentElement.dataset.theme).toBe('dark')

    tell(VIEW)
    expect(dots().map((d) => d.dataset.dot)).toEqual(['1', '2', '3', '4'])
    expect(dots().map((d) => d.dataset.light)).toEqual(['working', 'asking', 'done', 'failed'])
    expect(screen.getByRole('button', { name: 'Pick a tag scheme, needs you' })).toBe(dots()[1])
  })

  it('rings the agent whose panel is out', () => {
    render(<QuickDock />)
    tell({ ...VIEW, selected: '2' })
    expect(dots().map((d) => d.dataset.selected)).toEqual(['false', 'true', 'false', 'false'])
    expect(dots()[1]).toHaveAttribute('aria-current', 'true')
    tell({ ...VIEW, selected: '3' })
    expect(dots().map((d) => d.dataset.selected)).toEqual(['false', 'false', 'true', 'false'])
    tell(VIEW)
    expect(dots().every((d) => d.dataset.selected === 'false')).toBe(true)
  })

  it('tells main where the pointer is, and which dot was clicked', () => {
    render(<QuickDock />)
    tell(VIEW)
    sent = []
    fireEvent.mouseEnter(dots()[0]!)
    fireEvent.mouseEnter(dots()[2]!)
    fireEvent.click(dots()[2]!)
    fireEvent.mouseLeave(screen.getByRole('group', { name: 'Quick agents' }))
    expect(sent).toEqual([
      { kind: 'hover', id: '1' },
      { kind: 'hover', id: '3' },
      { kind: 'pick', id: '3' },
      { kind: 'hover', id: null },
    ])
  })

  it('reports its size and the centre of each dot, measured down from its top', () => {
    // jsdom lays nothing out: the dock is at y 100, each slot 18px under 5px
    // of padding.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const slots = this.parentElement === null ? [] : [...this.parentElement.children]
      const top =
        this.dataset.dot === undefined ? 100 : 100 + 5 + 18 * slots.indexOf(this as Element)
      const height = this.dataset.dot === undefined ? 10 + 18 * dots().length : 18
      return {
        top,
        height,
        width: 28,
        left: 0,
        right: 28,
        bottom: top + height,
        x: 0,
        y: top,
      } as DOMRect
    })
    render(<QuickDock />)
    tell(VIEW)
    expect(sent.filter((r) => r.kind === 'size').at(-1)).toEqual({
      kind: 'size',
      width: 28,
      height: 82,
      dots: [14, 32, 50, 68],
    })
    // A dot more: measured again.
    tell({ ...VIEW, dots: [...VIEW.dots, { id: '5', name: 'Draft the reply', state: 'working' }] })
    expect(sent.filter((r) => r.kind === 'size').at(-1)).toMatchObject({
      height: 100,
      dots: [14, 32, 50, 68, 86],
    })
  })

  it("wears the open vault's theme, which can recolour the lights", () => {
    render(<QuickDock />)
    tell({ ...VIEW, remote: 'syv/vault' })
    expect(trpc).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'theme.read', input: { remote: 'syv/vault' } }),
    )
  })

  it('lets a new dot arrive, but not the ones the dock opened with', () => {
    render(<QuickDock />)
    tell(VIEW)
    expect(dots().map((d) => d.querySelector('.quick-dot')!.getAttribute('data-arriving'))).toEqual(
      ['false', 'false', 'false', 'false'],
    )
    tell({ ...VIEW, dots: [...VIEW.dots, { id: '5', name: 'Draft the reply', state: 'working' }] })
    expect(dots().map((d) => d.querySelector('.quick-dot')!.getAttribute('data-arriving'))).toEqual(
      ['false', 'false', 'false', 'false', 'true'],
    )
  })
})
