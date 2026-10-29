/** The wizard's "does" step: its model and the documents it takes. */
import { type WizardDraft } from './draft'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { FormField } from './step-parts'

/** Claude Code's model aliases, as the settings offer them. */
const MODELS = [
  { value: 'default', label: 'Default' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
]

export function DoesStep({
  draft,
  set,
}: {
  draft: WizardDraft
  set: (patch: Partial<WizardDraft>) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <FormField label="Soul">
        <Textarea
          aria-label="Soul"
          className="min-h-40 text-sm"
          placeholder={
            'You write proposals for our customers.\n- Lay them out as tilbud/template.md.\n- Ask before quoting a price that is not in the price list.'
          }
          value={draft.soul}
          onChange={(e) => set({ soul: e.target.value })}
        />
      </FormField>
      <p className="-mt-4 text-xs text-muted-foreground">
        Who it is and what it should always keep in mind. Left empty, it starts with a heading for
        you to fill in later.
      </p>
      <FormField label="Documents it takes">
        <Textarea
          aria-label="Documents it takes"
          className="min-h-20 font-mono text-xs"
          placeholder="kunder/**/*.md"
          value={draft.accepts}
          onChange={(e) => set({ accepts: e.target.value })}
        />
      </FormField>
      <p className="-mt-4 text-xs text-muted-foreground">
        Vault paths, one a line: <code className="font-mono">**</code> any folders,{' '}
        <code className="font-mono">*</code> within a name. Empty: any document.
      </p>
      <FormField label="Model" orientation="horizontal">
        <Select value={draft.model} onValueChange={(v) => set({ model: v })}>
          <SelectTrigger size="sm" className="w-36" aria-label="Model">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODELS.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
    </div>
  )
}

// ── 5. What it may do ─────────────────────────────────────────────────────
