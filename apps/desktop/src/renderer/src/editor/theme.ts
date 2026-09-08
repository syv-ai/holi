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
    // A list's three lengths, declared here so a stack that borrows this base
    // can retune them in one place: one nesting level, the space held between a
    // marker and its text on top of the one space markdown already requires,
    // and the air above each item.
    '--list-indent': '2em',
    '--list-gap': '0.5em',
    '--list-space': '0.7em',
    '--list-bullet': '0.6em',
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
  '.cm-content': { padding: '16px 24px', maxWidth: '48rem', caretColor: '#e5e5e5' },

  // drawSelection() draws its own cursor and hides the native one, so caretColor
  // alone is invisible — the drawn cursor is a border-left element, style it.
  '.cm-cursor, .cm-cursor-primary': { borderLeftColor: '#e5e5e5', borderLeftWidth: '2px' },
  '.cm-selectionBackground': { background: 'rgba(125,211,252,0.20)' },
  '&.cm-focused .cm-selectionBackground': { background: 'rgba(125,211,252,0.28)' },

  // headings: size only — no extra margins, so render/un-render doesn't jump (FR-3b)
  '.cm-heading': { fontWeight: '600' },
  '.cm-heading-1': { fontSize: '1.5em' },
  '.cm-heading-2': { fontSize: '1.25em' },
  '.cm-heading-3': { fontSize: '1.1em' },

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
    paddingLeft: 'calc(var(--list-indent, 2em) * var(--list-depth, 1))',
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
