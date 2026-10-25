/**
 * What main takes as the dock's icon from the window (docs/ui-system.md,
 * Motion): a PNG data URL of a sane size, and nothing else. Pure, so it is
 * tested without Electron; `ipc.ts` sets the icon.
 */

/** A 1024 PNG is a few hundred kB as base64; much more is not an icon. */
export const MAX_DOCK_ICON = 4_000_000

export function isDockIconPng(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_DOCK_ICON &&
    value.startsWith('data:image/png;base64,')
  )
}
