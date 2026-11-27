export const moveFixtureBytes = {
  source: '\uFEFF---\r\ntitle: Source\r\n---\r\n😀 [[from.md| self ]] [self](from.md#part)\r\n',
  moved: '\uFEFF---\r\ntitle: Source\r\n---\r\n😀 [[to.md| self ]] [self](to.md#part)\r\n',
  backA: 'first [[from.md|  label ]] then [[from.md#Heading]] [inline](from.md#part)\r\n',
  movedA: 'first [[to.md|  label ]] then [[from.md#Heading]] [inline](to.md#part)\r\n',
  backB: '😀 [[from.md|another label]] and [[from.md]]\n',
  movedB: '😀 [[to.md|another label]] and [[to.md]]\n',
  relativeSource: '![asset](asset.bin) [peer](../ref.md)\r\n',
  relativeMoved: '![asset](../old/asset.bin) [peer](../ref.md)\r\n',
  relativeBacklink: '[note](old/note.md#part)\n',
  relativeMovedBacklink: '[note](new/note.md#part)\n',
  asset: 'synthetic asset bytes remain unchanged',
} as const
