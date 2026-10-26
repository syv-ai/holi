/** The wizard's "may" step: what the Holi may do without asking. */
import { FileText, Plus, ShieldCheck, StickyNote, X } from 'lucide-react'
import { useState } from 'react'
import { holiRuleError } from '@holi/shared'
import { type WizardDraft } from './draft'
import { Badge } from '@/components/reui/badge'
import { Frame } from '@/components/reui/frame'
import { IconButton } from '@/composites/icon-button'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group'
import { FormField, Fact } from './step-parts'

/** A folder as the rule that lets a run write in it. */
function folderRule(folder: string): string {
  const clean = folder.trim().replace(/^\/+|\/+$/g, '')
  return `Edit(${clean}/**)`
}

function AddField({
  label,
  placeholder,
  button,
  toRule,
  onAdd,
}: {
  label: string
  placeholder: string
  button: string
  toRule: (text: string) => string
  onAdd: (rule: string) => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const add = () => {
    if (text.trim() === '') return
    const rule = toRule(text)
    const refused = holiRuleError(rule)
    if (refused !== null) {
      setError(refused.replace(/`/g, ''))
      return
    }
    onAdd(rule)
    setText('')
    setError(undefined)
  }
  return (
    <FormField label={label} error={error}>
      <InputGroup>
        <InputGroupInput
          aria-label={label}
          placeholder={placeholder}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setError(undefined)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton onClick={add}>
            <Plus className="size-3.5" />
            {button}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </FormField>
  )
}

export function MayStep({
  draft,
  set,
}: {
  draft: WizardDraft
  set: (patch: Partial<WizardDraft>) => void
}): React.JSX.Element {
  const add = (rule: string) => {
    if (!draft.allow.includes(rule)) set({ allow: [...draft.allow, rule] })
  }
  return (
    <div className="flex flex-col gap-6">
      <Frame stacked spacing="sm">
        <Fact icon={ShieldCheck} title="Everything else asks you">
          A run uses Claude Code's own permission prompts. What is not listed here, it asks you
          first, in the Agents view or the Inbox when you are away.
        </Fact>
        <Fact icon={FileText} title="Name the folders it writes">
          A bare Edit or Write is refused: a run that could write anywhere could rewrite AGENTS.md,
          .holi/ or .claude/, and through them every later run.
        </Fact>
        <Fact icon={StickyNote} title="Its memory is always allowed">
          Keeping its own memory never asks: those commands redact anything that looks like a
          credential.
        </Fact>
      </Frame>
      <AddField
        label="A folder it may write"
        placeholder="tilbud"
        button="Allow"
        toRule={folderRule}
        onAdd={add}
      />
      <AddField
        label="Another Claude Code rule"
        placeholder="Bash(holi google read:*)"
        button="Add"
        toRule={(t) => t.trim()}
        onAdd={add}
      />
      <div className="flex flex-col gap-2">
        <span className="text-xs text-muted-foreground">Allowed without asking</span>
        {draft.allow.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing yet: it asks before each action.</p>
        ) : (
          <ul aria-label="Allowed without asking" className="flex flex-wrap gap-2">
            {draft.allow.map((rule) => (
              <li key={rule}>
                <Badge variant="secondary" size="lg" className="font-mono">
                  {rule}
                  <IconButton
                    size="icon-xs"
                    label={`Remove ${rule}`}
                    onClick={() => set({ allow: draft.allow.filter((r) => r !== rule) })}
                  >
                    <X />
                  </IconButton>
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// ── 6. Habits ─────────────────────────────────────────────────────────────
