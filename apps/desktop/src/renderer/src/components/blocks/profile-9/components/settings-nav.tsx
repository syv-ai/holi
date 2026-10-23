/**
 * The sidebar while Settings is the tab in front: Back, then the pages under
 * their groups, the open one lit (after Linear and ReUI's profile-9). It
 * replaces the files rather than folding them to the rail, so the sidebar
 * keeps its width and the pages read as a place you went to.
 */
import { useAtom, useAtomValue } from "jotai"

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
} from "@/components/ui/sidebar"
import { settingsSectionAtom } from "@/state/settings-section"
import { ChevronLeftIcon } from "lucide-react"

import { pageFor, settingsGroupsAtom } from "./sections"

/** The sidebar rows' own fill, as the files nav draws it. */
const ROW =
  "hover:bg-foreground/5 data-active:bg-foreground/10 data-active:hover:bg-foreground/12"

export function SettingsNav({ onBack }: { onBack: () => void }) {
  const groups = useAtomValue(settingsGroupsAtom)
  const [section, setSection] = useAtom(settingsSectionAtom)
  const active = pageFor(groups, section).id

  return (
    <Sidebar
      collapsible="none"
      role="navigation"
      aria-label="Settings"
      className="animate-in fade-in-0 h-full w-full duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"
    >
      <SidebarHeader className="px-2 pt-3 pb-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={onBack} className={ROW}>
              <ChevronLeftIcon aria-hidden="true" />
              <span>Back</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="px-2 pb-3">
        {groups.map((group) =>
          group.pages.length === 0 ? null : (
            <SidebarGroup key={group.id} className="px-0">
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu className="gap-0.5">
                  {group.pages.map((page) => {
                    const Icon = page.icon
                    const current = page.id === active
                    return (
                      <SidebarMenuItem key={page.id}>
                        <SidebarMenuButton
                          isActive={current}
                          aria-current={current ? "page" : undefined}
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
          )
        )}
      </SidebarContent>
    </Sidebar>
  )
}
