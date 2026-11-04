/**
 * Add or edit one agent harness (docs/features/agent-sessions.md, Harnesses).
 * Every list is one argument per line, never a command line split on spaces:
 * what is typed is what the program gets. A built-in agent shows its command
 * fields alone; how it starts and resumes is its own, and Claude Code takes
 * no arguments or environment at all.
 *
 * The form is filled once, when it mounts: the card mounts it afresh (a new
 * `key`) each time it opens on an agent.
 */
import { useState } from 'react'
import { AGENT_ID } from '@holi/shared'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

/** Mirrors `Harness` in the agent's main/harness/record.ts. */
export interface HarnessRecord {
  id: string
  label: string
  integration?: 'claude' | 'codex' | 'pi'
  command: { bin: string; args: string[] }
  prompt?: { args: string[] }
  resume?: { pick?: string[]; byId?: string[] }
  env?: Record<string, string>
  test?: string[]
}

type Draft = {
  id: string
  label: string
  bin: string
  args: string
  prompt: string
  pick: string
  byId: string
  env: string
  test: string
}

const lines = (list: readonly string[] | undefined): string => (list ?? []).join('\n')
/** One argument per line; a blank line is none. */
const argsOf = (text: string): string[] => text.split('\n').filter((line) => line.trim() !== '')

function draftOf(h: HarnessRecord | null): Draft {
  return {
    id: h?.id ?? '',
    label: h?.label ?? '',
    bin: h?.command.bin ?? '',
    args: lines(h?.command.args),
    prompt: lines(h?.prompt?.args),
    pick: lines(h?.resume?.pick),
    byId: lines(h?.resume?.byId),
    env: Object.entries(h?.env ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
    test: h?.test === undefined ? '--version' : lines(h.test),
  }
}

/** A slug out of a name: what a new harness's id starts as. */
const slugOf = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+|-+$/g, '')
    .slice(0, 32)

function recordOf(draft: Draft, base: HarnessRecord | null): HarnessRecord {
  const env: Record<string, string> = {}
  for (const line of draft.env.split('\n')) {
    if (line.trim() === '') continue
    const at = line.indexOf('=')
    // A line without `=` is a name with no value, which main refuses by name.
    if (at === -1) env[line.trim()] = ''
    else env[line.slice(0, at).trim()] = line.slice(at + 1)
  }
  const record: HarnessRecord = {
    id: draft.id.trim(),
    label: draft.label.trim(),
    command: { bin: draft.bin.trim(), args: argsOf(draft.args) },
  }
  if (base?.integration !== undefined) record.integration = base.integration
  // Claude Code's sessions are its supervisor's, which reads neither.
  if (base?.integration === 'claude') record.command.args = []
  else if (Object.keys(env).length > 0) record.env = env
  if (base?.integration === undefined) {
    if (argsOf(draft.prompt).length > 0) record.prompt = { args: argsOf(draft.prompt) }
    const pick = argsOf(draft.pick)
    const byId = argsOf(draft.byId)
    if (pick.length > 0 || byId.length > 0) {
      record.resume = {
        ...(pick.length > 0 ? { pick } : {}),
        ...(byId.length > 0 ? { byId } : {}),
      }
    }
  }
  const test = argsOf(draft.test)
  if (!(test.length === 1 && test[0] === '--version')) record.test = test
  return record
}

/** One field of the form: its label, the control, and a line on what goes in. */
function Row({
  id,
  label,
  hint,
  children,
}: {
  id: string
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {children}
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
    </Field>
  )
}

export function HarnessDialog({
  open,
  onOpenChange,
  harness,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The harness to edit; null adds one. */
  harness: HarnessRecord | null
  /** Throws with main's reason when the harness is refused. */
  onSave: (harness: HarnessRecord, create: boolean) => Promise<void>
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(harness))
  const [idTouched, setIdTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))
  const creating = harness === null
  const builtIn = harness?.integration !== undefined
  // Claude Code's sessions run in its own background supervisor, which takes
  // no arguments or environment from Holi.
  const claude = harness?.integration === 'claude'
  const idOk = AGENT_ID.test(draft.id)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await onSave(recordOf(draft, harness), creating)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <div className="flex max-h-160 flex-col gap-6 overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{creating ? 'Add an agent' : `Edit ${harness.label}`}</DialogTitle>
            <DialogDescription>
              Kept on this machine only. Holi runs the program with the vault as its folder, each
              argument as you write it: one per line, never through a shell.
            </DialogDescription>
          </DialogHeader>

          <FieldGroup>
            <Row id="harness-label" label="Name">
              <Input
                id="harness-label"
                value={draft.label}
                placeholder="Aider"
                onChange={(event) =>
                  set({
                    label: event.target.value,
                    ...(creating && !idTouched ? { id: slugOf(event.target.value) } : {}),
                  })
                }
              />
            </Row>
            {creating ? (
              <Row
                id="harness-id"
                label="Id"
                hint="How settings name it: lowercase letters, digits and dashes. It cannot change later."
              >
                <Input
                  id="harness-id"
                  value={draft.id}
                  aria-invalid={draft.id !== '' && !idOk}
                  onChange={(event) => {
                    setIdTouched(true)
                    set({ id: event.target.value })
                  }}
                />
              </Row>
            ) : null}
            <Row
              id="harness-bin"
              label="Program"
              hint="Its name on PATH, or its full path. The program alone: its arguments go below."
            >
              <Input
                id="harness-bin"
                value={draft.bin}
                placeholder="aider"
                onChange={(event) => set({ bin: event.target.value })}
              />
            </Row>
            {claude ? (
              <FieldDescription>
                Claude Code takes no arguments or environment here: its sessions run in its own
                background supervisor, which does not read them.
              </FieldDescription>
            ) : (
              <Row
                id="harness-args"
                label="Arguments"
                hint={
                  builtIn
                    ? `One per line, before the ones ${harness.label} gets from Holi, in its terminals only.`
                    : 'One per line, every time it starts.'
                }
              >
                <Textarea
                  id="harness-args"
                  rows={2}
                  value={draft.args}
                  onChange={(event) => set({ args: event.target.value })}
                />
              </Row>
            )}
            {builtIn ? null : (
              <>
                <Row
                  id="harness-prompt"
                  label="Start on a message"
                  hint="One per line, with {prompt} on a line of its own after a -- line, so a message that starts with - is not read as an option. Empty: it cannot start on a message."
                >
                  <Textarea
                    id="harness-prompt"
                    rows={2}
                    value={draft.prompt}
                    placeholder={'--\n{prompt}'}
                    onChange={(event) => set({ prompt: event.target.value })}
                  />
                </Row>
                <Row
                  id="harness-pick"
                  label="Resume: its own picker"
                  hint="One per line. Empty: no Resume for it in the + menu."
                >
                  <Textarea
                    id="harness-pick"
                    rows={2}
                    value={draft.pick}
                    placeholder="--resume"
                    onChange={(event) => set({ pick: event.target.value })}
                  />
                </Row>
                <Row
                  id="harness-by-id"
                  label="Resume: a conversation by its id"
                  hint="One per line, with {id} on a line of its own. Holi knows the id when holi-signal turn-end --conversation says it."
                >
                  <Textarea
                    id="harness-by-id"
                    rows={2}
                    value={draft.byId}
                    placeholder={'--resume\n{id}'}
                    onChange={(event) => set({ byId: event.target.value })}
                  />
                </Row>
              </>
            )}
            {claude ? null : (
              <Row
                id="harness-env"
                label="Environment"
                hint={
                  builtIn
                    ? "NAME=value, one per line, for its terminals and its unattended runs too. PATH and HOLI_ variables are Holi's."
                    : "NAME=value, one per line. PATH and HOLI_ variables are Holi's."
                }
              >
                <Textarea
                  id="harness-env"
                  rows={2}
                  value={draft.env}
                  onChange={(event) => set({ env: event.target.value })}
                />
              </Row>
            )}
            <Row
              id="harness-test"
              label="Test arguments"
              hint="What Test runs, one per line. It must finish within 5 seconds."
            >
              <Textarea
                id="harness-test"
                rows={1}
                value={draft.test}
                onChange={(event) => set({ test: event.target.value })}
              />
            </Row>
            {error !== null ? <FieldError>{error}</FieldError> : null}
          </FieldGroup>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={busy || (creating && !idOk)}
              onClick={() => void submit()}
            >
              {creating ? 'Add agent' : 'Save'}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
