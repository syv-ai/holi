/**
 * Two versions of a file as one listing for the code block's diff marks:
 * every line of both, in order, with the removed and added ones named by
 * their line in that listing (the block's `diff` prop counts lines of the
 * code it is given, from 1).
 *
 * A longest-common-subsequence diff over lines, after trimming the shared
 * head and tail, which is what most edits are. Past `MAX_CELLS` of table the
 * middle is shown as removed then added rather than aligned, so a huge
 * rewrite costs nothing to open.
 */
const MAX_CELLS = 4_000_000

export interface LineDiff {
  code: string
  added: number[]
  removed: number[]
}

type Op = { kind: "same" | "add" | "remove"; text: string }

function splitLines(text: string): string[] {
  if (text === "") return []
  const lines = text.split("\n")
  // A final newline ends the last line; it does not start another.
  if (lines.at(-1) === "") lines.pop()
  return lines
}

function middleOps(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  if (n * m > MAX_CELLS) {
    return [
      ...a.map((text): Op => ({ kind: "remove", text })),
      ...b.map((text): Op => ({ kind: "add", text })),
    ]
  }
  // lcs[i][j]: the common run of a[i..] and b[j..], flattened.
  const width = m + 1
  const lcs = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!)
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", text: a[i]! })
      i++
      j++
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      ops.push({ kind: "remove", text: a[i++]! })
    } else {
      ops.push({ kind: "add", text: b[j++]! })
    }
  }
  while (i < n) ops.push({ kind: "remove", text: a[i++]! })
  while (j < m) ops.push({ kind: "add", text: b[j++]! })
  return ops
}

export function lineDiff(before: string, after: string): LineDiff {
  const a = splitLines(before)
  const b = splitLines(after)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++

  const ops: Op[] = [
    ...a.slice(0, head).map((text): Op => ({ kind: "same", text })),
    ...middleOps(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...a.slice(a.length - tail).map((text): Op => ({ kind: "same", text })),
  ]

  const added: number[] = []
  const removed: number[] = []
  ops.forEach((op, index) => {
    if (op.kind === "add") added.push(index + 1)
    else if (op.kind === "remove") removed.push(index + 1)
  })
  return { code: ops.map((op) => op.text).join("\n"), added, removed }
}
