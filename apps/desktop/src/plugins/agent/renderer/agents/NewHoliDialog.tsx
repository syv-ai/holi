/**
 * Making a Holi: a name, a face, what it is for, which documents it takes,
 * what it may do without asking and its instructions (docs/features/holis.md).
 * It writes one file in `.holi/holis/`, which syncs like a note; its first
 * send on each machine asks that machine's person to approve it.
 */
import { useSetAtom } from 'jotai'
import { useState } from 'react'
import { Button, Dialog, Input, Label, Textarea, ToggleGroup, ToggleGroupItem } from '@/primitives'
import { HOLI_COLOURS, HOLI_MASCOTS, holiSlug, type HoliMascot } from '@holi/shared'
import { createHoliAtom } from '../state/holis'
import { PixelMascot } from './PixelMascot'

const lines = (text: string): string[] =>
  text
    .split(/[\n,]/)
    .map((l) => l.trim())
    .filter((l) => l !== '')

export function NewHoliDialog({
  accepts: startAccepts = '',
  onClose,
}: {
  /** What it takes, to start from: the document's folder. */
  accepts?: string
  onClose(): void
}): React.JSX.Element {
  const create = useSetAtom(createHoliAtom)
  const [name, setName] = useState('')
  const [mascot, setMascot] = useState<HoliMascot>('invader')
  const [description, setDescription] = useState('')
  const [accepts, setAccepts] = useState(startAccepts)
  const [allow, setAllow] = useState('')
  const [instructions, setInstructions] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const color = HOLI_COLOURS[HOLI_MASCOTS.indexOf(mascot) % HOLI_COLOURS.length]!
  const id = holiSlug(name)

  const submit = async () => {
    setBusy(true)
    setError(null)
    const res = await create({
      name,
      mascot,
      color,
      instructions,
      accepts: lines(accepts),
      allow: lines(allow),
      ...(description.trim() === '' ? {} : { description }),
    })
    setBusy(false)
    if (res.ok) onClose()
    else setError(res.message)
  }

  return (
    <Dialog open onClose={onClose} size="lg">
      <Dialog.Header>A Holi for this vault</Dialog.Header>
      <Dialog.Body>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="holi-name">Name</Label>
            <Input
              id="holi-name"
              value={name}
              autoFocus
              placeholder="Proposal"
              onChange={(e) => setName(e.target.value)}
            />
            {id !== '' && (
              <span className="font-mono text-xs text-muted-foreground">.holi/holis/{id}.yaml</span>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Face</span>
            {/* One pick among a few: the app's segmented control, which brings
                the radio semantics and arrow keys. */}
            <ToggleGroup
              type="single"
              aria-label="Face"
              value={mascot}
              spacing={1}
              className="flex-wrap"
              // Radix reports a press on the current pick as `''`; a face is
              // always chosen, so that press changes nothing.
              onValueChange={(value) => {
                if (value !== '') setMascot(value as HoliMascot)
              }}
            >
              {HOLI_MASCOTS.map((m, i) => (
                <ToggleGroupItem key={m} value={m} aria-label={m}>
                  <PixelMascot
                    name={m}
                    color={HOLI_COLOURS[i % HOLI_COLOURS.length]!}
                    still
                    className="size-6"
                  />
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="holi-what">What it is for</Label>
            <Input
              id="holi-what"
              value={description}
              placeholder="Turns a customer note into a PDF proposal"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="holi-accepts">Documents it takes</Label>
              <Textarea
                id="holi-accepts"
                value={accepts}
                className="font-mono"
                placeholder="kunder/**/*.md"
                onChange={(e) => setAccepts(e.target.value)}
              />
              <span className="text-xs text-muted-foreground">
                One path per line. Empty: any document.
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="holi-allow">Allowed without asking</Label>
              <Textarea
                id="holi-allow"
                value={allow}
                className="font-mono"
                placeholder="Edit(tilbud/**)"
                onChange={(e) => setAllow(e.target.value)}
              />
              <span className="text-xs text-muted-foreground">
                Claude Code rules, one per line, naming the folders it writes. Everything else asks
                you.
              </span>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="holi-rules">Instructions</Label>
            <Textarea
              id="holi-rules"
              value={instructions}
              placeholder="Write a proposal for the customer in the note, laid out as Templates/proposal.typ, and export it as a PDF to tilbud/."
              onChange={(e) => setInstructions(e.target.value)}
            />
          </div>
          {error !== null && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </Dialog.Body>
      <Dialog.Footer>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={busy || id === '' || instructions.trim() === ''}
          onClick={() => void submit()}
        >
          Make {name.trim() === '' ? 'Holi' : name.trim()}
        </Button>
      </Dialog.Footer>
    </Dialog>
  )
}
