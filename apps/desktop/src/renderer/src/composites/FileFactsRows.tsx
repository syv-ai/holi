/**
 * Read-only facts about a file under its frontmatter rows: when it was created
 * and by whom, and how it is linked. Last updated, version and size are in the
 * header and not repeated.
 *
 * The rows are drawn from the first frame with empty values and fill in when
 * main answers, so the block does not jump under the pointer.
 */
import { useFileFacts, type CommitFact } from '@/state/file-facts'
import { formatCommitDate } from '@/editor/frontmatter'
import { FIELD_READONLY, FieldRow } from './FieldRow'

/** `DD/MM/YY, name`, the name linking to the GitHub profile the same way the
 *  collapsed summary's does (the git author name used as the username). */
function Stamp({ commit }: { commit: CommitFact }): React.JSX.Element {
  const url = `https://github.com/${encodeURIComponent(commit.author)}`
  return (
    <span className={FIELD_READONLY}>
      {formatCommitDate(commit.date)},{' '}
      <a
        href={url}
        className="motion-respond hover:text-foreground hover:underline"
        onClick={(e) => {
          e.preventDefault()
          void window.holi.openExternal(url)
        }}
      >
        {commit.author}
      </a>
    </span>
  )
}

export function FileFactsRows({ path }: { path: string }): React.JSX.Element {
  const facts = useFileFacts(path)
  const history = facts?.history ?? null
  const links = facts?.links ?? null
  return (
    <div className="mt-3 flex flex-col" data-fm-facts="">
      <FieldRow label="created">{history !== null && <Stamp commit={history.first} />}</FieldRow>
      <FieldRow label="links">
        <span className={FIELD_READONLY}>
          {links === null ? '' : `${links.in} in · ${links.out} out`}
        </span>
      </FieldRow>
    </div>
  )
}
