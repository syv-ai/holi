/**
 * Find in a meeting's transcript, and replace what the speech model
 * misheard: the search finds lines with the words in any case (or the
 * speaker), and, opened, Replace corrects the first line it is in and
 * Replace all every line (`meeting.segment.replace`). Each changed line is a
 * correction, as one typed into the line is: quoted where it is cited, and
 * told to Hviske.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { Replace, Search } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { activeRemoteAtom } from '@/plugin-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { IconButton } from '@/composites/icon-button'
import { meetingCap } from './meeting-cap'
import { message, putSegmentAtom } from './state'

export function TranscriptFind({
  meetingId,
  query,
  onQuery,
  matches,
  actions,
}: {
  meetingId: string
  query: string
  onQuery: (query: string) => void
  /** How many lines the search finds. */
  matches: number
  /** What sits at the row's end, such as Copy transcript. */
  actions?: React.ReactNode
}): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const put = useSetAtom(putSegmentAtom)
  const [replacing, setReplacing] = useState(false)
  const [replacement, setReplacement] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const find = query.trim()

  const replace = async (all: boolean) => {
    if (remote === null || find === '') return
    setBusy(true)
    setError(null)
    try {
      const changed = await meetingCap['segment.replace'](remote, {
        meetingId,
        find,
        replace: replacement,
        all,
      })
      for (const s of changed) put(meetingId, s)
      toast(
        changed.length === 0
          ? 'Nothing to replace'
          : changed.length === 1
            ? 'Replaced in 1 line'
            : `Replaced in ${changed.length} lines`,
      )
    } catch (e) {
      setError(`Nothing was replaced: ${message(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <InputGroup className="max-w-sm">
          <InputGroupAddon>
            <Search aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search the transcript"
            placeholder="Search the transcript"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
          />
          {find !== '' && (
            <InputGroupAddon align="inline-end">
              <span className="text-xs text-muted-foreground tabular-nums">
                {matches === 1 ? '1 line' : `${matches} lines`}
              </span>
            </InputGroupAddon>
          )}
        </InputGroup>
        <IconButton
          label={replacing ? 'Hide replace' : 'Replace'}
          size="icon-sm"
          aria-pressed={replacing}
          onClick={() => setReplacing(!replacing)}
        >
          <Replace aria-hidden />
        </IconButton>
        {actions}
      </div>
      {replacing && (
        <div className="flex items-center gap-2">
          <Input
            aria-label="Replace with"
            placeholder="Replace with"
            className="max-w-sm"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void replace(false)
              }
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy || find === '' || matches === 0}
            onClick={() => void replace(false)}
          >
            Replace
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || find === '' || matches === 0}
            onClick={() => void replace(true)}
          >
            Replace all
          </Button>
        </div>
      )}
      {error !== null && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
