/**
 * Finding a word inside a document that is not the app's.
 *
 * Each mail body is its own sandboxed frame (`mail-frame.ts`), so find runs
 * per document; the component orders results across messages. This is the
 * React-free half: mark the matches in one document and return them in order.
 *
 * Marks are real elements, not `CSS.highlights`: the frame document is
 * rewritten on theme or image-policy changes while a highlight registry lives
 * on the window, so the two desynchronise invisibly.
 *
 * Mark colours are `!important`: mail CSS can hide `mark`, and a hidden match
 * the counter still reports is worse than none.
 */

/** The attribute every mark carries, so clearing can find them all again. */
const MARK_ATTR = 'data-holi-find'
/** Set on the one match the user is standing on. */
const ACTIVE_ATTR = 'data-holi-find-active'

/** Inline styles: the frame document has no stylesheet of ours. */
const MARK_STYLE = 'background:#fde047!important;color:#111827!important'
const ACTIVE_STYLE = 'background:#fb923c!important;color:#111827!important'

/**
 * Every text node worth searching.
 *
 * `SCRIPT` and `STYLE` cannot appear (sanitised). A previous run's marks can,
 * which is why `findIn` clears first: marks would otherwise nest.
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
 * Case-insensitive, within a single text node: a term split across elements
 * (`he<b>llo</b>`) is not found.
 */
export function findIn(root: Element, term: string): HTMLElement[] {
  clearIn(root)
  if (term === '') return []

  const doc = root.ownerDocument
  const needle = term.toLowerCase()
  const marks: HTMLElement[] = []

  // Collected before mutating, or a live walker walks into its own marks.
  for (const node of textNodesIn(root, doc)) {
    const text = node.nodeValue ?? ''
    const haystack = text.toLowerCase()
    if (!haystack.includes(needle)) continue

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
 * `normalize()` matters: unwrapping leaves adjacent text nodes, and a later
 * search could not match across the seams.
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
