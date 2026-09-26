/**
 * Every row filed under one section, from `VAULT_SETTING_DESCRIPTORS`.
 *
 * **Claims its rows rather than being handed them.** Descriptors say which
 * section they belong to (`descriptor.section`), so adding a setting means
 * adding one descriptor and touching nothing here.
 */
import { VAULT_SETTING_DESCRIPTORS } from '@holi/shared'
import { SettingRow } from './SettingRow'
import { SettingsList } from './settings-ui'
import { useVaultSettings } from './useVaultSettings'

/** The descriptors filed under a section, in the order the shared list declares
 *  them. */
export function descriptorsIn(section: string) {
  return VAULT_SETTING_DESCRIPTORS.filter((d) => d.section === section)
}

export function DescriptorSection({ section }: { section: string }): React.JSX.Element {
  const { values, change, warningsFor } = useVaultSettings()

  return (
    <SettingsList>
      {descriptorsIn(section).map((descriptor) => (
        <SettingRow
          key={descriptor.key}
          descriptor={descriptor}
          settings={values}
          onChange={(_, value) => void change(descriptor, value)}
          warnings={warningsFor(descriptor.key)}
        />
      ))}
    </SettingsList>
  )
}
