/**
 * A markdown body's first heading, read and written.
 *
 * This is the title rule. A task's name is the first heading in its body at
 * **any** level, not a `title:` in frontmatter and not the filename — so the
 * name of the thing is written where you are already writing, in the document,
 * and there is no second field to disagree with it.
 *
 * Generic rather than task-shaped on purpose: nothing here knows what a task is,
 * and a note that wants the same rule later needs no new code.
 *
 * **ATX only** (`# Title`), never setext (`Title` over `=====`). Every heading
 * Holi's own editor writes is ATX, and a setext underline is indistinguishable
 * from a paragraph until the line after it, which is a lookahead this does not
 * need to grow for a spelling nobody here produces.
 */

/** Up to three leading spaces is still a heading; the fourth makes it code. */
const ATX = /^ {0,3}(#{1,6})\s+(.*)$/
/** The same indent rule for a fence, which is the thing a `#` can hide inside. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/
/** A closing run of hashes is decoration, not part of the text: `# Title #`. */
const TRAILING_HASHES = /\s+#+\s*$/

/**
 * The first heading's text, or `null` when the body has none.
 *
 * **Fenced code is skipped**, which is the whole reason this is not a one-line
 * regex: a task whose body opens with a shell block would otherwise be called
 * `!/bin/bash` — or worse, renamed by a comment someone pasted.
 */
export function firstHeading(body: string): string | null {
  let fence: string | null = null
  for (const line of body.split('\n')) {
    const fenced = FENCE.exec(line)
    if (fenced !== null) {
      const marker = fenced[1]![0]!
      // A ``` inside a ~~~ block is content, not a close. Only its own
      // character can end a fence.
      if (fence === null) fence = marker
      else if (marker === fence) fence = null
      continue
    }
    if (fence !== null) continue

    const heading = ATX.exec(line)
    if (heading === null) continue
    const text = heading[2]!.replace(TRAILING_HASHES, '').trim()
    // `#` alone is an empty heading, which names nothing. Keep looking.
    if (text !== '') return text
  }
  return null
}

/**
 * The body with `title` as its first heading.
 *
 * Replaces the existing heading's text when there is one, keeping its level —
 * a task whose author wrote `## ` meant that — and prepends an `#` heading when
 * there is not. Used when a task is created; every later rename is someone
 * editing the line.
 */
export function setFirstHeading(body: string, title: string): string {
  const lines = body.split('\n')
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fenced = FENCE.exec(line)
    if (fenced !== null) {
      const marker = fenced[1]![0]!
      if (fence === null) fence = marker
      else if (marker === fence) fence = null
      continue
    }
    if (fence !== null) continue

    const heading = ATX.exec(line)
    if (heading === null) continue
    if (heading[2]!.replace(TRAILING_HASHES, '').trim() === '') continue
    lines[i] = `${heading[1]!} ${title}`
    return lines.join('\n')
  }

  const rest = body.trim()
  return rest === '' ? `# ${title}\n` : `# ${title}\n\n${rest}\n`
}
