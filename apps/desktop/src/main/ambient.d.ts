/** Vite's `?raw` imports — the hook scripts ship as real .mjs files (linted,
 * runnable, testable) and are inlined into the seed table at build time. */
declare module '*?raw' {
  const content: string
  export default content
}
