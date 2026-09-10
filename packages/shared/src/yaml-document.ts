/**
 * Merge values into a YAML file without losing the file.
 *
 * **The one rule this module exists for: a write never destroys a comment.**
 * `.holi/settings/*.yaml` carries the explanations that used to live only in
 * the settings tab — what a key means, what a token paints — and it is also
 * somewhere a person or the agent can write a note of their own. Stringifying a
 * plain object over the top would delete all of it, once, permanently, the
 * first time anybody touched a control.
 *
 * So every write goes `parseDocument` → `set` → `toString`, and the document
 * survives the round trip: comments, key order, and any structure this app does
 * not know about.
 *
 * **Comments are added, never replaced.** A key that already carries one keeps
 * it, so a note somebody wrote above a setting is not overwritten by the
 * generated one on the next write.
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
 * A path rather than a key, because a theme file is nested: `['dark', 'primary']`
 * wants the note for `--primary`, and `['dark']` wants "the dark palette".
 * Return `undefined` for anything with nothing to say.
 */
export type CommentFor = (path: readonly string[]) => string | undefined

/** Attach a generated comment to every key that has one and lacks its own. */
function annotate(map: YAMLMap, commentFor: CommentFor, path: readonly string[]): void {
  for (const pair of map.items) {
    // **A key set programmatically is a bare string, not a node**, and only a
    // node can carry a comment. Keys that came from the parser are already
    // Scalars; the ones `set` just added are not, which is why a freshly seeded
    // file came out with no explanations at all while a merged one had them.
    // Promote, then annotate, so both paths behave the same.
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
      // faithfully keeps it — so a converted file would come out as one long
      // line with its comments stacked at the top. The walk is already here.
      value.flow = false
      annotate(value, commentFor, here)
    }
  }
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
  // lands inside `{ a: 1, b: 2 }` on one line — and a comment attached to a key
  // inside a flow map has nowhere sensible to go, so they all pile up at the
  // front. This is the difference between a file that explains itself and a
  // file with the explanations shuffled.
  if (doc.contents === null) doc.contents = doc.createNode({}) as YAMLMap

  // **Errors as well as shape.** A document that failed to parse can still hand
  // back a map, and `toString` on it THROWS — so a corrupt file would make
  // every later write fail and leave the settings pane unable to repair the one
  // thing it is looking at. Both cases mean the same thing: there is nothing
  // here to merge with, so start over.
  if (doc.errors.length > 0 || !isMap(doc.contents)) {
    return mergeYamlDocument(null, values, commentFor)
  }
  doc.contents.flow = false

  for (const [key, value] of Object.entries(values)) {
    // **`createNode`, not the plain value.** `doc.set(key, {a: 1})` stores the
    // JS object as-is and only turns it into YAML at `toString`, so there are
    // no nested pairs to walk and a nested key can never be given a comment —
    // which is why `theme.yaml` named its palettes but not the tokens inside
    // them. `createNode` converts the whole subtree into real nodes.
    doc.set(key, doc.createNode(value))
  }
  annotate(doc.contents, commentFor, [])

  // `lineWidth: 0` disables folding. A wrapped value in a settings file is a
  // value somebody has to reassemble by eye before they can edit it.
  return doc.toString({ lineWidth: 0 })
}
