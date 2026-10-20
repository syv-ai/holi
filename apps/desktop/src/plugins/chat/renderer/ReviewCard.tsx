/**
 * What a session's last turn changed, under its reply: the files and their
 * lines, and Keep or Revert for the whole turn. Keep takes it out of Ready for
 * review; Revert writes each file back to how it was before the turn, as new
 * commits, the same write the turn review makes per hunk
 * (docs/features/agent-sessions.md, Turn review).
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { FileText, GitCompare } from 'lucide-react'
import { useState } from 'react'
import { Button, Icon } from '@/primitives'
import { appModeAtom, openPathAtom } from '@/plugin-api'
import { churnAtom, keepTurnAtom, revertTurnAtom } from './state/review'
import { Churn } from './parts'

export function ReviewCard({ chatId }: { chatId: string }): React.JSX.Element | null {
  const churn = useAtomValue(churnAtom)[chatId]
  const keep = useSetAtom(keepTurnAtom)
  const revert = useSetAtom(revertTurnAtom)
  const openPath = useSetAtom(openPathAtom)
  const setMode = useSetAtom(appModeAtom)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (churn === undefined || churn.files.length === 0) return null

  const act = (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    void fn()
      .then((res) => {
        if (res !== null && typeof res === 'object' && 'ok' in res && res.ok === false) {
          setError(String((res as unknown as { message: string }).message))
        }
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }

  const count = churn.files.length
  return (
    <div
      className="flex flex-col rounded-xl bg-foreground/[0.02] ring-1 ring-foreground/[0.07] ring-inset"
      data-review-card={chatId}
    >
      <div className="flex items-center gap-2 border-b border-divider px-3 py-2.5 text-sm">
        <Icon icon={GitCompare} size="sm" tone={undefined} className="text-muted-foreground" />
        <span>
          {count} {count === 1 ? 'file' : 'files'} changed
        </span>
        <Churn added={churn.added} removed={churn.removed} />
        <span className="flex-1" />
        <Button
          size="xs"
          variant="secondary"
          disabled={busy}
          onClick={() => act(() => revert(chatId))}
        >
          Revert
        </Button>
        <Button size="xs" disabled={busy} onClick={() => act(() => keep(chatId))}>
          Keep
        </Button>
      </div>
      <div className="flex flex-col py-1">
        {churn.files.map((f) => (
          <Button
            key={f.path}
            variant="ghost"
            className="h-auto w-full justify-start gap-2 rounded-none px-3 py-1.5 text-sm font-normal text-foreground/85"
            onClick={() => {
              setMode('documents')
              void openPath(f.path)
            }}
          >
            <Icon icon={FileText} size="sm" className="text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-start">{f.path}</span>
            <span className="text-xs">
              <Churn added={f.added} removed={f.removed} />
            </span>
          </Button>
        ))}
      </div>
      {error !== null && <p className="px-3 pb-2 text-xs text-destructive">{error}</p>}
    </div>
  )
}
