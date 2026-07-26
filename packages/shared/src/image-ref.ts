/** Where a markdown `![](target)` points. */
export type ImageRef = { kind: 'external'; url: string } | { kind: 'vault'; path: string }

/**
 * Resolve a markdown image target against the note that contains it.
 * - `http(s)://…`          → external, used as the `<img src>` verbatim.
 * - `/foo/bar.png`         → vault-root-absolute (leading slash), GitHub semantics.
 * - `foo.png` / `../x.png` → note-relative, normalized (`.`/`..` collapsed).
 * `..` that would climb above the root is clamped (the main-process handler
 * re-validates with `vaultRelPath`, which rejects any residual `..`).
 * Pure; no filesystem access. Wiki embeds `[[img.png]]` are vault-relative and
 * do NOT go through here — they are used as-is.
 */
export function resolveImageRef(notePath: string, target: string): ImageRef {
  const t = target.trim()
  if (/^https?:\/\//i.test(t)) return { kind: 'external', url: t }

  const base = t.startsWith('/')
    ? [] // vault-root-absolute: ignore the note's folder
    : notePath.split('/').slice(0, -1) // the note's folder
  const stack = [...base]
  for (const seg of t.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') stack.pop()
    else stack.push(seg)
  }
  return { kind: 'vault', path: stack.join('/') }
}
