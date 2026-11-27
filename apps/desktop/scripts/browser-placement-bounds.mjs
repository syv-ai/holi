export function boundsFrameAligned(expected, native, placementRects) {
  if (expected.length !== native.length || expected.length === 0) return false
  const sameRect = (left, right) =>
    ['x', 'y', 'width', 'height'].every((key) => left[key] === right[key])
  return expected.every(
    (rect, index) =>
      sameRect(rect, native[index]) && placementRects.some((message) => sameRect(rect, message)),
  )
}
