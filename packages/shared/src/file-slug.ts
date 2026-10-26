/**
 * A title as a file name that Holi makes for it (a task's, a saved link's):
 * lower case, words joined by dashes, and nothing else. `Møde om Q3: næste
 * skridt` is `moede-om-q3-naeste-skridt`.
 *
 * Danish and Norwegian letters are written out the way they are typed
 * without them (æ ae, ø oe, å aa), ß is ss, and any other accented letter
 * loses its accent (é e, ü u). Everything that is still not a letter or a
 * digit is a separator, so no `/`, `..` or `.local.` can come through to move
 * the file, leave the vault, or keep it off other machines.
 */

const SPELLED: Readonly<Record<string, string>> = { æ: 'ae', ø: 'oe', å: 'aa', ß: 'ss' }

export function fileSlug(
  title: string,
  { max = 60, fallback }: { max?: number; fallback: string },
): string {
  const slug = title
    .toLowerCase()
    .replace(/[æøåß]/g, (c) => SPELLED[c]!)
    // Split a letter from its accent, then drop the accent.
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  // Cut at the last whole word that fits.
  const cut =
    slug.length <= max ? slug : slug.slice(0, max + 1).replace(/-[^-]*$/, '') || slug.slice(0, max)
  const tidy = cut.replace(/-+$/, '')
  return tidy === '' ? fallback : tidy
}
