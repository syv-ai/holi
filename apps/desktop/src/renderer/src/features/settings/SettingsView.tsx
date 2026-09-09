/**
 * Every setting this vault has, in a tab (#16).
 *
 * **Renders the list; does not know the list.** Every row comes from
 * `VAULT_SETTING_DESCRIPTORS` — the same list the onboarding ritual renders and
 * the same list `seed-content.ts` builds a new vault's `settings.json` from — so
 * adding a setting is adding a descriptor and this file should not need
 * touching. It writes through `settings.write`, which is also the ritual's only
 * writer, so the two surfaces cannot drift into writing different shapes.
 *
 * **A tab, not a modal.** A modal blocks the window while you compare a setting
 * against the vault it applies to; a tab splits beside the note you are changing
 * it for, and closes like anything else.
 *
 * **Changes apply now.** That question was open — the resolved settings are
 * cached per vault and the cache's own docstring says re-reading them mid-session
 * would mean answering "what happens to the tab you are looking at". The answer
 * turned out to be that most of them already do: the hooks and the file-size cap
 * are read by main on every commit, `colorScheme` re-applies through
 * `useVaultTheme`, and `editorFont` is a CSS custom property. So a write here
 * forces the cache and the app follows. `landing` is the exception and says so
 * on its own row: it describes what happens when a vault OPENS, and this one
 * already did.
 */
import { useEffect, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { ExternalLink, TriangleAlert } from 'lucide-react'
import {
  SETTINGS_FILE,
  SETTINGS_LOCAL_FILE,
  VAULT_SETTING_DESCRIPTORS,
  availableOptions,
  type ResolvedVaultSettings,
  type VaultSettingDescriptor,
} from '@holi/shared'
import { Button, Checkbox, Tooltip } from '@/primitives'
import { trpc } from '@/lib/trpc'
import { openPinned, workspaceAtom } from '@/state/panes'
import { loadVaultSettingsAtom } from '@/state/settings'
import { activeRemoteAtom } from '@/state/vaults'
import { vaultPanelOpenAtom } from '@/state/vault-panel'

/** The one setting whose value is a statement about an event that has already
 *  happened by the time you can change it. Everything else applies as you go. */
const APPLIES_ON_NEXT_OPEN = new Set<string>(['landing'])

function Layer({ target }: { target: VaultSettingDescriptor['target'] }): React.JSX.Element {
  const committed = target === 'committed'
  return (
    <Tooltip
      content={
        committed
          ? `shared with the vault — written to ${SETTINGS_FILE}`
          : `this machine only — written to ${SETTINGS_LOCAL_FILE}, which is never committed`
      }
    >
      <span className="rounded border border-border px-1.5 py-0.5 text-[10px] leading-4 text-muted-foreground">
        {committed ? 'vault' : 'this machine'}
      </span>
    </Tooltip>
  )
}

function Row({
  descriptor,
  settings,
  onChange,
  warnings,
}: {
  descriptor: VaultSettingDescriptor
  settings: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
  warnings: string[]
}): React.JSX.Element {
  const { key, label, explanation, control } = descriptor
  const value = settings[key] ?? descriptor.default

  return (
    <div
      role="group"
      aria-label={label}
      data-setting={key}
      className="flex flex-col gap-2 border-b border-border px-6 py-4 last:border-b-0"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{label}</span>
            <Layer target={descriptor.target} />
            {APPLIES_ON_NEXT_OPEN.has(key) && (
              <span className="text-[10px] leading-4 text-muted-foreground">
                takes effect next time this vault opens
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{explanation}</p>
        </div>

        {control.kind === 'toggle' && (
          <Checkbox
            checked={value === true}
            onCheckedChange={(next) => onChange(key, next === true)}
            aria-label={label}
          />
        )}
      </div>

      {control.kind === 'choice' && (
        <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
          {/* Filtered, not disabled — the same call the ritual makes. A greyed
              out choice invites "why not?" and the answer is another row. */}
          {availableOptions(descriptor, settings).map((option) => (
            <Button
              key={option.label}
              type="button"
              variant={
                JSON.stringify(option.value) === JSON.stringify(value) ? 'secondary' : 'ghost'
              }
              size="xs"
              role="radio"
              // Structural equality: a `landing` option's value is an object, and
              // the answer is a different object with the same shape.
              aria-checked={JSON.stringify(option.value) === JSON.stringify(value)}
              onClick={() => onChange(key, option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      )}

      {control.kind === 'group' && (
        <div className="flex flex-col gap-2 pt-1">
          {control.toggles.map((toggle) => {
            const block = (value ?? {}) as Record<string, boolean>
            return (
              <label key={toggle.key} className="flex items-start gap-2.5">
                <Checkbox
                  className="mt-0.5"
                  checked={block[toggle.key] === true}
                  // The whole block, not just the switch that moved: a patch
                  // naming one transform must not read as an answer about the
                  // others.
                  onCheckedChange={(next) =>
                    onChange(key, { ...block, [toggle.key]: next === true })
                  }
                  aria-label={`${toggle.label}. ${toggle.explanation}`}
                />
                <span className="min-w-0">
                  <span className="text-xs">{toggle.label}</span>
                  <span className="ml-1.5 text-xs text-muted-foreground">{toggle.explanation}</span>
                </span>
              </label>
            )
          })}
        </div>
      )}

      {/* The resolver's own complaint about this key, which until now nothing
          displayed at all — a value dropped for being malformed was silently
          replaced by a default and never mentioned. */}
      {warnings.map((warning) => (
        <p key={warning} className="flex items-start gap-1.5 text-xs text-destructive">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          {warning}
        </p>
      ))}
    </div>
  )
}

export function SettingsView(): React.JSX.Element {
  const remote = useAtomValue(activeRemoteAtom)
  const load = useSetAtom(loadVaultSettingsAtom)
  const setWorkspace = useSetAtom(workspaceAtom)
  const setVaultPanel = useSetAtom(vaultPanelOpenAtom)
  const [resolved, setResolved] = useState<ResolvedVaultSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    void load().then((s) => {
      if (!disposed) setResolved(s)
    })
    return () => {
      disposed = true
    }
  }, [load, remote])

  if (remote === null) {
    return <Placeholder>No vault is open.</Placeholder>
  }
  if (resolved === null) {
    return <Placeholder>Reading this vault&rsquo;s settings…</Placeholder>
  }

  const values = resolved as unknown as Record<string, unknown>

  const change = async (descriptor: VaultSettingDescriptor, value: unknown): Promise<void> => {
    setError(null)
    // Optimistic, because a control that lags a click reads as a broken control.
    // The forced re-read below is what makes it true.
    setResolved({ ...resolved, [descriptor.key]: value } as ResolvedVaultSettings)
    const patch = JSON.stringify({ [descriptor.key]: value })
    try {
      // The ritual's writer, unchanged: `fields` validates strings and booleans
      // only, so the patch travels as text and is parsed in main through the same
      // validator that guards a committed file a teammate wrote.
      const result = await trpc.settings.write.mutate({
        remote,
        ...(descriptor.target === 'committed' ? { committedJson: patch } : { localJson: patch }),
      })
      if (result.warnings.length > 0) setError(result.warnings.join('; '))
      // Force, not read: this atom caches per vault, and the point of the pane is
      // to see your own write. Everything that reads the atom re-renders with it,
      // which is what makes appearance and the editor font apply as you click.
      setResolved(await load({ force: true }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not write the settings file')
      setResolved(await load({ force: true }))
    }
  }

  /** The resolver's warnings, split by the key each one names. Anything it
   *  cannot attribute is shown once at the top rather than dropped. */
  const warningsFor = (key: string): string[] =>
    resolved.warnings.filter((w) => w.includes(`"${key}"`))
  const unattributed = resolved.warnings.filter(
    (w) => !VAULT_SETTING_DESCRIPTORS.some((d) => w.includes(`"${d.key}"`)),
  )

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto max-w-3xl py-4">
        {error !== null && (
          <p className="mx-6 mb-3 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}
        {unattributed.map((warning) => (
          <p
            key={warning}
            className="mx-6 mb-3 flex items-start gap-1.5 text-xs text-muted-foreground"
          >
            <TriangleAlert size={13} className="mt-0.5 shrink-0" />
            {warning}
          </p>
        ))}

        {VAULT_SETTING_DESCRIPTORS.map((descriptor) => (
          <Row
            key={descriptor.key}
            descriptor={descriptor}
            settings={values}
            onChange={(_, value) => void change(descriptor, value)}
            warnings={warningsFor(descriptor.key)}
          />
        ))}

        {/* The escape hatch, the same one "Edit Icon…" offers for its map: these
            are files, they are readable, and a pane that hid them would be
            claiming to be the only way to change a vault's mind. */}
        <div className="flex flex-col gap-2 px-6 py-4">
          <p className="text-xs text-muted-foreground">
            These are two files in the vault, and you can edit them by hand.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="xs"
              onClick={() => setWorkspace((w) => openPinned(w, SETTINGS_FILE))}
            >
              {SETTINGS_FILE}
            </Button>
            <Button
              variant="secondary"
              size="xs"
              onClick={() => setWorkspace((w) => openPinned(w, SETTINGS_LOCAL_FILE))}
            >
              {SETTINGS_LOCAL_FILE}
            </Button>
            <Button
              variant="secondary"
              size="xs"
              onClick={() => setWorkspace((w) => openPinned(w, '.holi/theme.json'))}
            >
              .holi/theme.json
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Colours and chrome live in <code>.holi/theme.json</code> (D64) and have no controls
            here yet — the file is the interface for now.
          </p>
        </div>

        {/* Identity and membership are not preferences, so they keep their own
            panel; this is the door to it, so a gear does not mean two things. */}
        <div className="flex items-center gap-2 border-t border-border px-6 py-4">
          <Button
            variant="ghost"
            size="xs"
            className="gap-1.5 text-muted-foreground"
            onClick={() => setVaultPanel(true)}
          >
            This vault on GitHub
            <ExternalLink size={12} />
          </Button>
          <span className="text-xs text-muted-foreground">
            Who it belongs to, who can see it, and who you are signed in as.
          </span>
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
