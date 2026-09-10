/**
 * One setting, rendered from its descriptor.
 *
 * Extracted from `SettingsView` when the tab gained a rail: the rows are no
 * longer one list in one component, they are whatever the section on screen
 * claims from `VAULT_SETTING_DESCRIPTORS`. The row itself did not change.
 */
import { TriangleAlert } from 'lucide-react'
import {
  SETTINGS_FILE,
  SETTINGS_LOCAL_FILE,
  availableOptions,
  type VaultSettingDescriptor,
} from '@holi/shared'
import { Button, Checkbox, Tooltip } from '@/primitives'

/** The one setting whose value is a statement about an event that has already
 *  happened by the time you can change it. Everything else applies as you go. */
const APPLIES_ON_NEXT_OPEN = new Set<string>(['landing'])

export function Layer({
  target,
}: {
  target: VaultSettingDescriptor['target']
}): React.JSX.Element {
  const committed = target === 'committed'
  return (
    <Tooltip
      content={
        committed
          ? `shared with the vault — written to ${SETTINGS_FILE}`
          : `this machine only — written to ${SETTINGS_LOCAL_FILE}, which is never committed`
      }
    >
      <span className="rounded border border-border px-1.5 py-0.5 text-[10px] leading-4 text-muted-foreground">
        {committed ? 'vault' : 'this machine'}
      </span>
    </Tooltip>
  )
}

export function SettingRow({
  descriptor,
  settings,
  onChange,
  warnings,
}: {
  descriptor: VaultSettingDescriptor
  settings: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
  warnings: string[]
}): React.JSX.Element {
  const { key, label, explanation, control } = descriptor
  const value = settings[key] ?? descriptor.default

  return (
    <div
      role="group"
      aria-label={label}
      data-setting={key}
      className="flex flex-col gap-2 border-b border-border py-4 last:border-b-0"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{label}</span>
            <Layer target={descriptor.target} />
            {APPLIES_ON_NEXT_OPEN.has(key) && (
              <span className="text-[10px] leading-4 text-muted-foreground">
                takes effect next time this vault opens
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{explanation}</p>
        </div>

        {control.kind === 'toggle' && (
          <Checkbox
            checked={value === true}
            onCheckedChange={(next) => onChange(key, next === true)}
            aria-label={label}
          />
        )}
      </div>

      {control.kind === 'choice' && (
        <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
          {/* Filtered, not disabled — the same call the ritual makes. A greyed
              out choice invites "why not?" and the answer is another row. */}
          {availableOptions(descriptor, settings).map((option) => (
            <Button
              key={option.label}
              type="button"
              variant={
                JSON.stringify(option.value) === JSON.stringify(value) ? 'secondary' : 'ghost'
              }
              size="xs"
              role="radio"
              // Structural equality: a `landing` option's value is an object, and
              // the answer is a different object with the same shape.
              aria-checked={JSON.stringify(option.value) === JSON.stringify(value)}
              onClick={() => onChange(key, option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      )}

      {control.kind === 'group' && (
        <div className="flex flex-col gap-2 pt-1">
          {control.toggles.map((toggle) => {
            const block = (value ?? {}) as Record<string, boolean>
            return (
              <label key={toggle.key} className="flex items-start gap-2.5">
                <Checkbox
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
                <span className="min-w-0">
                  <span className="text-xs">{toggle.label}</span>
                  <span className="ml-1.5 text-xs text-muted-foreground">{toggle.explanation}</span>
                </span>
              </label>
            )
          })}
        </div>
      )}

      {/* The resolver's own complaint about this key, which until the tab
          existed nothing displayed at all — a value dropped for being malformed
          was silently replaced by a default and never mentioned. */}
      {warnings.map((warning) => (
        <p key={warning} className="flex items-start gap-1.5 text-xs text-destructive">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          {warning}
        </p>
      ))}
    </div>
  )
}
