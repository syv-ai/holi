/**
 * The file tree's own order (docs/features/file-tree.md): a folder's children
 * as you dragged them, kept per vault on this machine (`state/tree-order.ts`).
 * Pure, so the rules are tested without a tree.
 *
 * **Ordered first, then by name.** A child you placed sorts by its place; one
 * you never placed (new, or arrived by a pull) follows, in the tree's default
 * order. A placed path that has gone (renamed, moved, deleted) is ignored, not
 * removed, as a pin is: an undone rename finds its place again.
 */

/** Sort `children` by `order` (ids placed, in place order), then `fallback`. */
export function orderChildren(
  children: readonly string[],
  order: readonly string[] | undefined,
  fallback: (a: string, b: string) => number,
): string[] {
  if (order === undefined || order.length === 0) return [...children].sort(fallback)
  const at = new Map(order.map((id, i) => [id, i]))
  return [...children].sort((a, b) => {
    const ia = at.get(a)
    const ib = at.get(b)
    if (ia !== undefined && ib !== undefined) return ia - ib
    if (ia !== undefined) return -1
    if (ib !== undefined) return 1
    return fallback(a, b)
  })
}

/**
 * The folder's order once `moving` lands before or after `target`. `siblings`
 * is the folder's children as shown now; `moving` may come from elsewhere (a
 * move into the folder with a place), already renamed to its path here. The
 * result places every child, so the shown order is exactly what is kept.
 */
export function placeAmong(
  siblings: readonly string[],
  moving: readonly string[],
  target: string,
  side: 'before' | 'after',
): string[] {
  const moved = new Set(moving)
  const rest = siblings.filter((id) => !moved.has(id))
  const i = rest.indexOf(target)
  if (i === -1) return [...rest, ...moving]
  const at = side === 'before' ? i : i + 1
  return [...rest.slice(0, at), ...moving, ...rest.slice(at)]
}
