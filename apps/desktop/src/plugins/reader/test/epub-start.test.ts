import { describe, expect, it, vi } from 'vitest'
import type { View } from '../renderer/vendor/foliate/view.js'
import { startReading } from '../renderer/epub-start'

/** What one `init` does in foliate: shows a page, resolves showing none (a
 *  chapter that failed to load, a place past the spine), or rejects (a saved
 *  place whose node is gone). */
type Outcome = 'page' | 'blank' | 'throws' | 'loads-then-throws'

function fakeView(...outcomes: Outcome[]) {
  const view = new EventTarget()
  const init = vi.fn(async () => {
    const outcome = outcomes.shift()
    if (outcome === 'page' || outcome === 'loads-then-throws') view.dispatchEvent(new Event('load'))
    if (outcome === 'throws' || outcome === 'loads-then-throws') throw new Error('no such node')
  })
  return { view: Object.assign(view, { init }) as unknown as View, init }
}

describe('opening a book', () => {
  it('goes to where it was last read', async () => {
    const { view, init } = fakeView('page')
    const forget = vi.fn()
    await startReading(view, 'epubcfi(/6/4!/4/2)', forget)
    expect(init.mock.calls).toEqual([[{ lastLocation: 'epubcfi(/6/4!/4/2)' }]])
    expect(forget).not.toHaveBeenCalled()
  })

  it('starts over and forgets the place when that place is gone', async () => {
    for (const gone of ['throws', 'loads-then-throws'] as const) {
      const { view, init } = fakeView(gone, 'page')
      const forget = vi.fn()
      await startReading(view, 'epubcfi(/6/4!/4/2)', forget)
      expect(init).toHaveBeenLastCalledWith({ showTextStart: true })
      expect(forget).toHaveBeenCalledOnce()
    }
  })

  it('starts over and forgets the place when it shows nothing', async () => {
    const { view, init } = fakeView('blank', 'page')
    const forget = vi.fn()
    await startReading(view, 'epubcfi(/6/99!/4/2)', forget)
    expect(init).toHaveBeenLastCalledWith({ showTextStart: true })
    expect(forget).toHaveBeenCalledOnce()
  })

  it('fails when even its start shows nothing', async () => {
    await expect(startReading(fakeView('blank').view, undefined, vi.fn())).rejects.toThrow(
      /first page/,
    )
    await expect(
      startReading(fakeView('throws', 'blank').view, 'epubcfi(/6/4!/4/2)', vi.fn()),
    ).rejects.toThrow(/first page/)
  })
})
