/**
 * Every row filed under one section, from the settings descriptors with the
 * installed plugins' commit transforms (`settingDescriptorsAtom`).
 *
 * **Claims its rows rather than being handed them.** Descriptors say which
 * section they belong to (`descriptor.section`), so adding a setting means
 * adding one descriptor and touching nothing here.
 */
import type { VaultSettingDescriptor } from '@holi/shared'
import { useAtomValue } from 'jotai'
import { settingDescriptorsAtom } from '@/state/plugins'
import { SettingRow } from './SettingRow'
import { SettingsList } from '@/composites'
import { useVaultSettings } from './useVaultSettings'

/** The descriptors filed under a section, in the order the shared list declares
 *  them. */
export function descriptorsIn(
  descriptors: readonly VaultSettingDescriptor[],
  section: string,
): VaultSettingDescriptor[] {
  return descriptors.filter((d) => d.section === section)
}

export function DescriptorSection({ section }: { section: string }): React.JSX.Element {
  const { values, change, warningsFor } = useVaultSettings()
  const descriptors = useAtomValue(settingDescriptorsAtom)

  return (
    <SettingsList>
      {descriptorsIn(descriptors, section).map((descriptor) => (
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
