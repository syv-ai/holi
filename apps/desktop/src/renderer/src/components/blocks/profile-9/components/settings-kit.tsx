/**
 * The settings pages' vocabulary, as ReUI's profile-9 block draws it: a card
 * with a title and one line under it, rows of label and muted explanation on
 * the left with the control on the right, and a footer only where an edit
 * waits for Save. Every section is built from these and nothing else, so the
 * pages cannot drift apart.
 */
import type { ReactNode } from "react"

import { cn } from "@/lib/cn"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

export function SettingsCard({
  title,
  description,
  action,
  children,
  footer,
}: {
  title: string
  description?: ReactNode
  /** Beside the title: a link out, or the card's one action. */
  action?: ReactNode
  children: ReactNode
  /** Cancel and Save, for a card whose edits wait to be saved. */
  footer?: ReactNode
}) {
  return (
    <Card className="gap-0 p-0">
      <CardHeader className="flex items-start justify-between gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <CardTitle>{title}</CardTitle>
          {description ? (
            <CardDescription>{description}</CardDescription>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </CardHeader>
      <CardContent className="p-0">
        <FieldGroup className="gap-1 py-1">{children}</FieldGroup>
      </CardContent>
      {footer ? (
        <CardFooter className="justify-end gap-2 border-t px-4 py-2.5">
          {footer}
        </CardFooter>
      ) : null}
    </Card>
  )
}

export function SettingsRow({
  title,
  description,
  htmlFor,
  children,
  titleAddon,
  align = "center",
}: {
  title: ReactNode
  description?: ReactNode
  /** The control's id, when it is one control a label can name. */
  htmlFor?: string
  children?: ReactNode
  titleAddon?: ReactNode
  align?: "center" | "start"
}) {
  return (
    <Field
      className={cn(
        "grid gap-y-2.5 px-4 py-2.5 md:grid-cols-[minmax(0,clamp(15.5rem,43%,17.8rem))_minmax(0,1fr)] md:gap-x-7",
        align === "start" ? "md:items-start" : "md:items-center"
      )}
    >
      <FieldContent className="gap-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {htmlFor ? (
            <FieldLabel htmlFor={htmlFor}>{title}</FieldLabel>
          ) : (
            <FieldTitle>{title}</FieldTitle>
          )}
          {titleAddon}
        </div>
        {description ? (
          <FieldDescription>{description}</FieldDescription>
        ) : null}
      </FieldContent>
      <FieldContent className="w-full min-w-0 md:items-end">
        {children}
      </FieldContent>
    </Field>
  )
}

/** A card's body while what it shows is still being read. */
export function SettingsRowsLoading({
  rows = 2,
  label,
}: {
  rows?: number
  label: string
}) {
  return (
    <div role="status" aria-label={label} className="flex flex-col">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="flex items-center justify-between gap-6 px-4 py-3"
        >
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-56" />
          </div>
          <Skeleton className="h-7 w-24" />
        </div>
      ))}
    </div>
  )
}

export type Choice<TValue extends string> = {
  value: TValue
  label: string
  icon?: ReactNode
}

/** Pick one of a few, all visible: Theme, Transparency, the notes' font. */
export function Segmented<TValue extends string>({
  label,
  value,
  choices,
  onChange,
}: {
  label: string
  value: TValue
  choices: readonly Choice<TValue>[]
  onChange: (value: TValue) => void
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      // A value is always chosen, so pressing the chosen one changes nothing.
      onValueChange={(next) => next && onChange(next as TValue)}
      variant="outline"
      spacing={0}
      size="sm"
      aria-label={label}
    >
      {choices.map((choice) => (
        <ToggleGroupItem
          key={choice.value}
          value={choice.value}
          aria-label={choice.label}
        >
          {choice.icon}
          {choice.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

/** Pick one of a list too long to lay out: a Select at the row's end. */
export function OptionSelect<TValue extends string>({
  id,
  label,
  value,
  choices,
  onChange,
}: {
  id: string
  label: string
  value: TValue
  choices: readonly Choice<TValue>[]
  onChange: (value: TValue) => void
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => next && onChange(next as TValue)}
    >
      <SelectTrigger id={id} aria-label={label} className="w-full md:w-48">
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper">
        <SelectGroup>
          {choices.map((choice) => (
            <SelectItem key={choice.value} value={choice.value}>
              {choice.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
