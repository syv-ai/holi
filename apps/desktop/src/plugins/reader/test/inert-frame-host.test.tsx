/** A `.test.tsx` so it runs in the jsdom project: the frame is mounted. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { atom } from 'jotai'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/plugin-api', () => ({ openExternal: vi.fn(), activeModeAtom: atom('light') }))
const { InertFrame } = await import('../renderer/inert-frame-host')

/** A draw that settles when the test says so. */
function pending() {
  let settle!: { resolve: () => void; reject: (err: Error) => void }
  const draw = vi.fn(() => new Promise<void>((resolve, reject) => (settle = { resolve, reject })))
  return { draw, settle: () => settle }
}

afterEach(cleanup)

describe('a file drawn in a frame', () => {
  it('shows a page’s shape until it is drawn', async () => {
    const { draw, settle } = pending()
    render(<InertFrame label="a.docx" failure="This document didn’t open" draw={draw} />)
    expect(screen.getByRole('status')).toBeTruthy()
    await act(async () => settle().resolve())
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows the error with Retry when drawing fails, and draws again on Retry', async () => {
    const { draw, settle } = pending()
    render(<InertFrame label="a.docx" failure="This document didn’t open" draw={draw} />)
    await act(async () => settle().reject(new Error('It unpacks too large to open.')))
    expect(screen.getByRole('alert').textContent).toContain('It unpacks too large to open.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(draw).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('status')).toBeTruthy()
  })

  it('aborts the draw when it goes', () => {
    const { draw } = pending()
    const { unmount } = render(<InertFrame label="a.docx" failure="x" draw={draw} />)
    const signal = (draw.mock.calls[0] as unknown as [HTMLElement, AbortSignal])[1]
    unmount()
    expect(signal.aborted).toBe(true)
  })
})
