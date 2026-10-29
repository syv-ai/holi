import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { EditorView } from '@codemirror/view'
import {
  BLOCK_OPTION_CLASS,
  COMPLETION_CLASS,
  EMPTY_OPTION_CLASS,
  OPTION_CLASS,
} from './completion'

/** The one mono stack. */
const MONO = 'ui-monospace, SF Mono, monospace'

/** Every rule in `completionChrome` is prefixed with this, and it is three
 *  classes on purpose. See `COMPLETION_CLASS`. */
const POPUP = `.cm-tooltip.cm-tooltip-autocomplete.${COMPLETION_CLASS}`

/**
 * The completion popup: mentions, slash commands, settings keys, and the
 * markdown-table menu, which is deliberately left alone.
 *
 * Exported so `test/completion.test.ts` can assert that every selector carries
 * `COMPLETION_CLASS` (without it CodeMirror's own rules outrank the block),
 * that nothing is a hex literal (vault theming and light mode), and that nothing
 * contests `:has(.cm-completionIcon-table)`.
 *
 * The radius tokens carry fallbacks because Tailwind's `@theme` tree-shakes
 * what it cannot see referenced, and Tailwind never scans this file.
 * @public exported for its test
 */
export const completionChrome = {
  [POPUP]: {
    // An animation, not a transition: the element is created already in place,
    // so a transition has no "from". It plays once: CodeMirror keeps this
    // element and rebuilds only the `<ul>` as you type, so an animation on the
    // list would replay on every keystroke.
    animation: 'cm-completion-in var(--motion-arrive, 300ms) var(--ease-settle, ease-out) both',
    transformOrigin: 'top left',
    background: 'var(--popover)',
    color: 'var(--popover-foreground)',
    // Borderless on the popover shadow, like every overlay; see `components/ui/popover.tsx`.
    border: 'none',
    // The menus' surface (`MENU_SURFACE`): `rounded-lg p-1`.
    borderRadius: 'var(--radius-lg, 8px)',
    boxShadow: 'var(--shadow-popover)',
    padding: '4px',
  },
  // The app's UI font: CodeMirror's own rule here is `fontFamily: monospace`.
  [`${POPUP} > ul`]: {
    fontFamily: 'inherit',
    fontSize: 'var(--text-nav, 13px)',
    maxHeight: '18em',
    minWidth: '220px',
    padding: '0',
  },
  // The slash menu is ReUI's width, and tall enough for a group and a half.
  [`${POPUP} > ul:has(> li.${BLOCK_OPTION_CLASS})`]: { width: '18rem', maxHeight: '22rem' },
  // A row is the menus' row (`MENU_ROW`): `rounded-md px-1.5 py-1 text-nav`.
  [`${POPUP} > ul > li`]: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 6px',
    borderRadius: 'var(--radius-md, 6px)',
    lineHeight: 'calc(18 / 13)',
    color: 'var(--popover-foreground)',
    transition: 'background var(--motion-respond, 150ms) var(--ease-settle, ease-out)',
  },
  [`${POPUP} > ul > li:hover:not([aria-selected])`]: {
    background: 'color-mix(in srgb, var(--accent) 55%, transparent)',
  },
  // The same pair `DropdownMenuItem` uses for `focus:`. A keyboard-selected row
  // here and a focused menu item there are the same gesture.
  [`${POPUP} > ul > li[aria-selected]`]: {
    background: 'var(--accent)',
    color: 'var(--accent-foreground)',
  },
  // CodeMirror's own default for a section header is `border-bottom: 1px solid
  // silver` at 0.7 opacity, which belongs to no theme at all.
  [`${POPUP} > ul > completion-section`]: {
    borderBottom: 'none',
    borderTop: 'none',
    marginTop: '4px',
    padding: '6px 6px 4px',
    fontSize: '12px',
    fontWeight: '500',
    color: 'var(--muted-foreground)',
    opacity: '1',
  },
  [`${POPUP} > ul > completion-section:first-child`]: {
    marginTop: '0',
  },
  [`${POPUP} .cm-completionLabel`]: {
    flex: '1',
    minWidth: '0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  [`${POPUP} .cm-completionDetail`]: {
    color: 'var(--muted-foreground)',
    fontStyle: 'normal',
    fontSize: '12px',
    flex: 'none',
  },
  [`${POPUP} > ul > li[aria-selected] .cm-completionDetail`]: { color: 'inherit' },
  // `--brand`, never `--primary`: `index.css`'s role note says the fill is not
  // a text colour.
  [`${POPUP} .cm-completionMatchedText`]: {
    color: 'var(--brand)',
    textDecoration: 'none',
    fontWeight: '600',
  },
  [`${POPUP} > ul > li[aria-selected] .cm-completionMatchedText`]: { color: 'inherit' },
  // CodeMirror's type glyph, hidden on our rows and only ours. The element has
  // to stay in the DOM: `codemirror-markdown-tables` hangs its whole menu off a
  // `:has()` over it.
  [`${POPUP} > ul > li.${OPTION_CLASS} .cm-completionIcon`]: { display: 'none' },
  [`${POPUP} .cm-holi-icon`]: {
    width: 'var(--icon-sm)',
    height: 'var(--icon-sm)',
    strokeWidth: 'var(--icon-stroke)',
    flex: 'none',
    color: 'var(--muted-foreground)',
  },
  // A task's status colour is information, so it survives selection: no blanket
  // `color: inherit` for a selected row's glyph. Same `--task-*` tokens as the
  // editor's task orbs and the file tree.
  [`${POPUP} .cm-holi-icon-holi-task-todo`]: { color: 'var(--task-todo)' },
  [`${POPUP} .cm-holi-icon-holi-task-doing`]: { color: 'var(--task-doing)' },
  [`${POPUP} .cm-holi-icon-holi-task-done`]: { color: 'var(--task-done)' },
  [`${POPUP} .cm-holi-emoji`]: {
    fontSize: '13px',
    lineHeight: '1',
    textAlign: 'center',
    display: 'inline-block',
  },
  // Text, not a pill: no text on a tinted fill of its own ground.
  [`${POPUP} .cm-holi-meta`]: {
    flex: 'none',
    fontSize: 'var(--text-xs, 12px)',
    color: 'var(--muted-foreground)',
  },
  [`${POPUP} > ul > li[aria-selected] .cm-holi-meta`]: { color: 'inherit' },
  // Hidden until the row is selected, which is why it is rendered on every row
  // rather than on one: CodeMirror does not re-render rows when the selection
  // moves. `opacity`, not `display`, so the row's width does not jump.
  [`${POPUP} .cm-holi-enter`]: {
    flex: 'none',
    fontSize: 'var(--text-xs, 12px)',
    color: 'var(--muted-foreground)',
    opacity: '0',
  },
  [`${POPUP} > ul > li[aria-selected] .cm-holi-enter`]: { opacity: '1', color: 'inherit' },
  /**
   * A slash menu block (after ReUI's slash menu): its glyph on a small raised
   * tile, the title over a one-line hint, and the markdown that makes the
   * same block at the end.
   */
  [`${POPUP} > ul > li.${BLOCK_OPTION_CLASS}`]: {
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
    columnGap: '8px',
    alignItems: 'center',
  },
  [`${POPUP} > ul > li.${BLOCK_OPTION_CLASS} .cm-holi-icon`]: {
    gridColumn: '1',
    gridRow: '1 / span 2',
    boxSizing: 'content-box',
    width: 'var(--icon-md, 16px)',
    height: 'var(--icon-md, 16px)',
    padding: '5px',
    color: 'var(--foreground)',
    background: 'var(--background)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-md, 6px)',
    boxShadow: '0 1px 2px color-mix(in oklab, var(--foreground) 6%, transparent)',
  },
  [`${POPUP} > ul > li.${BLOCK_OPTION_CLASS} .cm-completionLabel`]: {
    gridColumn: '2',
    gridRow: '1',
  },
  [`${POPUP} > ul > li.${BLOCK_OPTION_CLASS} .cm-completionDetail`]: {
    gridColumn: '2',
    gridRow: '2',
    marginLeft: '0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  [`${POPUP} > ul > li.${BLOCK_OPTION_CLASS} .cm-holi-meta`]: {
    gridColumn: '3',
    gridRow: '1 / span 2',
    fontSize: '12px',
    letterSpacing: '0.1em',
  },
  [`${POPUP} > ul > li.${BLOCK_OPTION_CLASS}[aria-selected] .cm-completionDetail, ${POPUP} > ul > li.${BLOCK_OPTION_CLASS}[aria-selected] .cm-holi-meta`]:
    { color: 'var(--muted-foreground)' },
  [`${POPUP} > ul > li.${BLOCK_OPTION_CLASS} .cm-holi-enter`]: { display: 'none' },
  [`${POPUP} > ul > li.${BLOCK_OPTION_CLASS} > .cm-completionIcon`]: { display: 'none' },
  // Nothing matched: the menu stays, saying so, as ReUI's `CommandEmpty`.
  [`${POPUP} > ul > li.${EMPTY_OPTION_CLASS}`]: {
    justifyContent: 'center',
    padding: '20px 8px',
    color: 'var(--muted-foreground)',
  },
  [`${POPUP} > ul > li.${EMPTY_OPTION_CLASS}[aria-selected]`]: {
    background: 'transparent',
    color: 'var(--muted-foreground)',
  },
  [`${POPUP} > ul > li.${EMPTY_OPTION_CLASS} .cm-completionLabel`]: { flex: 'none' },
  [`${POPUP} > ul > li.${EMPTY_OPTION_CLASS} .cm-holi-enter`]: { display: 'none' },
  [`${POPUP}.cm-tooltip-above`]: { transformOrigin: 'bottom left' },
  '@keyframes cm-completion-in': {
    from: { opacity: '0', transform: 'translateY(-4px) scale(0.97)' },
    to: { opacity: '1', transform: 'none' },
  },
}

/**
 * The editor's look, in both modes. Exported as a plain object so
 * `test/completion.test.ts` can hold all of it to the rule the completion
 * chrome follows: no hex or `rgba(` literal, since a literal is one mode's
 * colour (a `#e5e5e5` caret vanished on the light page) and no vault can
 * re-theme it.
 * @public exported for its test
 */
export const editorThemeSpec = {
  ...completionChrome,
  // The table widget reads its own `--tbl-style-font-family` (default
  // `system-ui`). Declared on the editor element, not `:root`.
  '&': {
    height: '100%',
    fontSize: '14px',
    '--tbl-style-font-family': MONO,
    // The column's side inset. It cannot live on `.cm-content` (see `.cm-line`),
    // so the line and the table widget each read it.
    '--editor-inset': '24px',
  },
  // Mono for every stack that borrows this base (plain/code editor, mail
  // composer, `DiffView`).
  '.cm-scroller': { fontFamily: MONO, lineHeight: '1.6' },
  /**
   * Left-aligned: the code editor, the mail composer and `DiffView` share it.
   */
  '.cm-content': { padding: '16px 0', maxWidth: '48rem', caretColor: 'var(--foreground)' },
  /**
   * The side margins live on the LINE, not on `.cm-content`.
   *
   * `drawSelection` draws the middle of a multi-line selection from a left edge
   * it reads off the first rendered line's padding. Padding on `.cm-content`
   * highlighted every later line into the page margin. For the same reason a
   * list indents by margin, not padding: every line's padding must match.
   *
   * A BLOCK WIDGET is not a line and gets none of this, so each one (`.cm-fm`,
   * the table widget, a mermaid diagram) applies `--editor-inset` itself.
   */
  '.cm-line': { padding: '0 var(--editor-inset)' },
  /**
   * `codemirror-markdown-tables` pulls its widget back by 10px so drag handles
   * hang off the left; the inset is added to that offset, on both sides so the
   * widget's middle is the column's. `.cm-content div…` because the plugin's
   * own rules are two classes deep.
   */
  '.cm-content div.tbl-table-widget': {
    marginLeft: 'calc(var(--editor-inset) - 10px)',
    marginRight: 'calc(var(--editor-inset) - 10px)',
  },
  /**
   * A table sits centred in the column; its cells keep their own alignment.
   * The wrapper is the plugin's fit-content box that its handles are placed
   * in, so they come along. Wider than the column, the auto margins are zero
   * and the widget scrolls from the left edge as before.
   */
  '.cm-content div.tbl-table-wrapper': { marginInline: 'auto' },

  // drawSelection() draws its own cursor and hides the native one, so caretColor
  // alone is invisible — the drawn cursor is a border-left element, style it.
  // The text's own colour, so it is the brightest thing on the page in either
  // mode: it is the editor's only focus indicator.
  '.cm-cursor, .cm-cursor-primary': {
    borderLeftColor: 'var(--foreground)',
    borderLeftWidth: '2px',
  },
  /**
   * The theme's `--selection`, themeable per vault. Written at this depth because
   * CodeMirror's own selection rule is five classes deep and a shallower one
   * loses however late it is mounted (the shape one-dark uses too).
   */
  '&.cm-editor .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    background: 'color-mix(in srgb, var(--selection) 60%, transparent)',
  },
  '&.cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    background: 'var(--selection)',
  },
  '@keyframes cm-tip-in': { from: { opacity: '0' }, to: { opacity: '1' } },

  // Validity status strip (plain/code editor). A bottom panel; strip CM's default
  // panel chrome so it reads as part of the editor, not a boxed toolbar.
  '.cm-panels, .cm-panels-bottom': { background: 'transparent', border: 'none' },
  '.cm-validity': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '0.4rem',
    padding: '3px 12px',
    borderTop: '1px solid var(--divider)',
    fontFamily: MONO,
    fontSize: 'var(--text-xs, 12px)',
    // Neutral while valid: quiet until wrong.
    color: 'var(--muted-foreground)',
  },
  '.cm-validity-dot': {
    width: '7px',
    height: '7px',
    borderRadius: '9999px',
    background: 'var(--muted-foreground)',
  },
  // `--syntax-invalid`, the frontmatter mark's red: `--destructive` is a fill.
  '.cm-validity-invalid': { color: 'var(--syntax-invalid)' },
  '.cm-validity-invalid .cm-validity-dot': { background: 'var(--syntax-invalid)' },
}

export const editorTheme = EditorView.baseTheme(editorThemeSpec)

/**
 * Token colours for the plain/code editor (`plainTextExtensions`). Legacy
 * StreamLanguage modes (toml/ini/shell) route through the same standard tags.
 * Tokens, not hexes, so light and dark mode share one definition.
 */
const codeHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.operatorKeyword], color: 'var(--syntax-keyword)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--syntax-property)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syntax-string)' },
  // `tags.color` descends from `literal`, so a CSS hex lands here too. A muted
  // token of its own read as the same colour as the `variableName` beside it.
  { tag: [t.number, t.bool, t.null, t.atom, t.literal], color: 'var(--syntax-number)' },
  { tag: [t.typeName, t.className, t.tagName], color: 'var(--syntax-type)' },
  { tag: [t.variableName, t.definition(t.variableName)], color: 'var(--syntax-variable)' },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName)],
    color: 'var(--syntax-function)',
  },
  {
    tag: [t.comment, t.lineComment, t.blockComment],
    color: 'var(--syntax-comment)',
    fontStyle: 'italic',
  },
  { tag: [t.escape, t.special(t.brace)], color: 'var(--syntax-number)' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: 'var(--syntax-punctuation)' },
  { tag: [t.meta, t.processingInstruction], color: 'var(--syntax-punctuation)' },
  { tag: t.invalid, color: 'var(--syntax-invalid)' },
])

/** The highlight extension to add to the plain/code stack. */
export const codeHighlighting = syntaxHighlighting(codeHighlightStyle)
