// ReUI block: @reui/profile-9 (`npx shadcn@latest view @reui/profile-9` shows the published source)
/**
 * The open settings page: its title and one line, then its cards. With the
 * nav out of sight (the sidebar folded to its rail, or a phone) a picker in
 * the heading reaches the other pages.
 */
import { useAtom, useAtomValue } from "jotai"
import { useEffect, useRef } from "react"

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { settingsSectionAtom } from "@/state/settings-section"
import { activeRemoteAtom } from "@/state/vaults"

import { pageFor, settingsGroupsAtom } from "./settings-pages"

export function SettingsView({ navHidden }: { navHidden: boolean }) {
  const groups = useAtomValue(settingsGroupsAtom)
  const [section, setSection] = useAtom(settingsSectionAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const page = pageFor(groups, section)
  const Page = page.Component
  const scroller = useRef<HTMLDivElement>(null)

  // A new page starts at its top, not where the last one was scrolled to.
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [page.id])

  return (
    <div
      ref={scroller}
      data-slot="settings-view"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-8 p-3 sm:p-4 lg:p-6">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h1 className="truncate text-xl font-semibold tracking-tight">
              {page.label}
            </h1>
            {page.description ? (
              <p className="text-muted-foreground text-sm">
                {page.description}
              </p>
            ) : null}
          </div>
          {navHidden ? (
            <Select value={page.id} onValueChange={setSection}>
              <SelectTrigger aria-label="Settings page" className="shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                {groups.map((group) => (
                  <SelectGroup key={group.id}>
                    <SelectLabel>{group.label}</SelectLabel>
                    {group.pages.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>
        {remote === null ? null : (
          // Keyed by page and vault: a page's local state never outlives either.
          <div key={`${page.id}:${remote}`} className="flex flex-col gap-8">
            <Page remote={remote} />
          </div>
        )}
      </div>
    </div>
  )
}
