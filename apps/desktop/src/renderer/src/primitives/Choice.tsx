/**
 * `PillGroup`: one choice among a few, as pills: a `ToggleGroup` with a
 * value-picking API. State is background only; nothing here draws an edge.
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { ToggleGroup, ToggleGroupItem } from './ToggleGroup'

export type PillOption<T extends string> = { value: T; label: ReactNode }

/**
 * Pills for one choice among a few, or several (`multiple`), on `ToggleGroup`.
 * Every press calls `onPick` with its pill's value, the current pick's
 * included, so the caller decides what a press means. `active` marks the pill
 * a keyboard is on (the focus ring), for a group stepped by arrow keys from
 * outside; `tabbable={false}` keeps the pills out of the Tab order for the
 * same reason.
 */
export function PillGroup<T extends string>({
  options,
  isOn,
  onPick,
  active,
  label,
  multiple = false,
  tabbable = true,
  className,
}: {
  options: readonly PillOption<T>[]
  isOn: (value: T) => boolean
  onPick: (value: T) => void
  active?: T
  /** The group's accessible name. */
  label: string
  multiple?: boolean
  tabbable?: boolean
  className?: string
}): React.JSX.Element {
  const on = options.filter((o) => isOn(o.value)).map((o) => o.value)
  const items = options.map((option) => (
    <ToggleGroupItem
      key={option.value}
      value={option.value}
      data-value={option.value}
      data-active={active === option.value ? '' : undefined}
      tabIndex={tabbable ? undefined : -1}
      // The press itself, not the group's change: Radix reports a press on
      // the current single pick as a deselect, which a pick never is here.
      onClick={() => onPick(option.value)}
      className="data-active:ring-1 data-active:ring-ring"
    >
      {option.label}
    </ToggleGroupItem>
  ))
  const shared = {
    'aria-label': label,
    size: 'sm' as const,
    spacing: 1,
    rovingFocus: tabbable,
    className: cn('flex-wrap', className),
  }
  return multiple ? (
    <ToggleGroup type="multiple" value={on} {...shared}>
      {items}
    </ToggleGroup>
  ) : (
    <ToggleGroup type="single" value={on[0] ?? ''} {...shared}>
      {items}
    </ToggleGroup>
  )
}
