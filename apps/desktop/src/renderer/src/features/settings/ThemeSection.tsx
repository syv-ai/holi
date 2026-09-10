/**
 * The vault's colours and chrome, with real controls (#16, D64).
 *
 * The settings tab used to end with a link to `.holi/settings/theme.json` and the words
 * "no controls here yet". This is that gap.
 *
 * **Two axes, chosen once for the whole section rather than per token**, because
 * both are facts about who and when, not about the colour:
 *
 * - **Mode.** The theme files carry a `light` and a `dark` block, so every token
 *   has two values. The picker follows whichever mode the app is actually in by
 *   default, so what you see is what you are editing.
 * - **Layer.** `theme.json` is committed and shared; `theme.local.json` is this
 *   machine's and overrides it per key. Same split as settings, same badge.
 *
 * **A token with no value is the normal case, not an empty field.** A vault's
 * theme file is `{dark:{}, light:{}}` until someone changes something, so every
 * row shows the colour *in force* — which is Holi's default, resolved by the
 * browser — and says whether this vault has actually set it. Clearing a row
 * deletes the key rather than writing a blank, which is why the patch carries
 * `null`.
 *
 * **Rendered from `THEME_TOKEN_GROUPS`, not from a list here.** Adding a token
 * to the whitelist puts it in this pane, and a shared test fails if it does
 * not.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAtomValue } from 'jotai'
import { RotateCcw } from 'lucide-react'
import {
  THEME_TOKEN_GROUPS,
  THEME_TOKEN_NOTES,
  themeTokenKind,
  themeTokenLabel,
  type ResolvedTheme,
  type ThemeMode,
  THEME_FILE,
  THEME_LOCAL_FILE,
} from '@holi/shared'
import { Button, ColorSwatch, Input, Tooltip } from '@/primitives'
import { tokenToHex } from '@/lib/css-color'
import { trpc } from '@/lib/trpc'
import { activeModeAtom } from '@/state/color-scheme'

type Layer = 'committed' | 'local'

/** A pair of buttons that read as one choice. The settings rows above use the
 *  same shape for `choice`, so the section does not introduce a new control. */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: readonly { value: T; label: string; hint?: string }[]
  onChange: (next: T) => void
  label: string
}): React.JSX.Element {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((option) => (
        <Button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          variant={option.value === value ? 'secondary' : 'ghost'}
          size="xs"
          title={option.hint}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  )
}

function TokenRow({
  slug,
  set,
  onSet,
  onClear,
}: {
  slug: string
  /** What this vault says, for the mode and layer on screen. Absent when it
   *  says nothing, which is most tokens most of the time. */
  set: string | undefined
  onSet: (value: string) => void
  onClear: () => void
}): React.JSX.Element {
  const kind = themeTokenKind(slug)
  const note = THEME_TOKEN_NOTES[slug]
  // The colour IN FORCE, whoever decided it. Painted as `var(--slug)` so the
  // browser resolves it; the hex is only where the picker opens.
  const shown = `var(--${slug})`
  const [draft, setDraft] = useState(set ?? '')
  useEffect(() => setDraft(set ?? ''), [set])

  return (
    <div className="flex items-start gap-3 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs">{themeTokenLabel(slug)}</span>
          <code className="text-[10px] text-muted-foreground">--{slug}</code>
          {set === undefined && (
            <span className="text-[10px] leading-4 text-muted-foreground">default</span>
          )}
        </div>
        {note !== undefined && <p className="mt-0.5 text-[11px] text-muted-foreground">{note}</p>}
      </div>

      {kind === 'color' ? (
        <ColorSwatch
          shown={shown}
          hex={tokenToHex(slug)}
          onPick={onSet}
          label={`${themeTokenLabel(slug)} colour`}
        />
      ) : (
        // A length or a shadow. Typed rather than picked: `0.5rem` and a
        // box-shadow are not things a swatch can express, and the validator
        // already says exactly what it will accept.
        <Input
          value={draft}
          aria-label={themeTokenLabel(slug)}
          placeholder={kind === 'length' ? '0.5rem' : 'inherits'}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft.trim() === '') onClear()
            else if (draft !== set) onSet(draft.trim())
          }}
          className="h-6 w-44 shrink-0 px-1.5 py-0 font-mono text-[11px]"
        />
      )}

      <Tooltip content={set === undefined ? 'already the default' : 'back to the default'}>
        <Button
          variant="ghost"
          size="xs"
          aria-label={`reset ${themeTokenLabel(slug)}`}
          disabled={set === undefined}
          onClick={onClear}
          className="size-6 shrink-0 p-0"
        >
          <RotateCcw size={12} />
        </Button>
      </Tooltip>
    </div>
  )
}

export function ThemeSection({ remote }: { remote: string }): React.JSX.Element {
  const appMode = useAtomValue(activeModeAtom)
  // Starts on the mode the app is in, so the first thing you edit is the thing
  // you can see. Free to diverge after that — editing the other mode's palette
  // without switching the whole app to it is the point of having the control.
  const [mode, setMode] = useState<ThemeMode>(appMode === 'light' ? 'light' : 'dark')
  const [layer, setLayer] = useState<Layer>('committed')
  const [theme, setTheme] = useState<ResolvedTheme | null>(null)
  const [error, setError] = useState<string | null>(null)

  const read = useCallback(async () => {
    setTheme(await trpc.theme.read.query({ remote }))
  }, [remote])

  useEffect(() => {
    void read()
  }, [read])

  const write = async (slug: string, value: string | null): Promise<void> => {
    setError(null)
    try {
      const result = await trpc.theme.write.mutate({
        remote,
        layer,
        patchJson: JSON.stringify({ [mode]: { [slug]: value } }),
      })
      if (result.warnings.length > 0) setError(result.warnings.join('; '))
      // The watcher re-applies the theme to the document on its own; this is
      // only so the pane's own "default" markers agree with the file.
      await read()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not write the theme file')
      await read()
    }
  }

  /**
   * What this vault says for the mode on screen.
   *
   * **Read from the RESOLVED theme, which is committed merged under local.** So
   * with the layer set to shared, a token the local file overrides still shows
   * the local value — because that is the colour in force, and a pane that
   * showed the shared one would be describing a vault nobody is looking at.
   * The layer decides where a write LANDS, not what is displayed.
   */
  const values = useMemo(() => (theme === null ? {} : theme[mode]), [theme, mode])

  if (theme === null) {
    return <p className="px-6 py-4 text-xs text-muted-foreground">Reading this vault’s theme…</p>
  }

  return (
    <div className="border-t border-border px-6 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Theme</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Colours and chrome, and nothing else — a theme cannot move or resize anything.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            label="Mode"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'dark' as const, label: 'Dark' },
              { value: 'light' as const, label: 'Light' },
            ]}
          />
          <Segmented
            label="Where changes go"
            value={layer}
            onChange={setLayer}
            options={[
              { value: 'committed' as const, label: 'Shared', hint: THEME_FILE },
              { value: 'local' as const, label: 'This machine', hint: THEME_LOCAL_FILE },
            ]}
          />
        </div>
      </div>

      {error !== null && (
        <p className="mt-3 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      {theme.warnings.map((warning) => (
        <p key={warning} className="mt-2 text-xs text-muted-foreground">
          {warning}
        </p>
      ))}

      {THEME_TOKEN_GROUPS.map((group) => (
        <section key={group.title} className="mt-4">
          <h3 className="text-xs font-medium">{group.title}</h3>
          <p className="text-[11px] text-muted-foreground">{group.blurb}</p>
          <div className="mt-1 divide-y divide-divider">
            {group.tokens.map((slug) => (
              <TokenRow
                key={slug}
                slug={slug}
                set={values[slug]}
                onSet={(value) => void write(slug, value)}
                onClear={() => void write(slug, null)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
