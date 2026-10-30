/** Vite's `?raw` imports: the hook scripts ship as real .mjs files (linted,
 * runnable, testable) and are inlined into the seed table at build time. */
declare module '*?raw' {
  const content: string
  export default content
}

/** Vite's `?inline` imports: a binary asset as a base64 data URL. */
declare module '*?inline' {
  const dataUrl: string
  export default dataUrl
}
