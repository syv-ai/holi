import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

/** How long the class stays on after a selection move. Longer than the
 *  transition on purpose: the class only *permits* a slide, so being late to
 *  take it off costs nothing. */
const WINDOW_MS = 600

/**
 * The two halves of a heading's `#` sliding (D92) that CSS cannot do alone.
 *
 * **When it may run.** The transition is declared only under
 * `.cm-heading-sliding`, and this adds that class on a selection move and takes
 * it off again shortly after. Without the gate every heading in a file animated
 * its marks shut the moment the file opened: CodeMirror creates the mark span
 * and settles its style in two steps, so the element's first resolved width is
 * `auto` and the rule closing it reads as a change to transition. A newly
 * rendered mark now finds transitions switched off and simply appears closed.
 * `ViewPlugin.update` runs before the DOM is written (`updatePlugins` precedes
 * `docView.update`), which is what makes the class arrive in time to matter.
 *
 * **Where the caret goes.** `drawSelection` draws the caret from coordinates
 * read once per update, so it lands where the text was when the transition
 * started and stays there, short by the width of the marks, until the next edit
 * snaps it across. `view.requestMeasure()` cannot fix that: the caret is a
 * `layer`, and a layer recomputes only when its own measure request is queued —
 * on a transaction or a doc-view update, and there is no API to poke one.
 * Dispatching a transaction per frame would redraw it and would also rebuild
 * every decoration in the viewport fifteen times for one caret move, which is
 * the cost the editor's no-animation rule exists to refuse. So this does the
 * cheap half of that transaction by hand, and only while a slide is in flight.
 */
export const headingSlide = ViewPlugin.fromClass(
  class {
    /** Marks in flight. Leaving one heading for another runs two transitions, and
     *  the first `transitionend` must not stop the pump the second still needs. */
    private running = 0
    private frame = 0
    private timer: ReturnType<typeof setTimeout> | null = null

    constructor(readonly view: EditorView) {
      view.dom.addEventListener('transitionrun', this.onRun)
      view.dom.addEventListener('transitionend', this.onSettle)
      view.dom.addEventListener('transitioncancel', this.onSettle)
    }

    update(update: ViewUpdate): void {
      // A pure scroll must not arm this: `viewportChanged` renders lines, and
      // their marks would animate shut on the way in. Only a caret that moved
      // can open or close one.
      if (!update.selectionSet) return
      this.view.dom.classList.add('cm-heading-sliding')
      if (this.timer !== null) clearTimeout(this.timer)
      this.timer = setTimeout(this.disarm, WINDOW_MS)
    }

    destroy(): void {
      this.view.dom.removeEventListener('transitionrun', this.onRun)
      this.view.dom.removeEventListener('transitionend', this.onSettle)
      this.view.dom.removeEventListener('transitioncancel', this.onSettle)
      if (this.timer !== null) clearTimeout(this.timer)
      this.stop()
    }

    private disarm = (): void => {
      this.timer = null
      this.view.dom.classList.remove('cm-heading-sliding')
    }

    private isSlide(event: TransitionEvent): boolean {
      const target = event.target
      return (
        event.propertyName === 'width' &&
        target instanceof HTMLElement &&
        target.classList.contains('cm-heading-mark')
      )
    }

    private onRun = (event: TransitionEvent): void => {
      if (!this.isSlide(event)) return
      this.running++
      if (this.frame === 0) this.frame = requestAnimationFrame(this.pump)
    }

    private onSettle = (event: TransitionEvent): void => {
      if (!this.isSlide(event)) return
      this.running = Math.max(0, this.running - 1)
      if (this.running === 0) this.stop()
    }

    private pump = (): void => {
      this.frame = 0
      this.follow()
      if (this.running > 0) this.frame = requestAnimationFrame(this.pump)
    }

    /** Put the drawn caret where the text has got to this frame. */
    private follow(): void {
      const caret = this.view.dom.querySelector<HTMLElement>('.cm-cursor-primary')
      if (caret === null) return
      const coords = this.view.coordsAtPos(this.view.state.selection.main.head)
      if (coords === null) return
      // The layer lives in `.cm-scroller` and its markers are placed from that
      // element's own origin, scroll offset included — CodeMirror's `getBase`.
      const box = this.view.scrollDOM.getBoundingClientRect()
      caret.style.left = `${coords.left - box.left + this.view.scrollDOM.scrollLeft}px`
    }

    private stop(): void {
      if (this.frame !== 0) cancelAnimationFrame(this.frame)
      this.frame = 0
      this.running = 0
    }
  },
)
