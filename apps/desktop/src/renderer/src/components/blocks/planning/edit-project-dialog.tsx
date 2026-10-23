/**
 * Edit project: everything `.holi/project.md` holds, in one form. Saving
 * writes the file whole (`serializeProjectFile`), keeping any key this
 * version does not know.
 */
import { useState } from "react"
import {
  PROJECT_STATUSES,
  type Milestone,
  type Project,
  type ProjectStatus,
} from "@holi/shared"
import { PlusIcon, Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"

const NO_LEAD = "none"

type Draft = {
  name: string
  status: ProjectStatus
  lead: string
  start: string
  due: string
  about: string
  milestones: Milestone[]
}

/** A stamp's day, for a date field: `2026-10-01T09:00` edits as its day. */
const day = (stamp: string | undefined) => (stamp ?? "").slice(0, 10)

function draftOf(project: Project): Draft {
  return {
    name: project.name ?? "",
    status: project.status,
    lead: project.lead ?? NO_LEAD,
    start: day(project.start),
    due: day(project.due),
    about: project.about,
    milestones: project.milestones.map((m) => ({ ...m })),
  }
}

function projectOf(draft: Draft, base: Project): Project {
  const keep = (stamp: string | undefined, edited: string) =>
    edited === "" ? undefined : day(stamp) === edited ? stamp : edited
  const project: Project = {
    status: draft.status,
    milestones: draft.milestones
      .filter((m) => m.name.trim() !== "" && m.date !== "")
      .map((m) => ({ name: m.name.trim(), date: m.date }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    about: draft.about,
    ...(base.extra ? { extra: base.extra } : {}),
  }
  if (draft.name.trim() !== "") project.name = draft.name.trim()
  if (draft.lead !== NO_LEAD) project.lead = draft.lead
  const start = keep(base.start, draft.start)
  const due = keep(base.due, draft.due)
  if (start !== undefined) project.start = start
  if (due !== undefined) project.due = due
  return project
}

export function EditProjectDialog({
  open,
  onOpenChange,
  project,
  fallbackName,
  people,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: Project
  /** What the project is called when it has no name of its own. */
  fallbackName: string
  people: readonly string[]
  onSave: (project: Project) => Promise<void>
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(project))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))
  const leads =
    draft.lead !== NO_LEAD && !people.includes(draft.lead)
      ? [draft.lead, ...people]
      : people

  const setMilestone = (index: number, patch: Partial<Milestone>) =>
    set({
      milestones: draft.milestones.map((m, i) =>
        i === index ? { ...m, ...patch } : m
      ),
    })

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await onSave(projectOf(draft, project))
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Opening starts from what the file says now.
        if (next) setDraft(draftOf(project))
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <DialogHeader>
            <DialogTitle>Edit project</DialogTitle>
            <DialogDescription>
              Saved to .holi/project.md and shared with everyone in the vault.
            </DialogDescription>
          </DialogHeader>

          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="project-name">Name</FieldLabel>
              <Input
                id="project-name"
                value={draft.name}
                placeholder={fallbackName}
                onChange={(event) => set({ name: event.target.value })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel htmlFor="project-status">Status</FieldLabel>
                <Select
                  value={draft.status}
                  onValueChange={(value) =>
                    set({ status: value as ProjectStatus })
                  }
                >
                  <SelectTrigger id="project-status" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROJECT_STATUSES.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="project-lead">Lead</FieldLabel>
                <Select
                  value={draft.lead}
                  onValueChange={(value) => set({ lead: value })}
                >
                  <SelectTrigger id="project-lead" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_LEAD}>No lead</SelectItem>
                    {leads.map((login) => (
                      <SelectItem key={login} value={login}>
                        {login}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="project-start">Start</FieldLabel>
                <Input
                  id="project-start"
                  type="date"
                  value={draft.start}
                  onChange={(event) => set({ start: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="project-due">Due</FieldLabel>
                <Input
                  id="project-due"
                  type="date"
                  value={draft.due}
                  onChange={(event) => set({ due: event.target.value })}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="project-about">About</FieldLabel>
              <Textarea
                id="project-about"
                rows={5}
                value={draft.about}
                placeholder="What this project is for, in a few lines. Markdown works."
                onChange={(event) => set({ about: event.target.value })}
              />
            </Field>

            <FieldSet className="gap-3">
              <FieldLegend variant="label">Milestones</FieldLegend>
              {draft.milestones.map((milestone, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    aria-label={`Milestone ${index + 1} name`}
                    value={milestone.name}
                    placeholder="Milestone"
                    onChange={(event) =>
                      setMilestone(index, { name: event.target.value })
                    }
                  />
                  <Input
                    aria-label={`Milestone ${index + 1} date`}
                    type="date"
                    className="w-40 shrink-0"
                    value={milestone.date}
                    onChange={(event) =>
                      setMilestone(index, { date: event.target.value })
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove milestone ${index + 1}`}
                    onClick={() =>
                      set({
                        milestones: draft.milestones.filter(
                          (_, i) => i !== index
                        ),
                      })
                    }
                  >
                    <Trash2Icon aria-hidden="true" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() =>
                  set({
                    milestones: [...draft.milestones, { name: "", date: "" }],
                  })
                }
              >
                <PlusIcon data-icon="inline-start" aria-hidden="true" />
                Add milestone
              </Button>
            </FieldSet>
            {error !== null ? <FieldError>{error}</FieldError> : null}
          </FieldGroup>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Save project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
