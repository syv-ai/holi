/**
 * `turndown-plugin-gfm` ships no typings and has no `@types` package. Only
 * what the composer needs is declared: `gfm` bundles tables, strikethrough,
 * task lists and fenced code.
 */
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown'

  export const gfm: TurndownService.Plugin
  export const tables: TurndownService.Plugin
  export const strikethrough: TurndownService.Plugin
  export const taskListItems: TurndownService.Plugin
  export const highlightedCodeBlock: TurndownService.Plugin
}
