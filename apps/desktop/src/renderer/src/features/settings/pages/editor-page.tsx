/** Editor: how notes read and behave for you. */
import { EDITOR_FONTS, type EditorFont } from '@holi/shared'
import { Switch } from '@/components/ui/switch'
import {
  Segmented,
  SettingsGroup,
  SettingsFieldRow,
  SettingsRowsLoading,
  type Choice,
} from '../settings-kit'
import { useVaultSettings } from '../use-vault-settings'

const FONT_LABEL: Record<EditorFont, string> = {
  serif: 'Serif',
  sans: 'Sans',
  mono: 'Mono',
}

const FONTS: readonly Choice<EditorFont>[] = EDITOR_FONTS.map((font) => ({
  value: font,
  label: FONT_LABEL[font],
}))

export function EditorPage() {
  const { resolved, write } = useVaultSettings()

  return (
    <SettingsGroup
      title="Writing"
      description="How notes read and what the editor does as you type."
    >
      {resolved === null ? (
        <SettingsRowsLoading rows={3} label="Reading the settings" />
      ) : (
        <>
          <SettingsFieldRow
            title="Notes are set in"
            description="Prose only. Code and frontmatter stay monospaced. On this machine only."
          >
            <Segmented
              label="Notes are set in"
              value={resolved.editorFont}
              choices={FONTS}
              onChange={(font) => void write('editorFont', font)}
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
