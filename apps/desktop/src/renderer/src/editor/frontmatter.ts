/**
 * Frontmatter as one in-editor widget (FR-2 hide / FR-16 reveal).
 *
 * Modelled on the table widget (`codemirror-markdown-tables`): an atomic
 * block-`replace` decoration over the region, hosting its own nested
 * `EditorView`, whose edits are **dispatched back to the root** over the
 * region's range with a marker annotation so the plugin does not rebuild (and
 * so lose the nested caret) on its own write. The difference from the table is
 * two render states — a collapsed pill (this is the FR-2 hide) and, on reveal, a
 * nested *plain* editor (no markdown stack, so `⌘B` cannot corrupt a key).
 *
 * The region is **always** replaced by the widget: the root frontmatter text is
 * never edited directly, only through the nested editor's write-back. Because
 * the write-back reconstructs the `---` fences every time, breaking the YAML
 * body never dissolves the block — it only turns the status dot red (and, via
 * `frontmatterValid`, holds off the save).
 */
import {
  Annotation,
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
  type Range,
} from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import {
  Decoration,
  drawSelection,
  EditorView,
  keymap,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { frontmatterSchema, isTaskFilePath, readYamlMapping, splitFrontmatter } from '@holi/shared'
import {
  frontmatterBlockRange,
  frontmatterRegion,
  frontmatterYamlValid,
} from './frontmatter-region'
import { yaml } from '@codemirror/lang-yaml'
import {
  closeFrontmatterPortal,
  openFrontmatterPortal,
  updateFrontmatterPortal,
} from './frontmatter-portals'
import { linkNavFacet } from './links'
import { notePathFacet } from './livePreview'
import { codeHighlighting } from './theme'
import { prefersReducedMotion } from '@/lib/motion'

/** Flip the reveal state. The pill and the header chevron both dispatch this. */
export const toggleFrontmatter = StateEffect.define<boolean>()

/**
 * The block's height when its pill or chevron was pressed, for the next build
 * to open or close from.
 *
 * A toggle does not change this widget, it replaces it (`eq` differs on
 * `expanded`), so there is no element whose height a transition could run on.
 * The press records what was on screen, and `toDOM` animates the new block
 * from that height to its own (`.cm-fm-resizing`, below). Keyed by view: two
 * panes toggling at once must not hand each other a height.
 */
const toggledFrom = new WeakMap<EditorView, number>()

/**
 * The summary as one line: `lead` (the collapse button, or the bare bar) with
 * the text in it, and the author beside it as a link to their GitHub profile.
 *
 * The git author name is used as the GitHub username, which it is for anyone
 * whose git identity is their GitHub one. The link sits BESIDE the button, not
 * in it: a link inside a button is not valid HTML, and pressing the name would
 * toggle the block too. One line, never wrapped: in a narrow pane the text
 * truncates and the name stays whole.
 */
function summaryLine(
  view: EditorView,
  lead: HTMLElement,
  chars: number,
  commit: FrontmatterCommit | null,
): HTMLElement {
  const { text, author } = frontmatterSummaryParts(chars, commit)
  const summary = document.createElement('span')
  summary.className = 'cm-fm-summary'
  summary.textContent = author === null ? text : `${text},`
  lead.appendChild(summary)

  const line = document.createElement('div')
  line.className = 'cm-fm-line'
  line.appendChild(lead)
  if (author !== null) {
    const url = `https://github.com/${encodeURIComponent(author)}`
    const link = document.createElement('a')
    link.className = 'cm-fm-author'
    link.href = url
    link.textContent = author
    link.onmousedown = (e) => {
      e.preventDefault()
      view.state.facet(linkNavFacet)?.().openExternal(url)
    }
    // The window never navigates: `openExternal` above is the whole action.
    link.onclick = (e) => e.preventDefault()
    line.appendChild(link)
  }
  return line
}

function pressToggle(view: EditorView, wrap: HTMLElement, open: boolean): void {
  toggledFrom.set(view, wrap.getBoundingClientRect().height)
  view.dispatch({ effects: toggleFrontmatter.of(open) })
}

/**
 * Open or close from the height the last block had (A, D98: it enters or
 * leaves the layout, so leaving is the faster token).
 *
 * The one place inside a note where height moves, and why that is affordable
 * here: it is one block widget at the top of the document, the text under it
 * reflows as ordinary DOM with nothing for CodeMirror to redo per frame, and
 * CodeMirror is asked to measure once, when the block has landed, so its height
 * map catches up with what the animation left behind.
 */
function playResize(view: EditorView, wrap: HTMLElement, opening: boolean): void {
  const from = toggledFrom.get(view)
  toggledFrom.delete(view)
  if (from === undefined || prefersReducedMotion()) return
  wrap.style.setProperty('--fm-from', `${from}px`)
  wrap.classList.add('cm-fm-resizing', opening ? 'cm-fm-opening' : 'cm-fm-closing')
  const done = (e: AnimationEvent) => {
    if (e.target !== wrap) return
    wrap.classList.remove('cm-fm-resizing', 'cm-fm-opening', 'cm-fm-closing')
    wrap.removeEventListener('animationend', done)
    view.requestMeasure()
  }
  wrap.addEventListener('animationend', done)
}

/** Marks a transaction as the widget's own write-back, so the view plugin maps
 *  its decorations through it rather than rebuilding and remounting the nested
 *  editor mid-keystroke — the table widget's `table.edit` annotation, renamed. */
const frontmatterEdit = Annotation.define<boolean>()

/**
 * Whether a file's frontmatter is the point of the file.
 *
 * FR-2 hides frontmatter because in a *note* it is metadata about prose someone
 * came here to read — a title, a date, a type. Under `.claude/` it is the
 * opposite: a skill's `name` and `description` are what the agent matches
 * against when it decides whether to load the thing at all, an agent definition
 * is little else, and the body is the elaboration. Collapsing that to
 * "5051 chars · Last updated 20/08/26" hides the half of the file you opened it
 * to edit, and offers a chevron as the way back — discoverable only if you
 * already knew there was something behind it.
 *
 * So the reveal default is per-file, not global. Nothing else changes: the same
 * widget, the same nested plain-YAML editor, the same collapse chevron. A note
 * still opens to its prose.
 */
/**
 * Whether a file's frontmatter block has a collapsed state at all.
 *
 * A task's does not. FR-2's pill answers "what is in this file?" with a body
 * char count and a last-edited line, which for a task is a summary of the half
 * that is *not* the point: the fields are. There is nothing worth showing in
 * place of them, so there is no reason to offer the swap — a chevron that only
 * ever makes the view worse is a control with one wrong setting.
 */
export function frontmatterAlwaysOpen(path: string): boolean {
  return isTaskFilePath(path)
}

export function frontmatterStartsRevealed(path: string): boolean {
  // A task joins `.claude/` as the second case, and for the same reason read the
  // other way round: its frontmatter is not metadata over prose someone came to
  // read, it is half of what the file IS. Collapsing a task's status and due
  // date behind "0 chars · Last updated" hides the task.
  return path.startsWith('.claude/') || isTaskFilePath(path)
}

/** Revealed or collapsed. A note starts collapsed (FR-2); a file whose
 *  frontmatter IS its interface starts revealed (`frontmatterStartsRevealed`).
 *  The path comes off `notePathFacet`, which the notes stack already provides —
 *  reading it in `create` is what makes the default per-file rather than a
 *  constant, and there is nothing to thread through. */
export const frontmatterExpandedField = StateField.define<boolean>({
  create: (state) => frontmatterStartsRevealed(state.facet(notePathFacet)),
  update(value, tr) {
    // A file with no collapsed state cannot be toggled into one, whatever
    // dispatches the effect. Enforced here rather than by hiding the chevron
    // alone: the rule is about the file, not about one control.
    if (frontmatterAlwaysOpen(tr.state.facet(notePathFacet))) return true
    for (const e of tr.effects) if (e.is(toggleFrontmatter)) return e.value
    return value
  },
})

/** The file's last commit, for the collapsed summary — the author is the "last
 *  edited by" and the date its "last updated". */
export interface FrontmatterCommit {
  /** ISO 8601 (git author date). */
  date: string
  /** Author name (git `%an`). */
  author: string
}

/** Set by EditorPane once the file's last commit is fetched (async, over IPC);
 *  null while it loads and for a file with no history yet. */
export const setFrontmatterCommit = StateEffect.define<FrontmatterCommit | null>()

export const frontmatterCommitField = StateField.define<FrontmatterCommit | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setFrontmatterCommit)) return e.value
    return value
  },
})

/** ISO date → `DD/MM/YY`. Empty string when it can't be parsed. */
export function formatCommitDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${pad(d.getFullYear() % 100)}`
}

/** A char count as it reads in the summary: the number under a thousand, then
 *  `1.8K` / `2.3M`. One decimal, rounded DOWN, so a note just short of 2K never
 *  claims to be 2K; a trailing `.0` is dropped. */
export function formatCharCount(n: number): string {
  const scaled = (unit: number, suffix: string) =>
    `${String(Math.floor((n / unit) * 10) / 10)}${suffix}`
  if (n >= 1_000_000) return scaled(1_000_000, 'M')
  if (n >= 1_000) return scaled(1_000, 'K')
  return String(n)
}

/** The summary line in two parts: the text, and the author on their own, so
 *  the widget can make the name a link. "1.8K chars · Last updated DD/MM/YY",
 *  and the author once the file's last commit is known. */
export function frontmatterSummaryParts(
  chars: number,
  commit: FrontmatterCommit | null,
): { text: string; author: string | null } {
  const base = `${formatCharCount(chars)} char${chars === 1 ? '' : 's'}`
  const date = commit === null ? '' : formatCommitDate(commit.date)
  if (commit === null || date === '') return { text: base, author: null }
  return { text: `${base} · Last updated ${date}`, author: commit.author }
}

/** The summary line as one string: "1.8K chars · Last updated DD/MM/YY, Name". */
export function frontmatterSummary(chars: number, commit: FrontmatterCommit | null): string {
  const { text, author } = frontmatterSummaryParts(chars, commit)
  return author === null ? text : `${text}, ${author}`
}

/** Does the document's frontmatter parse? The save gate (EditorPane) reads this
 *  to hold off autosave and ⌘S while it is false. */
export function frontmatterValid(state: EditorState): boolean {
  return frontmatterYamlValid(state.doc.toString())
}

/** The raw YAML body between the fences (trailing newline included), or '' when
 *  the document has no parseable fence. */
function frontmatterBody(doc: string): string {
  try {
    return splitFrontmatter(doc).yaml ?? ''
  } catch {
    return ''
  }
}

/** Reconstruct the whole region from an edited YAML body, fences always intact
 *  so the block never dissolves under a temporarily-broken body. */
export function regionTextFrom(body: string): string {
  const inner = body === '' || body.endsWith('\n') ? body : `${body}\n`
  return `---\n${inner}---\n`
}

/** Count top-level `key:` lines — the pill's "N fields". Best-effort, never throws. */
function keyCount(body: string): number {
  return body.split('\n').filter((l) => /^\S.*:/.test(l)).length
}

/** The chevron IS the status indicator now — no separate orb. Neutral normally,
 *  red when the YAML won't parse; the field count lives in its tooltip. Shared by
 *  the initial render and the live refresh so the two can never disagree. */
function paintChevron(el: HTMLElement, body: string): void {
  const valid = frontmatterYamlValid(regionTextFrom(body))
  el.classList.toggle('cm-fm-invalid', !valid)
  const n = keyCount(body)
  el.title = valid ? `frontmatter · ${n} field${n === 1 ? '' : 's'}` : 'frontmatter — invalid YAML'
}

/** Two commits are the same for the summary if both are null or share both
 *  fields — cheap value equality for the widget's `eq`. */
function commitEq(a: FrontmatterCommit | null, b: FrontmatterCommit | null): boolean {
  if (a === null || b === null) return a === b
  return a.date === b.date && a.author === b.author
}

class FrontmatterWidget extends WidgetType {
  private nested: EditorView | null = null
  /** The live portal id while this widget is drawing fields, else null. */
  private portal: number | null = null
  /**
   * What the region holds *now*, which is not always what this widget was built
   * with: our own write-back maps the decoration rather than rebuilding it, so
   * the instance outlives the text it was constructed from. `eq` compares
   * against this, or the next unrelated edit to the body would look like an
   * external change and tear the block down mid-interaction.
   */
  private live: string | null
  /** The revealed chevron, kept so a nested edit can recolour it in place — the
   *  widget maps rather than rebuilds on its own write (to keep the nested caret),
   *  so nothing else would refresh the invalid-YAML cue live. */
  private chevron: HTMLElement | null = null

  constructor(
    readonly expanded: boolean,
    /** The YAML between the fences, or **null when the file has no frontmatter
     *  at all**. Null is the whole difference between the two things this widget
     *  is: a block that collapses, and a bar that only reports. */
    readonly body: string | null,
    /** Body char count, for the collapsed summary. */
    readonly chars: number,
    /** The file's last commit, for the collapsed summary (null until fetched). */
    readonly commit: FrontmatterCommit | null,
    /** The file, which is what decides whether this block has a schema. */
    readonly path: string,
  ) {
    super()
    this.live = body
  }

  /** Reuse the DOM (and the live nested editor) when nothing relevant changed.
   *  The write-back skips rebuild entirely; a genuine rebuild (toggle, external
   *  reload) makes a widget that differs here and so replaces the DOM.
   *
   *  The collapsed-only summary fields (`chars`, `commit`) are compared ONLY
   *  when collapsed: while expanded they must not force a remount, or every body
   *  keystroke (which changes the char count) would tear down the nested editor
   *  and drop its caret. */
  override eq(other: FrontmatterWidget): boolean {
    if (other.path !== this.path) return false
    if (other.expanded !== this.expanded || other.body !== this.live) return false
    if (this.expanded) return true
    return other.chars === this.chars && commitEq(other.commit, this.commit)
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-fm'
    wrap.setAttribute('data-frontmatter', this.expanded ? 'expanded' : 'collapsed')

    if (this.body === null) {
      // No frontmatter in the file. The bar is still shown, because "N chars ·
      // Last updated …" is a fact about a markdown file rather than a fact about
      // having metadata — it used to disappear only as a side effect of there
      // being nothing to collapse (#17). No chevron: there is no block to open,
      // and nothing here writes one, since `normalize-md` adds frontmatter on
      // the next commit anyway and two ways to do it is one too many.
      wrap.setAttribute('data-frontmatter', 'none')
      const bare = document.createElement('span')
      bare.className = 'cm-fm-bare'
      wrap.appendChild(summaryLine(view, bare, this.chars, this.commit))
      return wrap
    }

    if (!this.expanded) {
      // Collapsed: a chevron followed by a one-line summary — "N chars · Last
      // updated DD/MM/YY, Author". The chevron mark reddens if the YAML is
      // invalid (the field count is in its tooltip); the summary stays neutral.
      const pill = document.createElement('button')
      pill.type = 'button'
      pill.className = 'cm-fm-pill'
      pill.setAttribute('data-frontmatter-pill', '')

      const mark = document.createElement('span')
      mark.className = 'cm-fm-mark'
      mark.textContent = '▸'
      paintChevron(mark, this.body)

      pill.append(mark)
      pill.onmousedown = (e) => {
        e.preventDefault()
        pressToggle(view, wrap, true)
      }
      wrap.appendChild(summaryLine(view, pill, this.chars, this.commit))
      playResize(view, wrap, false)
      return wrap
    }

    // Expanded reads as ONE widget: a collapse chevron sitting to the left of the
    // YAML, no "frontmatter" title, no border, no box — just the fields.
    const row = document.createElement('div')
    row.className = 'cm-fm-reveal'

    if (!frontmatterAlwaysOpen(this.path)) {
      const chevron = document.createElement('button')
      chevron.type = 'button'
      chevron.className = 'cm-fm-chevron'
      chevron.setAttribute('data-frontmatter-header', '')
      chevron.textContent = '▾'
      paintChevron(chevron, this.body)
      this.chevron = chevron
      chevron.onmousedown = (e) => {
        e.preventDefault()
        pressToggle(view, wrap, false)
      }
      row.appendChild(chevron)
    }

    const host = document.createElement('div')
    host.className = 'cm-fm-body'
    row.appendChild(host)
    wrap.appendChild(row)

    playResize(view, wrap, true)

    // Rows, when this file has a schema and its frontmatter is a mapping. Both
    // halves matter: `.claude/` and `AGENTS.md` have no schema because their
    // frontmatter is somebody else's contract, and a document that will not
    // parse has no rows to draw. Either way the answer is the same one, the
    // YAML itself, which is why the editor below is the fallback rather than a
    // separate feature.
    if (frontmatterSchema(this.path) !== null && readYamlMapping(this.body) !== null) {
      wrap.setAttribute('data-frontmatter', 'fields')
      const slot = document.createElement('div')
      slot.className = 'cm-fm-fields'
      host.appendChild(slot)
      this.portal = openFrontmatterPortal({
        el: slot,
        path: this.path,
        yaml: this.body,
        chars: this.chars,
        write: (next) => {
          this.writeBack(view, next.replace(/\n$/, ''))
          if (this.chevron !== null) paintChevron(this.chevron, next)
        },
      })
      return wrap
    }

    // A PLAIN editor over the YAML body: basic editing + history only. No
    // markdown, no live-preview, no formatting keymap — that is the whole point
    // of a separate surface (notes-editor.md §Frontmatter reveal control).
    //
    // **Plain does not mean colourless.** The one thing this surface knows for
    // certain is that its content is YAML — it is the only editor in the app
    // whose language is settled before the document is read — so it gets the
    // grammar and the same `codeHighlighting` a `.yaml` file opens with. A key
    // and its value looking alike is what made a task's whole record read as
    // one grey block.
    this.nested = new EditorView({
      parent: host,
      doc: this.body.replace(/\n$/, ''),
      extensions: [
        yaml(),
        codeHighlighting,
        history(),
        drawSelection(),
        EditorView.lineWrapping,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return
          const body = u.state.doc.toString()
          this.writeBack(view, body)
          // Recolour the chevron here: the write-back is our own edit, so the
          // widget maps instead of rebuilding and the cue would otherwise stay
          // frozen — the invalid-YAML feedback has to be live while you type.
          if (this.chevron !== null) paintChevron(this.chevron, body)
        }),
        EditorView.theme({
          '&': { backgroundColor: 'transparent' },
          '.cm-content': { padding: 0 },
        }),
      ],
    })
    return wrap
  }

  /** Push the nested body back to the root over the current region, fences
   *  rebuilt, marked as our own edit so the plugin does not remount us. */
  private writeBack(view: EditorView, body: string): void {
    const region = frontmatterRegion(view.state.doc.toString())
    if (region === null) return
    this.live = body
    if (this.portal !== null) updateFrontmatterPortal(this.portal, body)
    view.dispatch({
      changes: { from: region.from, to: region.to, insert: regionTextFrom(body) },
      annotations: frontmatterEdit.of(true),
    })
  }

  override destroy(): void {
    this.nested?.destroy()
    this.nested = null
    this.chevron = null
    if (this.portal !== null) closeFrontmatterPortal(this.portal)
    this.portal = null
  }

  override ignoreEvent(): boolean {
    // Events inside the widget (typing in the nested editor, clicking the pill)
    // are the widget's own — the root must not treat them as its input.
    return true
  }
}

/**
 * The decoration set — pure over the state, so it is unit-testable without a DOM
 * exactly as `buildDecorations` is. One atomic block-replace over the region, or
 * nothing when the document has no frontmatter.
 */
export function frontmatterDecorations(state: EditorState): DecorationSet {
  const doc = state.doc.toString()
  // `frontmatterBlockRange`, not `frontmatterRegion`: the decoration stops at
  // the closing fence's line END, so the first body position stays on the first
  // body line rather than being swallowed into the widget's row. See the long
  // comment there — this one character is the whole of the stray-caret bug.
  const block = frontmatterBlockRange(doc)
  const expanded = state.field(frontmatterExpandedField, false) ?? false
  // Body-only char count (everything past the frontmatter region), trimmed so a
  // trailing newline isn't counted. `bodyStart` is 0 when there is no block, so
  // this is already right for both shapes. Only shown collapsed, but computed
  // here so the widget stays a pure render of what it is handed.
  const chars = doc.slice(bodyStart(doc)).trim().length
  const commit = state.field(frontmatterCommitField, false) ?? null
  const path = state.facet(notePathFacet)
  if (block === null) {
    // A markdown file with no frontmatter still gets the bar (#17) — inserted
    // above the first line rather than replacing anything, since there is
    // nothing here to replace. `side: -1` puts it before the line's own content
    // so the caret at position 0 lands in the body, not against the widget.
    const bare = Decoration.widget({
      widget: new FrontmatterWidget(false, null, chars, commit, path),
      block: true,
      side: -1,
    })
    return Decoration.set([bare.range(0)])
  }
  const widget = new FrontmatterWidget(expanded, frontmatterBody(doc), chars, commit, path)
  const range: Range<Decoration> = Decoration.replace({ widget, block: true }).range(
    block.from,
    block.to,
  )
  return Decoration.set([range])
}

/**
 * The block-replace lives in a **StateField**, not a ViewPlugin: CodeMirror
 * forbids block decorations from plugins (`RangeError: Block decorations may not
 * be specified via plugins`), which aborts EditorView construction — so a note
 * with frontmatter would open blank. The table widget provides its block decos
 * the same way (a StateField), and this is the difference between the two.
 *
 * The map-don't-rebuild rule is preserved: our own write-back maps the existing
 * set through the change so the nested editor keeps its caret; a genuine change
 * (edit from the root, toggle, external reload) recomputes from scratch.
 */
const frontmatterDecoField = StateField.define<DecorationSet>({
  create: (state) => frontmatterDecorations(state),
  update(deco, tr) {
    const ownEdit = tr.annotation(frontmatterEdit)
    const toggled = tr.effects.some((e) => e.is(toggleFrontmatter))
    const commitSet = tr.effects.some((e) => e.is(setFrontmatterCommit))
    // Our own write-back: map, do not rebuild, so the nested editor lives.
    if (ownEdit && !toggled) return deco.map(tr.changes)
    // A commit arriving (async, from EditorPane) refreshes the collapsed summary.
    if (tr.docChanged || toggled || commitSet) return frontmatterDecorations(tr.state)
    return deco
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    // Atomic: the caret cannot land inside the replaced region; it is edited
    // only through the nested editor. The guard the table widget relies on too.
    EditorView.atomicRanges.of((view) => view.state.field(f, false) ?? Decoration.none),
  ],
})

const frontmatterTheme = EditorView.baseTheme({
  // The space under it is air between the note's metadata and the note, and it
  // is the same open or closed so toggling moves nothing but the block itself.
  // PADDING, not margin: CodeMirror measures a block widget by its border box,
  // so a bottom margin is height it does not know about, and every line below
  // then sits that much lower than CodeMirror thinks. At 2.5rem a click on the
  // first heading landed on the line under it.
  //
  // Middle-aligned over the text, in every layout: one width open or closed,
  // so opening it never makes it wider, centred in the column by auto side
  // margins (horizontal margins are harmless to CodeMirror; only vertical ones
  // escape its measure). The collapsed summary centres in that width and the
  // fields fill it. A column narrower than the width keeps the text's inset.
  '.cm-fm': {
    width: 'min(24rem, 100% - 2 * var(--editor-inset))',
    margin: '0 auto',
    paddingBottom: '2.5rem',
    textAlign: 'center',
  },
  /**
   * Opening and closing (`playResize`). An ANIMATION rather than a transition,
   * because the element is new on each toggle and has no "before" to transition
   * from; `--fm-from` is that before. `interpolate-size` is what lets it end at
   * `auto`, the block's own height, which nothing here has to measure, the same
   * device the heading slide uses for width. The fields fade in on the way, so
   * they do not appear at full strength inside a block still opening.
   */
  '.cm-fm-resizing': { interpolateSize: 'allow-keywords', overflow: 'clip' },
  '.cm-fm-opening': {
    animation: 'cm-fm-resize var(--motion-arrive, 300ms) var(--ease-settle, ease-out)',
  },
  '.cm-fm-closing': {
    animation: 'cm-fm-resize var(--motion-leave, 190ms) var(--ease-settle, ease-out)',
  },
  '.cm-fm-opening .cm-fm-reveal': {
    animation: 'cm-fm-fields-in var(--motion-arrive, 300ms) var(--ease-settle, ease-out)',
  },
  '@keyframes cm-fm-resize': { from: { height: 'var(--fm-from)' } },
  '@keyframes cm-fm-fields-in': { from: { opacity: '0' } },
  // Collapsed: a chevron mark + a muted one-line summary, inline.
  '.cm-fm-pill': {
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: '0.35rem',
    padding: '0.05rem 0.15rem',
    fontSize: '0.8rem',
    lineHeight: '1.2',
    color: '#6b6b6b',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
  },
  // The summary line (`summaryLine`): never wrapped. The text gives way with an
  // ellipsis in a narrow pane and the author's name stays whole beside it.
  '.cm-fm-line': {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'baseline',
    gap: '0.3em',
    minWidth: '0',
    whiteSpace: 'nowrap',
  },
  '.cm-fm-line > .cm-fm-pill, .cm-fm-line > .cm-fm-bare': { minWidth: '0', overflow: 'hidden' },
  '.cm-fm-summary': {
    color: 'inherit',
    minWidth: '0',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  '.cm-fm-author': {
    flexShrink: '0',
    fontSize: '0.8rem',
    lineHeight: '1.2',
    color: '#6b6b6b',
    textDecoration: 'none',
    cursor: 'pointer',
  },
  '.cm-fm-author:hover': { color: '#a3a3a3', textDecoration: 'underline' },
  // The bar a file with no frontmatter gets (#17). The pill's type and colour
  // without the pill: there is nothing to press, so it is not a button.
  '.cm-fm-bare': {
    display: 'flex',
    padding: '0.05rem 0.15rem',
    fontSize: '0.8rem',
    lineHeight: '1.2',
    color: '#6b6b6b',
  },
  // Expanded: one borderless unit — the chevron sits to the left of the YAML,
  // no title, no box. The chevron aligns to the first line.
  '.cm-fm-reveal': {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0.4rem',
    textAlign: 'start',
  },
  '.cm-fm-chevron': {
    padding: '0',
    paddingTop: '0.05rem',
    fontSize: '0.8rem',
    lineHeight: '1.4',
    color: '#6b6b6b',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
  },
  '.cm-fm-pill:hover, .cm-fm-chevron:hover': { color: '#a3a3a3' },
  '.cm-fm-body': { flex: '1', minWidth: '0' },
  // See `caretInBlock`: a caret whose head is inside the replaced region would
  // render as tall as the whole block.
  '&.cm-fm-caret-hidden .cm-cursor': { display: 'none' },
  // Invalid YAML reddens the chevron mark — the only status cue, and it wins on
  // hover (an explicit colour on the mark overrides the inherited hover colour).
  '.cm-fm-mark.cm-fm-invalid, .cm-fm-chevron.cm-fm-invalid': { color: '#f87171' },
})

/** Where the editable body starts — just past the frontmatter block, or 0 when
 *  there is none. EditorPane seeds the initial caret here so it never opens to
 *  the left of the widget. */
export function bodyStart(doc: string): number {
  return frontmatterRegion(doc)?.to ?? 0
}

/**
 * The block is edited only through the nested editor — never from the root. Two
 * guards make that true, because the atomic-range facet alone leaves the
 * top-of-document boundary reachable (caret to the left of the widget) and lets
 * a Backspace at the edge delete the whole block as an atomic unit:
 *
 *  - a **change filter** drops any *user* edit that touches the region. It keys
 *    on `userEvent`, so programmatic reloads/merges (no userEvent) and our own
 *    write-back (`frontmatterEdit`) pass untouched — the load-bearing
 *    external-reload machinery is not affected.
 *  - a **transaction filter** pushes any root caret that lands at or before the
 *    block down to just after it. There is nothing to edit above the frontmatter.
 */
const protectFrontmatter = EditorState.changeFilter.of((tr) => {
  const region = frontmatterRegion(tr.startState.doc.toString())
  if (region === null) return true
  if (tr.annotation(frontmatterEdit) || tr.annotation(Transaction.userEvent) === undefined)
    return true
  return [region.from, region.to]
})

const caretBelowFrontmatter = EditorState.transactionFilter.of((tr) => {
  const region = frontmatterRegion(tr.newDoc.toString())
  if (region === null) return tr
  const sel = tr.newSelection
  // Only nudge a bare caret that lands at or before the block; a real selection
  // (select-all, a drag) is left alone so those still work — the block just
  // cannot be edited, via the change filter.
  if (!(sel.ranges.length === 1 && sel.main.empty && sel.main.from < region.to)) return tr
  // `assoc: 1` — bind the caret to the character AFTER it. `region.to` is the
  // seam between the widget's last line and the first body line, and a caret
  // that associates backwards there renders on the widget's side of it.
  return [tr, { selection: EditorSelection.cursor(region.to, 1) }]
})

/**
 * No caret against the block.
 *
 * `caretBelowFrontmatter` keeps a bare cursor out, and deliberately lets a
 * *range* through so select-all and a drag still take the frontmatter with
 * them. That leaves one case: a range whose head is inside the block. The block
 * is a single element as tall as all its rows, so `drawSelection` draws the
 * caret from those coordinates and you get a 230px bar blinking against its
 * edge, which reads as a broken text cursor rather than as the end of a
 * selection.
 *
 * So the caret is hidden while its head is in there. It is not a workaround for
 * the geometry: the region is atomic and cannot be typed into, so a caret
 * claiming an insertion point inside it was never telling the truth. The
 * selection itself is untouched — the highlight still covers the block, and
 * copy still takes it.
 */
const caretInBlock = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      this.sync(view)
    }
    update(u: ViewUpdate): void {
      if (u.selectionSet || u.docChanged) this.sync(u.view)
    }
    sync(view: EditorView): void {
      const block = frontmatterBlockRange(view.state.doc.toString())
      const main = view.state.selection.main
      view.dom.classList.toggle(
        'cm-fm-caret-hidden',
        block !== null && !main.empty && main.head <= block.to,
      )
    }
  },
)

/** The whole frontmatter feature, one extension. Register AFTER livePreview so
 *  the block-replace owns the region's rendering. */
export const frontmatterExtension: Extension = [
  frontmatterExpandedField,
  frontmatterCommitField,
  frontmatterDecoField,
  frontmatterTheme,
  protectFrontmatter,
  caretBelowFrontmatter,
  caretInBlock,
]
