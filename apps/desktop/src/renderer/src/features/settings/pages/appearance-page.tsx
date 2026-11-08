/** Appearance: how this machine's window looks (theme, glass), and how the
 *  vault's Calendar writes times and weeks, which is the vault's answer. */
import { useAtomValue, useSetAtom } from 'jotai'
import {
  VAULT_SETTING_DEFAULTS,
  type ColorScheme,
  type TimeFormat,
  type WindowGlass,
} from '@holi/shared'
import { Switch } from '@/components/ui/switch'
import { COLOR_SCHEMES, colorSchemeAtom, writeColorSchemeAtom } from '@/state/color-scheme'
import { isMac } from '@/lib/platform'
import { windowGlassAtom, writeWindowGlassAtom } from '@/state/window-glass'
import { BlendIcon, SquareDashedIcon, SquareIcon } from 'lucide-react'
import {
  choiceSetting,
  Segmented,
  SettingsGroup,
  SettingsFieldRow,
  type Choice,
} from '../settings-kit'
import { useVaultSettings } from '../use-vault-settings'

const THEMES: readonly Choice<ColorScheme>[] = COLOR_SCHEMES.map(
  ({ value, label, icon: Glyph }) => ({
    value,
    label,
    icon: <Glyph aria-hidden="true" />,
  }),
)

const GLASSES: readonly Choice<WindowGlass>[] = [
  {
    value: 'clear',
    label: 'Clear',
    icon: <SquareDashedIcon aria-hidden="true" />,
  },
  {
    value: 'frosted',
    label: 'Frosted',
    icon: <BlendIcon aria-hidden="true" />,
  },
  { value: 'solid', label: 'Solid', icon: <SquareIcon aria-hidden="true" /> },
]

const CLOCKS = choiceSetting<TimeFormat>('timeFormat')

export function AppearancePage() {
  // The same atoms the profile menu's toggles write: one setting, two doors.
  const scheme = useAtomValue(colorSchemeAtom)
  const setScheme = useSetAtom(writeColorSchemeAtom)
  const glass = useAtomValue(windowGlassAtom)
  const setGlass = useSetAtom(writeWindowGlassAtom)
  // The arcade is the open vault's machine-local file, like Space-to-ask.
  const { resolved, write } = useVaultSettings()

  return (
    <>
      <SettingsGroup
        title="Window"
        description="How Holi looks on this machine. Your teammates keep their own."
      >
        <SettingsFieldRow
          title="Theme"
          description="Light, dark, or whatever your system is set to."
        >
          <Segmented
            label="Theme"
            value={scheme}
            choices={THEMES}
            onChange={(next) => void setScheme(next)}
          />
        </SettingsFieldRow>
        {/* The window is glass only on a Mac. */}
        {isMac() ? (
          <SettingsFieldRow
            title="Transparency"
            description="How much of the desktop shows through the window."
          >
            <Segmented
              label="Transparency"
              value={glass}
              choices={GLASSES}
              onChange={(next) => void setGlass(next)}
            />
          </SettingsFieldRow>
        ) : null}
        <SettingsFieldRow
          title="Arcade on the New tab"
          description="Your Holis play a small game behind an empty tab: they file papers in the outbox, and you can take over with the arrow keys."
          htmlFor="settings-grid-arcade"
        >
          <Switch
            id="settings-grid-arcade"
            disabled={resolved === null}
            checked={resolved?.gridArcade ?? true}
            onCheckedChange={(on) => void write('gridArcade', on)}
          />
        </SettingsFieldRow>
        <SettingsFieldRow
          title="Confirm before closing split tabs"
          description="Ask before closing a tab entry that contains multiple views, including when closing other tabs or all tabs."
          htmlFor="settings-confirm-close-split-tabs"
        >
          <Switch
            id="settings-confirm-close-split-tabs"
            disabled={resolved === null}
            checked={
              resolved?.confirmCloseSplitTabs ?? VAULT_SETTING_DEFAULTS.confirmCloseSplitTabs
            }
            onCheckedChange={(on) => void write('confirmCloseSplitTabs', on)}
          />
        </SettingsFieldRow>
        <SettingsFieldRow
          title="Fold the sidebar in Mail and Calendar"
          description="Mail or Calendar in front folds the files sidebar to its rail, and leaving gives it back. ⌘B opens it either way."
          htmlFor="settings-fold-sidebar"
        >
          <Switch
            id="settings-fold-sidebar"
            disabled={resolved === null}
            checked={resolved?.foldSidebarForApps ?? true}
            onCheckedChange={(on) => void write('foldSidebarForApps', on)}
          />
        </SettingsFieldRow>
      </SettingsGroup>
      <SettingsGroup
        title="Calendar"
        description="How the Calendar writes times and weeks, for everyone in this vault."
      >
        <SettingsFieldRow title={CLOCKS.title} description={CLOCKS.description}>
          <Segmented
            label={CLOCKS.title}
            value={resolved?.timeFormat ?? VAULT_SETTING_DEFAULTS.timeFormat}
            choices={CLOCKS.choices}
            onChange={(clock) => void write('timeFormat', clock)}
          />
        </SettingsFieldRow>
        <SettingsFieldRow
          title="Week numbers"
          description="ISO week numbers, Monday first, down the side of the month."
          htmlFor="settings-week-numbers"
        >
          <Switch
            id="settings-week-numbers"
            disabled={resolved === null}
            checked={resolved?.weekNumbers ?? VAULT_SETTING_DEFAULTS.weekNumbers}
            onCheckedChange={(on) => void write('weekNumbers', on)}
          />
        </SettingsFieldRow>
      </SettingsGroup>
    </>
  )
}
