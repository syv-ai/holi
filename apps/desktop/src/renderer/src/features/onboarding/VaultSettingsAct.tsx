/**
 * The ritual's settings act — how this vault behaves, asked once, at birth.
 *
 * **Renders the list; does not know the list.** Every row comes from
 * `VAULT_SETTING_DESCRIPTORS`, which is also what `seed-content.ts` builds the
 * vault's `settings.json` from. Adding a setting later is adding a descriptor —
 * this file should not need touching, and the tests assert against the list's
 * length rather than a number so that stays true.
 *
 * Nothing here is required. Every row carries a default and the seed has already
 * written it, so clicking straight through is a no-op rather than a choice
 * deferred.
 */
import { VAULT_SETTING_DESCRIPTORS, type VaultSettingDescriptor } from '@holi/shared'
import { Button, Checkbox } from '@/primitives'

interface Props {
  /** The answers so far, keyed by descriptor. A missing key falls back to the
   *  descriptor's own default, so a row added later still renders. */
  settings: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
}

/** A pill in a `choice`.
 *
 *  Composes the `Button` primitive rather than a native element (the
 *  `no-restricted-syntax` boundary), and carries **radio** semantics: the group
 *  is one decision with one answer, so `role="radio"` is what says so to anyone
 *  not looking at the pills. The ritual's own `obrit-choice-pill` supplies the
 *  look, since this palette is self-contained and not the app's. */
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
}: {
  descriptor: VaultSettingDescriptor
  settings: Record<string, unknown>
  onChange: Props['onChange']
}) {
  const { key, label, explanation, control, whereToChange } = descriptor
  const value = settings[key] ?? descriptor.default

  return (
    <div className="obrit-setting" role="group" aria-label={label} data-setting={key}>
      <div className="obrit-setting-head">
        <div className="obrit-setting-label">{label}</div>
        <p className="obrit-setting-explain">{explanation}</p>
      </div>

      <div className="obrit-setting-control">
        {control.kind === 'toggle' && (
          <Checkbox
            checked={value === true}
            onCheckedChange={(next) => onChange(key, next === true)}
            aria-label={label}
          />
        )}

        {control.kind === 'choice' && (
          <div role="radiogroup" aria-label={label} className="obrit-choice-row">
            {control.options.map((option) => (
              <ChoicePill
                key={option.label}
                label={option.label}
                // Structural equality: a `landing` option's value is an object,
                // and the answer is a different object with the same shape.
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
              return (
                <label key={toggle.key} className="obrit-setting-sub">
                  <Checkbox
                    checked={block[toggle.key] === true}
                    // The whole block, not just the switch that moved: a patch
                    // naming one transform must not read as an answer about the
                    // other two.
                    onCheckedChange={(next) =>
                      onChange(key, { ...block, [toggle.key]: next === true })
                    }
                    aria-label={`${toggle.label} — ${toggle.explanation}`}
                  />
                  <span className="obrit-setting-sub-label">{toggle.label}</span>
                  <span className="obrit-setting-sub-explain">{toggle.explanation}</span>
                </label>
              )
            })}
          </div>
        )}
      </div>

      <div className="obrit-setting-where">{whereToChange}</div>
    </div>
  )
}

export function VaultSettingsAct({ settings, onChange }: Props) {
  return (
    <div className="obrit-settings">
      {VAULT_SETTING_DESCRIPTORS.map((descriptor) => (
        <Row key={descriptor.key} descriptor={descriptor} settings={settings} onChange={onChange} />
      ))}
    </div>
  )
}
