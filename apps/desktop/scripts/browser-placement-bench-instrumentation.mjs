import { createHash } from 'node:crypto'
const sourceHash = '247380eae2f98fef0bbcda7b9018e7d0bfcbc3fbc11de33282810769db5bc426'
export function instrumentPlacement(source, countsOnly = false) {
  const hash = createHash('sha256').update(source).digest('hex')
  if (hash !== sourceHash)
    throw new Error('BrowserSurface source changed; review benchmark instrumentation')
  if (!countsOnly) return { code: source, hash, instrumented: false }
  const seams = [
    [
      '      frame = requestAnimationFrame(tick)\n      const el = host.current\n      if (el === null) return\n      const r = el.getBoundingClientRect()',
      '      window.__placementBenchStats ??= { callbacks: 0, hostRects: 0, coverageScans: 0, overlayRects: 0 }\n      window.__placementBenchStats.callbacks++\n      frame = requestAnimationFrame(tick)\n      const el = host.current\n      if (el === null) return\n      window.__placementBenchStats.hostRects++\n      const r = el.getBoundingClientRect()',
    ],
    [
      '    if (!el.matches(OVERLAY)) continue\n    const r = el.getBoundingClientRect()',
      '    if (!el.matches(OVERLAY)) continue\n    window.__placementBenchStats.overlayRects++\n    const r = el.getBoundingClientRect()',
    ],
    [
      'function overlaid(box: Box): boolean {\n  for (const el of document.body.children) {',
      'function overlaid(box: Box): boolean {\n  window.__placementBenchStats.coverageScans++\n  for (const el of document.body.children) {',
    ],
  ]
  for (const [needle, replacement] of seams) {
    if (source.split(needle).length !== 2)
      throw new Error('unsupported placement instrumentation seam')
    source = source.replace(needle, replacement)
  }
  return { code: source, hash, instrumented: true }
}
