import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { EditorView } from '@codemirror/view'
import { EDITOR_FONT_STACKS, VAULT_SETTING_DEFAULTS } from '@holi/shared'
import { COMPLETION_CLASS, OPTION_CLASS } from './completion'

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
    borderRadius: 'var(--radius-md, 6px)',
    boxShadow: 'var(--shadow-popover)',
    padding: '4px',
  },
  // The app's UI font: CodeMirror's own rule here is `fontFamily: monospace`.
  [`${POPUP} > ul`]: {
    fontFamily: 'inherit',
    fontSize: '13px',
    maxHeight: '18em',
    minWidth: '220px',
    padding: '0',
  },
  [`${POPUP} > ul > li`]: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '5px 8px',
    borderRadius: 'var(--radius-sm, 4px)',
    lineHeight: '1.4',
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
    borderTop: '1px solid var(--divider)',
    marginTop: '3px',
    padding: '7px 8px 4px',
    fontSize: '10.5px',
    fontWeight: '600',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--muted-foreground)',
    opacity: '1',
  },
  [`${POPUP} > ul > completion-section:first-child`]: {
    borderTop: 'none',
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
    fontSize: '11px',
    color: 'var(--muted-foreground)',
  },
  [`${POPUP} > ul > li[aria-selected] .cm-holi-meta`]: { color: 'inherit' },
  // Hidden until the row is selected, which is why it is rendered on every row
  // rather than on one: CodeMirror does not re-render rows when the selection
  // moves. `opacity`, not `display`, so the row's width does not jump.
  [`${POPUP} .cm-holi-enter`]: {
    flex: 'none',
    fontSize: '11px',
    color: 'var(--muted-foreground)',
    opacity: '0',
  },
  [`${POPUP} > ul > li[aria-selected] .cm-holi-enter`]: { opacity: '1', color: 'inherit' },
  [`${POPUP}.cm-tooltip-above`]: { transformOrigin: 'bottom left' },
  '@keyframes cm-completion-in': {
    from: { opacity: '0', transform: 'translateY(-4px) scale(0.97)' },
    to: { opacity: '1', transform: 'none' },
  },
}

export const editorTheme = EditorView.baseTheme({
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
    // Makes `width: auto` interpolable, so a heading's `#` can slide.
    interpolateSize: 'allow-keywords',
    // List lengths: one nesting level, the gap between marker and text on top
    // of markdown's required space, and the air above each item.
    '--list-indent': '2em',
    '--list-gap': '0.5em',
    '--list-space': '0.7em',
    '--list-bullet': '0.6em',
    '--list-check': '1.15em',
  },
  // Mono for every stack that borrows this base (plain/code editor, mail
  // composer, `DiffView`). Only the notes editor overrides it (`notesFontTheme`).
  '.cm-scroller': { fontFamily: MONO, lineHeight: '1.6' },
  /**
   * Left-aligned in this base, which the code editor, the mail composer and
   * `DiffView` share. The notes stack centres its column in its pane
   * (`noteColumn` in `extensions.ts`).
   */
  '.cm-content': { padding: '16px 0', maxWidth: '48rem', caretColor: '#e5e5e5' },
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
  '.cm-cursor, .cm-cursor-primary': { borderLeftColor: '#e5e5e5', borderLeftWidth: '2px' },
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

  // Headings: size only, no extra margins, so render/un-render doesn't jump.
  '.cm-heading': { fontWeight: '600' },
  '.cm-heading-1': { fontSize: '1.5em' },
  '.cm-heading-2': { fontSize: '1.25em' },
  '.cm-heading-3': { fontSize: '1.1em' },
  /**
   * The one animation in the editor text. A heading's `#` slides rather
   * than blinks, because the heading's text moves furthest when marks appear.
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
   * rest of live preview is a plain swap.
   */
  '.cm-heading-mark': {
    display: 'inline-block',
    overflow: 'hidden',
    // `.cm-line` is `pre-wrap`, which at `width: 0` wraps the `## ` one
    // character per line and leaves the closed box several lines tall.
    whiteSpace: 'pre',
    verticalAlign: 'bottom',
    width: '0',
    opacity: '0',
  },
  '.cm-heading-raw .cm-heading-mark': { width: 'auto', opacity: '1' },
  /**
   * The transition only applies under a class `heading-slide.ts` sets briefly
   * after the caret moves. Unconditionally, every heading animated shut as a
   * file opened: CodeMirror creates the mark span and settles its style in two
   * steps, so its first resolved width is `auto`. `@starting-style` does not
   * help because this is not an insertion.
   */
  '&.cm-heading-sliding .cm-heading-mark': {
    transition:
      'width var(--motion-respond, 150ms) var(--ease-settle, ease-out), opacity var(--motion-respond, 150ms) var(--ease-settle, ease-out)',
  },
  /**
   * Reduced motion. `askAgent.ts` reads the same preference so its send does
   * not wait for a fade that is not happening.
   */
  '@media (prefers-reduced-motion: reduce)': {
    '&.cm-heading-sliding .cm-heading-mark': { transition: 'none' },
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
  '.cm-code-line': { background: 'rgba(255,255,255,0.04)' },
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
    background: 'rgba(255,255,255,0.04)',
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
    '--quote-inset': '2em',
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
    paddingTop: '0.6em',
    borderTopLeftRadius: 'var(--radius-md, 6px)',
    borderTopRightRadius: 'var(--radius-md, 6px)',
  },
  '.cm-quote.cm-quote-last': {
    paddingBottom: '0.6em',
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
  '&.cm-mod-held .cm-md-link': { cursor: 'pointer' },

  // A hairline across the line's middle, in the row its `---` takes.
  '.cm-hr': {
    display: 'inline-block',
    width: '100%',
    height: '1px',
    verticalAlign: 'middle',
    background: 'var(--border)',
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
    padding: '0.15rem 0.5rem',
    fontSize: '0.75rem',
    lineHeight: '1.4',
    color: 'var(--foreground)',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
  },
  '.cm-ask-agent-trigger:hover': { color: 'var(--link)' },
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
    fontSize: '0.6875rem',
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
    fontSize: '0.6875rem',
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
    overflow: 'hidden',
    color: 'var(--popover-foreground)',
    background: 'var(--popover)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    boxShadow: 'var(--shadow-popover)',
  },
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
  '.cm-ySelectionInfo': { fontSize: '10px', padding: '0 3px', borderRadius: '3px' },

  // Wiki-link hover preview. The card owns its chrome, so strip the base
  // tooltip wrapper.
  '.cm-tooltip.cm-tooltip-hover': { background: 'transparent', border: 'none' },
  '.cm-wiki-preview': {
    background: 'var(--popover)',
    color: 'var(--popover-foreground)',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    padding: '8px 10px',
    maxWidth: '320px',
    fontSize: '12px',
    lineHeight: '1.5',
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
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
  // panel chrome so it reads as part of the dark editor, not a boxed toolbar.
  '.cm-panels, .cm-panels-bottom': { background: 'transparent', border: 'none' },
  '.cm-validity': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '0.4rem',
    padding: '3px 12px',
    borderTop: '1px solid #262626',
    fontFamily: MONO,
    fontSize: '0.72rem',
    // Neutral while valid: quiet until wrong.
    color: '#737373',
  },
  '.cm-validity-dot': {
    width: '7px',
    height: '7px',
    borderRadius: '9999px',
    background: '#737373',
  },
  '.cm-validity-invalid': { color: '#f87171' },
  '.cm-validity-invalid .cm-validity-dot': { background: '#f87171' },
})

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
  '&': { '--tbl-style-font-family': `var(--editor-font, ${PROSE})` },
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
