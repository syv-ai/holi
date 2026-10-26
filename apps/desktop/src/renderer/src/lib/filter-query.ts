/**
 * The shape of a filter query (ReUI's `Filters` edits the same tree), for the
 * stores that hold one. Pure data, so state need not reach into
 * `components/reui`; the component's own types are structurally the same.
 */

export interface FilterRule {
  id: string
  type: 'rule'
  /** Field path, root first. */
  path: string[]
  operator: string
  value: unknown
  /** Flips the meaning in place. */
  negated?: boolean
}

interface FilterGroupNode {
  id: string
  type: 'group'
  combinator: 'and' | 'or'
  rules: FilterNode[]
}

export type FilterNode = FilterRule | FilterGroupNode

/** A whole query: always a group, so flat and nested are one code path. */
export type FilterQuery = FilterGroupNode

/** An empty query. */
export function emptyFilterQuery(): FilterQuery {
  return { id: 'root', type: 'group', combinator: 'and', rules: [] }
}

/** A rule over `path`. */
export function filterRule(input: {
  id: string
  path: string[]
  operator: string
  value?: unknown
}): FilterRule {
  return {
    id: input.id,
    type: 'rule',
    path: input.path,
    operator: input.operator,
    value: input.value,
  }
}
