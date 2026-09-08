import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { EditorView } from '@codemirror/view'

/** The one mono stack, named once so the places that must *stay* mono when the
 *  notes editor goes proportional cannot drift from the base they restore. */
const MONO = 'ui-monospace, SF Mono, monospace'

export const editorTheme = EditorView.baseTheme({
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
   * sibling of the lines, so it gets none of this and sat 24px out in the page
   * margin until it was given the inset by hand. There are two — the frontmatter
   * widget (`.cm-fm`, in frontmatter.ts) and the table below — and a third would
   * need the same. Padding them does not disturb the selection edge: that is
   * read off the first `.cm-line`, never off a widget.
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
      'width var(--duration-base, 240ms) var(--ease-settle, ease-out), opacity var(--duration-base, 240ms) var(--ease-settle, ease-out)',
  },
  // Respect the OS switch: the marks still appear, they just stop travelling.
  '@media (prefers-reduced-motion: reduce)': {
    '&.cm-heading-sliding .cm-heading-mark': { transition: 'none' },
  },

  '.cm-strong': { fontWeight: '700' },
  '.cm-emphasis': { fontStyle: 'italic' },
  '.cm-strikethrough': { textDecoration: 'line-through' },
  '.cm-inline-code': {
    background: 'rgba(255,255,255,0.08)',
    borderRadius: '3px',
    padding: '0 3px',
  },
  '.cm-code-line': { background: 'rgba(255,255,255,0.04)' },
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

  '.cm-wikilink': {
    background: 'color-mix(in srgb, var(--link) 12%, transparent)',
    color: 'var(--link)',
    borderRadius: '4px',
    padding: '0 4px',
    cursor: 'pointer',
  },
  // A task chip reads as a task, not a note: same shape, its own accent tint, and a
  // status orb before the title. `inline-flex` so the orb and title share a baseline row.
  '.cm-wikilink-task': {
    background: 'color-mix(in srgb, var(--task) 12%, transparent)',
    color: 'var(--task)',
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
  '.cm-wikilink-missing': {
    color: 'var(--link-missing)',
    background: 'color-mix(in srgb, var(--link-missing) 10%, transparent)',
  },

  // remote cursors (y-codemirror.next)
  '.cm-ySelectionInfo': { fontSize: '10px', padding: '0 3px', borderRadius: '3px' },

  // autocomplete popover (mentions / slash / table) — dark, or CM's default light
  // tooltip renders our inherited light text white-on-white.
  '.cm-tooltip.cm-tooltip-autocomplete': {
    background: '#1f1f1f',
    border: '1px solid #404040',
    borderRadius: '6px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
  },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'inherit', maxHeight: '18em' },
  '.cm-tooltip-autocomplete > ul > li': { color: '#e5e5e5', padding: '2px 8px', lineHeight: '1.5' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { background: '#2563eb', color: '#ffffff' },
  '.cm-completionDetail': { color: '#a3a3a3', fontStyle: 'normal', marginLeft: '0.6em' },
  '.cm-completionMatchedText': { color: '#7dd3fc', textDecoration: 'none' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionMatchedText': { color: '#e0f2fe' },

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
})
