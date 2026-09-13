/**
 * The popup's glyphs, as plain SVG fragments.
 *
 * **Hand-copied, and guarded rather than imported.** The explorer draws the
 * same task glyphs from `lucide-react` (`features/explorer/icons.tsx`), so a
 * task in this list should look like the same task in the tree. But a
 * CodeMirror option is built with `document.createElement`, and no React lives
 * inside CodeMirror anywhere in this app; `lucide-react` exports components,
 * not geometry, and its per-icon `__iconNode` is reachable only by a deep
 * import into `dist/`, which would break on any repackaging without saying so.
 *
 * So the geometry is copied here and `__tests__/completion-rows.test.tsx`
 * renders the real component and fails if the two ever diverge. Copied from
 * lucide-react 1.27.0.
 */

/** lucide's own SVG attributes. The size is left to CSS. */
export const SVG_ATTRS: Record<string, string> = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '2',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
  'aria-hidden': 'true',
}

export const GLYPHS: Record<string, string> = {
  // FileText
  'holi-note':
    '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/>' +
    '<path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  // Square / SquareDot / SquareCheck — the explorer's `TaskIcon` vocabulary.
  'holi-task-todo': '<rect width="18" height="18" x="3" y="3" rx="2"/>',
  'holi-task-doing':
    '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="12" cy="12" r="1"/>',
  'holi-task-done': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/>',
  // ListTodo
  'holi-list-todo':
    '<path d="M13 5h8"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="m3 17 2 2 4-4"/>' +
    '<rect x="3" y="4" width="6" height="6" rx="1"/>',
  // Table
  'holi-table':
    '<path d="M12 3v18"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/>',
  // Settings2
  'holi-setting':
    '<path d="M14 17H5"/><path d="M19 7h-9"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
}
