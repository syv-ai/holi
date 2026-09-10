/**
 * Which of these paths does git ignore?
 *
 * The tree shows gitignored files — that is deliberate, they are real files in
 * the directory — but until now it showed them looking exactly like committed
 * content. A vault can ignore anything: `*.local.*` is seeded, and an older
 * vault carries a bare `USER.md` line, so **the name does not tell you**. The
 * established answer, and VS Code's, is to dim them.
 *
 * **`git check-ignore` rather than reading `.gitignore` ourselves.** Ignore
 * rules nest, negate (`!keep.md`), and are spread across every directory plus
 * `.git/info/exclude` and the user's global file. Reimplementing that is a
 * second opinion about a question git already answers exactly.
 *
 * **It consults the index, and that is the behaviour we want.** A tracked file
 * is not ignored however well a rule matches it — git stops applying ignore
 * rules once a path is in the index — so a file someone committed before the
 * rule existed reads as ordinary content, which is what it is.
 *
 * Paths go over **stdin**, not as arguments: a vault holds thousands of files
 * and an argument list that long is `E2BIG`, silently, and only on the vaults
 * big enough for it to matter.
 */
import { tryGit } from '../git'

/**
 * The subset of `paths` git ignores. Empty on any failure.
 *
 * **Never throws, and that is load-bearing.** This decorates a tree; it does
 * not decide what is in one. A directory that is not a repo yet, a missing git
 * binary, a vault mid-rebase — each means "nothing is known to be ignored", and
 * the tree renders undimmed rather than not at all.
 */
export async function ignoredPaths(root: string, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return []

  // `-z` in both directions: a vault has paths with spaces and non-ASCII in
  // them (`nøter/æøå.md`), and without it git quotes and escapes them, so every
  // path downstream is one that does not exist.
  const outcome = await tryGit(root, ['check-ignore', '-z', '--stdin'], {
    input: `${paths.join('\0')}\0`,
  }).catch(() => null)

  // **Exit 1 means "none of them", not "it failed".** Treating a non-zero exit
  // as an error here would make an ordinary vault — one where nothing at all is
  // ignored — look like a broken one. Only 0 and 1 are answers; 128 is a real
  // failure and falls through to the empty list with everything else.
  if (outcome === null || (outcome.code !== 0 && outcome.code !== 1)) return []

  return outcome.stdout.split('\0').filter((p) => p !== '')
}
