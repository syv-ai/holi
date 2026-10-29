/**
 * ⌥ held on the click (or Enter) that opens something: a document, a
 * session, an app opens in split view beside what is in front instead of in
 * its place (docs/features/tabs-panes.md, Making a split). Whatever opens a
 * tab asks `openingBeside()` in the same moment; reading it spends it, so one
 * ⌥-click opens one thing beside.
 */
let last = { alt: false, at: 0 }

/** How long after the gesture an open still counts as its result: an open
 *  that follows a state change runs an effect later than the click. */
const WINDOW_MS = 400

function note(event: MouseEvent | KeyboardEvent) {
  last = { alt: event.altKey, at: performance.now() }
}

if (typeof window !== 'undefined') {
  window.addEventListener('click', note, true)
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Enter') note(event)
    },
    true,
  )
}

/** True once when the gesture that is opening something held ⌥. */
export function openingBeside(): boolean {
  const beside = last.alt && performance.now() - last.at < WINDOW_MS
  last = { alt: false, at: 0 }
  return beside
}

/** Make the next open, in this moment, open beside what is in front, as if
 *  ⌥ were held: for an action that asks for split view by itself, such as
 *  a card's Ask about this app, whose tab opens from a selection. */
export function openNextBeside(): void {
  last = { alt: true, at: performance.now() }
}
