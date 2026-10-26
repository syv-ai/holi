/** The Soul section of a Holi's settings: `SOUL.md`. */
import { useEffect, useRef, useState } from 'react'
import { holiCap } from './holis-cap'
import { failed, type HoliSummary } from './state'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useFiles } from './use-holi-files'
import { Loading, ReadError } from './holi-settings-parts'

export function Soul({ holi, onError }: { holi: HoliSummary; onError: (m: string) => void }) {
  const { files, error, retry, remote } = useFiles(holi)
  const [text, setText] = useState<string | null>(null)
  const [conflict, setConflict] = useState<{ text: string; hash: string } | null>(null)
  const opened = useRef<string | null>(null)
  // A fresh read replaces the text only while nothing is typed over it.
  useEffect(() => {
    if (files === null) return
    if (text === null || text === files.soul) {
      setText(files.soul)
      opened.current = files.soulHash
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files])

  if (!holi.folder) {
    return (
      <p className="text-sm text-muted-foreground">
        {holi.name} is an older single-file Holi: its soul is the `instructions` in {holi.path}.
        Edit it there.
      </p>
    )
  }
  if (error) return <ReadError retry={retry} />
  if (files === null || text === null) return <Loading />

  const save = (body: string, expected: string) => {
    if (remote === null) return
    void holiCap.save(remote, { holi: holi.id, file: 'soul', text: body, expected }).then(
      (res) => {
        if (res.ok) {
          opened.current = res.hash
          setConflict(null)
        } else setConflict({ text: res.text, hash: res.hash })
      },
      (err: unknown) => onError(failed(err).message),
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Who it is, and what it should always keep in mind. A run reads it first; changing it asks
        for approval again on each machine.
      </p>
      {conflict !== null && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
          <span className="min-w-0 flex-1 text-muted-foreground">
            It changed while you were editing.
          </span>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setText(conflict.text)
              opened.current = conflict.hash
              setConflict(null)
            }}
          >
            Use theirs
          </Button>
          <Button size="xs" variant="secondary" onClick={() => save(text, conflict.hash)}>
            Keep mine
          </Button>
        </div>
      )}
      <Textarea
        aria-label="Soul"
        className="min-h-72 flex-1 font-mono text-sm"
        placeholder="Who it is, and what it should always keep in mind"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (opened.current !== null && text !== files.soul && conflict === null) {
            save(text, opened.current)
          }
        }}
      />
    </div>
  )
}
