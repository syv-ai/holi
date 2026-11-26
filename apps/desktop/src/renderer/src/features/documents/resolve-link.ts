import type { VaultSnapshot } from '@holi/shared'

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

/** Resolve a rendered markdown link only when it names an existing vault note.
 * URL parsing supplies browser-compatible escaping; decoded segments are then
 * normalized as vault-relative paths, without ever granting URL-origin meaning. */
export function resolveMarkdownHref(
  href: string,
  from: string,
  snapshot: Pick<VaultSnapshot, 'docs' | 'files' | 'claimed'>,
): { path: string; heading?: string } | null {
  const target = href.trim()
  if (
    /^[a-z][a-z\d+.-]*:/i.test(target) ||
    target.startsWith('//') ||
    target.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(target)
  )
    return null
  let url: URL
  try {
    const base = `https://holi.invalid/${from.split('/').map(encodeURIComponent).join('/')}`
    url = new URL(target, base)
  } catch {
    return null
  }

  if (url.origin !== 'https://holi.invalid' || url.search) return null
  const notes = [
    ...snapshot.docs,
    ...snapshot.files,
    ...Object.values(snapshot.claimed).flatMap(({ items, broken }) => [...items, ...broken]),
  ]
  if (target.startsWith('#')) {
    let heading: string
    try {
      heading = decodeURIComponent(url.hash.slice(1))
    } catch {
      return null
    }
    return notes.some((doc) => doc.path === from) ? { path: from, heading } : null
  }

  let segments: string[]
  let heading: string | undefined
  try {
    segments = url.pathname
      .split('/')
      .filter(Boolean)
      .map((part) => decodeURIComponent(part))
    heading = url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined
  } catch {
    return null
  }

  const stack: string[] = []
  for (const segment of segments) {
    if (segment === '.' || segment === '') continue
    if (segment === '..') {
      if (!stack.length) return null
      stack.pop()
    } else {
      if (segment.includes('/') || segment.includes('\\') || segment.includes('\0')) return null
      stack.push(segment)
    }
  }
  const candidate = stack.join('/')
  if (!candidate.toLowerCase().endsWith('.md')) return null
  const found = notes.find((doc) => doc.path === candidate)
  return found ? { path: found.path, ...(heading === undefined ? {} : { heading }) } : null
}
