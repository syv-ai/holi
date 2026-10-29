import { parentOf } from '@/lib/tree-paths'

import { documentTitle } from './markdown'

/** The vault path a `[[target]]` names: an exact path, else a markdown
 *  file whose name matches, nearest folder first. */
export function resolveLink(
  target: string,
  from: string,
  docs: readonly { path: string }[],
): string | null {
  const wanted = target.toLowerCase().replace(/\.md$/, '')
  const exact = docs.find((doc) => doc.path.toLowerCase().replace(/\.md$/, '') === wanted)
  if (exact) return exact.path
  const named = docs.filter((doc) => documentTitle(doc.path).toLowerCase() === wanted)
  const folder = parentOf(from)
  return named.find((doc) => parentOf(doc.path) === folder)?.path ?? named[0]?.path ?? null
}
