/**
 * A running plugin's own settings, as rows in its section of the settings tab
 * (`settingsSectionsAtom` makes one per running plugin that declares any).
 *
 * The rows are read off `PluginInfo.settings`, so a plugin adds a row by
 * declaring a setting and nothing here changes. Each answer is written to the
 * plugins file its setting names, through the same `settings.write` the rest
 * of the tab uses.
 */
import { useState } from 'react'
import { pluginSettingValue, type PluginInfo, type PluginSetting } from '@holi/shared'
import { Button, Checkbox, Input, Textarea } from '@/primitives'
import { SettingsList, SettingsNote, SettingsRow } from '@/composites'
import { Layer } from './SettingRow'
import { useVaultSettings } from './useVaultSettings'

export function PluginSettingsSection({ info }: { info: PluginInfo }): React.JSX.Element {
  const { resolved, changePlugin, warningsFor } = useVaultSettings()
  return (
    <SettingsList>
      {(info.settings ?? []).map((setting) => (
        <PluginSettingRow
          key={setting.key}
          setting={setting}
          value={pluginSettingValue(resolved?.pluginValues ?? {}, info, setting.key)}
          onChange={(value) => void changePlugin(info, setting, value)}
          warnings={warningsFor(`${info.id}.${setting.key}`)}
        />
      ))}
    </SettingsList>
  )
}

function PluginSettingRow({
  setting,
  value,
  onChange,
  warnings,
}: {
  setting: PluginSetting
  value: unknown
  onChange: (value: unknown) => void
  warnings: string[]
}): React.JSX.Element {
  const { label, explanation, type } = setting
  return (
    <SettingsRow
      label={label}
      description={explanation}
      meta={<Layer target={setting.target} file="plugins" />}
      control={
        type.kind === 'boolean' ? (
          <Checkbox
            checked={value === true}
            onCheckedChange={(next) => onChange(next === true)}
            aria-label={label}
          />
        ) : type.kind === 'enum' ? (
          <div role="radiogroup" aria-label={label} className="flex flex-wrap justify-end gap-1.5">
            {type.options.map((option) => (
              <Button
                key={option.label}
                type="button"
                variant={option.value === value ? 'secondary' : 'ghost'}
                size="xs"
                role="radio"
                aria-checked={option.value === value}
                onClick={() => onChange(option.value)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        ) : type.kind === 'number' || type.kind === 'text' ? (
          <CommitInput
            label={label}
            numeric={type.kind === 'number'}
            value={String(value ?? '')}
            onCommit={(text) => {
              if (type.kind === 'text') onChange(text)
              else if (text.trim() !== '' && Number.isFinite(Number(text))) onChange(Number(text))
            }}
          />
        ) : undefined
      }
    >
      {type.kind === 'list' && (
        <CommitTextarea
          label={label}
          value={(value as string[]).join('\n')}
          onCommit={(text) =>
            onChange(
              text
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line !== ''),
            )
          }
        />
      )}
      {type.kind === 'switches' && (
        <Switches value={value as Record<string, boolean>} onChange={onChange} />
      )}
      {warnings.map((warning) => (
        <p key={warning} className="text-[11px] text-destructive">
          {warning}
        </p>
      ))}
    </SettingsRow>
  )
}

/** A text field that writes when you leave it or press Enter, not per key:
 *  each write is a file write in the vault. */
function CommitInput({
  label,
  numeric,
  value,
  onCommit,
}: {
  label: string
  numeric: boolean
  value: string
  onCommit: (text: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft)
    setDraft(null)
  }
  return (
    <Input
      aria-label={label}
      inputMode={numeric ? 'decimal' : undefined}
      className="w-56"
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') setDraft(null)
      }}
    />
  )
}

/** One entry per line, written when you leave the field. */
function CommitTextarea({
  label,
  value,
  onCommit,
}: {
  label: string
  value: string
  onCommit: (text: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <Textarea
      aria-label={label}
      rows={3}
      placeholder="One per line"
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== value) onCommit(draft)
        setDraft(null)
      }}
    />
  )
}

/** On or off per name. The names come from the plugin as it learns them, so
 *  with none yet there is nothing to switch. */
function Switches({
  value,
  onChange,
}: {
  value: Record<string, boolean>
  onChange: (value: Record<string, boolean>) => void
}): React.JSX.Element {
  const names = Object.keys(value)
  if (names.length === 0) return <SettingsNote>Nothing to switch yet.</SettingsNote>
  return (
    <div className="flex flex-col gap-2">
      {names.map((name) => (
        <label key={name} className="flex items-center gap-2.5 text-xs">
          <Checkbox
            checked={value[name] === true}
            onCheckedChange={(next) => onChange({ ...value, [name]: next === true })}
            aria-label={name}
          />
          {name}
        </label>
      ))}
    </div>
  )
}
