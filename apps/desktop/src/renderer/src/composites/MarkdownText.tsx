/**
 * Markdown shown read-only as formatted text: a release's notes in Settings
 * (docs/features/updates.md), the vault's README on Home
 * (docs/features/nav-menu.md).
 *
 * The text may be someone else's, so it never becomes HTML: `marked`'s lexer
 * reads it into tokens and each token becomes a React element, whose text React
 * escapes. Raw HTML is shown as the text it is. A link is clickable only when
 * it is `http:` or `https:`, and it opens in the browser; any other link is
 * shown as its words. Sizes and colours are inherited from the caller.
 */
import { Lexer, type Token, type Tokens } from 'marked'
import { useMemo, type ReactNode } from 'react'
import { Button, Tooltip } from '@/primitives'

/** A link target the browser may be handed: http(s) and nothing else. */
export function openableUrl(href: string): string | null {
  try {
    const url = new URL(href)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/** Text as tokens. A fresh lexer with its own options, so nothing configured
 *  on the module-level `marked` elsewhere in the bundle changes them. */
function lex(body: string): Token[] {
  return new Lexer({ gfm: true, breaks: false }).lex(body)
}

function Inline({ tokens }: { tokens: readonly Token[] | undefined }): ReactNode {
  return (tokens ?? []).map((token, i) => <InlineToken key={i} token={token} />)
}

function InlineToken({ token }: { token: Token }): ReactNode {
  switch (token.type) {
    case 'strong':
      return (
        <strong className="font-medium text-foreground">
          <Inline tokens={(token as Tokens.Strong).tokens} />
        </strong>
      )
    case 'em':
      return (
        <em>
          <Inline tokens={(token as Tokens.Em).tokens} />
        </em>
      )
    case 'del':
      return (
        <del>
          <Inline tokens={(token as Tokens.Del).tokens} />
        </del>
      )
    case 'codespan':
      return <code className="font-mono">{(token as Tokens.Codespan).text}</code>
    case 'br':
      return <br />
    case 'link': {
      const link = token as Tokens.Link
      const url = openableUrl(link.href)
      if (url === null) return <Inline tokens={link.tokens} />
      return (
        <Tooltip content={url}>
          <Button
            variant="link"
            onClick={() => void window.holi.openExternal(url)}
            className="inline h-auto p-0 align-baseline text-[length:inherit] font-normal whitespace-normal break-words text-foreground"
          >
            <Inline tokens={link.tokens} />
          </Button>
        </Tooltip>
      )
    }
    case 'image':
      return (token as Tokens.Image).text
    case 'text': {
      const text = token as Tokens.Text
      return text.tokens !== undefined ? <Inline tokens={text.tokens} /> : text.text
    }
    case 'escape':
    case 'html':
      return (token as Tokens.Escape | Tokens.HTML).text
    default:
      return 'text' in token && typeof token.text === 'string' ? token.text : null
  }
}

function Block({ token }: { token: Token }): ReactNode {
  switch (token.type) {
    case 'heading':
      return (
        <p className="pt-1 font-medium text-foreground">
          <Inline tokens={(token as Tokens.Heading).tokens} />
        </p>
      )
    case 'paragraph':
      return (
        <p className="break-words">
          <Inline tokens={(token as Tokens.Paragraph).tokens} />
        </p>
      )
    case 'list': {
      const list = token as Tokens.List
      const items = list.items.map((item, i) => (
        <li key={i} className="break-words">
          {item.tokens.map((child, j) => (
            <ListChild key={j} token={child} />
          ))}
        </li>
      ))
      return list.ordered ? (
        <ol start={list.start === '' ? undefined : list.start} className="list-decimal pl-4">
          {items}
        </ol>
      ) : (
        <ul className="list-disc pl-4">{items}</ul>
      )
    }
    case 'blockquote':
      return (
        <div className="pl-3">
          <Blocks tokens={(token as Tokens.Blockquote).tokens} />
        </div>
      )
    case 'code':
      return (
        <pre className="overflow-x-auto font-mono whitespace-pre">
          {(token as Tokens.Code).text}
        </pre>
      )
    case 'table': {
      // A table's rows as lines: neither Settings nor Home has room for columns.
      const table = token as Tokens.Table
      return [table.header, ...table.rows].map((row, i) => (
        <p key={i} className="break-words">
          {row.map((cell, j) => (
            <span key={j}>
              {j > 0 && ' · '}
              <Inline tokens={cell.tokens} />
            </span>
          ))}
        </p>
      ))
    }
    case 'space':
    case 'hr':
    case 'def':
      return null
    case 'html':
      return <p className="break-words">{(token as Tokens.HTML).text}</p>
    default:
      return <InlineToken token={token} />
  }
}

/** A list item's children: its loose text inline, its nested blocks as blocks. */
function ListChild({ token }: { token: Token }): ReactNode {
  if (token.type === 'text') return <InlineToken token={token} />
  return <Block token={token} />
}

function Blocks({ tokens }: { tokens: readonly Token[] }): ReactNode {
  return tokens.map((token, i) => <Block key={i} token={token} />)
}

/** Markdown as formatted text: headings, lists, emphasis, code and links. The
 *  wrapper's look is the caller's `className`. */
export function MarkdownText({
  body,
  className,
}: {
  body: string
  className?: string
}): React.JSX.Element {
  const tokens = useMemo(() => lex(body), [body])
  return (
    <div className={className}>
      <Blocks tokens={tokens} />
    </div>
  )
}
