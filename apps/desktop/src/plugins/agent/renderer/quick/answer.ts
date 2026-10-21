/**
 * A quick agent's answer, its last message, as the panel shows it
 * (docs/features/quick-agent.md): Claude's markdown, rendered.
 *
 * What the agent writes can carry what it read, so the HTML is built to be
 * inert: inline HTML is escaped, an image is its alt text (a panel fetches
 * nothing), and DOMPurify takes out what is left, a `javascript:` link
 * among it. A link opens in the browser (`QuickPanel`'s click), never here.
 */
import DOMPurify from 'dompurify'
import { Marked } from 'marked'
import { escapeHtml } from '@holi/shared'

/** An instance: `marked.use()` would change the module's global for every
 *  other feature. */
const renderer = new Marked({
  gfm: true,
  // Off: a soft-wrapped line would otherwise sprout a `<br>` at every wrap.
  breaks: false,
  renderer: {
    /** marked 18 routes both block and inline HTML through this one hook. */
    html({ text }) {
      return escapeHtml(text)
    },
    image({ text }) {
      return escapeHtml(text)
    },
  },
})

const FORBID_TAGS = ['img', 'style', 'form', 'input', 'button', 'textarea', 'select', 'iframe']
const FORBID_ATTR = ['style', 'target', 'ping', 'srcset']

/** The answer as HTML, safe to put in the panel. Pure. */
export function renderAnswer(markdown: string): string {
  return DOMPurify.sanitize(renderer.parse(markdown, { async: false }), {
    FORBID_TAGS,
    FORBID_ATTR,
  })
}
