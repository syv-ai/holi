/**
 * A task's fields as a row of chips: status, assignees, priority, due, start,
 * labels, project, estimate and sharing. Each chip says its value, or what it is while
 * unset, and opens the one picker that sets it. The same row sits in New task
 * (setting a draft) and on an open task (writing the file): it only reports
 * changes, the caller decides what a change does.
 *
 * Project is the task's folder: the vault root is no project, and a project
 * can be named here before the folder exists (the move or create makes it).
 * Sharing is whether the file is committed: a private task is
 * `task.<name>.local.md`, on this machine only (docs/features/tasks.md).
 */
import { useState, type ReactNode } from "react"
import { isEstimate, type Priority, type StatusDef } from "@holi/shared"
import { useAtomValue } from "jotai"
import {
  CalendarDaysIcon,
  CalendarPlusIcon,
  CheckIcon,
  FlagIcon,
  FolderIcon,
  LockIcon,
  PlusIcon,
  TagIcon,
  TimerIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/cn"
import { parentOf } from "@/lib/tree-paths"
import { PRIORITIES, shortDate } from "@/lib/planning"
import { memberLoginsAtom } from "@/state/members"
import { taskTagsAtom, tasksAtom } from "@/state/tasks"
import { snapshotAtom } from "@/state/vaults"
import { PeopleStack } from "@/composites/person-avatar"
import { StatusIcon } from "./task-bits"

/** What the row edits. `folder` is vault-relative, `""` the vault root. */
export interface TaskFieldValues {
  status: string
  assignees: string[]
  priority?: Priority
  due?: string
  start?: string
  tags: string[]
  folder: string
  estimate?: string
  /** Committed and synced with the vault; false is private, this machine's. */
  shared: boolean
}

/** One field's new value: `undefined` clears it. */
export type TaskFieldChange = {
  [K in keyof TaskFieldValues]-?: { field: K; value: TaskFieldValues[K] }
}[keyof TaskFieldValues]

/** The folders a task can go in: every real folder outside the dot-folders
 *  Holi and git keep, and every folder some task is already in. */
function useProjects(): string[] {
  const dirs = useAtomValue(snapshotAtom).dirs
  const tasks = useAtomValue(tasksAtom)
  const all = new Set<string>()
  for (const dir of dirs) {
    if (dir !== "" && !dir.split("/").some((part) => part.startsWith("."))) {
      all.add(dir)
    }
  }
  for (const path of tasks.keys()) {
    const folder = parentOf(path)
    if (folder !== "") all.add(folder)
  }
  return [...all].sort((a, b) => a.localeCompare(b))
}

/** A stamp's day as a local Date, for the calendar. */
function stampDay(stamp: string | undefined): Date | undefined {
  const match = stamp?.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) return undefined
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

/** A picked day as a stamp, keeping the time an existing stamp had. */
function dayStamp(day: Date, previous: string | undefined): string {
  const date = [
    day.getFullYear(),
    String(day.getMonth() + 1).padStart(2, "0"),
    String(day.getDate()).padStart(2, "0"),
  ].join("-")
  const time = previous?.match(/T\d{2}:\d{2}$/)?.[0] ?? ""
  return `${date}${time}`
}

/** A chip: an outline button showing a value, or its label muted when unset. */
function Chip({
  icon,
  set,
  label,
  children,
  ...props
}: {
  icon: ReactNode
  set: boolean
  label: string
  children?: ReactNode
} & React.ComponentProps<typeof Button>) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn(!set && "text-muted-foreground")}
      {...props}
    >
      {icon}
      {set ? children : label}
    </Button>
  )
}

function StatusField({
  statuses,
  value,
  onChange,
}: {
  statuses: readonly StatusDef[]
  value: string
  onChange: (status: string) => void
}) {
  const current = statuses.find((s) => s.id === value)
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Chip
          icon={current !== undefined ? <StatusIcon status={current} /> : null}
          set
          label="Status"
          aria-label={`Status: ${current?.name ?? value}`}
        >
          {current?.name ?? value}
        </Chip>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {statuses.map((status) => (
            <DropdownMenuRadioItem key={status.id} value={status.id}>
              <StatusIcon status={status} />
              {status.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function AssigneesField({
  value,
  onChange,
}: {
  value: string[]
  onChange: (assignees: string[]) => void
}) {
  const people = useAtomValue(memberLoginsAtom)
  const everyone = [...new Set([...people, ...value])]
  const toggle = (login: string, on: boolean) =>
    onChange(on ? [...value, login] : value.filter((x) => x !== login))
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Chip
          icon={
            value.length > 0 ? (
              <PeopleStack logins={value} max={2} />
            ) : (
              <UserIcon data-icon="inline-start" aria-hidden="true" />
            )
          }
          set={value.length > 0}
          label="Assignee"
          aria-label={
            value.length > 0 ? `Assignees: ${value.join(", ")}` : "Assignee"
          }
        >
          {value.length === 1 ? value[0] : `${value.length} people`}
        </Chip>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 min-w-48">
        <DropdownMenuLabel>Assign to</DropdownMenuLabel>
        {everyone.length === 0 ? (
          <p className="text-muted-foreground px-2 py-1.5 text-xs">
            No members found for this vault.
          </p>
        ) : (
          everyone.map((login) => (
            <DropdownMenuCheckboxItem
              key={login}
              checked={value.includes(login)}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) => toggle(login, checked === true)}
            >
              {login}
            </DropdownMenuCheckboxItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const NO_PRIORITY = "none"

function PriorityField({
  value,
  onChange,
}: {
  value: Priority | undefined
  onChange: (priority: Priority | undefined) => void
}) {
  const name = PRIORITIES.find((p) => p.id === value)?.name
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Chip
          icon={<FlagIcon data-icon="inline-start" aria-hidden="true" />}
          set={value !== undefined}
          label="Priority"
          aria-label={name !== undefined ? `Priority: ${name}` : "Priority"}
        >
          {name}
        </Chip>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-40">
        <DropdownMenuRadioGroup
          value={value ?? NO_PRIORITY}
          onValueChange={(next) =>
            onChange(next === NO_PRIORITY ? undefined : (next as Priority))
          }
        >
          {PRIORITIES.map((priority) => (
            <DropdownMenuRadioItem key={priority.id} value={priority.id}>
              {priority.name}
            </DropdownMenuRadioItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuRadioItem value={NO_PRIORITY}>
            No priority
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function DateField({
  label,
  icon,
  value,
  today,
  onChange,
}: {
  label: string
  icon: ReactNode
  value: string | undefined
  today: string
  onChange: (stamp: string | undefined) => void
}) {
  const [open, setOpen] = useState(false)
  const day = stampDay(value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Chip
          icon={icon}
          set={value !== undefined}
          label={label}
          aria-label={
            value !== undefined ? `${label}: ${shortDate(value, today)}` : label
          }
        >
          {value !== undefined ? shortDate(value, today) : null}
        </Chip>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto">
        <Calendar
          mode="single"
          selected={day}
          defaultMonth={day ?? stampDay(today)}
          onSelect={(picked) => {
            if (picked !== undefined) onChange(dayStamp(picked, value))
            setOpen(false)
          }}
        />
        {value !== undefined ? (
          <div className="border-t p-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => {
                onChange(undefined)
                setOpen(false)
              }}
            >
              Clear {label.toLowerCase()}
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

/** A searchable list that also takes a new name: labels and projects. */
function PickList({
  placeholder,
  options,
  selected,
  multiple,
  onPick,
  render = (option) => option,
  emptyOption,
}: {
  placeholder: string
  options: string[]
  selected: string[]
  multiple: boolean
  onPick: (option: string) => void
  render?: (option: string) => ReactNode
  /** A first item meaning "none", like the vault root for a project. */
  emptyOption?: { label: string; value: string }
}) {
  const [query, setQuery] = useState("")
  const typed = query.trim()
  const isNew =
    typed !== "" &&
    !options.some((option) => option.toLowerCase() === typed.toLowerCase())
  return (
    <Command>
      <CommandInput
        placeholder={placeholder}
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>Type a name to add it.</CommandEmpty>
        <CommandGroup>
          {emptyOption !== undefined ? (
            <CommandItem
              value={emptyOption.label}
              onSelect={() => onPick(emptyOption.value)}
            >
              {emptyOption.label}
              <CheckIcon
                className={cn(
                  "ml-auto",
                  !selected.includes(emptyOption.value) && "opacity-0"
                )}
                aria-hidden="true"
              />
            </CommandItem>
          ) : null}
          {options.map((option) => (
            <CommandItem
              key={option}
              value={option}
              onSelect={() => {
                onPick(option)
                if (!multiple) setQuery("")
              }}
            >
              {render(option)}
              <CheckIcon
                className={cn(
                  "ml-auto",
                  !selected.includes(option) && "opacity-0"
                )}
                aria-hidden="true"
              />
            </CommandItem>
          ))}
          {isNew ? (
            <CommandItem
              value={`create ${typed}`}
              onSelect={() => {
                onPick(typed)
                setQuery("")
              }}
            >
              <PlusIcon aria-hidden="true" />
              Add “{typed}”
            </CommandItem>
          ) : null}
        </CommandGroup>
      </CommandList>
    </Command>
  )
}

function LabelsField({
  value,
  onChange,
}: {
  value: string[]
  onChange: (tags: string[]) => void
}) {
  const known = useAtomValue(taskTagsAtom)
  const options = [...new Set([...known, ...value])]
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Chip
          icon={<TagIcon data-icon="inline-start" aria-hidden="true" />}
          set={value.length > 0}
          label="Labels"
          aria-label={
            value.length > 0 ? `Labels: ${value.join(", ")}` : "Labels"
          }
        >
          {value.length <= 2 ? value.join(", ") : `${value.length} labels`}
        </Chip>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <PickList
          placeholder="Find or add a label…"
          options={options}
          selected={value}
          multiple
          onPick={(tag) =>
            onChange(
              value.includes(tag)
                ? value.filter((t) => t !== tag)
                : [...value, tag]
            )
          }
        />
      </PopoverContent>
    </Popover>
  )
}

function ProjectField({
  value,
  onChange,
}: {
  value: string
  onChange: (folder: string) => void
}) {
  const [open, setOpen] = useState(false)
  const projects = useProjects()
  const options =
    value !== "" && !projects.includes(value) ? [...projects, value] : projects
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Chip
          icon={<FolderIcon data-icon="inline-start" aria-hidden="true" />}
          set={value !== ""}
          label="Project"
          aria-label={value !== "" ? `Project: ${value}` : "Project"}
        >
          {value.split("/").at(-1)}
        </Chip>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <PickList
          placeholder="Find or name a project…"
          options={options}
          selected={[value]}
          multiple={false}
          emptyOption={{ label: "No project", value: "" }}
          render={(folder) => (
            <span className="flex min-w-0 items-center gap-2">
              <FolderIcon aria-hidden="true" />
              <span className="truncate">{folder}</span>
            </span>
          )}
          onPick={(folder) => {
            onChange(folder.replace(/^\/+|\/+$/g, ""))
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

const ESTIMATE_PRESETS = ["30m", "1h", "2h", "4h", "1d", "1w"]

function EstimateField({
  value,
  onChange,
}: {
  value: string | undefined
  onChange: (estimate: string | undefined) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value ?? "")
  const bad = draft.trim() !== "" && !isEstimate(draft.trim())
  const commit = (next: string) => {
    const trimmed = next.trim()
    if (trimmed !== "" && !isEstimate(trimmed)) return
    onChange(trimmed === "" ? undefined : trimmed)
    setOpen(false)
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setDraft(value ?? "")
        setOpen(next)
      }}
    >
      <PopoverTrigger asChild>
        <Chip
          icon={<TimerIcon data-icon="inline-start" aria-hidden="true" />}
          set={value !== undefined}
          label="Estimate"
          aria-label={value !== undefined ? `Estimate: ${value}` : "Estimate"}
        >
          <span className="tabular-nums">{value}</span>
        </Chip>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60">
        <div
          className="flex flex-col gap-1.5"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              commit(draft)
            }
          }}
        >
          <Input
            autoFocus
            aria-label="Estimate"
            aria-invalid={bad}
            placeholder="2h"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <p
            className={cn(
              "text-xs",
              bad ? "text-destructive" : "text-muted-foreground"
            )}
          >
            A number and m, h, d or w, like 30m or 1.5d.
          </p>
        </div>
        <div className="flex flex-wrap gap-1">
          {ESTIMATE_PRESETS.map((preset) => (
            <Button
              key={preset}
              type="button"
              variant={preset === value ? "secondary" : "ghost"}
              size="xs"
              onClick={() => commit(preset)}
            >
              {preset}
            </Button>
          ))}
          {value !== undefined ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => commit("")}
            >
              Clear
            </Button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}

const SHARINGS = [
  {
    value: "private",
    name: "Private",
    detail: "Only on this machine",
    icon: <LockIcon aria-hidden="true" />,
  },
  {
    value: "shared",
    name: "Shared with vault",
    detail: "Synced to everyone",
    icon: <UsersIcon aria-hidden="true" />,
  },
] as const

function SharingField({
  value,
  onChange,
}: {
  value: boolean
  onChange: (shared: boolean) => void
}) {
  const current = SHARINGS[value ? 1 : 0]
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Chip
          icon={
            value ? (
              <UsersIcon data-icon="inline-start" aria-hidden="true" />
            ) : (
              <LockIcon data-icon="inline-start" aria-hidden="true" />
            )
          }
          set
          label="Sharing"
          aria-label={`Sharing: ${current.name}`}
        >
          {value ? "Shared" : "Private"}
        </Chip>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52">
        <DropdownMenuRadioGroup
          value={current.value}
          onValueChange={(next) => onChange(next === "shared")}
        >
          {SHARINGS.map((sharing) => (
            <DropdownMenuRadioItem key={sharing.value} value={sharing.value}>
              {sharing.icon}
              <span className="flex flex-col">
                <span>{sharing.name}</span>
                <span className="text-muted-foreground text-xs">
                  {sharing.detail}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function TaskFields({
  values,
  statuses,
  today,
  onChange,
  className,
}: {
  values: TaskFieldValues
  statuses: readonly StatusDef[]
  today: string
  onChange: (change: TaskFieldChange) => void
  className?: string
}) {
  return (
    <div
      role="group"
      aria-label="Task fields"
      className={cn("flex flex-wrap items-center gap-2", className)}
    >
      <StatusField
        statuses={statuses}
        value={values.status}
        onChange={(value) => onChange({ field: "status", value })}
      />
      <AssigneesField
        value={values.assignees}
        onChange={(value) => onChange({ field: "assignees", value })}
      />
      <PriorityField
        value={values.priority}
        onChange={(value) => onChange({ field: "priority", value })}
      />
      <DateField
        label="Due date"
        icon={<CalendarDaysIcon data-icon="inline-start" aria-hidden="true" />}
        value={values.due}
        today={today}
        onChange={(value) => onChange({ field: "due", value })}
      />
      <DateField
        label="Start date"
        icon={<CalendarPlusIcon data-icon="inline-start" aria-hidden="true" />}
        value={values.start}
        today={today}
        onChange={(value) => onChange({ field: "start", value })}
      />
      <LabelsField
        value={values.tags}
        onChange={(value) => onChange({ field: "tags", value })}
      />
      <ProjectField
        value={values.folder}
        onChange={(value) => onChange({ field: "folder", value })}
      />
      <EstimateField
        value={values.estimate}
        onChange={(value) => onChange({ field: "estimate", value })}
      />
      <SharingField
        value={values.shared}
        onChange={(value) => onChange({ field: "shared", value })}
      />
    </div>
  )
}
