/**
 * An agent's reply, as markdown drawn with React elements: `marked`'s lexer
 * reads it into tokens and each token becomes an element, so no HTML string
 * is ever put into the page. After MonoCode's `AgentMarkdown` (MIT, Copyright
 * (c) 2026 Nick; see NOTICE.md), which also draws its own tree.
 *
 * Raw HTML in a reply is shown as the text it is, never parsed. Links open
 * in the browser through the window guard, which sends any navigation out of
 * the app there. An image (`![alt](src)`) is drawn when it is the vault's own
 * file (a vault-relative path, through the `holi-vault://` asset route
 * documents use) or an `https:` URL (the page's policy leaves remote images
 * to the renderer); anything else is its alt text as a link or as text.
 */
import { Lexer, type Token, type Tokens } from 'marked'
import { Fragment, memo, type ReactNode } from 'react'
import { cn, vaultAssetUrl } from '@/plugin-api'

/** Where an image in a reply may load from: the vault's own files and
 *  https, nothing else (no `file:`, no `data:`, no paths out of the vault). */
export function imageSource(href: string): string | null {
  const h = href.trim()
  if (/^https:\/\//i.test(h)) return h
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('/') || h.startsWith('~')) return null
  let path: string
  try {
    path = decodeURI(h.replace(/^\.\//, ''))
  } catch {
    return null
  }
  const parts = path.split('/')
  if (path === '' || parts.some((p) => p === '..' || p === '')) return null
  return vaultAssetUrl(path)
}

function inline(tokens: readonly Token[] | undefined, key = ''): ReactNode {
  if (tokens === undefined) return null
  return tokens.map((t, i) => (
    <Fragment key={`${key}${i}`}>{inlineToken(t, `${key}${i}.`)}</Fragment>
  ))
}

function inlineToken(t: Token, key: string): ReactNode {
  switch (t.type) {
    case 'text': {
      const text = t as Tokens.Text
      return text.tokens !== undefined ? inline(text.tokens, key) : text.text
    }
    case 'escape':
      return (t as Tokens.Escape).text
    case 'strong':
      return (
        <strong className="font-semibold text-foreground">
          {inline((t as Tokens.Strong).tokens, key)}
        </strong>
      )
    case 'em':
      return <em>{inline((t as Tokens.Em).tokens, key)}</em>
    case 'del':
      return <del>{inline((t as Tokens.Del).tokens, key)}</del>
    case 'codespan':
      return (
        <code className="rounded-md bg-muted px-1.5 py-px font-mono text-xs text-foreground">
          {(t as Tokens.Codespan).text}
        </code>
      )
    case 'br':
      return <br />
    case 'link': {
      const link = t as Tokens.Link
      const safe = /^(https?:|mailto:)/i.test(link.href)
      return safe ? (
        <a
          href={link.href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground underline decoration-foreground/30 underline-offset-4 transition-colors hover:decoration-foreground"
        >
          {inline(link.tokens, key)}
        </a>
      ) : (
        inline(link.tokens, key)
      )
    }
    case 'image': {
      const image = t as Tokens.Image
      const src = imageSource(image.href)
      if (src === null) {
        return /^https?:/i.test(image.href) ? (
          <a
            href={image.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground underline decoration-foreground/30 underline-offset-4 transition-colors hover:decoration-foreground"
          >
            {image.text || image.href}
          </a>
        ) : (
          image.text
        )
      }
      return (
        <img
          src={src}
          alt={image.text}
          loading="lazy"
          className="my-1 inline-block max-h-96 max-w-full rounded-md align-top"
        />
      )
    }
    case 'html':
      return (t as Tokens.HTML).text
    default:
      return 'raw' in t ? String(t.raw) : null
  }
}

function block(t: Token, key: string): ReactNode {
  switch (t.type) {
    case 'paragraph':
      return <p key={key}>{inline((t as Tokens.Paragraph).tokens, key)}</p>
    case 'heading': {
      const h = t as Tokens.Heading
      return (
        <p
          key={key}
          className={cn(
            'font-semibold tracking-tight text-foreground',
            h.depth <= 2 && 'text-base',
          )}
        >
          {inline(h.tokens, key)}
        </p>
      )
    }
    case 'list': {
      const list = t as Tokens.List
      const Tag = list.ordered ? 'ol' : 'ul'
      return (
        <Tag
          key={key}
          className={cn('flex flex-col gap-1.5 pl-5', list.ordered ? 'list-decimal' : 'list-disc')}
        >
          {list.items.map((item, i) => (
            <li key={i}>
              {item.tokens.map((c, j) =>
                c.type === 'text'
                  ? inlineToken(c, `${key}.${i}.${j}`)
                  : block(c, `${key}.${i}.${j}`),
              )}
            </li>
          ))}
        </Tag>
      )
    }
    case 'code':
      return (
        <pre
          key={key}
          className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed text-foreground"
        >
          <code>{(t as Tokens.Code).text}</code>
        </pre>
      )
    case 'blockquote':
      return (
        <blockquote key={key} className="border-l-2 border-border pl-3 text-muted-foreground">
          {(t as Tokens.Blockquote).tokens.map((c, i) => block(c, `${key}.${i}`))}
        </blockquote>
      )
    case 'hr':
      return <hr key={key} className="border-border" />
    case 'table': {
      // A table the agent wrote in its reply, drawn as prose: not a data
      // region, so not the data grid.
      const table = t as Tokens.Table
      return (
        <div key={key} className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                {table.header.map((cell, i) => (
                  <th key={i} className="py-1.5 pr-3 font-medium">
                    {inline(cell.tokens, `${key}.h${i}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, r) => (
                <tr key={r} className="border-b border-border">
                  {row.map((cell, c) => (
                    <td key={c} className="py-1.5 pr-3">
                      {inline(cell.tokens, `${key}.${r}.${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
    case 'space':
      return null
    case 'html':
      return <p key={key}>{(t as Tokens.HTML).text}</p>
    default:
      return 'raw' in t ? <p key={key}>{String(t.raw)}</p> : null
  }
}

export const Markdown = memo(function Markdown({
  text,
  className,
}: {
  text: string
  className?: string
}): React.JSX.Element {
  let tokens: Token[]
  try {
    tokens = new Lexer({ gfm: true, breaks: false }).lex(text)
  } catch {
    return <p className={className}>{text}</p>
  }
  return (
    <div
      className={cn(
        'flex flex-col gap-2.5 text-sm leading-relaxed text-pretty text-foreground/90',
        className,
      )}
    >
      {tokens.map((t, i) => block(t, String(i)))}
    </div>
  )
})
