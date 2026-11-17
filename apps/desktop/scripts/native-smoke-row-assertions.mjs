import assert from 'node:assert/strict'

export function assertStableRowBoxes(rest, next, label) {
  for (const part of ['row', 'label', 'name', 'bell'])
    for (const dimension of ['x', 'y', 'width', 'height', 'right', 'bottom'])
      assert(
        Math.abs(rest.boxes[part][dimension] - next.boxes[part][dimension]) < 0.5,
        `${label}: ${part}.${dimension} shifted: ${JSON.stringify({ rest: rest.boxes, next: next.boxes })}`,
      )
}

export function assertExclusiveRowHover({ nameHovered, bellHovered, otherActions }, label) {
  assert(nameHovered, `${label}: pointer is over the row name`)
  assert(!bellHovered, `${label}: pointer is not over the bell`)
  assert(
    otherActions.every((action) => action.opacity === '0'),
    `${label}: unrelated bells remain hidden: ${JSON.stringify(otherActions)}`,
  )
}
