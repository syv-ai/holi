/** Commits: what a commit does. */
import { useAtomValue } from 'jotai'
import { VAULT_SETTING_DEFAULTS } from '@holi/shared'
import { Switch } from '@/components/ui/switch'
import { settingDescriptorsAtom } from '@/state/plugins'
import {
  OptionSelect,
  SettingsGroup,
  SettingsFieldRow,
  SettingsRowsLoading,
  type Choice,
} from '../settings-kit'
import { useVaultSettings } from '../use-vault-settings'

const MB = 1024 * 1024

export function CommitsPage() {
  const { resolved, write } = useVaultSettings()
  const descriptors = useAtomValue(settingDescriptorsAtom)
  const limit = descriptors.find((d) => d.key === 'maxCommittedFileBytes')
  const hooks = descriptors.find((d) => d.key === 'hooks')
  const sizes: Choice<string>[] =
    limit?.control.kind === 'choice'
      ? limit.control.options.map((option) => ({
          value: String(option.value),
          label: option.label,
        }))
      : []
  const toggles = hooks?.control.kind === 'group' ? hooks.control.toggles : []

  if (resolved === null) {
    return (
      <SettingsGroup title="Saving" description="What happens to each commit.">
        <SettingsRowsLoading rows={3} label="Reading the settings" />
      </SettingsGroup>
    )
  }

  const current = String(resolved.maxCommittedFileBytes)
  // A hand-written size none of the options name still shows as itself.
  const sizeChoices = sizes.some((size) => size.value === current)
    ? sizes
    : [
        ...sizes,
        {
          value: current,
          label: `${Math.round(resolved.maxCommittedFileBytes / MB)} MB`,
        },
      ]

  return (
    <>
      <SettingsGroup
        title="Saving"
        description="Your work is committed and pushed as you go. These apply to everyone in the vault."
      >
        <SettingsFieldRow
          title="Largest file to commit"
          description="Anything bigger is left out and reported, rather than pushed to everyone. GitHub refuses files over 100 MB."
          htmlFor="settings-max-file"
        >
          <OptionSelect
            id="settings-max-file"
            label="Largest file to commit"
            value={current}
            choices={sizeChoices}
            onChange={(bytes) => void write('maxCommittedFileBytes', Number(bytes), 'committed')}
          />
        </SettingsFieldRow>
      </SettingsGroup>
      <SettingsGroup
        title="Tidy on every commit"
        description="Each runs as your work is saved. None can stop a save."
      >
        {toggles.map((toggle) => {
          const block = resolved.hooks ?? VAULT_SETTING_DEFAULTS.hooks
          const id = `settings-hook-${toggle.key}`
          return (
            <SettingsFieldRow
              key={toggle.key}
              title={toggle.label}
              description={toggle.explanation}
              htmlFor={id}
            >
              <Switch
                id={id}
                checked={block[toggle.key] === true}
                // The whole block: a patch naming one transform must not read
                // as an answer about the others.
                onCheckedChange={(on) =>
                  void write('hooks', { ...block, [toggle.key]: on }, 'committed')
                }
              />
            </SettingsFieldRow>
          )
        })}
      </SettingsGroup>
    </>
  )
}
