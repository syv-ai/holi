/**
 * Frontmatter as one in-editor widget (docs/features/frontmatter.md).
 *
 * Modelled on the table widget (`codemirror-markdown-tables`): an atomic
 * block-`replace` decoration over the region, hosting fields or a nested
 * `EditorView`, whose edits are dispatched back to the root with a marker
 * annotation so the decoration maps rather than rebuilds (and loses the nested
 * caret). The nested editor is plain YAML, so `⌘B` cannot corrupt a key.
 *
 * The root frontmatter text is never edited directly. The write-back rebuilds
 * the `---` fences every time, so broken YAML never dissolves the block: it
 * reddens the chevron and, via `frontmatterValid`, holds off the save.
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
import { ChevronDown, ChevronRight, createElement } from 'lucide'
import {
  closeFrontmatterPortal,
  openFrontmatterPortal,
  updateFrontmatterPortal,
} from './frontmatter-portals'
import { linkNavFacet } from './links'
import { notePathFacet } from './livePreview'
import { codeHighlighting } from './theme'
import { formatCommitDate } from '@/lib/commit-date'
import { prefersReducedMotion } from '@/lib/motion'

/** Flip the reveal state. The pill and the header chevron both dispatch this. */
export const toggleFrontmatter = StateEffect.define<boolean>()

/**
 * The block's height when its chevron was pressed, for the next build to
 * animate from. A toggle replaces the widget (`eq` differs on `expanded`), so
 * there is no element for a transition to run on. Keyed by view so two panes
 * cannot hand each other a height.
 */
const toggledFrom = new WeakMap<EditorView, number>()

/**
 * The summary as one line: `lead` (the collapse button, or the bare bar) with
 * the text, the author as a GitHub profile link, then the version.
 *
 * The git author name is assumed to be the GitHub username. The link sits
 * beside the button, not in it: a link inside a button is invalid HTML and
 * would toggle the block too.
 */
function summaryLine(
  view: EditorView,
  lead: HTMLElement,
  chars: number,
  commit: FrontmatterCommit | null | undefined,
): HTMLElement {
  const { text, author, version } = frontmatterSummaryParts(chars, commit ?? null)
  const summary = document.createElement('span')
  summary.className = 'cm-fm-summary'
  summary.textContent = author === null ? text : `${text},`
  lead.appendChild(summary)

  const line = document.createElement('div')
  // Held invisible, its height kept, until the commit is known: drawn early it
  // shows a count alone and then grows the date, name and version.
  line.className = commit === undefined ? 'cm-fm-line cm-fm-pending' : 'cm-fm-line'
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
    const tail = document.createElement('span')
    tail.className = 'cm-fm-version'
    tail.append('· ', versionLink(view, version ?? ''))
    line.appendChild(tail)
  }
  return line
}

/**
 * The `v.N` after the name, as a link that opens the history sidebar. Plain
 * text in an editor with no `openHistory`.
 */
function versionLink(view: EditorView, version: string): HTMLElement | string {
  const openHistory = view.state.facet(linkNavFacet)?.().openHistory
  if (openHistory === undefined) return version
  const link = document.createElement('a')
  link.className = 'cm-fm-history'
  link.href = '#'
  link.textContent = version
  link.onmousedown = (e) => {
    e.preventDefault()
    openHistory()
  }
  link.onclick = (e) => e.preventDefault()
  return link
}

function pressToggle(view: EditorView, wrap: HTMLElement, open: boolean): void {
  toggledFrom.set(view, wrap.getBoundingClientRect().height)
  view.dispatch({ effects: toggleFrontmatter.of(open) })
}

/**
 * Open or close from the height the last block had (D98: leaving uses the
 * faster token).
 *
 * The one place inside a note where height moves. Affordable because it is one
 * block widget at the top, the text under it reflows as ordinary DOM, and
 * CodeMirror is asked to measure once when the block has landed.
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

/** Marks a transaction as the widget's own write-back, so the decorations map
 *  through it rather than remounting the nested editor mid-keystroke (the
 *  table widget's `table.edit` annotation, renamed). */
const frontmatterEdit = Annotation.define<boolean>()

/**
 * Whether a file's frontmatter block has a collapsed state at all. A task's
 * does not: its fields are the point, and the collapsed summary would describe
 * the other half.
 */
export function frontmatterAlwaysOpen(path: string): boolean {
  return isTaskFilePath(path)
}

/**
 * Whether a file opens with its frontmatter revealed. A note's frontmatter is
 * metadata over prose and starts collapsed. Under `.claude/` a skill's `name`
 * and `description` are what the agent matches on, and a task's frontmatter is
 * half of what it is, so both start revealed.
 */
export function frontmatterStartsRevealed(path: string): boolean {
  return path.startsWith('.claude/') || isTaskFilePath(path)
}

/** Revealed or collapsed. The default is per-file, read off `notePathFacet` in
 *  `create`. */
export const frontmatterExpandedField = StateField.define<boolean>({
  create: (state) => frontmatterStartsRevealed(state.facet(notePathFacet)),
  update(value, tr) {
    // Enforced here, not only by hiding the chevron: the rule is about the file.
    if (frontmatterAlwaysOpen(tr.state.facet(notePathFacet))) return true
    for (const e of tr.effects) if (e.is(toggleFrontmatter)) return e.value
    return value
  },
})

/** The file's last commit and commit count, for the summary line. */
export interface FrontmatterCommit {
  /** ISO 8601 (git author date). */
  date: string
  /** Author name (git `%an`). */
  author: string
  /** Commits touching the file, the first included: the `v.N` in the summary. */
  revisions: number
}

/** Set by EditorPane from `fileHistoryAtom`, when the file's history first
 *  answers and whenever it moves: null for a file with no history yet, or
 *  when the fetch failed. */
export const setFrontmatterCommit = StateEffect.define<FrontmatterCommit | null>()

/** The last commit; `undefined` until the fetch has answered, so the summary
 *  can wait for it rather than draw a half line that grows. */
export const frontmatterCommitField = StateField.define<FrontmatterCommit | null | undefined>({
  create: () => undefined,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setFrontmatterCommit)) return e.value
    return value
  },
})

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

/** The summary line in parts, the author separate so the widget can link it.
 *  Author and version are null until the last commit is known. */
export function frontmatterSummaryParts(
  chars: number,
  commit: FrontmatterCommit | null,
): { text: string; author: string | null; version: string | null } {
  const base = `${formatCharCount(chars)} char${chars === 1 ? '' : 's'}`
  const date = commit === null ? '' : formatCommitDate(commit.date)
  if (commit === null || date === '') return { text: base, author: null, version: null }
  return {
    text: `${base} · Last updated ${date}`,
    author: commit.author,
    version: `v.${commit.revisions}`,
  }
}

/** The summary line as one string: "1.8K chars · Last updated DD/MM/YY, Name · v.14". */
export function frontmatterSummary(chars: number, commit: FrontmatterCommit | null): string {
  const { text, author, version } = frontmatterSummaryParts(chars, commit)
  return author === null ? text : `${text}, ${author} · ${version}`
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

/** Count top-level `key:` lines for the chevron's tooltip. Best-effort. */
function keyCount(body: string): number {
  return body.split('\n').filter((l) => /^\S.*:/.test(l)).length
}

/** The chevron is the status indicator: red when the YAML won't parse. Shared
 *  by the initial render and the live refresh so the two cannot disagree. */
function paintChevron(el: HTMLElement, body: string): void {
  const valid = frontmatterYamlValid(regionTextFrom(body))
  el.classList.toggle('cm-fm-invalid', !valid)
  const n = keyCount(body)
  el.title = valid ? `frontmatter · ${n} field${n === 1 ? '' : 's'}` : 'frontmatter — invalid YAML'
}

function commitEq(
  a: FrontmatterCommit | null | undefined,
  b: FrontmatterCommit | null | undefined,
): boolean {
  if (!a || !b) return a === b
  return a.date === b.date && a.author === b.author && a.revisions === b.revisions
}

/**
 * What a drawn block holds while it is on screen, keyed by its DOM.
 *
 * On the DOM, not the widget instance: when a rebuilt widget compares equal or
 * `updateDOM` accepts it, CodeMirror hands the existing DOM to the new instance
 * and drops the old one, stranding any state on it where `destroy` never runs.
 * `destroy(dom)` and `updateDOM(dom)` both receive the element.
 */
interface LiveBlock {
  /**
   * What the region holds now. Our own write-back maps the decoration rather
   * than rebuilding it, so this can differ from what the widget was built
   * with. `updateDOM` compares against this, or the next unrelated edit would
   * look like an external change and tear the block down.
   */
  body: string | null
  nested: EditorView | null
  /** The live portal id while the block is drawing fields, else null. */
  portal: number | null
  /** The header, replaced whole when the summary changes (`updateDOM`). */
  header: HTMLElement | null
  /** The chevron mark, kept so a nested edit can recolour it in place: the
   *  write-back maps rather than rebuilds, so nothing else would refresh it. */
  mark: HTMLElement | null
}

const liveBlocks = new WeakMap<HTMLElement, LiveBlock>()

class FrontmatterWidget extends WidgetType {
  constructor(
    readonly expanded: boolean,
    /** The YAML between the fences, or null when the file has no frontmatter:
     *  then the widget is a bar that only reports. */
    readonly body: string | null,
    readonly chars: number,
    /** Undefined until fetched, null for a file with no history. */
    readonly commit: FrontmatterCommit | null | undefined,
    /** Decides whether this block has a schema. */
    readonly path: string,
  ) {
    super()
  }

  /** Plain value equality. Reuse beyond it is `updateDOM`'s call, which can
   *  see the block. */
  override eq(other: FrontmatterWidget): boolean {
    return (
      other.path === this.path &&
      other.expanded === this.expanded &&
      other.body === this.body &&
      other.chars === this.chars &&
      commitEq(other.commit, this.commit)
    )
  }

  /**
   * Keep the block and repaint only its header when file, state and live body
   * match. The char count changes with every keystroke in the note, and a
   * redraw would tear down the fields or nested editor and drop its caret.
   */
  override updateDOM(dom: HTMLElement, view: EditorView, from: FrontmatterWidget): boolean {
    const live = liveBlocks.get(dom)
    if (live === undefined || live.header === null) return false
    if (from.path !== this.path || from.expanded !== this.expanded || live.body !== this.body)
      return false
    const header = this.header(view, dom, live)
    // The one change a reader should see arrive: the line appearing at all.
    if (from.commit === undefined && this.commit !== undefined && !prefersReducedMotion())
      header.classList.add('cm-fm-arrive')
    live.header.replaceWith(header)
    live.header = header
    return true
  }

  /**
   * The summary line, the same open or closed. A block with a collapsed state
   * leads it with the toggling chevron; a file with no frontmatter, and a
   * task, get the line bare.
   */
  private header(view: EditorView, wrap: HTMLElement, live: LiveBlock): HTMLElement {
    if (this.body === null || frontmatterAlwaysOpen(this.path)) {
      live.mark = null
      const bare = document.createElement('span')
      bare.className = 'cm-fm-bare'
      return summaryLine(view, bare, this.chars, this.commit)
    }
    const pill = document.createElement('button')
    pill.type = 'button'
    pill.className = 'cm-fm-pill'
    pill.setAttribute(this.expanded ? 'data-frontmatter-header' : 'data-frontmatter-pill', '')
    const mark = document.createElement('span')
    mark.className = 'cm-fm-mark'
    mark.setAttribute('data-chevron', this.expanded ? 'open' : 'closed')
    mark.append(
      createElement(this.expanded ? ChevronDown : ChevronRight, {
        class: 'cm-fm-chevron',
        'aria-hidden': 'true',
      }),
    )
    paintChevron(mark, live.body ?? this.body)
    live.mark = mark
    pill.append(mark)
    const open = !this.expanded
    pill.onmousedown = (e) => {
      e.preventDefault()
      pressToggle(view, wrap, open)
    }
    return summaryLine(view, pill, this.chars, this.commit)
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-fm'
    const live: LiveBlock = {
      body: this.body,
      nested: null,
      portal: null,
      header: null,
      mark: null,
    }
    liveBlocks.set(wrap, live)

    live.header = this.header(view, wrap, live)
    wrap.appendChild(live.header)

    if (this.body === null) {
      // No frontmatter: the bar still shows, since its header is about the file.
      // No chevron and nothing here writes a block: `normalize-md` adds
      // frontmatter on the next commit anyway.
      wrap.setAttribute('data-frontmatter', 'none')
      return wrap
    }

    if (!this.expanded) {
      wrap.setAttribute('data-frontmatter', 'collapsed')
      playResize(view, wrap, false)
      return wrap
    }

    wrap.setAttribute('data-frontmatter', 'expanded')
    const body = this.body
    const row = document.createElement('div')
    row.className = 'cm-fm-reveal'
    const host = document.createElement('div')
    host.className = 'cm-fm-body'
    row.appendChild(host)
    wrap.appendChild(row)

    playResize(view, wrap, true)

    // Rows, when this file has a schema and its frontmatter is a mapping.
    // `.claude/` and `AGENTS.md` have no schema (somebody else's contract), and
    // an unparseable document has no rows: both fall back to the YAML editor.
    if (frontmatterSchema(this.path) !== null && readYamlMapping(body) !== null) {
      wrap.setAttribute('data-frontmatter', 'fields')
      const slot = document.createElement('div')
      slot.className = 'cm-fm-fields'
      host.appendChild(slot)
      live.portal = openFrontmatterPortal({
        el: slot,
        path: this.path,
        yaml: body,
        write: (next) => {
          writeBack(view, live, next.replace(/\n$/, ''))
          if (live.mark !== null) paintChevron(live.mark, next)
        },
      })
      return wrap
    }

    // A plain editor over the YAML body: basic editing and history, no markdown
    // stack or formatting keymap. It does get YAML highlighting, so keys and
    // values do not read as one grey block.
    live.nested = new EditorView({
      parent: host,
      doc: body.replace(/\n$/, ''),
      extensions: [
        yaml(),
        codeHighlighting,
        history(),
        drawSelection(),
        EditorView.lineWrapping,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return
          const next = u.state.doc.toString()
          writeBack(view, live, next)
          // Recolour the chevron here: our own write-back maps instead of
          // rebuilding, so the invalid-YAML cue would otherwise stay frozen.
          if (live.mark !== null) paintChevron(live.mark, next)
        }),
        EditorView.theme({
          '&': { backgroundColor: 'transparent' },
          '.cm-content': { padding: 0 },
        }),
      ],
    })
    return wrap
  }

  override destroy(dom: HTMLElement): void {
    const live = liveBlocks.get(dom)
    if (live === undefined) return
    liveBlocks.delete(dom)
    live.nested?.destroy()
    if (live.portal !== null) closeFrontmatterPortal(live.portal)
  }

  override ignoreEvent(): boolean {
    // Events inside the widget are its own; the root must not treat them as input.
    return true
  }
}

/** Push the nested body back to the root over the current region, fences
 *  rebuilt, marked as our own edit so the plugin does not remount the block. */
function writeBack(view: EditorView, live: LiveBlock, body: string): void {
  const region = frontmatterRegion(view.state.doc.toString())
  if (region === null) return
  live.body = body
  if (live.portal !== null) updateFrontmatterPortal(live.portal, body)
  view.dispatch({
    changes: { from: region.from, to: region.to, insert: regionTextFrom(body) },
    annotations: frontmatterEdit.of(true),
  })
}

/**
 * The decoration set, pure over the state so it is unit-testable without a
 * DOM. One atomic block-replace over the region, or a bare bar widget when the
 * document has no frontmatter.
 */
export function frontmatterDecorations(state: EditorState): DecorationSet {
  const doc = state.doc.toString()
  // `frontmatterBlockRange`, not `frontmatterRegion`: the decoration stops at
  // the closing fence's line end, so the first body position stays on the
  // first body line (see the comment there).
  const block = frontmatterBlockRange(doc)
  const expanded = state.field(frontmatterExpandedField, false) ?? false
  // Body-only char count, trimmed. `bodyStart` is 0 when there is no block.
  const chars = doc.slice(bodyStart(doc)).trim().length
  const commit = state.field(frontmatterCommitField, false)
  const path = state.facet(notePathFacet)
  if (block === null) {
    // No frontmatter: insert the bar above the first line. `side: -1` so the
    // caret at position 0 lands in the body, not against the widget.
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
 * The block-replace lives in a StateField, not a ViewPlugin: CodeMirror forbids
 * block decorations from plugins (`RangeError: Block decorations may not be
 * specified via plugins`), which aborts EditorView construction and opens the
 * note blank.
 *
 * Our own write-back maps the set so the nested editor keeps its caret; any
 * other change (root edit, toggle, external reload) recomputes.
 */
const frontmatterDecoField = StateField.define<DecorationSet>({
  create: (state) => frontmatterDecorations(state),
  update(deco, tr) {
    const ownEdit = tr.annotation(frontmatterEdit)
    const toggled = tr.effects.some((e) => e.is(toggleFrontmatter))
    const commitSet = tr.effects.some((e) => e.is(setFrontmatterCommit))
    if (ownEdit && !toggled) return deco.map(tr.changes)
    if (tr.docChanged || toggled || commitSet) return frontmatterDecorations(tr.state)
    return deco
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    // Atomic: the caret cannot land inside the replaced region.
    EditorView.atomicRanges.of((view) => view.state.field(f, false) ?? Decoration.none),
  ],
})

const frontmatterTheme = EditorView.baseTheme({
  // PADDING, not margin, below: CodeMirror measures a block widget by its
  // border box, so a vertical margin is height it does not know about and
  // clicks below land a line off. Horizontal auto margins are harmless.
  //
  // One width open or closed, centred in the column; a narrower column keeps
  // the text's inset.
  '.cm-fm': {
    width: 'min(24rem, 100% - 2 * var(--editor-inset))',
    margin: '0 auto',
    paddingBottom: '2.5rem',
    textAlign: 'center',
  },
  /**
   * Opening and closing (`playResize`). An animation, not a transition: the
   * element is new on each toggle, so `--fm-from` supplies the "before".
   * `interpolate-size` lets it end at `auto` without measuring.
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
  '.cm-fm-pill': {
    display: 'inline-flex',
    alignItems: 'baseline',
    gap: '0.35rem',
    padding: '0.05rem 0.15rem',
    fontSize: '0.8rem',
    lineHeight: '1.2',
    color: 'var(--muted-foreground)',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
  },
  // Never wrapped: in a narrow pane the text truncates and the name stays whole.
  '.cm-fm-line': {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'baseline',
    gap: '0.3em',
    minWidth: '0',
    whiteSpace: 'nowrap',
  },
  '.cm-fm-line > .cm-fm-pill, .cm-fm-line > .cm-fm-bare': { minWidth: '0', overflow: 'hidden' },
  '.cm-fm-pending': { visibility: 'hidden' },
  '.cm-fm-arrive': {
    animation: 'cm-fm-fields-in var(--motion-arrive, 300ms) var(--ease-settle, ease-out)',
  },
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
    color: 'var(--muted-foreground)',
    textDecoration: 'none',
    cursor: 'pointer',
  },
  '.cm-fm-version': {
    flexShrink: '0',
    fontSize: '0.8rem',
    lineHeight: '1.2',
    color: 'var(--muted-foreground)',
  },
  '.cm-fm-history': { color: 'inherit', textDecoration: 'none', cursor: 'pointer' },
  '.cm-fm-author:hover, .cm-fm-history:hover': {
    color: 'var(--foreground)',
    textDecoration: 'underline',
  },
  // The bar for a file with no frontmatter or no collapsed state: not a button.
  '.cm-fm-bare': {
    display: 'flex',
    padding: '0.05rem 0.15rem',
    fontSize: '0.8rem',
    lineHeight: '1.2',
    color: 'var(--muted-foreground)',
  },
  '.cm-fm-reveal': { paddingTop: '0.5rem', textAlign: 'start' },
  '.cm-fm-pill:hover': { color: 'var(--foreground)' },
  // Centred on the text: an svg's own baseline is its bottom edge.
  '.cm-fm-mark': { display: 'inline-flex', alignSelf: 'center' },
  '.cm-fm-chevron': {
    width: 'var(--icon-sm)',
    height: 'var(--icon-sm)',
    strokeWidth: 'var(--icon-stroke)',
  },
  // See `caretInBlock`: a caret whose head is inside the replaced region would
  // render as tall as the whole block.
  '&.cm-fm-caret-hidden .cm-cursor': { display: 'none' },
  // Explicit on the mark, so it wins over the inherited hover colour.
  // `--syntax-invalid`, not `--destructive`: that is a fill, too dark for a
  // glyph on the dark page.
  '.cm-fm-mark.cm-fm-invalid': { color: 'var(--syntax-invalid)' },
})

/** Where the editable body starts: past the frontmatter block, or 0. EditorPane
 *  seeds the initial caret here. */
export function bodyStart(doc: string): number {
  return frontmatterRegion(doc)?.to ?? 0
}

/**
 * The block is edited only through the nested editor. The atomic range alone
 * leaves the caret reachable left of the widget and lets Backspace at the edge
 * delete the whole block, so two guards:
 *
 *  - a change filter drops any user edit touching the region. It keys on
 *    `userEvent`, so programmatic reloads/merges and our own write-back pass.
 *  - a transaction filter pushes a caret at or before the block to just after it.
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
  // Only a bare caret; a real selection (select-all, a drag) is left alone.
  if (!(sel.ranges.length === 1 && sel.main.empty && sel.main.from < region.to)) return tr
  // `assoc: 1`: `region.to` is the seam between widget and body, and a caret
  // associating backwards there renders on the widget's side.
  return [tr, { selection: EditorSelection.cursor(region.to, 1) }]
})

/**
 * No caret against the block. A range whose head is inside the block would get
 * a caret as tall as the whole widget from `drawSelection`. The region cannot
 * be typed into anyway, so the caret is hidden; the selection is untouched.
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
