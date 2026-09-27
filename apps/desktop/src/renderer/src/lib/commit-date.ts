/**
 * A commit's date as the frontmatter header and facts line show it.
 */

/** ISO date → `DD/MM/YY`. Empty string when it can't be parsed. */
export function formatCommitDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${pad(d.getFullYear() % 100)}`
}
