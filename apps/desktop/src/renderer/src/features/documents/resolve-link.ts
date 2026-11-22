import { parentOf } from '@/lib/tree-paths'

import { documentTitle } from './markdown'

/** The vault path a `[[target]]` names: an exact path, else a markdown
 *  file whose name matches, nearest folder first. `.mdx` is resolved only as
 *  an exact source-file path; it is never included in ordinary note matching. */
export function resolveLink(
  target: string,
  from: string,
  docs: readonly { path: string }[],
  mdxFiles: readonly { path: string }[] = [],
): string | null {
  if (target.toLowerCase().endsWith('.mdx'))
    return mdxFiles.find((file) => file.path.toLowerCase() === target.toLowerCase())?.path ?? null
  const wanted = target.toLowerCase().replace(/\.md$/, '')
  const exact = docs.find((doc) => doc.path.toLowerCase().replace(/\.md$/, '') === wanted)
  if (exact) return exact.path
  const named = docs.filter((doc) => documentTitle(doc.path).toLowerCase() === wanted)
  const folder = parentOf(from)
  return named.find((doc) => parentOf(doc.path) === folder)?.path ?? named[0]?.path ?? null
}
