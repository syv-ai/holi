/** The General section of a Holi's settings: face, name, model, what it may do, its documents, removal. */
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState } from 'react'
import { activeRemoteAtom, appModeAtom, openPathAtom } from '@/plugin-api'
import {
  DEFAULT_HOLI_COLOUR,
  HOLI_COLOURS,
  HOLI_MASCOTS,
  HOLI_MASCOT_LABELS,
  type HoliMascot,
} from '@holi/shared'
import { holiCap } from './holis-cap'
import {
  failed,
  holiSettingsAtom,
  pendingApprovalAtom,
  updateHoliAtom,
  type HoliSummary,
} from './state'
import { PixelPersona } from '@/composites/pixel-persona/pixel-persona'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Group, Row, LinesField } from './holi-settings-parts'

/** Claude Code's model aliases; anything else stays as the file says. */
const MODELS = [
  { value: 'default', label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
]

export function General({ holi, onError }: { holi: HoliSummary; onError: (m: string) => void }) {
  const update = useSetAtom(updateHoliAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const close = useSetAtom(holiSettingsAtom)
  const approve = useSetAtom(pendingApprovalAtom)
  const setMode = useSetAtom(appModeAtom)
  const openPath = useSetAtom(openPathAtom)
  const [name, setName] = useState(holi.name)
  const [removing, setRemoving] = useState(false)
  useEffect(() => setName(holi.name), [holi.name])

  const save = (edits: Parameters<typeof update>[0]['edits']) =>
    void update({ holi: holi.id, edits }).then((res) => {
      if (!res.ok) onError(res.message)
    })

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-3 pt-2">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" className="h-auto" aria-label="Change its face and colour">
              <span className="py-2">
                <PixelPersona
                  name={holi.mascot ?? 'strategist'}
                  color={holi.color ?? DEFAULT_HOLI_COLOUR}
                  crop="full"
                  scale={2}
                />
              </span>
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-68">
            <ToggleGroup
              type="single"
              size="sm"
              spacing={1}
              aria-label="Face"
              className="grid grid-cols-5"
              value={holi.mascot ?? ''}
              onValueChange={(m) => m !== '' && save({ mascot: m as HoliMascot })}
            >
              {HOLI_MASCOTS.map((m) => (
                <ToggleGroupItem key={m} value={m} aria-label={HOLI_MASCOT_LABELS[m]}>
                  <PixelPersona name={m} color={holi.color ?? DEFAULT_HOLI_COLOUR} still />
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <div className="h-px bg-divider" />
            <ToggleGroup
              type="single"
              size="sm"
              spacing={1}
              aria-label="Colour"
              className="grid grid-cols-6"
              value={holi.color ?? ''}
              onValueChange={(c) => c !== '' && save({ color: c })}
            >
              {HOLI_COLOURS.map((c) => (
                <ToggleGroupItem key={c} value={c} aria-label={`Colour ${c}`}>
                  {/* The Holi's own colour: categorical identity, as data. */}
                  <span
                    className="size-4 rounded-full bg-(--swatch)"
                    style={{ '--swatch': c } as React.CSSProperties}
                  />
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </PopoverContent>
        </Popover>
        <Input
          aria-label="Name"
          className="max-w-60 text-center font-medium"
          maxLength={40}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (name.trim() !== '' && name.trim() !== holi.name) save({ name: name.trim() })
            else setName(holi.name)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
      </div>

      <Group title="Model">
        <Row
          label="Model"
          hint="What it thinks and replies with."
          control={
            <Select
              value={holi.model ?? 'default'}
              onValueChange={(v) => save({ model: v === 'default' ? null : v })}
            >
              <SelectTrigger size="sm" className="w-36" aria-label="Model">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[
                  ...MODELS,
                  ...(holi.model !== undefined && !MODELS.some((m) => m.value === holi.model)
                    ? [{ value: holi.model, label: holi.model }]
                    : []),
                ].map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <Row
          label="Permissions"
          hint="What it may do without asking, one Claude Code rule a line. Everything else asks you."
        >
          <LinesField
            label="Permissions"
            value={holi.allow ?? []}
            placeholder={'Edit(tilbud/**)\nBash(holi google read:*)'}
            onSave={(allow) => save({ allow })}
          />
        </Row>
      </Group>

      <Group title="Documents" blurb="What it can be sent from a document's Agent menu.">
        <Row
          label="Takes"
          hint="Vault paths, one a line, like kunder/**/*.md. Empty: any document."
        >
          <LinesField
            label="Documents it takes"
            value={holi.accepts ?? []}
            placeholder="kunder/**/*.md"
            onSave={(accepts) => save({ accepts })}
          />
        </Row>
      </Group>

      <Group title="On this machine">
        <Row
          label="Approval"
          hint={
            holi.status === 'approved'
              ? 'Approved here: sends run at once.'
              : holi.status === 'changed'
                ? 'Changed since you approved it here.'
                : 'Not approved here yet.'
          }
          control={
            holi.status === 'approved' || holi.status === 'invalid' ? undefined : (
              <Button size="xs" variant="secondary" onClick={() => approve({ holi })}>
                Review and approve
              </Button>
            )
          }
        />
        <Row
          label="Its file"
          hint={holi.path}
          control={
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                close(null)
                setMode('documents')
                void openPath(holi.path)
              }}
            >
              Open
            </Button>
          }
        />
      </Group>

      <Group title="Remove">
        <Row
          label={`Remove ${holi.name}`}
          hint="Its folder leaves the vault, soul and memory with it. Git keeps the history."
          control={
            removing ? (
              <div className="flex items-center gap-1">
                <Button size="xs" variant="ghost" onClick={() => setRemoving(false)}>
                  Cancel
                </Button>
                <Button
                  size="xs"
                  variant="destructive"
                  onClick={() => {
                    if (remote === null) return
                    void holiCap.remove(remote, { holi: holi.id }).then(
                      () => close(null),
                      (err: unknown) => onError(failed(err).message),
                    )
                  }}
                >
                  Remove
                </Button>
              </div>
            ) : (
              <Button size="xs" variant="ghost" onClick={() => setRemoving(true)}>
                Remove…
              </Button>
            )
          }
        />
      </Group>
    </div>
  )
}
