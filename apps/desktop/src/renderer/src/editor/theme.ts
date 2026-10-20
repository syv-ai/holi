import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { EditorView } from '@codemirror/view'
import { EDITOR_FONT_STACKS, VAULT_SETTING_DEFAULTS } from '@holi/shared'
import {
  BLOCK_OPTION_CLASS,
  COMPLETION_CLASS,
  EMPTY_OPTION_CLASS,
  OPTION_CLASS,
} from './completion'

/** The one mono stack, named once so the places that must *stay* mono when the
 *  notes editor goes proportional cannot drift from the base they restore. */
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
 */
/** A task checkbox's font against its line's: its box and gap are in its own
 *  ems, and the list's hang has to scale them back. */
const TASK_CHECK_SCALE = 0.8

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
    // Borderless on the popover shadow, like every overlay; see `primitives/Popover.tsx`.
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
 */
export const editorThemeSpec = {
  ...completionChrome,
  // The table widget reads its own `--tbl-style-font-family` (default
  // `system-ui`). Declared on the editor element, not `:root`, so the notes
  // stack can override it the way it overrides `.cm-scroller`.
  '&': {
    height: '100%',
    fontSize: '14px',
    '--tbl-style-font-family': MONO,
    // The column's side inset. It cannot live on `.cm-content` (see `.cm-line`),
    // so the line, the frontmatter widget and the table widget each read it.
    '--editor-inset': '24px',
    // Makes `width: auto` interpolable, so a line's marks can slide (`.cm-slide-mark`).
    interpolateSize: 'allow-keywords',
    // List lengths: one nesting level, the gap between marker and text on top
    // of markdown's required space, and the air above each item.
    '--list-indent': '2em',
    '--list-gap': '0.5em',
    '--list-space': '0.7em',
    '--list-bullet': '0.6em',
    '--list-check': '1.15em',
    // Where a filled block (a quote, a code block) starts: just outside the
    // text's edge, so its own text sits a step in. One edge for every fill.
    '--block-inset': 'calc(var(--editor-inset) - 8px)',
  },
  // Mono for every stack that borrows this base (plain/code editor, mail
  // composer, `DiffView`). Only the notes editor overrides it (`notesFontTheme`).
  '.cm-scroller': { fontFamily: MONO, lineHeight: '1.6' },
  /**
   * Left-aligned in this base, which the code editor, the mail composer and
   * `DiffView` share. The notes stack centres its column in its pane
   * (`noteColumn` in `extensions.ts`).
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

  /**
   * Headings. A heading belongs to what follows it, so it has air above and
   * none below, and a list straight under it drops its own air above
   * (`--list-space`). Padding, not margin, for the reason a list's is; and the
   * same whether the `#` shows or not, so moving the caret onto it never jumps.
   * H1 at the notes' 16px is 24px, the `text-2xl` of Home's and Settings' titles.
   */
  '.cm-heading': { fontWeight: '600' },
  '.cm-heading-1': { fontSize: '1.5em', paddingTop: '0.6em' },
  '.cm-heading-2': { fontSize: '1.25em', paddingTop: '0.5em' },
  '.cm-heading-3': { fontSize: '1.1em', paddingTop: '0.4em' },
  '.cm-heading + .cm-list, .cm-heading + .cm-line:not(.cm-heading) + .cm-list': {
    paddingTop: '0',
  },
  /**
   * The editor text's one animation: a mark at the start of a line slides
   * rather than blinks. A heading's `#`, a quote's `>` and a fence's
   * backticks, the marks that move a whole line's text when they appear.
   * Each is a mark that is never replaced, opened by a class on its line.
   *
   * `width: 0` to `width: auto` (interpolable via `interpolate-size` on the
   * root) needs no measurement: the marks' width in the vault's face is
   * one no CSS unit knows, and measuring a marker was tried and deleted as too
   * much machinery.
   *
   * `vertical-align: bottom` because a clipping inline-block takes its baseline
   * from its bottom margin edge, which lifts the `#` by a descender.
   *
   * Decorations that move CodeMirror's geometry peg its measure loop, so the
   * rest of live preview is a plain swap. These are the exception because
   * each moves one line's text sideways by a few characters.
   */
  '.cm-slide-mark': {
    display: 'inline-block',
    overflow: 'hidden',
    // `.cm-line` is `pre-wrap`, which at `width: 0` wraps the `## ` one
    // character per line and leaves the closed box several lines tall.
    whiteSpace: 'pre',
    verticalAlign: 'bottom',
    width: '0',
    opacity: '0',
  },
  '.cm-heading-raw .cm-heading-mark, .cm-quote-raw .cm-quote-mark, .cm-code-raw .cm-code-mark': {
    width: 'auto',
    opacity: '1',
  },
  /**
   * The transition only applies under a class `mark-slide.ts` sets briefly
   * after the caret moves. Unconditionally, every heading animated shut as a
   * file opened: CodeMirror creates the mark span and settles its style in two
   * steps, so its first resolved width is `auto`. `@starting-style` does not
   * help because this is not an insertion.
   */
  '.cm-content.cm-marks-sliding .cm-slide-mark': {
    transition:
      'width var(--motion-respond, 150ms) var(--ease-settle, ease-out), opacity var(--motion-respond, 150ms) var(--ease-settle, ease-out)',
  },
  /**
   * Reduced motion. `askAgent.ts` reads the same preference so its send does
   * not wait for a fade that is not happening.
   */
  '@media (prefers-reduced-motion: reduce)': {
    '.cm-content.cm-marks-sliding .cm-slide-mark': { transition: 'none' },
    '.cm-ask-agent-open, .cm-ask-agent-leaving, .cm-comment-body': { animation: 'none' },
  },

  '.cm-strong': { fontWeight: '700' },
  '.cm-emphasis': { fontStyle: 'italic' },
  '.cm-strikethrough': { textDecoration: 'line-through' },
  // Colour alone marks it: no fill, no padding, so it sits in the sentence.
  '.cm-inline-code': { color: 'var(--code)' },
  /**
   * An unfocused table cell hides its `**`, `*` and `` ` ``.
   *
   * The cell view is the plugin's own `contenteditable`, painted from highlight
   * classes with no decorations, so this is CSS. A mark inherits the class of
   * the node it sits in, so a link's `[` is the only mark carrying
   * `cm-cell-link`.
   *
   * A link keeps its brackets: markdown parses the inner pair of `[[…]]` as a
   * shortcut link, so hiding one pair reads as a broken link. The plugin maps
   * clicks through its own model, so hidden characters do not shift them.
   */
  '.tbl-cell-view .cm-md-mark:not(.cm-cell-link)': { display: 'none' },
  // In a cell only. The classes exist wherever the highlight style does (a
  // fenced block carries `cm-cell-code` too), so the selector scopes them.
  '.tbl-cell-view .cm-cell-code': { color: 'var(--code)', fontFamily: MONO },
  '.tbl-cell-view .cm-cell-link': { color: 'var(--link)' },
  /**
   * A fenced block: the quote's geometry (`--block-inset` each side, only its
   * ends rounded), with the house `[0.04]` fill mixed from the text so it
   * shows in either mode. Margins, not padding (see `.cm-line`).
   */
  '.cm-code-line': {
    marginInline: 'var(--block-inset)',
    background: 'color-mix(in oklab, var(--foreground) 4%, transparent)',
  },
  '.cm-code-line.cm-code-first': {
    borderTopLeftRadius: 'var(--radius-md, 6px)',
    borderTopRightRadius: 'var(--radius-md, 6px)',
  },
  '.cm-code-line.cm-code-last': {
    borderBottomLeftRadius: 'var(--radius-md, 6px)',
    borderBottomRightRadius: 'var(--radius-md, 6px)',
  },
  // A quiet label while its backticks are shut, the raw text while they are open.
  '.cm-code-line:not(.cm-code-raw) .cm-code-info': {
    color: 'var(--muted-foreground)',
    fontSize: '0.85em',
  },
  /**
   * A rendered mermaid diagram. No box, and vertical padding close to the
   * source's, so a note does not lurch when it opens or closes. It scrolls
   * sideways rather than shrinking a flowchart to unreadable. The side margin
   * is the block-widget inset (see `.cm-line`).
   */
  '.cm-mermaid': { padding: '0.3em 0', margin: '0 var(--editor-inset)', overflowX: 'auto' },
  '.cm-mermaid svg': { maxWidth: '100%', height: 'auto' },
  // Shown until the render lands, and kept when it fails: code, not an error.
  '.cm-mermaid-source': {
    margin: '0',
    fontFamily: MONO,
    whiteSpace: 'pre-wrap',
    background: 'color-mix(in oklab, var(--foreground) 4%, transparent)',
    color: 'var(--muted-foreground)',
  },
  /**
   * Lists. `livePreview` stamps the depth; this turns it into a distance. The
   * author's literal indentation is concealed, so two-space and four-space
   * lists land alike, and unconditionally, so the line does not move when the
   * caret lands on it.
   */
  '.cm-list': {
    marginLeft:
      'calc(var(--quote-inset, 0px) + var(--list-indent, 2em) * var(--list-depth, 1) + var(--list-hang))',
    // The hang: the line starts where the text of its wrapped rows does, and
    // the first row pulls the marker back out into the indent.
    textIndent: 'calc(-1 * var(--list-hang))',
    // Padding, not margin: adjacent margins collapse, and CodeMirror measures
    // line heights itself. Above, not below, so the next paragraph does not sit
    // inside a trailing gap.
    paddingTop: 'var(--list-space, 0.7em)',
  },
  // A later line of an item's text, under the text.
  '.cm-list-cont': {
    marginLeft:
      'calc(var(--quote-inset, 0px) + var(--list-indent, 2em) * var(--list-depth, 1) + var(--list-hang))',
  },
  // `text-indent` is inherited, and every box in the line (the marker's, a
  // checkbox, a wiki-link chip) would take the hang into its own first row.
  '.cm-list *': { textIndent: '0' },
  // The marker's box plus the gap after it, one per kind of marker. Declared
  // on the line, which carries the ordered marker's `--list-mark`.
  '.cm-list-bullet-item': {
    '--list-hang': 'calc(var(--list-bullet, 0.6em) + var(--list-gap, 0.5em))',
  },
  // The checkbox sets its own smaller font, so its box and gap are in its ems.
  '.cm-list-task-item': {
    '--list-hang': `calc(${TASK_CHECK_SCALE} * (var(--list-check, 1.15em) + var(--list-gap, 0.5em)))`,
  },
  '.cm-list-number-item': { '--list-hang': 'calc(var(--list-mark) + var(--list-gap, 0.5em))' },
  '.cm-list-mark': { marginRight: 'var(--list-gap, 0.5em)' },
  // One box for the raw `-`/`*`/`+` and the dot that replaces it off the active
  // line, so the line does not move when the caret arrives. Ordered markers are
  // never swapped.
  '.cm-list-bullet': { display: 'inline-block', width: 'var(--list-bullet, 0.6em)' },
  '.cm-list-number': {
    display: 'inline-block',
    width: 'var(--list-mark)',
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
  },
  /**
   * Clickable objects react; prose never does. Paint only: never width,
   * height, font-size, padding or margin, which pegs CodeMirror's measure loop
   * (see docs/features/editor.md).
   */
  '.cm-wikilink, .cm-task-check': {
    transition:
      'background-color var(--motion-respond, 150ms) var(--ease-settle, ease-out), color var(--motion-respond, 150ms) var(--ease-settle, ease-out), border-color var(--motion-respond, 150ms) var(--ease-settle, ease-out)',
  },
  '.cm-wikilink:hover': { background: 'var(--accent)' },
  '.cm-task-check:hover': { borderColor: 'var(--foreground)' },

  '.cm-task-check': {
    display: 'inline-block',
    width: 'var(--list-check, 1.15em)',
    height: 'var(--list-check, 1.15em)',
    lineHeight: 'var(--list-check, 1.15em)',
    marginRight: 'var(--list-gap, 0.5em)',
    verticalAlign: '-0.12em',
    textAlign: 'center',
    fontSize: `${TASK_CHECK_SCALE}em`,
    border: '1px solid var(--muted-foreground)',
    borderRadius: '50%',
    cursor: 'pointer',
  },
  '.cm-task-check-done': {
    background: 'var(--task-done)',
    borderColor: 'var(--task-done)',
    color: 'var(--background)',
  },
  // The box scales with its list's text, so the tick fills it rather than
  // taking a fixed size, capped at the small icon. `middle` keeps the box on
  // the baseline the text tick gave it.
  '.cm-task-tick': {
    width: 'min(var(--icon-sm), 80%)',
    height: 'min(var(--icon-sm), 80%)',
    strokeWidth: 'var(--icon-stroke)',
    verticalAlign: 'middle',
  },
  /**
   * A blockquote: a flat surface, narrower than the column and centred in it,
   * holding whatever the quote holds. Each line paints its own slice, so only
   * the first and last round their corners.
   *
   * Translucent, because CodeMirror draws the selection behind the lines, and
   * an opaque fill would hide a selection inside the quote.
   *
   * Margins, not padding, for the same reason a list's are (see `.cm-line`).
   * A list line in a quote adds `--quote-inset` to its own margin, so the
   * hang lines up in there as it does outside.
   */
  '.cm-quote': {
    '--quote-inset': 'var(--block-inset)',
    // Toward the text, so it lifts off the page in either mode.
    '--quote-surface': 'color-mix(in srgb, var(--foreground) 16%, transparent)',
    marginRight: 'var(--quote-inset)',
    background: 'var(--quote-surface)',
  },
  '.cm-quote:not(.cm-list):not(.cm-list-cont)': { marginLeft: 'var(--quote-inset)' },
  /**
   * A list line's margin starts its box, and so its fill, further in than the
   * quote's edge. An outer shadow the width of that extra margin fills the gap:
   * it paints outside the line's box only, so nothing is tinted twice.
   */
  '.cm-quote.cm-list, .cm-quote.cm-list-cont': {
    boxShadow:
      'calc(-1 * (var(--list-indent, 2em) * var(--list-depth, 1) + var(--list-hang))) 0 0 0 var(--quote-surface)',
  },
  // Two classes, so they outrank a list line's own air above it.
  '.cm-quote.cm-quote-first': {
    paddingTop: '0.9em',
    borderTopLeftRadius: 'var(--radius-md, 6px)',
    borderTopRightRadius: 'var(--radius-md, 6px)',
  },
  '.cm-quote.cm-quote-last': {
    paddingBottom: '0.9em',
    borderBottomLeftRadius: 'var(--radius-md, 6px)',
    borderBottomRightRadius: 'var(--radius-md, 6px)',
  },
  '.cm-quote-mark': { color: 'var(--muted-foreground)' },
  /**
   * An HTML comment on its own lines (`comments.ts`): a small note floating over
   * the page, centred in the column, so it has a surface and the popover's
   * shadow. Its own `--comment` and `--comment-background` tokens, so a vault
   * can recolour it. Text-aligned to the left, however many lines it has. The
   * side margin is the block-widget inset (see `.cm-line`).
   */
  '.cm-comment': {
    display: 'flex',
    justifyContent: 'center',
    margin: '0 var(--editor-inset)',
    cursor: 'text',
  },
  /**
   * The banner is exactly as tall as its source: the note's line height, and
   * a vertical padding (`--comment-pad`) that the source's first and last
   * lines take too while it shows (`.cm-comment-source-*`). A comment whose
   * `<!--` and `-->` sit on lines of their own has that many more source
   * lines, and the banner pads by half a line for each.
   */
  '.cm-comment, .cm-comment-source': { '--comment-pad': '0.75em' },
  '.cm-comment-body': {
    maxWidth: '100%',
    padding:
      'calc(var(--comment-pad) + var(--comment-extra-lines, 0) * 0.8em) 1.6em calc(var(--comment-pad) + var(--comment-extra-lines, 0) * 0.8em) 1.9em',
    borderRadius: 'var(--radius-md, 6px)',
    background: 'var(--comment-background)',
    color: 'var(--comment)',
    boxShadow: 'var(--shadow-popover)',
    lineHeight: '1.6',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    // Opacity only: anything that moves geometry pegs CodeMirror's measure loop.
    animation: 'cm-comment-in var(--motion-arrive, 300ms) var(--ease-settle, ease-out) both',
  },
  '@keyframes cm-comment-in': { from: { opacity: '0' }, to: { opacity: '1' } },
  // Two classes, so they outrank `.cm-line`'s own padding whatever the order.
  '.cm-line.cm-comment-source-first': { paddingTop: 'var(--comment-pad)' },
  '.cm-line.cm-comment-source-last': { paddingBottom: 'var(--comment-pad)' },
  '.cm-comment-inline': { color: 'var(--comment)' },
  // A plain click on a markdown link places the caret; only ⌘/Ctrl-click
  // navigates (links.ts), so the pointer shows only while the modifier is held.
  // Wiki-link chips navigate on a plain click and keep theirs.
  // A hairline, part-transparent underline: the colour already says "link".
  '.cm-md-link': {
    color: 'var(--link)',
    textDecoration: 'underline',
    textDecorationThickness: '1px',
    textDecorationColor: 'color-mix(in srgb, var(--link) 45%, transparent)',
    textUnderlineOffset: '0.2em',
  },
  /**
   * A link's colour reaches everything inside it. GFM parses `www.…` and
   * `https://…` as `URL` nodes, and `tags.url` descends from `literal`, which
   * `codeHighlighting` (loaded here for fenced code) paints as a number. A
   * domain linkify finds is no node, so without this the two looked different.
   */
  '.cm-md-link.cm-md-link *': { color: 'inherit' },
  '&.cm-mod-held .cm-md-link': { cursor: 'pointer' },

  // A hairline across the line's middle, in the row its `---` takes. Mixed
  // toward the text: `--border` all but vanished on the dark page.
  '.cm-hr': {
    display: 'inline-block',
    width: '100%',
    height: '1px',
    verticalAlign: 'middle',
    background: 'color-mix(in srgb, var(--foreground) 30%, var(--background))',
  },

  /**
   * A chip is coloured text with no background of its own: text is never a
   * brighter shade of the ground it sits on. The hover tint is neutral for the
   * same reason.
   */
  '.cm-wikilink': {
    color: 'var(--link)',
    borderRadius: '4px',
    padding: '0 4px',
    cursor: 'pointer',
  },
  /**
   * A task chip reads as a task through its status orb, not its colour: it
   * takes `.cm-wikilink`'s link treatment, as in the file tree and the
   * `@`-mention list. `inline-flex` so the orb and title share a baseline row.
   */
  '.cm-wikilink-task': {
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: '4px',
  },
  '.cm-task-orb': {
    display: 'inline-block',
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    alignSelf: 'center',
  },
  '.cm-task-orb-todo': { background: 'var(--task-todo)' },
  '.cm-task-orb-doing': { background: 'var(--task-doing)' },
  '.cm-task-orb-done': { background: 'var(--task-done)' },
  // A done task strikes its title, matching the board card (muted-foreground).
  '.cm-wikilink-done': { textDecoration: 'line-through', color: 'var(--muted-foreground)' },
  // Last: a missing target outranks the kind tint, for a note and a task alike.
  // Colour only — see `.cm-wikilink`.
  '.cm-wikilink-missing': { color: 'var(--link-missing)' },

  /**
   * "Ask agent", over a selection. A tooltip, because CodeMirror already
   * positions tooltips against a range: a button that opens into a field.
   */
  '.cm-ask-agent-trigger': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    height: '28px',
    padding: '0 8px',
    fontFamily: 'var(--font-sans, ui-sans-serif, system-ui, sans-serif)',
    fontSize: 'var(--text-nav, 13px)',
    color: 'var(--foreground)',
    background: 'transparent',
    border: 'none',
    borderRadius: 'var(--radius-md, 6px)',
    outline: 'none',
    cursor: 'default',
    transition: 'background var(--motion-respond, 150ms) var(--ease-settle, ease-out)',
  },
  '.cm-ask-agent-trigger:hover': { background: 'var(--accent)' },
  '.cm-ask-agent-trigger:focus-visible': { boxShadow: '0 0 0 1px var(--ring)' },
  /**
   * The format bar (`formatBar.ts`, after ReUI's bubble bar): toggles in the
   * icon size the toolbar uses, pressed as the menus' accent fill, a labelled
   * block type trigger, and hairlines between the groups.
   */
  '.cm-format-bar': {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '4px',
    fontFamily: 'var(--font-sans, ui-sans-serif, system-ui, sans-serif)',
  },
  '.cm-format-group': { display: 'flex', alignItems: 'center', gap: '2px' },
  '.cm-format-btn': {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '2px',
    minWidth: '28px',
    height: '28px',
    padding: '0',
    color: 'var(--color-icon, var(--muted-foreground))',
    background: 'transparent',
    border: 'none',
    borderRadius: 'var(--radius-md, 6px)',
    outline: 'none',
    cursor: 'default',
    transition:
      'background var(--motion-respond, 150ms) var(--ease-settle, ease-out), color var(--motion-respond, 150ms) var(--ease-settle, ease-out)',
  },
  '.cm-format-btn:hover, .cm-format-btn[aria-expanded="true"]': {
    color: 'var(--color-icon-active, var(--foreground))',
    background: 'var(--accent)',
  },
  '.cm-format-btn[aria-pressed="true"]': {
    color: 'var(--accent-foreground)',
    background: 'var(--accent)',
  },
  '.cm-format-btn:focus-visible, .cm-format-row:focus-visible, .cm-format-swatch:focus-visible': {
    boxShadow: '0 0 0 1px var(--ring)',
  },
  '.cm-format-btn[aria-disabled="true"]': { opacity: '0.5', background: 'transparent' },
  '.cm-format-icon': {
    width: 'var(--icon-md, 16px)',
    height: 'var(--icon-md, 16px)',
    strokeWidth: 'var(--icon-stroke, 2)',
    flex: 'none',
  },
  '.cm-format-chevron': {
    width: 'var(--icon-sm, 14px)',
    height: 'var(--icon-sm, 14px)',
    opacity: '0.6',
  },
  /** Fixed width, so the bar never shifts as the block's type changes. */
  '.cm-format-select': {
    width: '7rem',
    justifyContent: 'space-between',
    padding: '0 6px 0 8px',
    color: 'var(--foreground)',
    fontSize: 'var(--text-nav, 13px)',
  },
  '.cm-format-select-label': { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  '.cm-format-align': { padding: '0 4px' },
  '.cm-format-rule': {
    flex: 'none',
    width: '1px',
    height: '16px',
    background: 'var(--border)',
  },
  /** A control's name and key, over it, as the app's tooltips read. */
  '.cm-format-btn[data-tip]:is(:hover, :focus-visible)::after': {
    content: 'attr(data-tip)',
    position: 'absolute',
    bottom: 'calc(100% + 8px)',
    left: '50%',
    transform: 'translateX(-50%)',
    padding: '4px 8px',
    whiteSpace: 'pre',
    fontSize: '12px',
    lineHeight: '1.4',
    color: 'var(--popover-foreground)',
    background: 'var(--popover)',
    borderRadius: 'var(--radius-md, 6px)',
    boxShadow: 'var(--shadow-popover)',
    pointerEvents: 'none',
    zIndex: '2',
    animation: 'cm-tip-in var(--motion-respond, 150ms) var(--ease-settle, ease-out) 400ms both',
  },
  '@keyframes cm-tip-in': { from: { opacity: '0' }, to: { opacity: '1' } },
  /** A menu or popover hanging under its trigger, on the menus' surface. */
  '.cm-format-panel': {
    position: 'absolute',
    top: 'calc(100% + 4px)',
    zIndex: '3',
    padding: '4px',
    color: 'var(--popover-foreground)',
    background: 'var(--popover)',
    borderRadius: 'var(--radius-lg, 8px)',
    boxShadow: 'var(--shadow-popover)',
    transformOrigin: 'top left',
    animation: 'cm-completion-in var(--motion-arrive, 300ms) var(--ease-settle, ease-out) both',
  },
  '.cm-format-menu': { display: 'flex', flexDirection: 'column', minWidth: '13rem' },
  '.cm-format-menu-label': {
    padding: '4px 6px',
    fontSize: '12px',
    fontWeight: '500',
    color: 'var(--muted-foreground)',
  },
  '.cm-format-row': {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    width: '100%',
    padding: '4px 6px',
    fontSize: 'var(--text-nav, 13px)',
    lineHeight: 'calc(18 / 13)',
    textAlign: 'left',
    color: 'var(--popover-foreground)',
    background: 'transparent',
    border: 'none',
    borderRadius: 'var(--radius-md, 6px)',
    outline: 'none',
    cursor: 'default',
    transition: 'background var(--motion-respond, 150ms) var(--ease-settle, ease-out)',
  },
  '.cm-format-row:hover, .cm-format-row:focus': {
    background: 'var(--accent)',
    color: 'var(--accent-foreground)',
  },
  '.cm-format-row .cm-format-icon': {
    width: 'var(--icon-md, 16px)',
    height: 'var(--icon-md, 16px)',
    color: 'var(--color-icon, var(--muted-foreground))',
  },
  '.cm-format-row-label': { flex: '1' },
  '.cm-format-kbd': {
    marginLeft: 'auto',
    fontSize: '12px',
    letterSpacing: '0.1em',
    color: 'var(--muted-foreground)',
  },
  '.cm-format-row .cm-format-check': {
    width: 'var(--icon-sm, 14px)',
    height: 'var(--icon-sm, 14px)',
    color: 'var(--foreground)',
  },
  '.cm-format-swatches': { display: 'flex', alignItems: 'center', gap: '4px' },
  '.cm-format-swatch': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '28px',
    height: '28px',
    padding: '0',
    background: 'transparent',
    border: 'none',
    borderRadius: 'var(--radius-md, 6px)',
    outline: 'none',
    transition: 'background var(--motion-respond, 150ms) var(--ease-settle, ease-out)',
  },
  '.cm-format-swatch:hover': { background: 'var(--accent)' },
  '.cm-format-dot': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    height: '20px',
    borderRadius: '9999px',
    color: 'var(--foreground)',
  },
  '.cm-format-dot .cm-format-icon': {
    width: 'var(--icon-sm, 14px)',
    height: 'var(--icon-sm, 14px)',
  },
  '.cm-format-linkpanel': { width: '20rem' },
  /** The house text field: a calm grey fill and no edge; invalid tints it. */
  '.cm-format-input': {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    height: '32px',
    padding: '0 2px 0 8px',
    background: 'var(--muted)',
    borderRadius: 'var(--radius-md, 6px)',
    color: 'var(--color-icon, var(--muted-foreground))',
  },
  '.cm-format-input .cm-format-btn': { minWidth: '24px', height: '24px' },
  '.cm-format-input .cm-format-icon': {
    width: 'var(--icon-sm, 14px)',
    height: 'var(--icon-sm, 14px)',
  },
  '.cm-format-input-invalid': {
    background: 'color-mix(in oklab, var(--destructive) 15%, transparent)',
  },
  '.cm-format-input-field': {
    flex: '1',
    minWidth: '0',
    height: '100%',
    padding: '0',
    fontSize: 'var(--text-nav, 13px)',
    color: 'var(--foreground)',
    background: 'transparent',
    border: 'none',
    outline: 'none',
  },
  '.cm-format-input-field::placeholder': { color: 'var(--muted-foreground)' },
  '.cm-format-error': { padding: '6px 2px 0', fontSize: '12px', color: 'var(--destructive)' },
  '.cm-format-error:empty': { display: 'none' },

  /** The caret's link (after ReUI's link bubble): its address, Edit, Remove. */
  '.cm-tooltip.cm-link-bubble': {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    padding: '4px',
    color: 'var(--popover-foreground)',
    background: 'var(--popover)',
    border: 'none',
    borderRadius: 'var(--radius-lg, 8px)',
    boxShadow: 'var(--shadow-popover)',
    fontFamily: 'var(--font-sans, ui-sans-serif, system-ui, sans-serif)',
  },
  '.cm-link-bubble-href': {
    gap: '6px',
    maxWidth: '16rem',
    padding: '0 8px',
    fontSize: 'var(--text-nav, 13px)',
    color: 'var(--muted-foreground)',
  },
  '.cm-link-bubble-href span': {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },

  /** The caret's empty line says what it can do (`placeholder.ts`). */
  '.cm-line-hint': {
    color: 'var(--muted-foreground)',
    opacity: '0.7',
    pointerEvents: 'none',
    userSelect: 'none',
  },
  /** Space on an empty line (`askSpace.ts`): the Ask field on its own, under the line. */
  '.cm-tooltip.cm-space-ask': { transformOrigin: 'top left', overflow: 'hidden' },
  // A line's height, near enough, so it sits on the line it replaces.
  '.cm-space-ask .cm-ask-agent-field': { paddingBlock: '0.3rem' },

  /** The block whose menu is open, tinted like a selection, and the one being
   *  dragged, faded (`blockActions.ts`). Paint only. */
  '.cm-line.cm-block-menu': {
    background: 'color-mix(in oklab, var(--foreground) 7%, transparent)',
  },
  '.cm-line.cm-block-dragging': { opacity: '0.5' },
  '.cm-block-droplayer': { pointerEvents: 'none' },
  '.cm-block-dropline': {
    position: 'absolute',
    height: '2px',
    borderRadius: '9999px',
    background: 'var(--foreground)',
  },

  /** The Contents block (`contents.ts`), after ReUI's: a quiet label and the
   *  headings as links, indented by depth. */
  '.cm-contents': {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '4px var(--editor-inset, 0)',
    fontFamily: 'var(--font-sans, ui-sans-serif, system-ui, sans-serif)',
  },
  '.cm-contents-title': {
    margin: '0',
    fontSize: '12px',
    fontWeight: '500',
    color: 'var(--muted-foreground)',
  },
  '.cm-contents-empty': { margin: '0', fontSize: '14px', color: 'var(--muted-foreground)' },
  '.cm-contents-list': { display: 'flex', flexDirection: 'column', alignItems: 'flex-start' },
  '.cm-contents-link': {
    maxWidth: '100%',
    padding: '2px 0',
    paddingInlineStart: 'calc(var(--contents-depth, 0) * 1rem)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '14px',
    textAlign: 'left',
    color: 'var(--muted-foreground)',
    background: 'transparent',
    border: 'none',
    borderRadius: 'var(--radius-sm, 4px)',
    outline: 'none',
    cursor: 'pointer',
    transition: 'color var(--motion-respond, 150ms) var(--ease-settle, ease-out)',
  },
  '.cm-contents-link:hover': {
    color: 'var(--foreground)',
    textDecoration: 'underline',
    textUnderlineOffset: '4px',
  },
  '.cm-contents-link:focus-visible': { boxShadow: '0 0 0 1px var(--ring)' },

  /** Highlights, in Tailwind's 200 on light and 400 at 30% on dark (ReUI's
   *  pairs), and underline. */
  '.cm-highlight': { borderRadius: '2px', boxDecorationBreak: 'clone', padding: '0 0.1em' },
  '&light .cm-highlight-yellow': { background: 'oklch(94.5% 0.129 101.54)' },
  '&light .cm-highlight-green': { background: 'oklch(90.5% 0.093 164.15)' },
  '&light .cm-highlight-blue': { background: 'oklch(90.1% 0.058 230.902)' },
  '&light .cm-highlight-pink': { background: 'oklch(89.9% 0.061 343.231)' },
  '&light .cm-highlight-violet': { background: 'oklch(89.4% 0.057 293.283)' },
  '&dark .cm-highlight-yellow': { background: 'oklch(85.2% 0.199 91.936 / 0.3)' },
  '&dark .cm-highlight-green': { background: 'oklch(76.5% 0.177 163.223 / 0.3)' },
  '&dark .cm-highlight-blue': { background: 'oklch(74.6% 0.16 232.661 / 0.3)' },
  '&dark .cm-highlight-pink': { background: 'oklch(71.8% 0.202 349.761 / 0.3)' },
  '&dark .cm-highlight-violet': { background: 'oklch(70.2% 0.183 293.541 / 0.3)' },
  '.cm-underline': { textDecoration: 'underline', textUnderlineOffset: '3px' },
  '.cm-task-done-text': { color: 'var(--muted-foreground)', textDecoration: 'line-through' },

  /** Aligned blocks (`marks.ts`): the lines take the alignment, and the
   *  wrapper's tags and blank lines stay small and quiet at a fixed size. */
  '.cm-align-center': { textAlign: 'center' },
  '.cm-align-right': { textAlign: 'right' },
  '.cm-align-justify': { textAlign: 'justify' },
  '.cm-align-tag': {
    fontFamily: MONO,
    fontSize: '0.75em',
    lineHeight: '1.4',
    color: 'var(--muted-foreground)',
    opacity: '0.6',
  },
  '.cm-align-gap': { fontSize: '0.5em', lineHeight: '1' },
  // The tag is markup, not content: no HTML highlighting on it.
  '.cm-align-tag span': { color: 'inherit' },
  /**
   * The target row: which session this ask goes to. Styled like the pane's tab
   * strip, neutral fill for the chosen one and no state colour. It scrolls
   * sideways rather than wrapping so the field does not move down.
   */
  '.cm-ask-agent-targets': {
    display: 'flex',
    alignItems: 'center',
    gap: '0.15rem',
    padding: '0.35rem 0.45rem 0',
    overflowX: 'auto',
    scrollbarWidth: 'none',
  },
  '.cm-ask-agent-target': {
    flexShrink: '0',
    maxWidth: '9rem',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    padding: '0.1rem 0.45rem',
    borderRadius: '9999px',
    fontSize: 'var(--text-xs, 12px)',
    lineHeight: '1.5',
    color: 'var(--muted-foreground)',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
  },
  '.cm-ask-agent-target:hover': { color: 'var(--foreground)' },
  '.cm-ask-agent-target[aria-checked="true"]': {
    color: 'var(--foreground)',
    background: 'var(--secondary)',
  },
  /** Why a send did not go. Empty, and so invisible, until one does not. */
  '.cm-ask-agent-notice': {
    padding: '0 0.6rem 0.45rem',
    fontSize: 'var(--text-xs, 12px)',
    lineHeight: '1.5',
    color: 'var(--destructive)',
  },
  '.cm-ask-agent-notice:empty': { display: 'none' },
  /**
   * The popover shell. CodeMirror puts `cm-tooltip` on the element `create`
   * returns rather than wrapping it, so this is one element wearing both
   * classes: an ancestor selector (`:has`) matches nothing, and the pair
   * outranks CodeMirror's own light `.cm-tooltip` background.
   *
   * Animate `transform` and `opacity` only: CodeMirror positions the tooltip
   * itself, and anything layout-changing drags its measure loop into every
   * frame. The fade and `askAgent.ts`'s timer both read `--motion-leave`.
   */
  '.cm-tooltip.cm-ask-agent': {
    padding: '0',
    // It sits above the passage, so it grows out of its own bottom edge.
    transformOrigin: 'bottom center',
    // Visible while it is the bar: its menus and tooltips hang outside it.
    overflow: 'visible',
    color: 'var(--popover-foreground)',
    background: 'var(--popover)',
    // The one floating surface: the shadow carries the hairline.
    border: 'none',
    borderRadius: 'var(--radius-lg, 8px)',
    boxShadow: 'var(--shadow-popover)',
  },
  '.cm-tooltip.cm-ask-agent.cm-ask-agent-open': { overflow: 'hidden' },
  /**
   * The field reads as the note does; its face is set only in `notesFontTheme`.
   * No `font-family` here: a `theme` and a `baseTheme` produce selectors of
   * equal specificity, so setting it in both would depend on stylesheet order.
   *
   * No height of its own: `askAgent.ts` grows it with its content up to
   * `maxHeight` and re-places the bubble.
   */
  '.cm-ask-agent-field': {
    display: 'block',
    fontSize: 'inherit',
    fontWeight: 'inherit',
    fontStyle: 'inherit',
    lineHeight: '1.6',
    width: '26rem',
    maxWidth: '60vw',
    maxHeight: '40vh',
    // `askAgent.ts` turns this to `auto` only once content passes `maxHeight`:
    // the scrollbars are not overlay ones, and a rounded `scrollHeight` would
    // show a permanent track.
    overflowY: 'hidden',
    padding: '0.5rem 0.6rem',
    color: 'var(--popover-foreground)',
    background: 'transparent',
    border: 'none',
    borderRadius: '0',
    resize: 'none',
    outline: 'none',
  },
  '.cm-ask-agent-field::placeholder': { color: 'var(--muted-foreground)' },
  /**
   * The bubble animates, not the transparent field inside it. `-open` is added
   * by the press, not at mount: the element is rebuilt on every selection change
   * and a mount-time animation would replay throughout a drag.
   */
  '.cm-ask-agent-open': {
    animation: 'cm-ask-in var(--motion-arrive, 300ms) var(--ease-settle, ease-out) both',
  },
  '.cm-ask-agent-leaving': {
    // `askAgent.ts` waits for exactly this token, so the two cannot drift.
    animation: 'cm-ask-out var(--motion-leave, 190ms) var(--ease-settle, ease-out) both',
    pointerEvents: 'none',
  },
  '@keyframes cm-ask-in': {
    from: { opacity: '0', transform: 'translateY(10px) scale(0.88)' },
    to: { opacity: '1', transform: 'none' },
  },
  '@keyframes cm-ask-out': {
    from: { opacity: '1', transform: 'none' },
    to: { opacity: '0', transform: 'translateY(8px) scale(0.90)' },
  },
  '.cm-ySelectionInfo': {
    fontSize: 'var(--text-xs, 12px)',
    padding: '0 3px',
    borderRadius: 'var(--radius-sm, 4px)',
  },

  // Wiki-link hover preview. The card owns its chrome, so strip the base
  // tooltip wrapper. The one floating surface: `--popover` under the popover
  // shadow, which carries the hairline, and the menus' radius.
  '.cm-tooltip.cm-tooltip-hover': { background: 'transparent', border: 'none' },
  '.cm-wiki-preview': {
    background: 'var(--popover)',
    color: 'var(--popover-foreground)',
    border: 'none',
    borderRadius: 'var(--radius-lg, 8px)',
    padding: '8px 10px',
    maxWidth: '320px',
    fontFamily: 'var(--font-sans, ui-sans-serif, system-ui, sans-serif)',
    fontSize: 'var(--text-xs, 12px)',
    lineHeight: '1.5',
    boxShadow: 'var(--shadow-popover)',
  },
  '.cm-wiki-preview-title': {
    fontWeight: '600',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    marginBottom: '4px',
  },
  '.cm-wiki-preview-meta': { color: 'var(--muted-foreground)' },
  '.cm-wiki-preview-line': {
    color: 'var(--muted-foreground)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },

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
 * Token colours for the plain/code editor (`plainTextExtensions`). The markdown
 * editor paints itself with live-preview decorations instead. Legacy
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

/**
 * Markdown's own tags, mapped onto live preview's classes. This exists for
 * TABLE CELLS: `codemirror-markdown-tables` renders an unfocused cell itself,
 * classing spans from `highlightingFor(rootState, tags)`, so a HighlightStyle
 * is the only thing that styles one. `strikethrough` fires in the body only: a
 * cell's (unconfigurable) parser has no GFM.
 */
const markdownHighlightStyle = HighlightStyle.define([
  // Same text live preview marks, so bold-in-a-cell stays one definition.
  { tag: t.strong, class: 'cm-strong' },
  { tag: t.emphasis, class: 'cm-emphasis' },
  { tag: t.strikethrough, class: 'cm-strikethrough' },
  // Cell-only classes. `monospace` also tags fenced `CodeText`, and `link`
  // covers a link's brackets, so borrowing body classes would misfire.
  { tag: t.monospace, class: 'cm-cell-code' },
  { tag: t.link, class: 'cm-cell-link' },
  // `EmphasisMark`, `CodeMark` and `LinkMark` share this tag; they are told
  // apart by the class they inherit from their parent node.
  { tag: t.processingInstruction, class: 'cm-md-mark' },
])

/** Notes stack only. "Edit Source" opens a `.md` in the plain editor, where the
 *  point is to see it raw. */
export const markdownHighlighting = syntaxHighlighting(markdownHighlightStyle)

/** The prose face before `useEditorFont` has stamped `--editor-font`: the
 *  setting's own default, so the two cannot drift. */
const PROSE = EDITOR_FONT_STACKS[VAULT_SETTING_DEFAULTS.editorFont]

/**
 * The notes editor's prose font.
 *
 * `EditorView.theme`, not `baseTheme`, so it outranks `editorTheme` for the one
 * stack that includes it. The plain/code editor, mail composer and `DiffView`
 * stay mono: column alignment matters in `.json`/`.ts`/`.env`.
 *
 * A CSS custom property rather than a compartment: the setting changes only on
 * a vault switch, and a var restyles every open editor with no plumbing.
 *
 * Stays mono: fenced and inline code, and the frontmatter widget's nested YAML
 * editor, whose `.cm-scroller` is a DOM descendant of this one's. Tables follow
 * the prose face via `--tbl-style-font-family`, which the plugin reads instead
 * of the inherited font.
 */
export const notesFontTheme = EditorView.theme({
  /**
   * Reading size and measure. A note is long-form prose, so it is set at 16px
   * (the plain editor, the composer and `DiffView` keep the base's 14px), in a
   * column of about 70 characters plus the side insets: at 14px in 48rem a
   * line ran to some 110. Small text sets it back a step (`EditorPane`).
   */
  '&': { fontSize: '16px', '--tbl-style-font-family': `var(--editor-font, ${PROSE})` },
  '& > .cm-scroller > .cm-content': { maxWidth: 'calc(70ch + 2 * var(--editor-inset))' },
  '.cm-scroller': { fontFamily: `var(--editor-font, ${PROSE})` },
  // The running text's colour (`--prose` in index.css); marks, links and chips
  // keep their own.
  '.cm-content': { color: 'var(--prose)' },
  '.cm-code-line': { fontFamily: MONO },
  '.cm-inline-code': { fontFamily: MONO },
  /**
   * Inline code as tall as the prose around it. Mono at the prose's size reads
   * larger, and by how much depends on the vault's face, so no fixed `em`
   * fits. `from-font` computes to the line's own face's x-height ratio, and
   * the code inherits that number, scaling its mono to the prose's x-height.
   * The prose itself is left as it is: its own ratio is the one it has.
   */
  '.cm-line, .tbl-cell-view': { fontSizeAdjust: 'from-font' },
  '.cm-fm .cm-scroller': { fontFamily: MONO },
  // Reaches the ask popover because CodeMirror mounts tooltips inside `.cm-editor`.
  '.cm-ask-agent-field': { fontFamily: `var(--editor-font, ${PROSE})` },
})
