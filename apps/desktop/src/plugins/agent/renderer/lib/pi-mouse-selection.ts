/** Pi's TUI enables xterm mouse reporting, which captures ordinary left drags.
 * Keep the terminal selectable while leaving every other provider's modes alone. */
export function preservePiMouseSelection(term: {
  modes: { mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any' }
  onWriteParsed: (listener: () => void) => { dispose: () => void }
  write: (data: string) => void
}) {
  return term.onWriteParsed(() => {
    if (term.modes.mouseTrackingMode !== 'none') {
      // Reset all supported tracking modes together. The write is parsed once;
      // the following callback observes `none` and does not write recursively.
      term.write('\x1b[?9;1000;1002;1003l')
    }
  })
}
