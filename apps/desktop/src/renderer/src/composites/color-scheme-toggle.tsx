import { useAtomValue, useSetAtom } from 'jotai'
import type { ColorScheme } from '@holi/shared'

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { COLOR_SCHEMES, colorSchemeAtom, writeColorSchemeAtom } from '@/state/color-scheme'

/** Light, dark or the OS's, as one pressed segment. The vault's machine-local
 *  `colorScheme`, which `useColorScheme` stamps on <html> as `data-theme`. */
export function ColorSchemeToggle() {
  const current = useAtomValue(colorSchemeAtom)
  const setScheme = useSetAtom(writeColorSchemeAtom)

  return (
    <ToggleGroup
      type="single"
      value={current}
      // A scheme is always set, so pressing the active one again changes nothing.
      onValueChange={(value) => value && void setScheme(value as ColorScheme)}
      variant="outline"
      spacing={0}
      size="sm"
      aria-label="Theme"
    >
      {COLOR_SCHEMES.map(({ value, label, icon: Icon }) => (
        <ToggleGroupItem key={value} value={value} aria-label={label}>
          <Icon aria-hidden="true" />
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
