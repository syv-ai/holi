/**
 * Every setting this vault has, in a tab with a rail.
 *
 * **Renders the sections; does not know the sections.** Rail items come from
 * `settingsSectionsAtom` and rows from `VAULT_SETTING_DESCRIPTORS`, the same list
 * the onboarding ritual renders. Adding a setting is adding a descriptor.
 *
 * **A tab, not a modal**, so it can split beside the note it is changing.
 *
 * **Changes apply now.** The hooks and the file-size cap are read by main on
 * every commit, `colorScheme` re-applies through `useVaultTheme`, and
 * `editorFont` is a CSS custom property, so a write here forces the cache and
 * the app follows. `home` does too; the part of it that is what a vault opens
 * on acts when a vault opens.
 *
 * **The scroll container lives here, not in a section.** The rail jumps to a
 * heading by scrolling this element, so a section that owned its own scrolling
 * would be a section the rail could not reach into.
 */
import { Fragment, useEffect, useRef } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { TriangleAlert } from 'lucide-react'
import { Icon } from '@/primitives'
import { openPinned, workspaceAtom } from '@/state/panes'
import { activeRemoteAtom } from '@/state/vaults'
import { SettingsPicker, SettingsRail } from './SettingsRail'
import { DEFAULT_SECTION_ID, settingsSectionsAtom } from './sections'
import { SettingsLink, SettingsNote } from '@/composites'
import { cn } from '@/lib/cn'
import { navOpenAtom } from '@/state/preferences'
import { settingsJumpAtom, settingsSectionAtom } from '@/state/settings-section'
import { useVaultSettings } from './useVaultSettings'

export function SettingsView(): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const sections = useAtomValue(settingsSectionsAtom)
  const { resolved, error, unattributed } = useVaultSettings()
  const setWorkspace = useSetAtom(workspaceAtom)
  // Shared with the sidebar's rail, which shows while the sidebar is open.
  const [chosen, setActiveId] = useAtom(settingsSectionAtom)
  const activeId = chosen ?? DEFAULT_SECTION_ID
  const railInSidebar = useAtomValue(navOpenAtom)
  const [jumpRequest, setJumpRequest] = useAtom(settingsJumpAtom)
  const scroller = useRef<HTMLDivElement | null>(null)

  // A section change is a change of place, so it starts at the top rather than
  // inheriting the last section's scroll offset.
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
  }, [activeId])

  const jump = (headingId: string): void => {
    scroller.current?.querySelector(`[data-heading="${headingId}"]`)?.scrollIntoView({
      block: 'start',
      behavior: 'smooth',
    })
  }
  // A jump asked for by the sidebar's rail.
  useEffect(() => {
    if (jumpRequest === null) return
    jump(jumpRequest.id)
    setJumpRequest(null)
  }, [jumpRequest, setJumpRequest])

  if (remote === null) {
    return <Placeholder>No vault is open.</Placeholder>
  }
  if (resolved === null) {
    return <Placeholder>Reading this vault&rsquo;s settings…</Placeholder>
  }

  const section = sections.find((s) => s.id === activeId) ?? sections[0]!

  return (
    // **A container query, not a media query**: only the pane's own width
    // decides whether a rail fits. The rail plus controls want roughly 560px, so
    // below that the rail becomes a picker above the content.
    //
    // **Two elements, and they cannot be one.** A container query resolves
    // against the nearest ANCESTOR container, never the element declaring
    // `container-type`, so `@container` and `@min-[560px]:*` on the same div
    // never match.
    <div className="@container h-full min-h-0">
      <div className="flex h-full min-h-0 flex-col @min-[560px]:flex-row">
        <div
          className={cn(
            'hidden w-56 shrink-0 overflow-y-auto',
            !railInSidebar && '@min-[560px]:block',
          )}
        >
          <SettingsRail
            sections={sections}
            activeId={section.id}
            onSelect={setActiveId}
            onJump={jump}
          />
        </div>

        <div
          className={cn(
            'shrink-0 border-b border-divider px-3 py-2 @min-[560px]:hidden',
            railInSidebar && 'hidden',
          )}
        >
          <SettingsPicker
            sections={sections}
            activeId={section.id}
            onSelect={setActiveId}
            onJump={jump}
          />
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex max-w-2xl flex-col gap-4 px-8 pt-8 pb-12">
              <h2 className="text-2xl font-semibold tracking-tight text-foreground">
                {section.label}
              </h2>

              {error !== null && (
                <p
                  role="alert"
                  className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive"
                >
                  {error}
                </p>
              )}
              {/* Warnings the resolver could not attribute to any key. Shown once
                  at the top of whichever section you are in rather than dropped. */}
              {unattributed.map((warning) => (
                <p key={warning} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <Icon icon={TriangleAlert} size="sm" className="mt-0.5" />
                  {warning}
                </p>
              ))}

              <div>
                <section.Component remote={remote} />
              </div>
            </div>
          </div>

          {/* The escape hatch: these are files, and this names which file backs
              the section on screen. Outside the scroller so it is always visible
              and never collides with a section's trailing content. Absent for
              sections backed by nothing on disk (GitHub, Google). */}
          {section.files.length > 0 && (
            <div className="shrink-0 border-t border-divider px-8 py-2.5">
              <div className="mx-auto max-w-2xl">
                <SettingsNote>
                  A view of{' '}
                  {section.files.map((file, i) => (
                    <Fragment key={file}>
                      {i > 0 && (i === section.files.length - 1 ? ' and ' : ', ')}
                      <SettingsLink onClick={() => setWorkspace((w) => openPinned(w, file))}>
                        <span className="font-mono">{file}</span>
                      </SettingsLink>
                    </Fragment>
                  ))}
                  , which you can edit by hand.
                </SettingsNote>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Placeholder({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}
