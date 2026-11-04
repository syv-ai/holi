/** The wizard's "who" step: the Holi's face, name and description. */
import {
  HOLI_COLOURS,
  HOLI_MASCOTS,
  HOLI_MASCOT_LABELS,
  holiSlug,
  type HoliMascot,
} from '@holi/shared'
import { type WizardDraft } from './draft'
import { PixelPersona } from '@/composites/pixel-persona/pixel-persona'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { FormField, Labelled } from './step-parts'

export function WhoStep({
  draft,
  set,
}: {
  draft: WizardDraft
  set: (patch: Partial<WizardDraft>) => void
}): React.JSX.Element {
  const name = draft.name ?? HOLI_MASCOT_LABELS[draft.mascot]
  const nameError =
    draft.name !== undefined && holiSlug(draft.name) === ''
      ? 'Give it a name with a letter or a digit in it.'
      : undefined
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4">
        <span className="flex size-20 shrink-0 items-center justify-center rounded-full bg-foreground/[0.04]">
          <PixelPersona name={draft.mascot} color={draft.color} crop="full" scale={2} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <FormField label="Name" required error={nameError}>
            <Input
              aria-label="Name"
              maxLength={40}
              value={name}
              onChange={(e) => set({ name: e.target.value })}
            />
          </FormField>
        </div>
      </div>
      <Labelled label="Face">
        <ToggleGroup
          type="single"
          size="sm"
          spacing={1}
          aria-label="Face"
          className="grid grid-cols-5"
          value={draft.mascot}
          onValueChange={(m) => m !== '' && set({ mascot: m as HoliMascot })}
        >
          {HOLI_MASCOTS.map((m) => (
            <ToggleGroupItem key={m} value={m} aria-label={HOLI_MASCOT_LABELS[m]}>
              <PixelPersona name={m} color={draft.color} still />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Labelled>
      <Labelled label="Colour">
        <ToggleGroup
          type="single"
          size="sm"
          spacing={1}
          aria-label="Colour"
          className="grid grid-cols-6"
          value={draft.color}
          onValueChange={(c) => c !== '' && set({ color: c })}
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
      </Labelled>
      <FormField label="Short description">
        <Input
          aria-label="Short description"
          placeholder="Turns a customer note into a PDF proposal"
          value={draft.description}
          onChange={(e) => set({ description: e.target.value })}
        />
      </FormField>
    </div>
  )
}

// ── 4. What it does ───────────────────────────────────────────────────────
