/**
 * The history: the chats that were archived, out of the stack of bubbles and
 * kept here. Each can be read, brought back (un-archived) or deleted for good,
 * so the page is also how the vault's old conversations are tidied away:
 * find one by name, delete it, or delete the lot.
 *
 * A running session is never in it: archiving stops one first.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { ArchiveRestore, ArrowLeft, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button, Dialog, Icon, IconButton, Input } from '@/primitives'
import { AgentFace } from './AgentFace'
import { ago } from './BubbleStack'
import {
  archiveSessionAtom,
  openSessionAtom,
  removeSessionAtom,
} from '../../agent/renderer/state/send'
import {
  agentArchiveListAtom,
  agentViewAtom,
  type StackEntry,
} from '../../agent/renderer/state/sessions'

/** How a finished chat ended, and when it began. */
function line(entry: StackEntry, now: number): string {
  const how =
    entry.kind === 'past'
      ? entry.session.phase === 'failed'
        ? 'Ended badly'
        : 'Finished'
      : 'Running'
  return entry.startedAt === 0 ? how : `${how} · started ${ago(entry.startedAt, now)}`
}

export function AgentHistory(): React.JSX.Element {
  const archived = useAtomValue(agentArchiveListAtom)
  const setView = useSetAtom(agentViewAtom)
  const openSession = useSetAtom(openSessionAtom)
  const archive = useSetAtom(archiveSessionAtom)
  const remove = useSetAtom(removeSessionAtom)
  const [query, setQuery] = useState('')
  /** What is about to be deleted: one chat, or every finished one listed. */
  const [deleting, setDeleting] = useState<StackEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const now = Date.now()

  const shown = archived.filter((e) => e.name.toLowerCase().includes(query.trim().toLowerCase()))
  // A running one cannot be deleted: it is stopped first.
  const deletable = shown.filter((e) => e.kind === 'past')

  const confirmDelete = async (): Promise<void> => {
    const targets = deleting ?? []
    setDeleting(null)
    setError(null)
    for (const entry of targets) {
      const res = await remove(entry.id)
      if (!res.ok) return setError(res.message)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-agent-history="">
      <header className="flex shrink-0 items-center gap-2 px-4 py-3">
        <IconButton
          icon={ArrowLeft}
          label="Back to the chat"
          size="sm"
          onClick={() => setView('chat')}
        />
        <h2 className="text-sm font-medium text-foreground">History</h2>
        <span className="text-xs text-muted-foreground">{archived.length} archived</span>
        {deletable.length > 0 && (
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto text-destructive"
            onClick={() => setDeleting(deletable)}
          >
            {query.trim() === '' ? 'Delete all' : `Delete ${deletable.length} shown`}
          </Button>
        )}
      </header>

      {archived.length > 0 && (
        <div className="shrink-0 px-4 pb-2">
          <Input
            aria-label="Search the history"
            placeholder="Search archived chats"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      )}
      {error !== null && <p className="px-4 pb-2 text-xs text-destructive">{error}</p>}

      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {archived.length === 0 && (
          <li className="px-4 py-12 text-center text-sm text-muted-foreground">
            Nothing is archived. Archive a chat from its bubble&apos;s menu to tidy it away here.
          </li>
        )}
        {archived.length > 0 && shown.length === 0 && (
          <li className="px-4 py-12 text-center text-sm text-muted-foreground">
            No archived chat matches.
          </li>
        )}
        {shown.map((entry) => (
          <li
            key={entry.id}
            data-history-row={entry.id}
            className="group/row flex items-center gap-3 rounded-2xl px-3 py-2 hover:bg-accent"
          >
            <AgentFace size="md" seed={entry.id} state="off" muted />
            <Button
              variant="ghost"
              size="sm"
              className="h-auto min-w-0 flex-1 flex-col items-start gap-0.5 p-0 text-left font-normal hover:bg-transparent dark:hover:bg-transparent"
              onClick={() => void openSession(entry.id)}
            >
              <span className="w-full truncate text-sm text-foreground">{entry.name}</span>
              <span className="w-full truncate text-xs text-muted-foreground">
                {line(entry, now)}
              </span>
            </Button>
            <IconButton
              icon={ArchiveRestore}
              label={`Bring back ${entry.name}`}
              size="sm"
              onClick={() => void archive({ id: entry.id, archived: false })}
            />
            {entry.kind === 'past' && (
              <IconButton
                icon={Trash2}
                label={`Delete ${entry.name}`}
                size="sm"
                onClick={() => setDeleting([entry])}
              />
            )}
          </li>
        ))}
      </ul>

      {deleting !== null && (
        <Dialog open onClose={() => setDeleting(null)} size="sm">
          <div className="grid min-w-0 gap-4 [&>*]:min-w-0">
            <Dialog.Header>
              {deleting.length === 1
                ? `Delete ${deleting[0]!.name}?`
                : `Delete ${deleting.length} chats?`}
            </Dialog.Header>
            <Dialog.Body>
              <p className="text-xs text-muted-foreground">
                {deleting.length === 1 ? 'Its' : 'Their'} conversation is removed from Claude Code
                for good. What {deleting.length === 1 ? 'it has' : 'they have'} already written in
                the vault stays.
              </p>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="ghost" size="sm" onClick={() => setDeleting(null)}>
                Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={() => void confirmDelete()}>
                <Icon icon={Trash2} />
                Delete
              </Button>
            </Dialog.Footer>
          </div>
        </Dialog>
      )}
    </div>
  )
}
