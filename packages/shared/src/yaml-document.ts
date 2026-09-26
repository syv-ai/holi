/**
 * Edit a YAML mapping without losing the rest of the file.
 *
 * **A write never destroys a comment.** Every write goes `parseDocument` →
 * `set` → `toString`, so comments, key order, and any structure this app does
 * not know about survive the round trip. Stringifying a plain object over the
 * top would delete them.
 *
 * (The settings and theme files do NOT go through here: their writers
 * regenerate the whole document. See `writeSettingsText`.)
 */
import {
  parseDocument,
  isMap,
  isScalar,
  Scalar,
  type Document,
  type Node,
  type YAMLMap,
} from 'yaml'

/**
 * The comment a key should carry, given its path from the root.
 *
 * A path rather than a key, so a nested map can annotate its inner keys.
 * Return `undefined` for anything with nothing to say.
 */
export type CommentFor = (path: readonly string[]) => string | undefined

/** Attach a generated comment to every key that has one and lacks its own, so a
 *  comment somebody wrote above a key is never overwritten. */
function annotate(map: YAMLMap, commentFor: CommentFor, path: readonly string[]): void {
  for (const pair of map.items) {
    // **A key set programmatically is a bare string, not a node**, and only a
    // node can carry a comment. Keys that came from the parser are already
    // Scalars; the ones `set` just added are not. Promote, then annotate, so
    // both behave the same.
    if (!isScalar(pair.key)) {
      const raw: unknown = pair.key
      if (typeof raw !== 'string' && typeof raw !== 'number') continue
      pair.key = new Scalar(String(raw))
    }
    const key = pair.key as Scalar
    const here = [...path, String(key.value)]
    if (key.commentBefore == null) {
      const comment = commentFor(here)
      // Each line gets a leading space, which is what makes `yaml` emit
      // `# text` rather than `#text`.
      if (comment !== undefined) {
        key.commentBefore = comment
          .split('\n')
          .map((line) => ` ${line}`)
          .join('\n')
      }
    }
    const value = pair.value as Node | null
    if (isMap(value)) {
      // A map parsed from JSON is a FLOW map (`{ a: 1 }`), and `toString`
      // faithfully keeps it, so a converted file would come out as one long
      // line with its comments stacked at the top.
      value.flow = false
      annotate(value, commentFor, here)
    }
  }
}

/**
 * The top-level mapping a YAML document holds, or `null` when it does not hold
 * one.
 *
 * The frontmatter editor's read half. `null` is the signal to fall back to
 * editing the text: a document that will not parse, or one whose root is a list
 * or a scalar, has no rows to draw.
 */
export function readYamlMapping(text: string): Record<string, unknown> | null {
  const doc = parseDocument(text)
  if (doc.errors.length > 0 || !isMap(doc.contents)) return null
  const value: unknown = doc.toJS()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * Set and delete keys in a mapping, keeping everything else exactly as written.
 *
 * The frontmatter editor's write-back. **`undefined` deletes here**: a control
 * that clears a field has to remove the key rather than leave `due: null`
 * behind. (In `mergeYamlDocument` it does not, so an accidental `undefined`
 * never silently drops a value.)
 *
 * Comments, key order, and anything nested this app does not understand survive
 * the round trip, so a hand-written frontmatter block can be edited through a
 * form.
 */
export function editYamlMapping(existing: string, changes: Record<string, unknown>): string {
  const doc: Document<Node, false> = parseDocument(existing)
  // Same two failure shapes `mergeYamlDocument` guards: a document that failed
  // to parse can still hand back a map whose `toString` throws. There is
  // nothing here to edit into, so the caller keeps what it had.
  if (doc.errors.length > 0 || !isMap(doc.contents)) return existing
  doc.contents.flow = false

  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) doc.delete(key)
    else doc.set(key, doc.createNode(value))
  }

  // **An emptied mapping is empty, not `{}`.** Clearing the last field would
  // otherwise write a literal `{}` between the fences that nobody typed.
  if (doc.contents.items.length === 0) return ''
  return doc.toString({ lineWidth: 0 })
}

/**
 * Merge `values` into `existing`, returning the whole file to write.
 *
 * `existing` is the file as it was read, or `null` for one that does not exist
 * yet. A file whose top level is not a mapping is replaced rather than merged
 * into: there is nothing to merge with, and refusing forever would leave the
 * app unable to fix a file somebody broke.
 */
export function mergeYamlDocument(
  existing: string | null,
  values: Record<string, unknown>,
  commentFor: CommentFor = () => undefined,
): string {
  // `Document<Node, false>`: not the `.Parsed` node types, because the empty
  // case assigns freshly created contents rather than parsed ones.
  const doc: Document<Node, false> = parseDocument(existing ?? '')

  // **An empty document gets a BLOCK map, not `{}`.** `parseDocument('{}')`
  // faithfully preserves the flow style it was given, so every later `set`
  // lands inside `{ a: 1, b: 2 }` on one line, and comments attached to keys
  // inside a flow map all pile up at the front.
  if (doc.contents === null) doc.contents = doc.createNode({}) as YAMLMap

  // **Errors as well as shape.** A document that failed to parse can still hand
  // back a map, and `toString` on it THROWS, so a corrupt file would make every
  // later write fail. Both cases mean there is nothing to merge with: start over.
  if (doc.errors.length > 0 || !isMap(doc.contents)) {
    return mergeYamlDocument(null, values, commentFor)
  }
  doc.contents.flow = false

  for (const [key, value] of Object.entries(values)) {
    // **`createNode`, not the plain value.** `doc.set(key, {a: 1})` stores the
    // JS object as-is and only turns it into YAML at `toString`, so there are
    // no nested pairs to walk and a nested key can never be given a comment.
    // `createNode` converts the whole subtree into real nodes.
    doc.set(key, doc.createNode(value))
  }
  annotate(doc.contents, commentFor, [])

  // `lineWidth: 0` disables folding: a wrapped value has to be reassembled by
  // eye before it can be edited.
  return doc.toString({ lineWidth: 0 })
}
