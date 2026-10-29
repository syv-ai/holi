/**
 * The sidebar while Settings is the tab in front: Back, then the pages under
 * their groups, the open one lit (after Linear and ReUI's profile-9). It
 * replaces the files rather than folding them to the rail, so the sidebar
 * keeps its width and the pages read as a place you went to.
 */
import { useAtom, useAtomValue } from 'jotai'

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { settingsSectionAtom } from '@/state/settings-section'
import { ChevronLeftIcon } from 'lucide-react'

import { pageFor, settingsGroupsAtom } from './settings-pages'

/** The sidebar rows' own fill, as the files nav draws it. */
const ROW = 'hover:bg-foreground/5 data-active:bg-foreground/10 data-active:hover:bg-foreground/12'

export function SettingsNav({ onBack }: { onBack: () => void }) {
  const groups = useAtomValue(settingsGroupsAtom)
  const [section, setSection] = useAtom(settingsSectionAtom)
  const active = pageFor(groups, section).id

  return (
    <div className="motion-in-fade h-full w-full">
      <Sidebar collapsible="none" role="navigation" aria-label="Settings" className="h-full w-full">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={onBack} className={ROW}>
                <ChevronLeftIcon aria-hidden="true" />
                <span>Back</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          {groups.map((group) =>
            group.pages.length === 0 ? null : (
              <SidebarGroup key={group.id}>
                <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {group.pages.map((page) => {
                      const Icon = page.icon
                      const current = page.id === active
                      return (
                        <SidebarMenuItem key={page.id}>
                          <SidebarMenuButton
                            isActive={current}
                            aria-current={current ? 'page' : undefined}
                            onClick={() => setSection(page.id)}
                            className={ROW}
                          >
                            <Icon aria-hidden={true} />
                            <span>{page.label}</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      )
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ),
          )}
        </SidebarContent>
      </Sidebar>
    </div>
  )
}
