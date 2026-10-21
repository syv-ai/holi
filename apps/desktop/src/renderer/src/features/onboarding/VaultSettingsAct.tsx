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
import { installedPluginsAtom } from '@/state/plugins'
import { Button, Switch } from '@/primitives'

interface Props {
  /** The answers so far, keyed by descriptor. A missing key falls back to the
   *  descriptor's own default, so a row added later still renders. */
  settings: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
}

/** A pill in a `choice`, with **radio** semantics: the group is one decision
 *  with one answer. The ritual's own `obrit-choice-pill` supplies the look,
 *  since this palette is self-contained and not the app's. */
function ChoicePill({
  label,
  checked,
  onSelect,
}: {
  label: string
  checked: boolean
  onSelect: () => void
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={`obrit-choice-pill${checked ? ' is-on' : ''}`}
    >
      {label}
    </Button>
  )
}

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

  return (
    <div
      className="obrit-setting"
      role="group"
      aria-label={label}
      data-setting={key}
      data-kind={control.kind}
    >
      <div className="obrit-setting-head">
        <div className="obrit-setting-label">{label}</div>
        <p className="obrit-setting-explain">{explanation}</p>
      </div>

      <div className="obrit-setting-control">
        {control.kind === 'toggle' && (
          <Switch
            checked={value === true}
            onCheckedChange={(next) => onChange(key, next === true)}
            aria-label={label}
          />
        )}

        {control.kind === 'choice' && (
          <div role="radiogroup" aria-label={label} className="obrit-choice-row">
            {/* Filtered, not disabled: a greyed-out choice invites "why not?"
                and the answer is already one row up. */}
            {availableOptions(descriptor, settings).map((option) => (
              <ChoicePill
                key={option.label}
                label={option.label}
                // Structural equality: an option's value may be any value the
                // setting holds, and the answer a different object of that shape.
                checked={JSON.stringify(option.value) === JSON.stringify(value)}
                onSelect={() => onChange(key, option.value)}
              />
            ))}
          </div>
        )}

        {control.kind === 'group' && (
          <div className="obrit-setting-group">
            {control.toggles.map((toggle) => {
              const block = (value ?? {}) as Record<string, boolean>
              const owner = owners.get(toggle.key)
              return (
                <label key={toggle.key} className="obrit-setting-sub">
                  <Switch
                    checked={block[toggle.key] === true}
                    // The whole block, not just the switch that moved: a patch
                    // naming one transform must not read as an answer about the
                    // others.
                    onCheckedChange={(next) =>
                      onChange(key, { ...block, [toggle.key]: next === true })
                    }
                    aria-label={`${toggle.label}. ${toggle.explanation}`}
                  />
                  <span className="obrit-setting-sub-label">
                    {toggle.label}
                    {owner !== undefined && <span className="obrit-setting-owner">{owner}</span>}
                  </span>
                  <span className="obrit-setting-sub-explain">{toggle.explanation}</span>
                </label>
              )
            })}
          </div>
        )}
      </div>
    </div>
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
      <div className="obrit-settings">
        {asked.map((descriptor) => (
          <Row
            key={descriptor.key}
            descriptor={descriptor}
            settings={settings}
            onChange={onChange}
            owners={owners}
          />
        ))}
      </div>
      {/* Once for the act rather than under every row: the same answer to the
          same question, eight times over, was the loudest thing on screen. */}
      <p className="obrit-settings-where">
        Change any of these later in Settings, or in <code>{SETTINGS_FILE}</code>.
      </p>
    </>
  )
}
