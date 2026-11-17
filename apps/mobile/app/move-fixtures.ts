export const moveFixtureBytes = {
  source: '\uFEFF---\r\ntitle: Source\r\n---\r\n😀 [[from.md| self ]]\r\n',
  moved: '\uFEFF---\r\ntitle: Source\r\n---\r\n😀 [[to.md| self ]]\r\n',
  backA: 'first [[from.md|  label ]] then [[from.md#Heading]]\r\n',
  movedA: 'first [[to.md|  label ]] then [[from.md#Heading]]\r\n',
  backB: '😀 [[from.md|another label]] and [[from.md]]\n',
  movedB: '😀 [[to.md|another label]] and [[to.md]]\n',
} as const
