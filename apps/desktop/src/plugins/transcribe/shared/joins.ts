/**
 * Topics a person joined: two or more groups from different parts of the
 * meeting, about one subject, read as one topic (docs/features/meetings.md).
 * A group stays the contiguous stretch the scribe wrote; joining only names
 * which group heads a set (`Topic.joinedTo`), so the scribe's writes, splits
 * and merges work as before and the join rides along.
 *
 * Pure and browser-safe: main keeps the joins tidy on every change, and the
 * renderer and the minutes read the sets from them.
 */
import type { Topic } from './meeting'

/** The id of the group heading `id`'s set: its own id when not joined. */
function rootOf(byId: ReadonlyMap<string, Topic>, id: string): string {
  const seen = new Set<string>()
  let at = id
  for (;;) {
    const next = byId.get(at)?.joinedTo
    if (next === undefined || !byId.has(next) || seen.has(next)) return at
    seen.add(at)
    at = next
  }
}

/**
 * The joins made consistent: a join to a group that is gone, or to itself,
 * dropped; every member pointing straight at its set's head; the head the
 * set's earliest group, so a joined topic sits where it was first talked
 * about; and the open group never in a set, since it is still being
 * written.
 */
export function tidyJoins(topics: readonly Topic[]): Topic[] {
  const byId = new Map(topics.map((t) => [t.id, t]))
  const sets = new Map<string, Topic[]>()
  for (const t of topics) {
    if (t.open) continue
    const root = rootOf(byId, t.id)
    if (byId.get(root)?.open === true) continue
    sets.set(root, [...(sets.get(root) ?? []), t])
  }
  const headOf = new Map<string, string>()
  for (const members of sets.values()) {
    if (members.length < 2) continue
    const head = members.reduce((a, b) => (b.start < a.start ? b : a))
    for (const m of members) if (m !== head) headOf.set(m.id, head.id)
  }
  return topics.map((t) => {
    const head = headOf.get(t.id)
    if (head === t.joinedTo) return t
    if (head === undefined) {
      const { joinedTo: _gone, ...rest } = t
      return rest
    }
    return { ...t, joinedTo: head }
  })
}

/** The topics as a person reads them: each set in one place, its head
 *  first and the rest in meeting order, where its head is. */
export function joinedSets(topics: readonly Topic[]): Topic[][] {
  const members = new Map<string, Topic[]>()
  for (const t of topics) {
    if (t.joinedTo !== undefined) members.set(t.joinedTo, [...(members.get(t.joinedTo) ?? []), t])
  }
  return topics
    .filter((t) => t.joinedTo === undefined)
    .map((t) => [t, ...(members.get(t.id) ?? [])])
}

/** A joined topic read as one group: the head's title and fields, every
 *  group's lines, bullets, keywords, decisions, questions and suggestions,
 *  each once, from the first's start to the last's end. A group not joined
 *  is itself. */
export function asOne(topics: readonly Topic[], t: Topic): Topic {
  const head = t.joinedTo ?? t.id
  const set = joinedSets(topics).find((s) => s[0]!.id === head)
  return set === undefined || set.length < 2 ? t : merged(set)
}

/** The groups of one set (`joinedSets`) read as one: how the topic, the
 *  minutes and Send all read a joined topic. */
export function merged(set: readonly Topic[]): Topic {
  const [first] = set as readonly [Topic, ...Topic[]]
  const all = <T>(pick: (x: Topic) => readonly T[]): T[] => [...new Set(set.flatMap(pick))]
  return {
    ...first,
    lines: all((x) => x.lines).sort((a, b) => a - b),
    summary: all((x) => x.summary),
    keywords: all((x) => x.keywords),
    decisions: all((x) => x.decisions),
    questions: all((x) => x.questions),
    suggestions: set.flatMap((x) => x.suggestions),
    end: Math.max(...set.map((x) => x.end)),
  }
}
