/**
 * The ritual's settings act: how this vault behaves, asked once, at birth.
 *
 * **Renders the list; does not know the list.** Every row comes from the
 * descriptors asked at birth, with the commit transforms of core and of the
 * plugins the act before kept on: a transform of a plugin turned off would be
 * a question about something this vault will not run.
 *
 * **The ritual's list is a subset.** A preference with a good default and no
 * consequence at a vault's first moment lives in the settings tab instead;
 * `askedAtBirth` is where each row says which it is.
 *
 * **One row per question** (`SettingCard`, stacked in one `Frame`), each
 * with its mark: a switch sits beside the heading, a choice is pills under
 * it, a group is a list of switches under it.
 *
 * Nothing here is required. The seed has already written every default, so
 * clicking straight through is a no-op.
 */
import {
  SETTINGS_FILE,
  VAULT_SETTING_DEFAULTS,
  availableOptions,
  resolvePlugins,
  knownTransforms,
  vaultSettingDescriptors,
  type PluginSettings,
  type VaultSettingDescriptor,
} from '@holi/shared'
import { useAtomValue } from 'jotai'
import {
  CalendarDays,
  GitCommitHorizontal,
  House,
  SlidersHorizontal,
  SunMoon,
  type LucideIcon,
} from 'lucide-react'
import { installedPluginsAtom } from '@/state/plugins'
import { SettingCard } from '@/composites/setting-card'
import { Badge } from '@/components/reui/badge'
import { Frame } from '@/components/reui/frame'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

interface Props {
  /** The answers so far, keyed by descriptor. A missing key falls back to the
   *  descriptor's own default, so a row added later still renders. */
  settings: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
}

/** Each question's mark, by setting key; one without falls back to sliders. */
const MARKS: Record<string, LucideIcon> = {
  dailyNotes: CalendarDays,
  home: House,
  hooks: GitCommitHorizontal,
  colorScheme: SunMoon,
}

/** Structural equality: an option's value may be any value the setting holds,
 *  and the answer a different object of that shape. */
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function Row({
  descriptor,
  settings,
  onChange,
  owners,
}: {
  descriptor: VaultSettingDescriptor
  settings: Record<string, unknown>
  onChange: Props['onChange']
  /** A transform's plugin, by transform name, for the ones a plugin runs. */
  owners: ReadonlyMap<string, string>
}) {
  const { key, label, explanation, control } = descriptor
  const value = settings[key] ?? descriptor.default
  const Mark = MARKS[key] ?? SlidersHorizontal
  const mark = <Mark aria-hidden className="size-5" />

  if (control.kind === 'toggle')
    return (
      <SettingCard
        mark={mark}
        title={label}
        description={explanation}
        data-setting={key}
        pressable
        control={
          <Switch
            checked={value === true}
            onCheckedChange={(next) => onChange(key, next === true)}
            aria-label={label}
          />
        }
      />
    )

  if (control.kind === 'choice') {
    // Filtered, not disabled: a greyed-out choice invites "why not?" and the
    // answer is already one row up. Pills take string values, so each option
    // is its index; the value itself may be a number or an object.
    const options = availableOptions(descriptor, settings)
    return (
      <SettingCard mark={mark} title={label} description={explanation} data-setting={key}>
        <ToggleGroup
          type="single"
          size="sm"
          spacing={1}
          aria-label={label}
          value={String(options.findIndex((o) => same(o.value, value)))}
          onValueChange={(i) => {
            // Pressing the picked pill again deselects it; a choice always stays.
            const option = options[Number(i)]
            if (i !== '' && option !== undefined) onChange(key, option.value)
          }}
          className="flex-wrap self-start"
        >
          {options.map((o, i) => (
            <ToggleGroupItem key={i} value={String(i)}>
              {o.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </SettingCard>
    )
  }

  // A group: one switch per thing it runs, each with its own line.
  const block = (value ?? {}) as Record<string, boolean>
  return (
    <SettingCard mark={mark} title={label} description={explanation} data-setting={key}>
      <div className="flex flex-col divide-y divide-border/60 rounded-lg border border-border/60">
        {control.kind === 'group' &&
          control.toggles.map((toggle) => {
            const owner = owners.get(toggle.key)
            return (
              <Label key={toggle.key} className="cursor-pointer leading-normal font-normal">
                <span className="flex w-full items-start gap-3 px-3 py-2.5">
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {toggle.label}
                      {owner !== undefined && (
                        <Badge variant="outline" radius="full">
                          {owner}
                        </Badge>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">{toggle.explanation}</span>
                  </span>
                  <Switch
                    className="mt-0.5"
                    checked={block[toggle.key] === true}
                    // The whole block, not just the switch that moved: a patch
                    // naming one transform must not read as an answer about the
                    // others.
                    onCheckedChange={(next) =>
                      onChange(key, { ...block, [toggle.key]: next === true })
                    }
                    aria-label={`${toggle.label}. ${toggle.explanation}`}
                  />
                </span>
              </Label>
            )
          })}
      </div>
    </SettingCard>
  )
}

export function VaultSettingsAct({ settings, onChange }: Props) {
  const infos = useAtomValue(installedPluginsAtom).map((p) => p.info)
  const { running: on } = resolvePlugins(
    (settings.plugins as PluginSettings | undefined) ?? VAULT_SETTING_DEFAULTS.plugins,
    infos,
  )
  const kept = infos.filter((info) => on.has(info.id))
  const asked = vaultSettingDescriptors(knownTransforms(kept)).filter((d) => d.askedAtBirth)
  const owners = new Map(
    kept.flatMap((info) => (info.transforms ?? []).map((t) => [t.name, info.label])),
  )
  return (
    <>
      <Frame stacked>
        {asked.map((descriptor) => (
          <Row
            key={descriptor.key}
            descriptor={descriptor}
            settings={settings}
            onChange={onChange}
            owners={owners}
          />
        ))}
      </Frame>
      {/* Once for the act rather than under every row: the same answer to the
          same question, eight times over, was the loudest thing on screen. */}
      <p className="text-xs text-muted-foreground">
        Change any of these later in Settings, or in{' '}
        <code className="font-mono">{SETTINGS_FILE}</code>.
      </p>
    </>
  )
}
