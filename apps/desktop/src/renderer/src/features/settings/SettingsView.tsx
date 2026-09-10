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
import { useEffect, useRef, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { ExternalLink, TriangleAlert } from 'lucide-react'
import { Button } from '@/primitives'
import { openPinned, workspaceAtom } from '@/state/panes'
import { activeRemoteAtom } from '@/state/vaults'
import { vaultPanelOpenAtom } from '@/state/vault-panel'
import { SettingsRail } from './SettingsRail'
import { DEFAULT_SECTION_ID, SETTINGS_SECTIONS } from './sections'
import { useVaultSettings } from './useVaultSettings'

export function SettingsView(): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const { resolved, error, unattributed } = useVaultSettings()
  const setWorkspace = useSetAtom(workspaceAtom)
  const setVaultPanel = useSetAtom(vaultPanelOpenAtom)
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
    <div className="flex h-full min-h-0">
      <div className="w-44 shrink-0 overflow-y-auto border-r border-border">
        <SettingsRail
          sections={SETTINGS_SECTIONS}
          activeId={section.id}
          onSelect={setActiveId}
          onJump={jump}
        />
      </div>

      <div ref={scroller} className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-6 py-4">
          <h2 className="text-sm font-medium">{section.label}</h2>

          {error !== null && (
            <p className="mt-3 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
          {/* Warnings the resolver could not attribute to any key. Shown once at
              the top of whichever section you are in rather than dropped: a
              value refused for being malformed used to vanish silently. */}
          {unattributed.map((warning) => (
            <p key={warning} className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
              <TriangleAlert size={13} className="mt-0.5 shrink-0" />
              {warning}
            </p>
          ))}

          <section.Component remote={remote} />

          {/* The escape hatch, the same one "Edit Icon…" offers for its map:
              these are files, they are readable, and a pane that hid them would
              be claiming to be the only way to change a vault's mind. Per
              section rather than one anonymous row at the end of everything, so
              it says WHICH file backs what you are looking at. */}
          <div className="mt-6 flex flex-col gap-2 border-t border-border pt-4">
            <p className="text-xs text-muted-foreground">
              {section.files.length === 1
                ? 'This section is a view of one file in the vault, and you can edit it by hand.'
                : 'This section is a view of two files in the vault, and you can edit them by hand.'}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {section.files.map((file) => (
                <Button
                  key={file}
                  variant="secondary"
                  size="xs"
                  onClick={() => setWorkspace((w) => openPinned(w, file))}
                >
                  {file}
                </Button>
              ))}
            </div>
          </div>

          {/* Identity and membership are not preferences, so they keep their own
              panel; this is the door to it, so a gear does not mean two things. */}
          <div className="mt-4 flex items-center gap-2 border-t border-border pt-4">
            <Button
              variant="ghost"
              size="xs"
              className="gap-1.5 text-muted-foreground"
              onClick={() => setVaultPanel(true)}
            >
              This vault on GitHub
              <ExternalLink size={12} />
            </Button>
          </div>
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
