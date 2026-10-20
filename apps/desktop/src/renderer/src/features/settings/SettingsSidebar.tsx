/**
 * The sidebar while Settings is the tab in front (after Linear): Back, then
 * the sections as the rail, in place of the vault's places and files. The
 * content stays in the tab; the section is shared through
 * `settingsSectionAtom`, a heading jump through `settingsJumpAtom`.
 */
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { ChevronLeft } from 'lucide-react'
import { Button, Icon } from '@/primitives'
import { closeActiveTabAtom } from '@/state/pane-exit'
import { settingsJumpAtom, settingsSectionAtom } from '@/state/settings-section'
import { SettingsRail } from './SettingsRail'
import { DEFAULT_SECTION_ID, settingsSectionsAtom } from './sections'

export function SettingsSidebar(): React.JSX.Element {
  const sections = useAtomValue(settingsSectionsAtom)
  const [chosen, setSection] = useAtom(settingsSectionAtom)
  const setJump = useSetAtom(settingsJumpAtom)
  const back = useSetAtom(closeActiveTabAtom)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-0.5 px-2 pt-2">
        <Button
          variant="ghost"
          className="h-7 justify-start gap-2 rounded-lg px-2 text-nav font-medium text-muted-foreground motion-respond hover:bg-foreground/[0.04] hover:text-foreground active:bg-foreground/[0.07] focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => back()}
        >
          <Icon icon={ChevronLeft} />
          Back
        </Button>
        <h2 className="px-2 pt-3 pb-1 text-nav font-semibold text-foreground">Settings</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        <SettingsRail
          sections={sections}
          activeId={chosen ?? DEFAULT_SECTION_ID}
          onSelect={setSection}
          onJump={(id) => setJump((j) => ({ id, n: (j?.n ?? 0) + 1 }))}
        />
      </div>
    </div>
  )
}
