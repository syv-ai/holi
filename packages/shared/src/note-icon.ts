/**
 * A note's own icon (D82): `icon: 🎯` in its **leading** frontmatter block.
 *
 * The emoji lives in the note rather than in a per-vault map keyed by path,
 * because a path-keyed map rots. Notes here are moved by things that never go
 * through Holi — the agent's `mv`, a terminal, a git operation — and every one
 * of those would silently detach an icon from its note and leave a dead entry
 * behind. Frontmatter travels with the file, so a move costs no migration code
 * and there is nothing to keep in sync. It is the same reasoning that already
 * puts `kind` in the file's frontmatter rather than in its filename (see
 * `DocMeta`), which is why this reads only the leading block, exactly as
 * `isDaily` does: a body containing a horizontal rule and an `icon:` line is a
 * note about icons, not a note with one.
 *
 * Folders are deliberately out of scope — they have no frontmatter, and giving
 * them one would mean either a per-folder marker file or the path-keyed map
 * this design rejects.
 */

/**
 * Exactly one emoji, in the forms a keyboard or picker actually produces:
 * `RGI_Emoji` covers ZWJ sequences (👩‍💻), skin-tone modifiers (👍🏽), regional
 * indicator pairs (🇩🇰) and keycaps (#️⃣) as single units, where a plain
 * `\p{Emoji}` would match the bare digit in `1` and split the rest.
 *
 * Built with `new RegExp` rather than a literal on purpose: the `v` flag is
 * ES2024 and this package targets ES2022, so TypeScript rejects the literal
 * form. Every runtime that loads this — Node 24 for the main process and tests,
 * Chromium 140 in Electron 43 for the renderer — supports it.
 */
const ONE_EMOJI = new RegExp('^\\p{RGI_Emoji}$', 'v')

/**
 * A lone pictograph, with or without a selector after it.
 *
 * RGI is strictly correct that a bare text-presentation character (❤, ⚙)
 * is not an emoji — but it is one to whoever typed it, and copying a symbol
 * out of a web page is enough to produce the bare form. Refusing it in
 * silence is the same failure as refusing the picker's star, so the bar here
 * is what the person meant rather than what the registry ratified.
 *
 * `Extended_Pictographic` is the safe way to say that: it holds no letter,
 * digit or punctuation, so this widens the rule without letting a word in.
 * The single-character anchor is what keeps a sentence out.
 */
const ONE_PICTOGRAPH = /^\p{Extended_Pictographic}\ufe0f?$/u

/**
 * Whether a value is a single emoji, in either spelling a keyboard produces.
 *
 * Emoji split in two here, and RGI holds exactly one spelling of each:
 *
 *   - **emoji-presentation by default** (⭐ ✅ ⚡ and every pictograph): RGI has
 *     the bare form, and `U+2B50 U+FE0F` is NOT in the set, the selector being
 *     redundant. The macOS picker emits it anyway.
 *   - **text-presentation by default** (❤️ ▶️ ☑️): RGI has the `…U+FE0F` form,
 *     and the bare character is a dingbat rather than an emoji.
 *
 * So one test cannot cover both, and testing only the literal value is what
 * made picking a star from the palette leave the note on its markdown glyph.
 * Trying the value with its selectors stripped catches the first class without
 * loosening anything: stripping cannot turn a non-emoji into an emoji, since
 * what is left still has to match RGI on its own.
 */
function isOneEmoji(value: string): boolean {
  return (
    ONE_EMOJI.test(value) ||
    ONE_EMOJI.test(value.replace(/\ufe0f/g, '')) ||
    ONE_PICTOGRAPH.test(value)
  )
}

/** The note's icon, or undefined if it declares none or declares a bad one. */
export function noteIcon(text: string): string | undefined {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return undefined
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) return undefined

  // `^icon:` is anchored hard against the line start: an indented `icon:` is a
  // child of some other YAML key and says nothing about this note.
  const match = /^icon:[ \t]*(.*)$/m.exec(normalized.slice(4, end + 1))
  if (!match?.[1]) return undefined

  // A YAML editor may quote the value; a lone emoji needs no quotes, so accept
  // either. Anything left that is not one emoji is refused rather than
  // truncated — the value lands in a fixed-size tree row.
  const value = match[1].trim().replace(/^(['"])(.*)\1$/, '$2')
  // Returned exactly as the file spells it, never re-normalized: both spellings
  // of a star render identically, and rewriting the user's frontmatter to say
  // something it does not say is not this function's job.
  return isOneEmoji(value) ? value : undefined
}
