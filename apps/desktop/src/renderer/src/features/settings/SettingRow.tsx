/**
 * One setting, rendered from its descriptor. The layout is `SettingsRow`; this
 * file decides only what a *setting* adds to a row: the layer badge, the
 * control kinds, and the resolver's complaint.
 */
import { useAtomValue } from 'jotai'
import { TriangleAlert } from 'lucide-react'
import {
  SETTINGS_FILE,
  SETTINGS_LOCAL_FILE,
  availableOptions,
  isLocalOnlyPath,
  type PluginSettings,
  type VaultSettingDescriptor,
  type VaultSettingOption,
} from '@holi/shared'
import { Button, Checkbox, Icon, Tooltip } from '@/primitives'
import { useAck } from '@/lib/use-ack'
import { surfaceLabel } from '@/lib/folder-documents'
import type { Surface } from '@/plugin-api/types'
import { homeDocumentsAtom } from '@/state/home'
import { installedPluginsAtom, surfacesAtom } from '@/state/plugins'
import { SettingsRow } from '@/composites'

export function Layer({ target }: { target: VaultSettingDescriptor['target'] }): React.JSX.Element {
  const committed = target === 'committed'
  return (
    <Tooltip
      content={
        committed
          ? `shared with the vault — written to ${SETTINGS_FILE}`
          : `this machine only — written to ${SETTINGS_LOCAL_FILE}, which is never committed`
      }
    >
      {/* `--border`, not `--divider`: this is a chip, and a chip is an object
          whose edge has to be seen. See the note in `composites/settings-ui.tsx`. */}
      <span className="rounded border border-border px-1.5 py-0.5 text-[10px] leading-4 text-muted-foreground">
        {committed ? 'vault' : 'this machine'}
      </span>
    </Tooltip>
  )
}

export function SettingRow({
  descriptor,
  settings,
  onChange,
  warnings,
}: {
  descriptor: VaultSettingDescriptor
  settings: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
  warnings: string[]
}): React.JSX.Element | null {
  const { key, label, explanation, control } = descriptor
  const value = settings[key] ?? descriptor.default
  const documents = useAtomValue(homeDocumentsAtom)
  const installed = useAtomValue(installedPluginsAtom)
  const surfaces = useAtomValue(surfacesAtom)
  const options: readonly VaultSettingOption[] =
    control.kind === 'choice' && control.openEnded === true
      ? homeOptions(availableOptions(descriptor, settings), surfaces, documents, value)
      : availableOptions(descriptor, settings)

  // Changing a setting WRITES A FILE in the vault, so the row flashes once to
  // make the write visible where it happened.
  const { ref: rowRef, ack } = useAck<HTMLDivElement>()
  const change = (k: string, v: unknown) => {
    ack('flash')
    onChange(k, v)
  }

  // A switch per installed plugin, so with none there is nothing to show.
  if (control.kind === 'plugins' && installed.length === 0) return null

  return (
    <SettingsRow
      ref={rowRef}
      role="group"
      aria-label={label}
      data-setting={key}
      label={label}
      description={explanation}
      meta={<Layer target={descriptor.target} />}
      // A switch and a pick-one are both one answer to the row's question, so
      // both sit on the label's line, right-aligned. Only the flag group is
      // below, in `children`.
      control={
        control.kind === 'toggle' ? (
          <Checkbox
            checked={value === true}
            onCheckedChange={(next) => change(key, next === true)}
            aria-label={label}
          />
        ) : control.kind === 'choice' ? (
          // `justify-end` so a group that has wrapped onto its own line stays
          // against the right edge, and so does a second row of options.
          <div role="radiogroup" aria-label={label} className="flex flex-wrap justify-end gap-1.5">
            {/* Filtered, not disabled — the same call the ritual makes. A greyed
                out choice invites "why not?" and the answer is another row. */}
            {options.map((option) => (
              <Button
                key={option.label}
                type="button"
                variant={
                  JSON.stringify(option.value) === JSON.stringify(value) ? 'secondary' : 'ghost'
                }
                size="xs"
                role="radio"
                // Structural equality: an option's value may be any value the
                // setting holds, and the answer a different object of that shape.
                aria-checked={JSON.stringify(option.value) === JSON.stringify(value)}
                onClick={() => change(key, option.value)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        ) : undefined
      }
    >
      {control.kind === 'group' && (
        <div className="flex flex-col gap-2">
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
                  onCheckedChange={(next) => change(key, { ...block, [toggle.key]: next === true })}
                  aria-label={`${toggle.label}. ${toggle.explanation}`}
                />
                <span className="min-w-0">
                  <span className="text-xs">{toggle.label}</span>
                  <span className="ml-1.5 text-[11px] text-muted-foreground">
                    {toggle.explanation}
                  </span>
                </span>
              </label>
            )
          })}
        </div>
      )}

      {control.kind === 'plugins' && (
        <div className="flex flex-col gap-2">
          {installed.map(({ info }) => {
            const plugins = value as PluginSettings
            const off = plugins.localOff.includes(info.id)
            return (
              <label key={info.id} className="flex items-start gap-2.5">
                <Checkbox
                  className="mt-0.5"
                  // The vault's answer. This machine's own off is the note.
                  checked={plugins.vault[info.id] ?? info.default}
                  // The vault's whole answer, as the flag group sends its block.
                  onCheckedChange={(next) =>
                    change(key, { ...plugins.vault, [info.id]: next === true })
                  }
                  aria-label={info.label}
                />
                <span className="min-w-0">
                  <span className="text-xs">{info.label}</span>
                  {off && (
                    <span className="ml-1.5 text-[11px] text-muted-foreground">
                      Off on this machine, in {SETTINGS_LOCAL_FILE}.
                    </span>
                  )}
                </span>
              </label>
            )
          })}
        </div>
      )}

      {/* The resolver's own complaint about this key, which until the tab
          existed nothing displayed at all — a value dropped for being malformed
          was silently replaced by a default and never mentioned. */}
      {warnings.map((warning) => (
        <p key={warning} className="flex items-start gap-1.5 text-[11px] text-destructive">
          <Icon icon={TriangleAlert} size="sm" className="mt-0.5" />
          {warning}
        </p>
      ))}
    </SettingsRow>
  )
}

/**
 * Home's options: core's fixed ones, the views that can be Home in this vault
 * (`homeable` surfaces, so one whose plugin is off is not offered), the
 * vault's shared folder documents (a vault app, say), and the current answer
 * even when it is none of them (a file, or a document not made yet), so the row
 * always shows what is in force. A personal (`.local.`) document is not
 * offered: this row writes the committed file, and naming one there would point
 * everyone else at nothing.
 */
function homeOptions(
  fixed: readonly VaultSettingOption[],
  surfaces: ReadonlyMap<string, Surface>,
  documents: readonly { path: string; label: string }[],
  value: unknown,
): VaultSettingOption[] {
  const listed = new Set(fixed.map((o) => o.value))
  const views = [...surfaces.values()]
    .filter((s) => s.homeable === true && !listed.has(s.kind))
    .map((s) => ({ value: s.kind, label: surfaceLabel(s) }))
  const docs = documents
    .filter((d) => !isLocalOnlyPath(d.path) && !listed.has(d.path))
    .map((d) => ({ value: d.path, label: d.label }))
  const all = [...fixed, ...views, ...docs]
  const current =
    typeof value === 'string' && !all.some((o) => o.value === value)
      ? [{ value, label: value }]
      : []
  return [...all, ...current]
}
