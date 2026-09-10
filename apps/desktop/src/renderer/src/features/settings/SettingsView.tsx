/**
 * Every setting this vault has, in a tab with a rail (#16).
 *
 * **Renders the sections; does not know the sections.** Every rail item comes
 * from `SETTINGS_SECTIONS` and every row inside one comes from
 * `VAULT_SETTING_DESCRIPTORS` — the same list the onboarding ritual renders and
 * the same list `seed-content.ts` builds a new vault's `app.json` from. Adding a
 * setting is adding a descriptor, including saying which section it lands in.
 *
 * **A tab, not a modal.** A modal blocks the window while you compare a setting
 * against the vault it applies to; a tab splits beside the note you are changing
 * it for, and closes like anything else.
 *
 * **Changes apply now.** The resolved settings are cached per vault and the
 * cache's own docstring says re-reading them mid-session would mean answering
 * "what happens to the tab you are looking at". The answer turned out to be that
 * most of them already do: the hooks and the file-size cap are read by main on
 * every commit, `colorScheme` re-applies through `useVaultTheme`, and
 * `editorFont` is a CSS custom property. So a write here forces the cache and
 * the app follows. `landing` is the exception and says so on its own row: it
 * describes what happens when a vault OPENS, and this one already did.
 *
 * **The scroll container lives here, not in a section.** The rail jumps to a
 * heading by scrolling this element, so a section that owned its own scrolling
 * would be a section the rail could not reach into.
 */
import { Fragment, useEffect, useRef, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { TriangleAlert } from 'lucide-react'
import { openPinned, workspaceAtom } from '@/state/panes'
import { activeRemoteAtom } from '@/state/vaults'
import { SettingsPicker, SettingsRail } from './SettingsRail'
import { DEFAULT_SECTION_ID, SETTINGS_SECTIONS } from './sections'
import { SettingsLink, SettingsNote } from './settings-ui'
import { useVaultSettings } from './useVaultSettings'

export function SettingsView(): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const { resolved, error, unattributed } = useVaultSettings()
  const setWorkspace = useSetAtom(workspaceAtom)
  const [activeId, setActiveId] = useState(DEFAULT_SECTION_ID)
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

  if (remote === null) {
    return <Placeholder>No vault is open.</Placeholder>
  }
  if (resolved === null) {
    return <Placeholder>Reading this vault&rsquo;s settings…</Placeholder>
  }

  const section = SETTINGS_SECTIONS.find((s) => s.id === activeId) ?? SETTINGS_SECTIONS[0]!

  return (
    // **A container query, not a media query.** This is a pane, not the window:
    // the same app at the same window size shows this tab full width or beside
    // two other panes, and only the tab's OWN width decides whether a rail fits.
    // A pane's `minSize` is 240px and the rail plus a column of controls wants
    // roughly 560, so below that the rail becomes a picker above the content.
    //
    // **Two elements, and they cannot be one.** A container query resolves
    // against the nearest ANCESTOR container, never against the element that
    // declares `container-type` itself — so `@container` and `@min-[560px]:*`
    // on the same div gives a query that can never match. The children's
    // variants worked (the rail appeared, the picker hid) while the row/column
    // switch silently did not, which reads as "the rail is there but the
    // content dropped below it".
    <div className="@container h-full min-h-0">
      <div className="flex h-full min-h-0 flex-col @min-[560px]:flex-row">
        <div className="hidden w-44 shrink-0 overflow-y-auto border-r border-divider @min-[560px]:block">
          <SettingsRail
            sections={SETTINGS_SECTIONS}
            activeId={section.id}
            onSelect={setActiveId}
            onJump={jump}
          />
        </div>

        <div className="shrink-0 border-b border-divider p-2 @min-[560px]:hidden">
          <SettingsPicker
            sections={SETTINGS_SECTIONS}
            activeId={section.id}
            onSelect={setActiveId}
            onJump={jump}
          />
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-2xl px-6 py-4">
              <h2 className="text-sm font-medium">{section.label}</h2>

              {error !== null && (
                <p className="mt-3 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
                  {error}
                </p>
              )}
              {/* Warnings the resolver could not attribute to any key. Shown once
                  at the top of whichever section you are in rather than dropped:
                  a value refused for being malformed used to vanish silently. */}
              {unattributed.map((warning) => (
                <p
                  key={warning}
                  className="mt-3 flex items-start gap-1.5 text-[11px] text-muted-foreground"
                >
                  <TriangleAlert size={13} className="mt-0.5 shrink-0" />
                  {warning}
                </p>
              ))}

              <div className="mt-2">
                <section.Component remote={remote} />
              </div>
            </div>
          </div>

          {/* The escape hatch, the same one "Edit Icon…" offers for its map:
              these are files, they are readable, and a pane that hid them would
              be claiming to be the only way to change a vault's mind. Per
              section rather than one anonymous row at the end of everything, so
              it says WHICH file backs what you are looking at.

              **Outside the scroller, not at the end of it.** As the last thing
              in a long section it was a footnote you had to reach; as a bar it
              is a persistent answer to "where does this live?". That also means
              it cannot collide with a section's own trailing content, which is
              what drew two hairlines a few pixels apart under Appearance.

              Absent, not empty, for the sections backed by nothing on disk:
              what GitHub says about a vault and which Google account this
              machine holds are not files, and offering none under a sentence
              promising some would be worse than saying nothing. */}
          {section.files.length > 0 && (
            <div className="shrink-0 border-t border-divider px-6 py-2">
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
