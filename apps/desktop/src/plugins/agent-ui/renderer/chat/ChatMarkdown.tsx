/**
 * An assistant message as prose. The markdown is Claude's, so the HTML it
 * becomes is sanitised before it reaches the page. Only an http(s) or mailto
 * link leads anywhere (it opens in the browser, never in the app's own
 * window); every other link is inert text, and a picture is not fetched at
 * all, since the address of one can carry what the conversation knows.
 *
 * The text is split into blocks with marked's lexer and each block's HTML is
 * kept by its raw text, so a message that grows re-parses, re-sanitises and
 * re-draws only the block that changed. A code block gets a Copy button, and
 * a wide code block or table scrolls inside itself.
 */
import DOMPurify from 'dompurify'
import { Marked, type Token, type Tokens, type TokensList } from 'marked'
import { memo, useMemo } from 'react'
import { cn } from '@/plugin-api'
import './chat.css'

/** An instance, not the module-level `marked`, whose options are global to
 *  the bundle. */
const markdown = new Marked({ gfm: true, breaks: false })

/** A link that may open outside the app. */
export function isSafeHref(href: string): boolean {
  return /^(?:https?:\/\/|mailto:)/i.test(href.trim())
}

/** What markdown can say, and a little of the raw HTML it lets through. An
 *  allowlist, not a denylist: anything that could fetch a resource (a picture,
 *  `<svg>`, media, a stylesheet, a form) is not in it, since the address of
 *  one can carry what the conversation knows. */
const ALLOWED_TAGS = [
  'a',
  'p',
  'br',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'code',
  'em',
  'strong',
  'b',
  'i',
  'u',
  's',
  'del',
  'ins',
  'mark',
  'small',
  'sub',
  'sup',
  'kbd',
  'span',
  'div',
  'details',
  'summary',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'input',
]
const ALLOWED_ATTR = [
  'href',
  'start',
  'type',
  'checked',
  'disabled',
  'align',
  'colspan',
  'rowspan',
  'open',
  'class',
]

/** What the page's own styles and scripts key on is not the model's to write:
 *  a class is kept only as a code block's language, an input only as the
 *  checkbox of a task list. */
function dropUnsafe(node: Element): void {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href')
    if (href !== null && !isSafeHref(href)) node.removeAttribute('href')
    // Whatever it was, it opens nothing the browser could be handed.
    node.removeAttribute('target')
  }
  const klass = node.getAttribute('class')
  if (klass !== null && !(node.tagName === 'CODE' && /^language-[\w-]+$/.test(klass))) {
    node.removeAttribute('class')
  }
  if (node.tagName === 'INPUT' && node.getAttribute('type') !== 'checkbox') node.remove()
  // `type` means something to a list and a checkbox only.
  if (node.tagName !== 'INPUT' && node.tagName !== 'OL' && node.tagName !== 'UL') {
    node.removeAttribute('type')
  }
}

function sanitise(html: string): string {
  DOMPurify.addHook('afterSanitizeAttributes', dropUnsafe)
  try {
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
    })
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes', dropUnsafe)
  }
}

/** Code and tables get a holder: the code a Copy button, both a scroll of
 *  their own. Applied to sanitised HTML, whose tags are balanced and
 *  lower-case, so a plain replacement is exact; the code inside a `pre` has
 *  its angle brackets escaped, so no `</pre>` can be part of it. */
function dress(html: string): string {
  return html
    .replace(
      /<pre(\s[^>]*)?>/g,
      (open) =>
        `<div class="agent-chat-code" data-code-block><button type="button" class="agent-chat-copy" data-copy-code aria-label="Copy code">Copy</button>${open}`,
    )
    .replace(/<\/pre>/g, '</pre></div>')
    .replace(/<table(\s[^>]*)?>/g, (open) => `<div class="agent-chat-table">${open}`)
    .replace(/<\/table>/g, '</table></div>')
}

export function renderChatMarkdown(text: string): string {
  return dress(sanitise(markdown.parse(text, { async: false })))
}

const CACHE_MAX = 600
/** A block's HTML by its raw text. Oldest out first. */
const blocks = new Map<string, string>()

function blockHtml(token: Token, links: TokensList['links']): string {
  const hit = blocks.get(token.raw)
  if (hit !== undefined) return hit
  const html = dress(sanitise(markdown.parser(Object.assign([token], { links }) as TokensList)))
  blocks.set(token.raw, html)
  if (blocks.size > CACHE_MAX) blocks.delete(blocks.keys().next().value as string)
  return html
}

/** The message as blocks of HTML, in order. A message with link definitions
 *  (`[a]: https://…`) is one block: a definition above changes the HTML of a
 *  block below. */
export function chatMarkdownBlocks(text: string): string[] {
  const tokens = markdown.lexer(text)
  if (Object.keys(tokens.links).length > 0) return [renderChatMarkdown(text)]
  const out: string[] = []
  for (const token of tokens) {
    if (token.type === 'space') continue
    const html = blockHtml(token as Tokens.Generic, tokens.links)
    if (html !== '') out.push(html)
  }
  return out
}

const Block = memo(function Block({ html }: { html: string }): React.JSX.Element {
  return <div className="agent-chat-block" dangerouslySetInnerHTML={{ __html: html }} />
})

const COPIED_MS = 1500

function copyCode(button: HTMLElement): void {
  const code = button.closest('[data-code-block]')?.querySelector('pre')?.textContent ?? ''
  void navigator.clipboard
    .writeText(code)
    .then(() => {
      button.textContent = 'Copied'
      setTimeout(() => {
        if (button.isConnected) button.textContent = 'Copy'
      }, COPIED_MS)
    })
    .catch(() => {})
}

export function ChatMarkdown({
  text,
  compact = false,
}: {
  text: string
  /** Smaller, for a row inside a sub-agent's card. */
  compact?: boolean
}): React.JSX.Element {
  const parts = useMemo(() => chatMarkdownBlocks(text), [text])
  return (
    <div
      className={cn('agent-chat-md', compact && 'agent-chat-md-compact')}
      onClick={(event) => {
        const target = event.target instanceof Element ? event.target : null
        const copy = target?.closest<HTMLElement>('[data-copy-code]')
        if (copy) {
          event.preventDefault()
          copyCode(copy)
          return
        }
        const link = target?.closest('a') ?? null
        if (link === null) return
        // The app's own window never navigates; only a safe address is handed
        // to the browser.
        event.preventDefault()
        const href = link.getAttribute('href') ?? ''
        if (isSafeHref(href)) void window.holi.openExternal(href)
      }}
    >
      {parts.map((html, i) => (
        <Block key={i} html={html} />
      ))}
    </div>
  )
}
