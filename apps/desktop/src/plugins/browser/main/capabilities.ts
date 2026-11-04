/**
 * The browser's capabilities (docs/features/browser.md): `holi browser` for
 * the agent and the same calls for the tab's own controls, so the agent and
 * the person drive one set of pages.
 *
 * Every verb but `open` and `tabs` takes `--tab`; left out, it is the tab
 * last used (`Pages.current`), so an agent working one page never names it.
 * What a page says reaches the agent fenced as untrusted (`fenceUntrusted`):
 * a web page is someone else's words, never instructions.
 *
 * No `electron` import: this loads under plain Node in the tests.
 */
import { fenceUntrusted } from '@holi/shared'
import {
  cap,
  CapabilityError,
  flagParam,
  optionalStringParam,
  paramsObject,
  stringParam,
  writeScreenshot,
} from '../../../main/plugin-api'
import { isPageUrl, SCROLL_TO, type PageInfo, type PageRead, type ScrollTo } from '../shared/page'

export const BROWSER_NAMESPACES = ['browser'] as const

/** Where a still or a page is drawn in Holi's window, in its CSS pixels. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** The pages themselves: Electron's in the app (`pages.ts`), a fake in the
 *  tests. Each takes a tab id that `tab` has already checked. */
export interface Pages {
  list(): PageInfo[]
  /** The tab a verb without `--tab` means, or null with none open. */
  current(): string | null
  has(id: string): boolean
  /** A new tab, showing `url` once it has loaded (or failed to), or blank.
   *  `id` reopens a tab Holi had before it restarted. */
  open(options: { url?: string; id?: string; reveal: boolean }): Promise<PageInfo>
  navigate(id: string, url: string): Promise<PageInfo>
  back(id: string): Promise<PageInfo>
  forward(id: string): Promise<PageInfo>
  reload(id: string): Promise<PageInfo>
  stop(id: string): PageInfo
  close(id: string): void
  read(id: string): Promise<PageRead>
  click(id: string, ref: number): Promise<PageInfo>
  type(id: string, ref: number, text: string, submit: boolean): Promise<PageInfo>
  press(id: string, key: string): Promise<PageInfo>
  scroll(id: string, to: ScrollTo): Promise<PageInfo & { atEnd: boolean }>
  screenshot(id: string): Promise<Uint8Array>
  /** The page as a `data:` image, for the tab to show while something of
   *  Holi's is drawn over it; null when it has not drawn. */
  still(id: string): Promise<string | null>
}

const NO_TAB = 'open one first: holi browser open <url>, or holi browser tabs to see what is open'

/** The tab a call means: `tab`, else the one last used. */
function tab(pages: Pages, id: string | undefined): string {
  if (id !== undefined) {
    if (!pages.has(id)) throw new CapabilityError('NOT_FOUND', `no browser tab ${id}`, NO_TAB)
    return id
  }
  const current = pages.current()
  if (current === null) throw new CapabilityError('NOT_FOUND', 'no browser tab is open', NO_TAB)
  return current
}

function pageUrl(raw: Record<string, unknown>): string {
  const url = stringParam(raw, 'url').trim()
  if (!isPageUrl(url)) {
    throw new CapabilityError('BAD_REQUEST', `not a web address: ${url}`, 'give an http(s) address')
  }
  return url
}

function refParam(raw: Record<string, unknown>): number {
  const value = raw['ref']
  const n = typeof value === 'string' ? Number(value.replace(/^\[|\]$/g, '')) : value
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    throw new CapabilityError('BAD_REQUEST', 'ref must be a control number from holi browser read')
  }
  return n
}

/** `--tab`, the one param every verb that acts on a page takes. */
const tabParams = (raw: unknown): { tab?: string } => {
  const id = optionalStringParam(paramsObject(raw), 'tab')
  return id === undefined ? {} : { tab: id }
}

/** One line about where a tab is now: what every verb that acts answers. */
function pageLine(page: PageInfo): string {
  const where = page.url === '' ? 'blank' : page.url
  const state = page.loading ? ' (still loading)' : ''
  const failed = page.error === null ? '' : `\nfailed to load: ${page.error.description}`
  return `[${page.id}] ${page.title || '(no title)'} — ${where}${state}${failed}`
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** A page's own words, fenced: the title and the text. */
const fencePage = <P extends { title: string; url: string }>(page: P, from = hostOf(page.url)) => ({
  ...page,
  title: fenceUntrusted(page.title, 'web', from === '' ? {} : { from }),
})

export function browserCapabilities(pages: Pages) {
  const at = (id: string | undefined): string => tab(pages, id)
  return {
    'browser.tabs': cap({
      doors: ['ui', 'cli'],
      cli: { args: [], summary: 'the open browser tabs, the one in use first' },
      params: () => ({}),
      run: async () => {
        const current = pages.current()
        const list = pages.list()
        return [...list.filter((p) => p.id === current), ...list.filter((p) => p.id !== current)]
      },
      cliValue: (list) => list.map((p) => fencePage(p)),
      text: (list) =>
        list.length === 0 ? 'no browser tabs are open' : list.map(pageLine).join('\n'),
    }),

    /**
     * A new tab, shown in Holi so the person sees what the agent does, with
     * `url` loaded. Answers once it has loaded or failed to; a slow page
     * answers while still loading, and the agent reads it when it is ready.
     */
    'browser.open': cap({
      doors: ['ui', 'cli'],
      cli: {
        args: ['url?'],
        summary: 'open a web page in a new Holi tab (or --tab <id> to go there in that tab)',
      },
      params: (raw) => {
        const p = paramsObject(raw)
        const url = p['url'] === undefined || p['url'] === '' ? undefined : pageUrl(p)
        const id = optionalStringParam(p, 'tab')
        // The tab's own controls open the tab themselves (`shown`), and
        // reopen one Holi had before a restart by its id.
        const reopen = optionalStringParam(p, 'reopen')
        const out: { url?: string; tab?: string; reopen?: string; shown?: boolean } = {}
        if (url !== undefined) out.url = url
        if (id !== undefined) out.tab = id
        if (reopen !== undefined) out.reopen = reopen
        if (p['shown'] === true) out.shown = true
        return out
      },
      run: async (_ctx, { url, tab: id, reopen, shown }) => {
        if (id !== undefined) {
          if (!pages.has(id)) throw new CapabilityError('NOT_FOUND', `no browser tab ${id}`, NO_TAB)
          return url === undefined
            ? pages.list().find((p) => p.id === id)!
            : pages.navigate(id, url)
        }
        // The agent's tab is revealed: the person sees what it does.
        return pages.open({
          ...(url === undefined ? {} : { url }),
          ...(reopen === undefined ? {} : { id: reopen }),
          reveal: shown !== true,
        })
      },
      cliValue: (page) => fencePage(page),
      text: pageLine,
    }),

    'browser.back': cap({
      doors: ['ui', 'cli'],
      cli: { args: [], summary: 'go back a page' },
      params: tabParams,
      run: async (_ctx, p) => pages.back(at(p.tab)),
      cliValue: (page) => fencePage(page),
      text: pageLine,
    }),

    'browser.forward': cap({
      doors: ['ui', 'cli'],
      cli: { args: [], summary: 'go forward a page' },
      params: tabParams,
      run: async (_ctx, p) => pages.forward(at(p.tab)),
      cliValue: (page) => fencePage(page),
      text: pageLine,
    }),

    'browser.reload': cap({
      doors: ['ui', 'cli'],
      cli: { args: [], summary: 'load the page again' },
      params: tabParams,
      run: async (_ctx, p) => pages.reload(at(p.tab)),
      cliValue: (page) => fencePage(page),
      text: pageLine,
    }),

    'browser.stop': cap({
      doors: ['ui'],
      params: tabParams,
      run: async (_ctx, p) => pages.stop(at(p.tab)),
    }),

    'browser.close': cap({
      doors: ['ui', 'cli'],
      cli: { args: [], summary: 'close a browser tab' },
      params: tabParams,
      run: async (_ctx, p) => {
        const id = at(p.tab)
        pages.close(id)
        return { closed: id }
      },
      text: ({ closed }) => `closed ${closed}`,
    }),

    /**
     * The page as text, each control numbered for click and type. The
     * numbers hold until the next read or until the page changes: read
     * again after anything that moves it.
     */
    'browser.read': cap({
      doors: ['cli'],
      cli: {
        args: [],
        summary: 'the page as text, its links, buttons and fields numbered for click and type',
      },
      params: tabParams,
      run: async (_ctx, p) => pages.read(at(p.tab)),
      cliValue: (page) => {
        const from = hostOf(page.url)
        return {
          ...fencePage(page, from),
          text: fenceUntrusted(page.text, 'web', from === '' ? {} : { from }),
        }
      },
      text: (page) =>
        [
          `[${page.id}] ${page.title} — ${page.url}`,
          '',
          page.text === '' ? '(the page shows no text)' : page.text,
          ...(page.truncated
            ? ['', '(cut here: holi browser scroll, then read again, for the rest)']
            : []),
        ].join('\n'),
    }),

    'browser.click': cap({
      doors: ['cli'],
      cli: { args: ['ref'], summary: 'click control <ref> from the last read' },
      params: (raw) => {
        const p = paramsObject(raw)
        return { ...tabParams(p), ref: refParam(p) }
      },
      run: async (_ctx, p) => pages.click(at(p.tab), p.ref),
      cliValue: (page) => fencePage(page),
      text: pageLine,
    }),

    /** Type into a field, replacing what it held: a select picks the option
     *  with that text. `--submit` presses Enter after. */
    'browser.type': cap({
      doors: ['cli'],
      cli: {
        args: ['ref', 'text'],
        flags: ['submit'],
        summary: 'type text into field <ref>, replacing it (--submit presses Enter after)',
      },
      params: (raw) => {
        const p = paramsObject(raw)
        const text = p['text']
        if (typeof text !== 'string') throw new CapabilityError('BAD_REQUEST', 'text is required')
        return { ...tabParams(p), ref: refParam(p), text, submit: flagParam(p, 'submit') }
      },
      run: async (_ctx, p) => pages.type(at(p.tab), p.ref, p.text, p.submit),
      cliValue: (page) => fencePage(page),
      text: pageLine,
    }),

    'browser.press': cap({
      doors: ['cli'],
      cli: { args: ['key'], summary: 'press a key: Enter, Escape, Tab, ArrowDown, Backspace…' },
      params: (raw) => {
        const p = paramsObject(raw)
        return { ...tabParams(p), key: stringParam(p, 'key') }
      },
      run: async (_ctx, p) => pages.press(at(p.tab), p.key),
      cliValue: (page) => fencePage(page),
      text: pageLine,
    }),

    'browser.scroll': cap({
      doors: ['cli'],
      cli: { args: ['to?'], summary: 'scroll the page: down (the default), up, top or bottom' },
      params: (raw) => {
        const p = paramsObject(raw)
        const to = optionalStringParam(p, 'to') ?? 'down'
        if (!SCROLL_TO.includes(to as ScrollTo)) {
          throw new CapabilityError('BAD_REQUEST', `to is one of ${SCROLL_TO.join(', ')}`)
        }
        return { ...tabParams(p), to: to as ScrollTo }
      },
      run: async (_ctx, p) => pages.scroll(at(p.tab), p.to),
      cliValue: (page) => fencePage(page),
      text: (page) => `${pageLine(page)}${page.atEnd ? '\n(at the end of the page)' : ''}`,
    }),

    /** A PNG of the page as it is drawn, for what text does not say: a
     *  chart, a layout. Prints its path, an owner-only temp file. */
    'browser.screenshot': cap({
      doors: ['cli'],
      cli: { args: [], summary: "a PNG of the page; prints the PNG's path" },
      params: tabParams,
      run: async (_ctx, p) => ({ png: await writeScreenshot(await pages.screenshot(at(p.tab))) }),
      text: ({ png }) => png,
    }),

    /** What the tab shows while a menu or dialog of Holi's is over it. */
    'browser.still': cap({
      doors: ['ui'],
      params: (raw) => ({ tab: stringParam(paramsObject(raw), 'tab') }),
      run: async (_ctx, { tab: id }) => (pages.has(id) ? pages.still(id) : null),
    }),
  }
}
