/**
 * Markdown → HTML for outgoing mail.
 *
 * The only renderer: the preview and the sent `text/html` part are both this
 * output, so the preview is the artifact, with no second renderer to drift.
 *
 * Inline HTML is escaped: an authoring decision, not security
 * (`sanitizeMailHtml` still runs downstream). It keeps `value < 5` intact and
 * stops a web paste smuggling markup into a hand-written message.
 */
import { Marked } from 'marked'

/** `&` first, or later entities get escaped twice. */
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
 * `marked.use()` mutates a global shared across the bundle, so another feature
 * could silently change what is sent.
 */
const renderer = new Marked({
  gfm: true,
  // Off: a soft-wrapped line would otherwise sprout a `<br>` at every wrap.
  breaks: false,
  renderer: {
    /** marked 18 routes both block and inline HTML through this one hook. */
    html({ text }) {
      return escapeHtml(text)
    },
  },
})

/** Render the composer's markdown to the HTML that will be sent. Pure. */
export function renderMailMarkdown(markdown: string): string {
  return renderer.parse(markdown, { async: false })
}
