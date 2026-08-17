/**
 * Finding a word inside a document that is not the app's.
 *
 * A mail body lives in its own sandboxed frame ([[mail-frame]]), so "find in
 * this thread" is not one search over one DOM — it is one search per message,
 * each in a separate document, and the results have to be ordered as the
 * messages are. That coordination belongs to the component; what belongs here
 * is the half that has no React and no iframes in it: given *a* document, mark
 * the matches and give them back in order.
 *
 * **Marks are real elements, not a `CSS.highlights` range.** The Custom
 * Highlight API would be tidier and does not survive what actually happens
 * here: the frame's document is rewritten whenever the theme or the image
 * policy changes, and a highlight registry lives on the window, so the two go
 * out of step invisibly. An element in the tree goes away with the tree it was
 * in, which is the behaviour that cannot desynchronise.
 *
 * **The mark carries its own colours with `!important`.** Mail brings hostile
 * CSS — a newsletter setting `mark { background: none }` is not hypothetical,
 * and a highlight the message can turn off is worse than none, because the
 * counter still says the match is there.
 *
 * Nothing here fetches, and nothing here is given untrusted *strings* — the
 * documents it walks have already been through the sanitiser.
 */

/** The attribute every mark carries, so clearing can find them all again. */
const MARK_ATTR = 'data-holi-find'
/** Set on the one match the user is standing on. */
const ACTIVE_ATTR = 'data-holi-find-active'

/** Inline styles rather than a class: the frame document has no stylesheet of
 *  ours, and adding one per message is more moving parts than two attributes. */
const MARK_STYLE = 'background:#fde047!important;color:#111827!important'
const ACTIVE_STYLE = 'background:#fb923c!important;color:#111827!important'

/**
 * Every text node worth searching.
 *
 * `SCRIPT` and `STYLE` cannot appear — the sanitiser forbids both — but a
 * previous run's own `<mark>` elements can, which is why clearing happens
 * before finding rather than being merged into it. Searching over marked text
 * would nest marks and make the second search's offsets meaningless.
 */
function textNodesIn(root: Node, doc: Document): Text[] {
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const out: Text[] = []
  let node = walker.nextNode()
  while (node !== null) {
    if (node.nodeValue !== null && node.nodeValue !== '') out.push(node as Text)
    node = walker.nextNode()
  }
  return out
}

/**
 * Mark every occurrence of `term` under `root`, in document order.
 *
 * Case-insensitive, and matches are found **within a single text node**. A term
 * split across an element boundary (`he<b>llo</b>`) is not found, which is what
 * every in-page find in a browser also does — reassembling the visible string
 * across elements would mean deciding where a mark starts and ends across a
 * tree, for a case that does not arise in prose.
 *
 * Returns the mark elements, so the caller can count them and scroll to one.
 */
export function findIn(root: Element, term: string): HTMLElement[] {
  clearIn(root)
  if (term === '') return []

  const doc = root.ownerDocument
  const needle = term.toLowerCase()
  const marks: HTMLElement[] = []

  // Collected BEFORE mutating: splitting a text node inserts new ones, and a
  // live walker would then walk into the text it had just marked.
  for (const node of textNodesIn(root, doc)) {
    const text = node.nodeValue ?? ''
    const haystack = text.toLowerCase()
    if (!haystack.includes(needle)) continue

    // Right to left, so an earlier index is still valid after a later split.
    const starts: number[] = []
    let at = haystack.indexOf(needle)
    while (at !== -1) {
      starts.push(at)
      at = haystack.indexOf(needle, at + needle.length)
    }

    const found: HTMLElement[] = []
    let rest = node
    let consumed = 0
    for (const start of starts) {
      // `splitText` returns the remainder, so offsets are relative to it.
      const middle = rest.splitText(start - consumed)
      const after = middle.splitText(needle.length)
      const mark = doc.createElement('mark')
      mark.setAttribute(MARK_ATTR, '')
      mark.setAttribute('style', MARK_STYLE)
      mark.textContent = middle.nodeValue
      middle.replaceWith(mark)
      found.push(mark)
      rest = after
      consumed = start + needle.length
    }
    marks.push(...found)
  }

  return marks
}

/**
 * Undo every mark, and put the text back the way it was.
 *
 * `normalize()` is the part that matters and the part that is easy to leave
 * out: unwrapping a mark leaves the text in three adjacent nodes, and a second
 * search would then be unable to match a term that straddles the seam — the
 * highlight would work once and then stop working on the same word.
 */
export function clearIn(root: Element): void {
  for (const mark of root.querySelectorAll(`[${MARK_ATTR}]`)) {
    mark.replaceWith(...mark.childNodes)
  }
  root.normalize()
}

/** Paint one match as the current one, and the rest as ordinary matches. */
export function setActiveMark(marks: HTMLElement[], index: number): void {
  marks.forEach((mark, at) => {
    const active = at === index
    mark.setAttribute('style', active ? ACTIVE_STYLE : MARK_STYLE)
    if (active) mark.setAttribute(ACTIVE_ATTR, '')
    else mark.removeAttribute(ACTIVE_ATTR)
  })
}
