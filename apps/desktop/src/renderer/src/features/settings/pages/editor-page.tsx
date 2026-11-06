/** Editor: how notes read and behave for you. */
import type { EditorFont, PropertiesLayout, TableStyle } from '@holi/shared'
import { Switch } from '@/components/ui/switch'
import {
  choiceSetting,
  Segmented,
  SettingsGroup,
  SettingsFieldRow,
  SettingsRowsLoading,
} from '../settings-kit'
import { useAtom } from 'jotai'
import { vimCodeEditingAtom } from '@/state/preferences'
import { useVaultSettings } from '../use-vault-settings'

const FONTS = choiceSetting<EditorFont>('editorFont')
const PROPERTIES = choiceSetting<PropertiesLayout>('propertiesLayout')
const TABLES = choiceSetting<TableStyle>('tableStyle')

export function EditorPage() {
  const { resolved, write } = useVaultSettings()
  const [vimCodeEditing, setVimCodeEditing] = useAtom(vimCodeEditingAtom)

  return (
    <SettingsGroup
      title="Writing"
      description="How notes read and what the editor does as you type."
    >
      <SettingsFieldRow
        title="Vim mode"
        description="Use Vim editing in code and plain-text files on this machine. Notes, mail, fields, browser pages and terminals are unchanged."
        htmlFor="settings-vim-code-editing"
      >
        <Switch
          id="settings-vim-code-editing"
          checked={vimCodeEditing}
          onCheckedChange={setVimCodeEditing}
        />
      </SettingsFieldRow>
      {resolved === null ? (
        <SettingsRowsLoading rows={5} label="Reading the settings" />
      ) : (
        <>
          <SettingsFieldRow title={FONTS.title} description={FONTS.description}>
            <Segmented
              label={FONTS.title}
              value={resolved.editorFont}
              choices={FONTS.choices}
              onChange={(font) => void write('editorFont', font)}
            />
          </SettingsFieldRow>
          <SettingsFieldRow title={PROPERTIES.title} description={PROPERTIES.description}>
            <Segmented
              label={PROPERTIES.title}
              value={resolved.propertiesLayout}
              choices={PROPERTIES.choices}
              onChange={(layout) => void write('propertiesLayout', layout)}
            />
          </SettingsFieldRow>
          <SettingsFieldRow title={TABLES.title} description={TABLES.description}>
            <Segmented
              label={TABLES.title}
              value={resolved.tableStyle}
              choices={TABLES.choices}
              onChange={(style) => void write('tableStyle', style)}
            />
          </SettingsFieldRow>
          <SettingsFieldRow
            title="Keep a daily note"
            description="A fresh note each morning, with yesterday's filed away. In a shared vault everyone writes the same one."
            htmlFor="settings-daily-notes"
          >
            <Switch
              id="settings-daily-notes"
              checked={resolved.dailyNotes}
              onCheckedChange={(on) => void write('dailyNotes', on)}
            />
          </SettingsFieldRow>
          <SettingsFieldRow
            title="Space asks the agent"
            description="Space on an empty line starts an ask for the agent, with the note as context. On this machine only."
            htmlFor="settings-space-asks"
          >
            <Switch
              id="settings-space-asks"
              checked={resolved.spaceAsksAgent}
              onCheckedChange={(on) => void write('spaceAsksAgent', on)}
            />
          </SettingsFieldRow>
        </>
      )}
    </SettingsGroup>
  )
}
