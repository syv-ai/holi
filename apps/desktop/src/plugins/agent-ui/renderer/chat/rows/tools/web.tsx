/**
 * WebFetch and WebSearch. A fetch is a link, the status it got, and the
 * model's answer as prose; a search is its links (title and domain) and any
 * commentary. A 404 is not an error to Claude Code, so the status is read from
 * the structured result or the text, not only from the call's state.
 */
import { Globe } from 'lucide-react'
import type { ToolItem } from '../../../../../agent/renderer/chat/items'
import type { ToolRenderer } from '../registry'
import {
  argsOf,
  arr,
  bytesLabel,
  countLabel,
  dataOf,
  durationLabel,
  firstStr,
  get,
  hostOf,
  isWebUrl,
  num,
  shortUrl,
  strings,
  textOf,
  unwrap,
} from './coerce'
import { Caption, ErrorPane, Markdown, Stack, WebLink } from './parts'
import { stateOf, verb, type CardView } from './view'

/** The HTTP status a fetch ended with, from the structured result or the text. */
function statusOf(item: ToolItem): number | undefined {
  const code = num(dataOf(item).code)
  if (code !== undefined) return code
  const m = /The server returned HTTP (\d{3})/.exec(textOf(item))
  return m === null ? undefined : Number(m[1])
}

export const webFetchRenderer: ToolRenderer = (item) => {
  const args = argsOf(item)
  const data = dataOf(item)
  const url = firstStr(args, ['url']) ?? firstStr(data, ['url'])
  if (url === undefined) return null
  const state = stateOf(item)
  const status = statusOf(item)
  const prompt = firstStr(args, ['prompt'])
  const answer = firstStr(data, ['result']) ?? unwrap(textOf(item))

  const chips: string[] = []
  if (status !== undefined) chips.push(status >= 400 ? `HTTP ${status}` : String(status))
  if (/^REDIRECT DETECTED/.test(answer)) chips.push('redirected')
  const bytes = num(data.bytes)
  if (bytes !== undefined) chips.push(bytesLabel(bytes))
  const took = num(data.durationMs)
  if (took !== undefined) chips.push(durationLabel(took))

  const view: CardView = {
    label: verb(item, 'Fetching', 'Fetched'),
    icon: Globe,
    summary: shortUrl(url),
    chips,
    body: (
      <Stack>
        <WebLink url={url} className="w-fit max-w-full truncate text-xs">
          {url}
        </WebLink>
        {prompt !== undefined && (
          <Caption>{prompt.length > 300 ? `${prompt.slice(0, 300)}…` : prompt}</Caption>
        )}
        {state === 'error' ? (
          <ErrorPane item={item} />
        ) : (
          state === 'done' && answer !== '' && <Markdown text={answer} lines={40} chars={4000} />
        )}
      </Stack>
    ),
  }
  return view
}

interface Link {
  title: string
  url: string
}

/** The links of a search result: `results[]` mixes `{content: [{title, url}]}`
 *  with plain strings of commentary. */
function linksOf(results: unknown): { links: Link[]; prose: string[] } {
  const links: Link[] = []
  const prose: string[] = []
  for (const entry of arr(results)) {
    if (typeof entry === 'string') {
      if (entry.trim() !== '') prose.push(entry)
      continue
    }
    for (const hit of arr(get(entry, 'content'))) {
      const url = firstStr(hit, ['url'])
      if (url === undefined) continue
      links.push({ url, title: firstStr(hit, ['title']) ?? hostOf(url) })
    }
  }
  return { links, prose }
}

export const webSearchRenderer: ToolRenderer = (item) => {
  const args = argsOf(item)
  const data = dataOf(item)
  const query = firstStr(args, ['query']) ?? firstStr(data, ['query'])
  if (query === undefined) return null
  const state = stateOf(item)
  const { links, prose } = linksOf(data.results)
  const domains = strings(args.allowed_domains)
  const took = num(data.durationSeconds)

  const chips: string[] = []
  if (state === 'done' && links.length > 0) chips.push(countLabel(links.length, 'link'))
  if (domains.length > 0) chips.push(domains.slice(0, 2).join(', '))
  if (took !== undefined) chips.push(durationLabel(took * 1000))

  const text = prose.length > 0 ? prose.join('\n\n') : links.length > 0 ? '' : unwrap(textOf(item))
  const view: CardView = {
    label: verb(item, 'Searching the web', 'Searched the web'),
    icon: Globe,
    summary: query,
    chips,
    body: (
      <Stack>
        {state === 'error' && <ErrorPane item={item} />}
        {state === 'done' && links.length > 0 && (
          <ul className="flex flex-col gap-0.5 text-xs" data-chat-links="">
            {links.slice(0, 10).map((link, i) => (
              <li key={i} className="flex min-w-0 items-baseline gap-2">
                <WebLink url={link.url} className="min-w-0 truncate">
                  {link.title}
                </WebLink>
                {isWebUrl(link.url) && (
                  <span className="shrink-0 text-muted-foreground">{hostOf(link.url)}</span>
                )}
              </li>
            ))}
            {links.length > 10 && (
              <li className="text-muted-foreground">{`${links.length - 10} more`}</li>
            )}
          </ul>
        )}
        {state === 'done' && text !== '' && <Markdown text={text} lines={20} chars={3000} />}
      </Stack>
    ),
  }
  return view
}
