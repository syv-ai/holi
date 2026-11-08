/**
 * The EPUB reader's themes (docs/features/reader.md): a page colour and a text
 * colour the reader picks, the app's own colours, or the book as published.
 * The choice is this machine's, kept in local storage, and one toolbar button
 * steps through them in this order.
 */
import { atomWithStorage } from 'jotai/utils'

const READING_THEMES = ['light', 'sepia', 'dark', 'app', 'book'] as const
export type ReadingTheme = (typeof READING_THEMES)[number]

export const READING_THEME_LABELS: Record<ReadingTheme, string> = {
  light: 'Light',
  sepia: 'Sepia',
  dark: 'Dark',
  app: 'App',
  book: 'Book default',
}

export const readingThemeAtom = atomWithStorage<ReadingTheme>('holi.reader.epubTheme', 'app')

/** The theme after `theme`, round again after the last. */
export function nextReadingTheme(theme: ReadingTheme): ReadingTheme {
  return READING_THEMES[(READING_THEMES.indexOf(theme) + 1) % READING_THEMES.length]!
}

/** A reading theme's paper, ink and link colours: a book's page, not the app's
 *  chrome, so these are fixed colours rather than theme tokens. */
const PAPERS = {
  light: { scheme: 'light', paper: '#ffffff', ink: '#1c1c1c', link: '#1a5fb4' },
  sepia: { scheme: 'light', paper: '#f4ecd8', ink: '#5b4636', link: '#8a4b08' },
  dark: { scheme: 'dark', paper: '#1c1c1e', ink: '#e4e4e4', link: '#8ab4f8' },
} as const

/** The app's colours as the app resolves them now, for `app`. */
export interface AppColours {
  mode: string
  foreground: string
  primary: string
}

/**
 * The stylesheet foliate puts into every chapter for `theme`.
 *
 * - A reading theme sets the page and forces the text colour, so a book that
 *   prints its text black stays readable on a dark page. The page colour is on
 *   `html`, which foliate also lays behind the page's margins.
 * - `app` gives the app's text colours and leaves the page to the app; the
 *   book's own CSS may still set its colours.
 * - `book` only lays a white page under the book, at no specificity
 *   (`:where`), so whatever the book sets wins.
 */
export function readingThemeCss(theme: ReadingTheme, app: AppColours): string {
  if (theme === 'book')
    return ':where(html) { color-scheme: light; background: #ffffff; color: #000000; }'
  if (theme === 'app')
    return `html { color-scheme: ${app.mode}; color: ${app.foreground}; background: transparent; }
a:any-link { color: ${app.primary}; }`
  const { scheme, paper, ink, link } = PAPERS[theme]
  return `html { color-scheme: ${scheme}; background: ${paper} !important; color: ${ink} !important; }
body { background: transparent !important; }
body *:not(a) { color: inherit !important; }
a:any-link, a:any-link * { color: ${link} !important; }`
}
