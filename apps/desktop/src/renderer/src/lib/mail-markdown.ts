/**
 * Markdown → HTML for outgoing mail (D71).
 *
 * The composer's source of truth is markdown, and this is the only thing that
 * turns it into the bytes a recipient sees. That matters more than it sounds:
 * the preview pane renders *this* output, and the `text/html` part of the sent
 * message is *this* output, so the preview is the artifact rather than a
 * likeness of it. There is no second renderer to drift against.
 *
 * **Inline HTML is escaped, not passed through.** That is an authoring
 * decision, not a security one — `sanitizeMailHtml` still runs downstream and
 * still has to handle the quoted parent, which is third-party text. Escaping
 * here buys: a `text/plain` part that reads as prose because it is the markdown
 * the user wrote; `value < 5` surviving being typed; and a paste from a web
 * page that cannot smuggle markup into a message the user believes they wrote
 * by hand.
 */
import { Marked } from 'marked'

/**
 * `&` first, or the entities produced by the later replacements get escaped a
 * second time and the recipient reads `&lt;div&gt;` as literal text.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * An instance, not the module-level `marked`.
 *
 * `marked.use()` mutates a global shared by every importer in the bundle, so a
 * second feature configuring it differently would silently change what this
 * app sends. An instance makes `renderMailMarkdown` a pure function of its
 * argument, which is what the preview/artifact identity above depends on.
 */
const renderer = new Marked({
  gfm: true,
  // Off deliberately. A single newline is not a `<br>` in GFM, and mail written
  // in an editor with soft wrapping would sprout one at every wrap point the
  // author never typed.
  breaks: false,
  renderer: {
    /**
     * marked 18 routes **both** block HTML (`Tokens.HTML`) and inline HTML
     * (`Tokens.Tag`) through this one hook. Older majors had two, and the
     * migration hazard runs the other way: code written against the two-hook
     * API overrides one of them and lets `<div>` on its own line slip through.
     */
    html({ text }) {
      return escapeHtml(text)
    },
  },
})

/** Render the composer's markdown to the HTML that will be sent. Pure. */
export function renderMailMarkdown(markdown: string): string {
  return renderer.parse(markdown, { async: false })
}
