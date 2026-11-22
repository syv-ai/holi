/**
 * Where an opening book starts (docs/features/reader.md): where this machine
 * last read it, or its start when that place is gone, or an error when even
 * the start shows nothing.
 *
 * foliate says little when it cannot show a place. A saved location whose
 * node a newer version of the book no longer has makes `init` reject; one past
 * the end of the spine, or a chapter that fails to load, resolves with no page
 * shown. So a page counts as shown only when the view says one loaded and
 * `init` did not reject.
 */
import type { View } from './vendor/foliate/view.js'

type Openable = Pick<View, 'init' | 'addEventListener' | 'removeEventListener'>

/** Shows the book's first page at `saved`, or at its start, calling `forget`
 *  when `saved` could not be shown. Rejects when nothing could be shown. */
export async function startReading(
  view: Openable,
  saved: string | undefined,
  forget: () => void,
): Promise<void> {
  let shown = false
  const onLoad = () => (shown = true)
  view.addEventListener('load', onLoad)
  try {
    if (saved !== undefined) {
      // A rejection may come after its chapter loaded, never placed: start over.
      const placed = await view.init({ lastLocation: saved }).then(
        () => shown,
        () => false,
      )
      if (placed) return
      forget()
    }
    await view.init({ showTextStart: true })
    if (!shown) throw new Error('The book’s first page didn’t load.')
  } finally {
    view.removeEventListener('load', onLoad)
  }
}
