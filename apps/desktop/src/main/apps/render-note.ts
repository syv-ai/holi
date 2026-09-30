/**
 * A note as HTML, for a vault app's `<holi-note>` and `holi docs render`.
 *
 * **Inline HTML is escaped.** The result is put into the app's frame, which
 * holds the app's bridge, so markup in a note (a teammate's, or one a
 * prompt-injected agent wrote) must not be able to run there as the app.
 *
 * A wiki-link becomes `<a href="#" data-holi-open="target">`, which the
 * element opens in Holi with `holi.open`, as the editor's chips do. Images and
 * embeds read as their text: images inside a rendered note are not supported.
 */
import { Marked, type TokenizerAndRendererExtension } from 'marked'
import {
  escapeHtml,
  parseWikiLinks,
  splitFrontmatter,
  wikiLinkDisplay,
  type WikiLinkMatch,
} from '@holi/shared'

interface WikiToken {
  type: 'wikiLink'
  raw: string
  embed: boolean
  link: WikiLinkMatch
}

/** An inline extension rather than a pass over the text, so a `[[x]]` inside a
 *  code span or block stays code. */
const wikiLink: TokenizerAndRendererExtension = {
  name: 'wikiLink',
  level: 'inline',
  start: (src) => src.match(/!?\[\[/)?.index,
  tokenizer(src): WikiToken | undefined {
    const m = /^(!?)(\[\[[^\]\n]+\]\])/.exec(src)
    const link = m === null ? undefined : parseWikiLinks(m[2]!)[0]
    if (m === null || link === undefined) return undefined
    return { type: 'wikiLink', raw: m[0], embed: m[1] === '!', link }
  },
  renderer(token) {
    const { embed, link } = token as unknown as WikiToken
    const text = escapeHtml(wikiLinkDisplay(link))
    if (embed) return text
    return `<a href="#" data-holi-open="${escapeHtml(link.target)}">${text}</a>`
  },
}

/** An instance, not the module-level `marked`: `marked.use()` mutates a global. */
const renderer = new Marked({
  gfm: true,
  // Off: a soft-wrapped line would otherwise sprout a `<br>` at every wrap.
  breaks: false,
  extensions: [wikiLink],
  renderer: {
    /** marked routes both block and inline HTML through this one hook. */
    html({ text }) {
      return escapeHtml(text)
    },
    image({ text }) {
      return escapeHtml(text)
    },
    /** Web and mail links only: a `javascript:` link clicked in the frame would
     *  run as the app, the same escalation escaped HTML closes. */
    link({ href, tokens }) {
      const text = this.parser.parseInline(tokens)
      if (!/^(https?:|mailto:)/i.test(href)) return text
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${text}</a>`
    },
  },
})

export function renderNote(markdown: string): string {
  let body = markdown
  try {
    body = splitFrontmatter(markdown).body
  } catch {
    // An unterminated fence: render the text as it stands.
  }
  return renderer.parse(body, { async: false })
}
