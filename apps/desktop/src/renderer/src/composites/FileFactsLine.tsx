/**
 * Read-only facts about a file, as one line over its frontmatter rows:
 * "In <folder> · created DD/MM/YY, <author> · N links". Last updated, version
 * and size are in the header and not repeated.
 *
 * The folder is derived, never written: for a task it is also its lane, and
 * changing it is a move, which rewrites inbound links and so belongs to the
 * file tree.
 *
 * The line keeps its height from the first frame but stays invisible until
 * main answers, then fades in whole, so it neither jumps nor grows piece by
 * piece.
 */
import { useFileFacts } from '@/state/file-facts'
import { formatCommitDate } from '@/lib/commit-date'
import { cn } from '@/lib/cn'
import { Tooltip } from '@/primitives'

export function FileFactsLine({ path }: { path: string }): React.JSX.Element {
  const facts = useFileFacts(path)
  // `lastIndexOf` is -1 at the vault root, and `slice(0, -1)` would then be the
  // path minus its last character.
  const slash = path.lastIndexOf('/')
  const folder = slash === -1 ? '' : path.slice(0, slash)
  const created = facts?.history?.first ?? null
  const links = facts?.links ?? null
  const url = created ? `https://github.com/${encodeURIComponent(created.author)}` : ''

  const parts: React.ReactNode[] = []
  if (folder !== '') parts.push(<span key="folder">In {folder}</span>)
  if (created !== null)
    parts.push(
      <span key="created">
        created {formatCommitDate(created.date)},{' '}
        {/* The git author name used as the GitHub username, as in the header. */}
        <a
          href={url}
          className="motion-respond hover:text-foreground hover:underline"
          onClick={(e) => {
            e.preventDefault()
            void window.holi.openExternal(url)
          }}
        >
          {created.author}
        </a>
      </span>,
    )
  if (links !== null) {
    const n = links.in + links.out
    parts.push(
      <Tooltip key="links" content={`${links.in} in · ${links.out} out`}>
        <span>
          {n} link{n === 1 ? '' : 's'}
        </span>
      </Tooltip>,
    )
  }

  return (
    <div
      data-fm-facts=""
      className={cn(
        'truncate px-1 pb-2 text-center text-xs text-muted-foreground',
        facts === null ? 'invisible' : 'motion-in-fade',
      )}
    >
      {/* A space until the answer, so the line holds its height. */}
      {parts.length === 0
        ? ' '
        : parts.flatMap((part, i) => (i === 0 ? [part] : [<span key={`dot${i}`}> · </span>, part]))}
    </div>
  )
}
