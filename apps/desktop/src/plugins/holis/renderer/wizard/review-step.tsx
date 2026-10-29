/** The wizard's last step: everything the Holi will be, to read before creating it. */
import { HOLI_MASCOT_LABELS } from '@holi/shared'
import { DAYS, type WizardDraft } from './draft'
import { PixelPersona } from '@/composites/pixel-persona/pixel-persona'
import { Frame, FramePanel } from '@/components/ui/frame'
import { KINDS } from './habit-step'

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <FramePanel>
      <div className="flex items-start gap-4">
        <span className="w-28 shrink-0 text-xs text-muted-foreground">{label}</span>
        <div className="min-w-0 flex-1 text-sm break-words">{children}</div>
      </div>
    </FramePanel>
  )
}

export function ReviewStep({
  draft,
  habits,
}: {
  draft: WizardDraft
  habits: boolean
}): React.JSX.Element {
  const name = (draft.name ?? HOLI_MASCOT_LABELS[draft.mascot]).trim()
  const accepts = lines(draft.accepts)
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <PixelPersona name={draft.mascot} color={draft.color} crop="full" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">{name}</span>
          <span className="truncate text-xs text-muted-foreground">
            {draft.description.trim() === '' ? 'No description' : draft.description.trim()}
          </span>
        </div>
      </div>
      <Frame stacked spacing="sm">
        <Line label="Soul">
          <p className="line-clamp-4 whitespace-pre-wrap">
            {draft.soul.trim() === '' ? 'A heading to fill in later' : draft.soul.trim()}
          </p>
        </Line>
        <Line label="Takes">
          {accepts.length === 0 ? (
            'Any document'
          ) : (
            <code className="font-mono text-xs">{accepts.join(', ')}</code>
          )}
        </Line>
        <Line label="Without asking">
          {draft.allow.length === 0 ? (
            'Nothing: it asks before each action'
          ) : (
            <code className="font-mono text-xs">{draft.allow.join(', ')}</code>
          )}
        </Line>
        <Line label="Model">{draft.model === 'default' ? 'Default' : draft.model}</Line>
        {habits && (
          <Line label="Habit">
            {draft.habit.on
              ? `${KINDS.find((k) => k.value === draft.habit.kind)?.label ?? ''}${draft.habit.kind === 'weekly' ? ` on ${DAYS[draft.habit.day]}` : ''} at ${draft.habit.time}, written off`
              : 'None'}
          </Line>
        )}
      </Frame>
      <p className="text-xs text-pretty text-muted-foreground">
        Creating writes its folder to the vault. Then you approve it on this machine: until you do,
        nothing runs.
      </p>
    </div>
  )
}

/** A field of one entry a line, as a list. */
function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
}
