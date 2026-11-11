/**
 * The Calendar section of the settings tab: the plugin's `timeFormat` and
 * `weekNumbers`, the vault's answers (`plugins.yaml`), which
 * `plugins.local.yaml` may override on one machine.
 *
 * Each control shows what the files resolve to, not its own copy: the write
 * goes through core's validated settings write and the settings cache re-reads
 * when the file changes on disk, so a machine's override keeps showing as the
 * answer it is.
 */
import { toast } from 'sonner'
import { SettingsList, SettingsRow } from '@/composites/settings-ui'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { GOOGLE_INFO } from '../../info'
import type { TimeFormat } from './calendar-format'
import { useTimeFormat, useWeekNumbers, writeCalendarSetting } from './calendar-settings'

const setting = (key: string) => GOOGLE_INFO.settings!.find((s) => s.key === key)!

const CLOCK = setting('timeFormat')
const WEEKS = setting('weekNumbers')
const CLOCKS = CLOCK.type.kind === 'enum' ? CLOCK.type.options : []

export function CalendarSettingsSection({ remote }: { remote: string }): React.JSX.Element {
  const clock = useTimeFormat()
  const weekNumbers = useWeekNumbers()

  const write = (key: 'timeFormat' | 'weekNumbers', value: TimeFormat | boolean) => {
    writeCalendarSetting(remote, key, value)
      .then((warnings) => {
        if (warnings.length > 0) {
          toast.error('That setting did not stick.', { description: warnings.join(' ') })
        }
      })
      .catch((error: unknown) => {
        toast.error("Couldn't save the setting.", {
          description:
            error instanceof Error ? error.message : 'The settings file could not be written.',
        })
      })
  }

  return (
    <SettingsList>
      <SettingsRow
        label={CLOCK.label}
        description={CLOCK.explanation}
        control={
          <ToggleGroup
            type="single"
            aria-label={CLOCK.label}
            variant="outline"
            spacing={0}
            size="sm"
            value={clock}
            // Pressing the current pick reports '', which a pick never is here.
            onValueChange={(next) => next !== '' && write('timeFormat', next as TimeFormat)}
          >
            {CLOCKS.map((option) => (
              <ToggleGroupItem key={String(option.value)} value={String(option.value)}>
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        }
      />
      <SettingsRow
        label={WEEKS.label}
        description={WEEKS.explanation}
        control={
          <Switch
            aria-label={WEEKS.label}
            checked={weekNumbers}
            onCheckedChange={(on) => write('weekNumbers', on)}
          />
        }
      />
    </SettingsList>
  )
}
