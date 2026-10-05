/**
 * Starting an event on a day: a title, the day (or days) and, unless it is all
 * day, a start and an end, and a place. It is a solo event on the primary
 * calendar: nobody is invited, so nobody is mailed (`google.createEvent`).
 */
import { useState } from 'react'
import { Button, Checkbox, Dialog, Input, Label } from '@/primitives'
import { nextDay } from './month-days'

export interface NewEventValues {
  title: string
  /** ISO instants, or `YYYY-MM-DD` when `allDay`; an all-day `end` is the day
   *  after its last day, as Google's is. */
  start: string
  end: string
  allDay: boolean
  location: string
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Nine to ten on the day, or the next whole hour when the day is today and
 *  nine has gone by. */
function defaultTimes(day: string): { start: string; end: string } {
  let hour = 9
  const now = new Date()
  const isToday = day === `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  if (isToday && now.getHours() >= hour) hour = Math.min(22, now.getHours() + 1)
  return { start: `${pad(hour)}:00`, end: `${pad(hour + 1)}:00` }
}

export function NewEventDialog({
  day,
  onClose,
  onCreate,
}: {
  /** The day it starts on, `YYYY-MM-DD`; null keeps the dialog closed. */
  day: string | null
  onClose: () => void
  /** Rejects with the words to show when it cannot be made. */
  onCreate: (values: NewEventValues) => Promise<void>
}): React.JSX.Element {
  return (
    <Dialog open={day !== null} onClose={onClose} size="sm">
      {day !== null && <Form key={day} day={day} onClose={onClose} onCreate={onCreate} />}
    </Dialog>
  )
}

function Form({
  day,
  onClose,
  onCreate,
}: {
  day: string
  onClose: () => void
  onCreate: (values: NewEventValues) => Promise<void>
}): React.JSX.Element {
  const times = defaultTimes(day)
  const [title, setTitle] = useState('')
  const [allDay, setAllDay] = useState(false)
  const [startDay, setStartDay] = useState(day)
  const [endDay, setEndDay] = useState(day)
  const [startTime, setStartTime] = useState(times.start)
  const [endTime, setEndTime] = useState(times.end)
  const [location, setLocation] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = (): void => {
    if (saving) return
    if (title.trim() === '') return setError('Give it a title.')
    const start = allDay ? startDay : new Date(`${startDay}T${startTime}`).toISOString()
    const end = allDay ? nextDay(endDay) : new Date(`${endDay}T${endTime}`).toISOString()
    if (endDay < startDay || (allDay ? false : Date.parse(end) <= Date.parse(start))) {
      return setError('It has to end after it starts.')
    }
    setError(null)
    setSaving(true)
    onCreate({ title: title.trim(), start, end, allDay, location: location.trim() }).then(
      onClose,
      (err: unknown) => {
        setSaving(false)
        setError(err instanceof Error ? err.message : 'Could not create the event.')
      },
    )
  }

  return (
    <>
      <Dialog.Header>New event</Dialog.Header>
      <Dialog.Body>
        <Input
          autoFocus
          aria-label="Title"
          placeholder="Title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <div className="flex items-center gap-2">
          <Checkbox
            id="new-event-all-day"
            checked={allDay}
            onCheckedChange={(checked) => setAllDay(checked === true)}
          />
          <Label htmlFor="new-event-all-day" className="text-sm font-normal">
            All day
          </Label>
        </div>
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Input
            type="date"
            aria-label="Starts"
            value={startDay}
            onChange={(event) => {
              setStartDay(event.target.value)
              if (endDay < event.target.value) setEndDay(event.target.value)
            }}
          />
          <Input
            type="time"
            aria-label="Start time"
            disabled={allDay}
            value={startTime}
            onChange={(event) => setStartTime(event.target.value)}
          />
          <Input
            type="date"
            aria-label="Ends"
            value={endDay}
            onChange={(event) => setEndDay(event.target.value)}
          />
          <Input
            type="time"
            aria-label="End time"
            disabled={allDay}
            value={endTime}
            onChange={(event) => setEndTime(event.target.value)}
          />
        </div>
        <Input
          aria-label="Location"
          placeholder="Location"
          value={location}
          onChange={(event) => setLocation(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Added to your own calendar. Nobody is invited, so nobody is emailed.
        </p>
        {error !== null && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </Dialog.Body>
      <Dialog.Footer>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={saving} onClick={submit}>
          {saving ? 'Adding…' : 'Add event'}
        </Button>
      </Dialog.Footer>
    </>
  )
}
