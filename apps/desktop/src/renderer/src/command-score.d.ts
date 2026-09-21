/**
 * `command-score` ships no types. It is the scorer cmdk bundles, used directly
 * so the palette's ranking is one pure function that a node test and the
 * screen share (D102). `0` means no match; higher is better.
 */
declare module 'command-score' {
  export default function commandScore(
    string: string,
    abbreviation: string,
    aliases?: readonly string[],
  ): number
}
