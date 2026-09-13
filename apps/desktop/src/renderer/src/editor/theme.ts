import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { EditorView } from '@codemirror/view'
import { COMPLETION_CLASS, OPTION_CLASS } from './completion'

/** The one mono stack, named once so the places that must *stay* mono when the
 *  notes editor goes proportional cannot drift from the base they restore. */
const MONO = 'ui-monospace, SF Mono, monospace'

/** Every rule in `completionChrome` is prefixed with this, and it is three
 *  classes on purpose. See `COMPLETION_CLASS`. */
const POPUP = `.cm-tooltip.cm-tooltip-autocomplete.${COMPLETION_CLASS}`

/**
 * The completion popup: mentions, slash commands, settings keys, and the
 * markdown-table menu, which is the one thing here deliberately left alone.
 *
 * **Exported so the guards can read it.** `test/completion.test.ts` asserts
 * three things the block this replaced got wrong: that every selector carries
 * `COMPLETION_CLASS`, without which CodeMirror's own rules outrank it and the
 * whole block is silently dead; that nothing here is a hex literal, because the
 * popup was the one overlay in the app that ignored D64 theming and light mode;
 * and that nothing contests `:has(.cm-completionIcon-table)`.
 *
 * The radius tokens carry fallbacks because they live in Tailwind's `@theme`,
 * which tree-shakes what it cannot see referenced, and Tailwind never scans
 * this file — the same reason `lib/motion.ts` writes `var(--motion-arrive,
 * 300ms)`.
 */
export const completionChrome = {
  [POPUP]: {
    // **Arrive.** The panel has weight and enters from the caret it belongs to.
    // An animation rather than a transition because the element is created
    // already in place, so there is no "from" for a transition to run. It plays
    // once, on open: CodeMirror keeps this element and rebuilds only the `<ul>`
    // inside it as you keep typing, which is also why the list itself has no
    // animation — one there would replay on every keystroke, and is why the
    // cross-fade between `/table`'s two levels is deliberately not built.
    animation: 'cm-completion-in var(--motion-arrive, 300ms) var(--ease-settle, ease-out) both',
    transformOrigin: 'top left',
    background: 'var(--popover)',
    color: 'var(--popover-foreground)',
    // Borderless on the popover shadow, like every overlay in the app since
    // 2026-08-14 — see `primitives/Popover.tsx`.
    border: 'none',
    borderRadius: 'var(--radius-md, 6px)',
    boxShadow: 'var(--shadow-popover)',
    padding: '4px',
  },
  // The app's UI font, which is the point of item 12: CodeMirror's own rule
  // here is `fontFamily: monospace`, and it was winning.
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
    // **Respond.** It notices the row under your pointer or caret, and reverses
    // the moment you leave. A transition, never an animation.
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
    width: '14px',
    height: '14px',
    flex: 'none',
    color: 'var(--muted-foreground)',
  },
  // A task's status colour is information, so it survives selection — which is
  // why there is no blanket `color: inherit` for a selected row's glyph here.
  // Same `--task-*` tokens the editor's task orbs and the file tree use, so one
  // status has one colour everywhere and a vault theme recolours all of it.
  [`${POPUP} .cm-holi-icon-holi-task-todo`]: { color: 'var(--task-todo)' },
  [`${POPUP} .cm-holi-icon-holi-task-doing`]: { color: 'var(--task-doing)' },
  [`${POPUP} .cm-holi-icon-holi-task-done`]: { color: 'var(--task-done)' },
  [`${POPUP} .cm-holi-emoji`]: {
    fontSize: '13px',
    lineHeight: '1',
    textAlign: 'center',
    display: 'inline-block',
  },
  // Text, not a pill. It carried `--muted-foreground` on a `--muted` fill, which
  // is the same "brighter shade of its own ground" this app does not do.
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
  // The table widget reads its own `--tbl-style-font-family` (it defaults to
  // `system-ui`, which belonged to no editor here). Declared on the editor
  // element rather than `:root` so it can be scoped: every stack that borrows
  // this base keeps its tables mono along with its prose, and the notes stack
  // overrides it below — the same split `.cm-scroller` makes on the next line.
  '&': {
    height: '100%',
    fontSize: '14px',
    '--tbl-style-font-family': MONO,
    // The column's side inset. Every child of `.cm-content` that holds content
    // has to carry it itself (see `.cm-line` below for why it cannot live on
    // `.cm-content`), so it is named once here and the three places that apply
    // it — the line, the frontmatter widget, the table widget — read it.
    '--editor-inset': '24px',
    // What lets a heading's `#` slide instead of blink: without it `width: auto`
    // is not an interpolable value and the transition below does nothing.
    interpolateSize: 'allow-keywords',
    // A list's three lengths, declared here so a stack that borrows this base
    // can retune them in one place: one nesting level, the space held between a
    // marker and its text on top of the one space markdown already requires,
    // and the air above each item.
    '--list-indent': '2em',
    '--list-gap': '0.5em',
    '--list-space': '0.7em',
    '--list-bullet': '0.6em',
    '--list-check': '1.15em',
  },
  // Mono, for every stack that borrows this base: the plain/code editor, the mail
  // composer and `DiffView`. The **notes** editor overrides it — see
  // `notesFontTheme` at the foot of this file — and only the notes editor does.
  '.cm-scroller': { fontFamily: MONO, lineHeight: '1.6' },
  /**
   * Left-aligned, NOT centred (`margin: 0 auto` was here and is deliberately
   * gone).
   *
   * A centred column moves its own centre whenever the pane resizes, so opening
   * the right sidebar slid the text you were reading 88px to the left — the
   * editor is supposed to get *narrower*, not shift. Anchoring the column to the
   * left makes the sidebar take width off the right-hand end only, and the words
   * under the caret stay where they were.
   *
   * The horizontal padding is the other half: with the pane narrower than the
   * column, `maxWidth` stops applying and the text ran flush to both edges.
   */
  '.cm-content': { padding: '16px 0', maxWidth: '48rem', caretColor: '#e5e5e5' },
  /**
   * The column's side margins live on the LINE, not on `.cm-content`.
   *
   * `drawSelection` draws the middle of a multi-line selection from one
   * document-wide left edge, and it works that edge out from the padding of the
   * first rendered line — not from the content's. With the 24px on `.cm-content`
   * every line after the first was highlighted 24px into the page margin, which
   * read as selectable whitespace that is not there. Moving it here makes the
   * edge the text's own edge.
   *
   * It is why a list indents by MARGIN (below) rather than padding: keeping every
   * line's padding identical keeps that edge still. Were the indent padding, the
   * whole selection would shift by it whenever a list line happened to be the
   * first one on screen.
   *
   * The price is that a BLOCK WIDGET is not a line. CodeMirror renders one as a
   * sibling of the lines, so it gets none of this and sits 24px out in the page
   * margin until it is given the inset by hand. There are three — the
   * frontmatter widget (`.cm-fm`, in frontmatter.ts), the table below, and a
   * rendered mermaid diagram — and each one arrived flush to the edge before
   * anyone remembered. Insetting them does not disturb the selection edge: that
   * is read off the first `.cm-line`, never off a widget.
   */
  '.cm-line': { padding: '0 var(--editor-inset)' },
  /**
   * The table widget, insetted to the same column as the text.
   *
   * `codemirror-markdown-tables` pads the widget by 16px on every side and then
   * pulls it back by 10px, so its cells sit 6px inside the text edge and its
   * drag handles have room to hang off the left. Both of its numbers are kept:
   * the inset is added to its own offset rather than replacing it, which is what
   * the `calc` says. Written `.cm-content div…` because the plugin's own rules
   * for this element are two classes deep and a shallower one loses to them.
   */
  '.cm-content div.tbl-table-widget': {
    marginLeft: 'calc(var(--editor-inset) - 10px)',
    marginRight: 'var(--editor-inset)',
  },

  // drawSelection() draws its own cursor and hides the native one, so caretColor
  // alone is invisible — the drawn cursor is a border-left element, style it.
  '.cm-cursor, .cm-cursor-primary': { borderLeftColor: '#e5e5e5', borderLeftWidth: '2px' },
  /**
   * The app's own selection tint — D64's `--selection`, brand-derived and
   * themeable per vault — rather than a second colour of the editor's own.
   *
   * Written at this depth, and not as `.cm-selectionBackground`, because
   * CodeMirror's own selection rule is five classes deep and a shallower one
   * loses to it however late it is mounted. This is the shape every CodeMirror
   * theme uses to override it, one-dark included.
   *
   * Which of CodeMirror's two it was losing to used to be the worse half of the
   * problem: nothing declared `EditorView.darkTheme`, so it painted the
   * near-white `#d7d4f0` it ships for a LIGHT editor over this near-black one.
   * That is fixed at its root now (`color-mode.ts`), and this is only about
   * whose colour wins.
   */
  '&.cm-editor .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    background: 'color-mix(in srgb, var(--selection) 60%, transparent)',
  },
  '&.cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    background: 'var(--selection)',
  },

  // headings: size only — no extra margins, so render/un-render doesn't jump (FR-3b)
  '.cm-heading': { fontWeight: '600' },
  '.cm-heading-1': { fontSize: '1.5em' },
  '.cm-heading-2': { fontSize: '1.25em' },
  '.cm-heading-3': { fontSize: '1.1em' },
  /**
   * D92: the one animation in the editor, and the exception that FR-2's "no
   * animation layer" is now written around. A heading's `#` slides out and back
   * rather than blinking, because the heading is the block whose text moves
   * furthest when its marks appear.
   *
   * `width: 0` to `width: auto`, which is only interpolable because of
   * `interpolate-size` on the editor root. That is the whole reason this needs no
   * measurement: the marks are one to six `#` plus a space in whatever face the
   * vault chose (D87), a width no CSS unit knows — `ch` is the width of a zero —
   * and the last attempt to measure a marker in this editor was deleted for being
   * more machinery than it was worth (`cd4cf31`). `auto` IS the measurement, and
   * the browser does it.
   *
   * `vertical-align: bottom` because an inline-block that clips takes its
   * baseline from its bottom margin edge, which lifts the `#` off the text's
   * baseline by a descender. Aligning the box to the line box's bottom instead
   * puts it back.
   *
   * Nothing else in the editor animates. Decorations that move CodeMirror's own
   * geometry peg its measure loop, which is why the rest of live preview is a
   * plain swap; a single line's inline width for a quarter of a second is the
   * whole of what is spent here.
   */
  '.cm-heading-mark': {
    display: 'inline-block',
    overflow: 'hidden',
    // NOT inherited: `.cm-line` is `pre-wrap`, and at `width: 0` that wraps the
    // `## ` inside this box onto one line per character. `overflow: hidden` only
    // clips sideways, so the box keeps the height it wrapped to and a closed h2
    // stood three lines tall. The marks are one line and are clipped, never
    // wrapped.
    whiteSpace: 'pre',
    verticalAlign: 'bottom',
    width: '0',
    opacity: '0',
  },
  '.cm-heading-raw .cm-heading-mark': { width: 'auto', opacity: '1' },
  /**
   * The transition is declared ONLY here, under a class `heading-slide.ts` puts
   * on for a moment after the caret moves.
   *
   * Unconditionally, every heading in a file animated its marks shut as the file
   * opened. CodeMirror creates the mark span and settles its style in two steps,
   * so the element's first resolved width is `auto` and the rule closing it reads
   * as a change worth transitioning. `@starting-style` does not help, because
   * this is not an insertion. Gating on a caret move does: a mark rendered by a
   * scroll, or by opening a file, finds transitions switched off and just
   * appears closed.
   */
  '&.cm-heading-sliding .cm-heading-mark': {
    transition:
      'width var(--motion-respond, 150ms) var(--ease-settle, ease-out), opacity var(--motion-respond, 150ms) var(--ease-settle, ease-out)',
  },
  /**
   * The OS switch, for both of the editor's two animations. The heading's marks
   * still appear and the ask popover still arrives and leaves; neither travels.
   * `askAgent.ts` reads the same preference and then waits for nothing, so its
   * send does not sit through a fade that is not happening.
   */
  '@media (prefers-reduced-motion: reduce)': {
    '&.cm-heading-sliding .cm-heading-mark': { transition: 'none' },
    '.cm-ask-agent-open, .cm-ask-agent-leaving': { animation: 'none' },
  },

  '.cm-strong': { fontWeight: '700' },
  '.cm-emphasis': { fontStyle: 'italic' },
  '.cm-strikethrough': { textDecoration: 'line-through' },
  '.cm-inline-code': {
    background: 'rgba(255,255,255,0.08)',
    borderRadius: '3px',
    padding: '0 3px',
  },
  /**
   * An unfocused table cell hides the `**`, `*` and `` ` `` it would otherwise
   * show.
   *
   * The cell view is the plugin's own `contenteditable`, painted from highlight
   * classes with no decorations behind it, so nothing there can conceal text the
   * way live preview does. What makes this possible anyway is that a mark
   * INHERITS the class of the node it sits in: `EmphasisMark`, `CodeMark` and
   * `LinkMark` share one tag, but a link's `[` is the only one of the three that
   * also carries `cm-cell-link`.
   *
   * **A link keeps its brackets on purpose.** Hiding them would leave a wiki-link
   * as `[notes/plan.md]` — markdown parses the INNER pair of `[[…]]` as a
   * shortcut link and the outer pair is plain text, so concealing one pair reads
   * as a broken link rather than as a rendered one. Concealing properly is a
   * decoration, and a cell has none; the caret has to enter the cell before the
   * real thing takes over.
   *
   * Verified in the running app that a click still lands where it looks like it
   * should: the plugin maps a click to a source offset through its own model
   * rather than through rendered widths, so hidden characters do not shift it.
   */
  '.tbl-cell-view .cm-md-mark:not(.cm-cell-link)': { display: 'none' },
  // Inline code and a link, in a cell and only in a cell. The classes exist
  // everywhere the highlight style does — a fenced block's body carries
  // `cm-cell-code` too — so the SELECTOR is what keeps them to a cell rather
  // than the tagging.
  '.tbl-cell-view .cm-cell-code': {
    background: 'rgba(255,255,255,0.08)',
    borderRadius: '3px',
    padding: '0 3px',
    fontFamily: MONO,
  },
  '.tbl-cell-view .cm-cell-link': { color: 'var(--link)' },
  '.cm-code-line': { background: 'rgba(255,255,255,0.04)' },
  /**
   * A rendered mermaid diagram (#6).
   *
   * The same restraint FR-3b asks of every other rendered block: no box, no
   * border, and vertical padding close to what the source occupied, so a note
   * does not lurch when a diagram opens or closes. It scrolls sideways rather
   * than shrinking, because a flowchart squeezed to a narrow pane is unreadable
   * in a way that a scrollbar is not.
   *
   * The side margin is the third instance of the note on `.cm-line`: a BLOCK
   * WIDGET is not a line and gets none of the line's padding, so without this it
   * sits out in the page margin exactly as the frontmatter widget and the table
   * did. That comment predicted a third and this is it.
   */
  '.cm-mermaid': { padding: '0.3em 0', margin: '0 var(--editor-inset)', overflowX: 'auto' },
  '.cm-mermaid svg': { maxWidth: '100%', height: 'auto' },
  // What is on screen until the render lands, and what stays there when it
  // fails. Styled as the code it is rather than as an error.
  '.cm-mermaid-source': {
    margin: '0',
    fontFamily: MONO,
    whiteSpace: 'pre-wrap',
    background: 'rgba(255,255,255,0.04)',
    color: 'var(--muted-foreground)',
  },
  /**
   * Lists. `livePreview`'s `ListItem` case stamps the depth; this turns it into
   * a distance, and that is the whole mechanism.
   *
   * The author's literal indentation is concealed rather than added to, so the
   * depth alone decides where a line sits and a list written with two spaces per
   * level lands where one written with four does. Nothing is concealed
   * conditionally, so the line does not move when the caret lands on it (FR-3b).
   */
  '.cm-list': {
    marginLeft: 'calc(var(--list-indent, 2em) * var(--list-depth, 1))',
    // Padding, not margin: adjacent margins collapse, and CodeMirror measures
    // line heights itself. Above rather than below, so a list gets no trailing
    // gap that the next paragraph would then sit inside. A wrapped item is one
    // line box and gets no second helping, and an item's continuation lines are
    // not `.cm-list` at all.
    paddingTop: 'var(--list-space, 0.7em)',
  },
  '.cm-list-mark': { marginRight: 'var(--list-gap, 0.5em)' },
  // One box for the raw `-`/`*`/`+` and for the dot that stands in for it off
  // the active line, so the line does not move when the caret arrives (FR-3b).
  // Ordered markers are never swapped and keep their natural width.
  '.cm-list-bullet': { display: 'inline-block', width: 'var(--list-bullet, 0.6em)' },
  // A task's checkbox stands in for the marker, so it wears the marker's gap.
  /**
   * Respond, inside a document.
   *
   * The line is "is it a thing you can click", not "is it in the editor": the
   * objects react, the prose never does. **Paint only** — colour, background,
   * border and shadow. Never width, height, font-size, padding or margin, which
   * is what pegs CodeMirror's measure loop (see the callout in
   * prd/notes-editor.md). A hover that resized a chip would relayout the line
   * under the pointer, which is the cost that rule exists to refuse.
   *
   * The duration comes from the app's vocabulary, so no number is stated here.
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
    fontSize: '0.8em',
    border: '1px solid var(--muted-foreground)',
    borderRadius: '50%',
    cursor: 'pointer',
  },
  '.cm-task-check-done': {
    background: 'var(--task-done)',
    borderColor: 'var(--task-done)',
    color: 'var(--background)',
  },
  '.cm-quote-mark': { color: '#737373' },
  // No pointer by default: a markdown link is editable text and a plain click
  // places the caret — only ⌘/Ctrl-click navigates (links.ts). The cursor is
  // therefore gated on the modifier actually being held, so it never advertises
  // a click that does nothing. Wiki-link chips below keep theirs: a plain click
  // on one does navigate.
  '.cm-md-link': { color: 'var(--link)', textDecoration: 'underline' },
  '&.cm-mod-held .cm-md-link': { cursor: 'pointer' },

  // compact HR (FR-3b: thin rule, minimal margins — not a chunky block)
  '.cm-hr': {
    borderTop: '1px solid #404040',
    margin: '0.3em 0',
    height: '1px',
  },

  /**
   * A chip is COLOURED TEXT, and it has no background of its own.
   *
   * Every one of these used to be its own colour painted twice: `--link` words
   * on a 12% `--link` wash, `--link-missing` on a 10% `--link-missing` wash. In
   * a paragraph that reads as a highlighter stain rather than as a link, and it
   * is a house rule that text is never a brighter shade of the ground it sits
   * on. The hover tint is NEUTRAL for the same reason — it says "you can click
   * this" without saying it in the link's own hue.
   */
  '.cm-wikilink': {
    color: 'var(--link)',
    borderRadius: '4px',
    padding: '0 4px',
    cursor: 'pointer',
  },
  /**
   * A task chip reads as a task through its ORB, not through its colour.
   *
   * It used to paint `--task` (amber) as both the text colour and a 12% wash
   * behind it, which in a paragraph of prose was a block of yellow words on a
   * yellow ground — reported as horrible, and it was. The chip now inherits
   * `.cm-wikilink`'s link treatment, like the note chip it sits beside, and the
   * only colour is the status orb: blue for doing, green for done, grey for
   * todo. Same principle as the file tree and the `@`-mention list, where the
   * status glyph carries the colour and the words are words.
   *
   * `--task` is still the token a vault themes to bring the tint back (it is in
   * D64's whitelist); the difference is that nothing is painted with it by
   * default. `inline-flex` so the orb and title share a baseline row.
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
   * "Ask agent", over a selection (#5).
   *
   * A tooltip rather than anything mounted in the content: it has to sit above
   * the passage without being part of it, and CodeMirror already positions
   * tooltips against a range. `.cm-tooltip` supplies the shell, so this is only
   * what sits inside it — first a button, and once pressed the field it opens
   * into, so the passage can be sent with an instruction rather than alone.
   */
  '.cm-ask-agent button': {
    padding: '0.15rem 0.5rem',
    fontSize: '0.75rem',
    lineHeight: '1.4',
    color: 'var(--foreground)',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
  },
  '.cm-ask-agent button:hover': { color: 'var(--link)' },
  /**
   * The popover: one field in a bubble, and the motion in and out.
   *
   * **The shell IS the tooltip.** CodeMirror puts `cm-tooltip` on the very
   * element the tooltip's `create` returns rather than wrapping it, so this is
   * one element wearing both classes. An ancestor selector (`:has`) therefore
   * matches nothing, which is how the first version of this rule silently did
   * nothing at all; and the pair is what outranks CodeMirror's own `.cm-tooltip`
   * rule, whose background is the light one. The field inside is transparent, so
   * there is one box rather than two.
   *
   * **`transform` and `opacity` only.** CodeMirror positions this tooltip itself
   * against the range, and animating anything that changes layout would drag its
   * measure loop into every frame — the cost the editor's no-animation rule
   * exists to refuse.
   *
   * The fade and the timer that waits for it both read `--motion-leave`, so they
   * are one number rather than two that can drift. `askAgent.ts` reads it off
   * the document; this used to be an `--ask-exit` property the plugin wrote onto
   * the element to say what its own local constant was.
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
   * The field reads as the note does. Size and weight are inherited from the
   * editor's own 14px here; the FACE is set once, by `notesFontTheme` at the foot
   * of this file, which is the seam the scroller and the frontmatter widget
   * already use. What you are writing about is prose, and so is what you write.
   *
   * **No `font-family` in this rule, deliberately.** A `theme` and a `baseTheme`
   * generate selectors of equal specificity, so a family set in both would be
   * settled by which stylesheet happens to come last. Setting it in exactly one
   * place is not a preference, it is what makes the answer not depend on that.
   *
   * No height of its own: `askAgent.ts` grows it with its content and tells
   * CodeMirror to re-place the bubble when it does. `maxHeight` is where growing
   * stops and scrolling starts, so one long message cannot cover the note it is
   * about.
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
    // `askAgent.ts` turns this to `auto` at the moment the content passes
    // `maxHeight`, and only then. See the note there: the app's scrollbars are
    // not overlay ones, so `auto` plus a rounded `scrollHeight` shows a
    // permanent track over a fraction of a pixel.
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
   * The BUBBLE animates, not the field inside it.
   *
   * Animating the field was the first version and it was invisible: the bubble
   * arrived instantly at full size and a transparent field faded inside it, so
   * there was nothing to see. `-open` is added by the press rather than being on
   * the element from birth, because this element is rebuilt on every selection
   * change and a mount-time animation would replay on every frame of a drag.
   */
  '.cm-ask-agent-open': {
    // Arrive, at the vocabulary's pace. This carried a local 320ms, chosen
    // because at the old tier's 160ms it read as nothing happening at all; the
    // app's arrive duration is 300ms, so that concern is answered by the
    // vocabulary rather than by a number kept here.
    animation: 'cm-ask-in var(--motion-arrive, 300ms) var(--ease-settle, ease-out) both',
  },
  '.cm-ask-agent-leaving': {
    // Leaving is faster than arriving, and `askAgent.ts` waits for exactly this
    // token, so the two cannot drift.
    animation: 'cm-ask-out var(--motion-leave, 190ms) var(--ease-settle, ease-out) both',
    // The message is already gone; nothing here is worth a click on the way out.
    pointerEvents: 'none',
  },
  // Enough travel to register as the popover opening rather than as a flicker,
  // and anchored at the bottom because the bubble sits above the passage.
  '@keyframes cm-ask-in': {
    from: { opacity: '0', transform: 'translateY(10px) scale(0.88)' },
    to: { opacity: '1', transform: 'none' },
  },
  '@keyframes cm-ask-out': {
    from: { opacity: '1', transform: 'none' },
    to: { opacity: '0', transform: 'translateY(8px) scale(0.90)' },
  },
  // remote cursors (y-codemirror.next)
  '.cm-ySelectionInfo': { fontSize: '10px', padding: '0 3px', borderRadius: '3px' },

  // Wiki-link hover preview (FR-6). The card owns its chrome, so strip the base
  // tooltip wrapper. Colours are D64 tokens, so a vault theme recolours the card.
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
    // Neutral while valid — the app's "quiet until wrong" cue, same as the
    // frontmatter chevron. `.cm-validity-invalid` reddens both dot and label.
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
 * Token colours for the plain/code editor (`plainTextExtensions`).
 *
 * The markdown editor never needed this — it paints itself with the live-preview
 * decorations (`.cm-heading`, `.cm-strong`, …), not the highlight-tag pipeline —
 * so a language's parse tree produced tags that nothing coloured. This is the
 * missing `HighlightStyle`: it maps Lezer tags to the app's syntax tokens (sky
 * for keys, green for strings, amber for literals). Legacy StreamLanguage modes
 * (toml/ini/shell) route through the same standard tags.
 *
 * **Tokens, not hexes.** These were hardcoded 300-tint colours picked to glow on
 * near-black, which meant a .json or .mjs file became unreadable the moment
 * light mode shipped. `var()` resolves per element against whichever
 * `data-theme` is stamped, so one definition serves both.
 */
const codeHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.operatorKeyword], color: 'var(--syntax-keyword)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--syntax-property)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syntax-string)' },
  // `tags.color` descends from `literal`, so a CSS hex lands here too — which
  // is right: a colour literal IS a literal, and the swatch beside it already
  // carries the hue. It had its own muted token for one commit and that was
  // worse, because a custom property name is `variableName` (near-white) and a
  // muted value beside it read as the same colour twice.
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
 * Markdown's own tags, mapped onto the classes live preview already uses.
 *
 * This exists for TABLE CELLS, and it is the only thing that reaches one.
 * `codemirror-markdown-tables` renders an unfocused cell itself — a
 * `contenteditable` div whose spans it classes from
 * `highlightingFor(rootState, tags)` — so a cell is styled by a HighlightStyle
 * and by nothing else. There are no decorations there, which is exactly why a
 * cell cannot conceal its `**` the way the document can: concealing is a
 * decoration, and a HighlightStyle only ever colours what is already on screen.
 *
 * Reusing live preview's own classes rather than restating the colours keeps
 * bold-in-a-cell and bold-in-a-note one definition. Inline code is the one
 * exception and takes a class of its own: its background is translucent, and in
 * the document body the highlight would land on the same range as live
 * preview's `.cm-inline-code` mark and paint it twice.
 *
 * `strikethrough` fires in the body only. A cell's grammar has no GFM in it, and
 * the parser the plugin renders an unfocused cell with is not configurable.
 */
const markdownHighlightStyle = HighlightStyle.define([
  // These three land on exactly the text live preview already marks, so they
  // borrow its classes and bold-in-a-cell stays one definition.
  { tag: t.strong, class: 'cm-strong' },
  { tag: t.emphasis, class: 'cm-emphasis' },
  { tag: t.strikethrough, class: 'cm-strikethrough' },
  // These two do not, and get classes of their own that only a CELL styles.
  // `monospace` is markdown's tag for `CodeText` as well as for `InlineCode`, so
  // borrowing `.cm-inline-code` would put an inline-code background on every line
  // of every fenced block; and `link` covers a link's brackets, which the body
  // draws as punctuation.
  { tag: t.monospace, class: 'cm-cell-code' },
  { tag: t.link, class: 'cm-cell-link' },
  // The delimiters. `EmphasisMark`, `CodeMark` and `LinkMark` all carry
  // `processingInstruction`, so this class alone cannot tell them apart — what
  // separates them is the class they INHERIT from the node they sit in, which is
  // how the cell rule below reaches `**` without touching a link's brackets.
  { tag: t.processingInstruction, class: 'cm-md-mark' },
])

/** Notes stack only. "Edit Source" opens a `.md` in the plain editor, where the
 *  point is to see it raw. */
export const markdownHighlighting = syntaxHighlighting(markdownHighlightStyle)

/**
 * The notes editor's prose font, and the three things it must not reach.
 *
 * **`EditorView.theme`, not `baseTheme`** — a theme outranks a base theme, so
 * this overrides `editorTheme`'s `.cm-scroller` for the one stack that includes
 * it (`baseEditorExtensions`). The plain/code editor, the mail composer and
 * `DiffView` include only the base and stay mono, which is not a detail: the
 * plain editor is where `.json`, `.ts` and `.env` open, and column alignment is
 * the whole point there.
 *
 * The value is a CSS custom property rather than a compartment because the
 * setting can only change on a vault switch, and a var restyles every open
 * editor at once with no reconfiguration and no per-view plumbing. Its fallback
 * is the same mono stack, so an editor mounted before `useEditorFont` has
 * stamped anything looks exactly as it always has.
 *
 * **What stays mono inside a proportional document:**
 * - fenced code (`.cm-code-line`) and inline code (`.cm-inline-code`), which
 *   carry their own decoration classes already;
 * - the frontmatter widget (`.cm-fm`), including the nested YAML editor it
 *   hosts — that editor never includes `editorTheme` itself, but its
 *   `.cm-scroller` is a DOM descendant of this one's, so the rule reaches it
 *   and has to be told not to.
 *
 * Tables come along too. `codemirror-markdown-tables` paints its cells from
 * `--tbl-style-font-family`, not from the inherited font, so the property has
 * to be re-pointed the same way — a rendered table is prose and should read as
 * prose. `editorTheme` sets it to `MONO` on the same element, which is what the
 * composer and the plain/code editor keep; a `theme` outranks a `baseTheme`, so
 * this wins for the notes stack. The menu font is left alone: that is UI.
 */
export const notesFontTheme = EditorView.theme({
  '&': { '--tbl-style-font-family': `var(--editor-font, ${MONO})` },
  '.cm-scroller': { fontFamily: `var(--editor-font, ${MONO})` },
  '.cm-code-line': { fontFamily: MONO },
  '.cm-inline-code': { fontFamily: MONO },
  '.cm-fm': { fontFamily: MONO },
  '.cm-fm .cm-scroller': { fontFamily: MONO },
  // The ask popover is about a passage of prose, so it is written in the same
  // face. It reaches here because CodeMirror mounts a tooltip as a child of
  // `.cm-editor`, which is where this theme's class lives.
  '.cm-ask-agent-field': { fontFamily: `var(--editor-font, ${MONO})` },
})
