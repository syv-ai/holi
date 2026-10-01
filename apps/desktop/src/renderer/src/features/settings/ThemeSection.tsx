/**
 * The vault's colours and chrome, with real controls.
 *
 * **Both palettes side by side.** The theme files carry a `light` and a `dark`
 * block; each token is a row and each palette a column, so a colour is edited
 * beside its counterpart, and the column the app is showing says so. Which one
 * shows is the Appearance setting above, not this table.
 *
 * **Layer, chosen once for the section.** `THEME_FILE` is committed and
 * shared; `THEME_LOCAL_FILE` is this machine's and overrides it per key. Same
 * split as settings.
 *
 * **A token with no value is the normal case.** Every cell shows the colour *in
 * force* (Holi's default, resolved by the browser), and offers a reset only
 * where this vault set it. A reset deletes the key rather than writing a
 * blank, which is why the patch carries `null`.
 *
 * **Rendered from `THEME_TOKEN_GROUPS`**, so adding a token to the whitelist
 * puts it in this pane.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAtomValue } from 'jotai'
import { RotateCcw } from 'lucide-react'
import {
  THEME_TOKEN_GROUPS,
  THEME_TOKEN_NOTES,
  themeBlockToVars,
  themeTokenKind,
  themeTokenLabel,
  type ResolvedTheme,
  type ThemeMode,
  THEME_FILE,
  THEME_LOCAL_FILE,
} from '@holi/shared'
import { Button, ColorSwatch, Dialog, IconButton, Input, Tooltip } from '@/primitives'
import { SettingsNote } from '@/composites'
import { SettingsHeading } from '@/composites'
import { LIGHT_AND_DARK } from './appearance-headings'
import { DescriptorSection } from './DescriptorSection'
import { cn } from '@/lib/cn'
import { tokenToHex } from '@/lib/css-color'
import { trpc } from '@/lib/trpc'
import { activeModeAtom } from '@/state/color-scheme'

type Layer = 'committed' | 'local'

/** A pair of buttons that read as one choice, the same shape the settings rows
 *  use for `choice`. */
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

/** The palettes, in the order their columns stand. */
const MODES: readonly ThemeMode[] = ['light', 'dark']

/** Label column, then one per palette. Shared by the header and every row, so
 *  the columns line up down the whole table. */
const GRID = 'grid grid-cols-[minmax(0,1fr)_9.5rem_9.5rem] items-center gap-3'

/**
 * One token in one palette: the value in force there, and its reset.
 *
 * Painted inside `[data-theme=mode]` with the vault's block for that mode, so
 * the swatch shows that palette's colour whichever mode the app is in (the
 * selector is not anchored to the root). The picker starts from the colour as
 * this cell resolves it, for the same reason.
 */
function TokenCell({
  slug,
  mode,
  block,
  set,
  onSet,
  onClear,
}: {
  slug: string
  mode: ThemeMode
  /** The vault's whole block for this mode: what the cell is painted with. */
  block: Record<string, string>
  /** What this vault says for this token here. Absent when it says nothing. */
  set: string | undefined
  onSet: (value: string) => void
  onClear: () => void
}): React.JSX.Element {
  const kind = themeTokenKind(slug)
  const label = `${themeTokenLabel(slug)} in ${mode}`
  const scope = useRef<HTMLDivElement>(null)
  const [hex, setHex] = useState('#000000')
  useLayoutEffect(() => {
    if (scope.current !== null) setHex(tokenToHex(slug, scope.current))
  }, [slug, block])
  const [draft, setDraft] = useState(set ?? '')
  useEffect(() => setDraft(set ?? ''), [set])

  return (
    <div
      ref={scope}
      data-theme={mode}
      style={themeBlockToVars(block) as React.CSSProperties}
      className="flex items-center justify-center gap-1"
    >
      {kind === 'color' ? (
        <ColorSwatch shown={`var(--${slug})`} hex={hex} onPick={onSet} label={label} />
      ) : (
        // A length or a shadow: typed rather than picked, since a swatch cannot
        // express it and the validator says what it accepts.
        <Input
          value={draft}
          aria-label={label}
          placeholder={kind === 'length' ? '0.5rem' : 'default'}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft.trim() === '') onClear()
            else if (draft !== set) onSet(draft.trim())
          }}
          className="h-6 min-w-0 flex-1 px-1.5 py-0 font-mono text-[11px]"
        />
      )}
      {/* Invisible rather than absent while there is nothing to reset, so a
          cell keeps its width and the column does not move. */}
      <IconButton
        icon={RotateCcw}
        label={`reset ${label}`}
        tooltip="back to Holi’s default"
        disabled={set === undefined}
        onClick={onClear}
        className={set === undefined ? 'invisible' : undefined}
      />
    </div>
  )
}

export function ThemeSection({ remote }: { remote: string }): React.JSX.Element {
  const [layer, setLayer] = useState<Layer>('committed')
  const [theme, setTheme] = useState<ResolvedTheme | null>(null)
  const [error, setError] = useState<string | null>(null)

  const read = useCallback(async () => {
    setTheme(await trpc.theme.read.query({ remote }))
  }, [remote])

  useEffect(() => {
    void read()
  }, [read])

  const write = async (mode: ThemeMode, slug: string, value: string | null): Promise<void> => {
    setError(null)
    try {
      const result = await trpc.theme.write.mutate({
        remote,
        layer,
        patchJson: JSON.stringify({ [mode]: { [slug]: value } }),
      })
      if (result.warnings.length > 0) setError(result.warnings.join('; '))
      // The watcher re-applies the theme to the document on its own; this is
      // only so the cells agree with the file.
      await read()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not write the theme file')
      await read()
    }
  }

  return (
    <div>
      <SettingsHeading title={LIGHT_AND_DARK} />
      {/* `colorScheme` is a descriptor like any other and lands here by saying
          so, rather than by this component knowing about it. */}
      <DescriptorSection section="appearance" />

      {/* **Above the theme's own loading gate, not behind it.** Light/dark is a
          settings row and the theme file a separate read, so it need not wait. */}
      {theme === null ? (
        <p className="py-4 text-xs text-muted-foreground">Reading this vault&rsquo;s theme…</p>
      ) : (
        <ThemeTokens
          remote={remote}
          theme={theme}
          layer={layer}
          setLayer={setLayer}
          error={error}
          write={write}
        />
      )}
    </div>
  )
}

/**
 * Every token, a row each, with the light and dark palettes side by side: a
 * palette is the set of colours for one mode, and the Appearance setting above
 * says which one is showing. Values are the RESOLVED theme, committed merged
 * under local, so a cell shows the colour in force; the layer decides only
 * where a write lands.
 */
function ThemeTokens({
  remote,
  theme,
  layer,
  setLayer,
  error,
  write,
}: {
  remote: string
  theme: ResolvedTheme
  layer: Layer
  setLayer: (next: Layer) => void
  error: string | null
  write: (mode: ThemeMode, slug: string, value: string | null) => Promise<void>
}): React.JSX.Element {
  const showing = useAtomValue(activeModeAtom)
  return (
    <>
      {/* **Sticky, because they govern everything below them.** Scrolled away,
          a column would be ambiguous about its palette and a write about its
          file. */}
      <div className="sticky top-0 z-10 -mx-1 mt-4 flex flex-col gap-2 bg-background px-1 py-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-xs font-medium">Theme</h3>
            <SettingsNote>
              Colours and chrome, and nothing else: a theme cannot move or resize anything.
            </SettingsNote>
          </div>
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
        <div className={GRID}>
          <span />
          {MODES.map((mode) => (
            <span key={mode} className="flex flex-col items-center gap-0.5">
              <span
                className={cn(
                  'w-full rounded-md py-1 text-center text-xs',
                  mode === showing
                    ? 'bg-secondary text-secondary-foreground'
                    : 'text-muted-foreground',
                )}
              >
                {mode === 'light' ? 'Light palette' : 'Dark palette'}
              </span>
              {/* Its own line, in both columns, hidden where it is not true:
                  switching mode moves the words, never the layout. */}
              <span
                className={cn(
                  'text-[10px] leading-4 text-muted-foreground',
                  mode !== showing && 'invisible',
                )}
              >
                showing now
              </span>
            </span>
          ))}
        </div>
      </div>

      {error !== null && (
        <p className="mt-3 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
          {error}
        </p>
      )}

      {theme.warnings.map((warning) => (
        <SettingsNote key={warning} className="mt-2">
          {warning}
        </SettingsNote>
      ))}

      {THEME_TOKEN_GROUPS.map((group) => (
        <section key={group.title}>
          {/* The rail's jump target for this group, derived from the same title
              the rail derives its id from. */}
          <SettingsHeading title={group.title} blurb={group.blurb} />
          <div className="flex flex-col">
            {group.tokens.map((slug) => {
              const note = THEME_TOKEN_NOTES[slug]
              return (
                <div key={slug} className={cn(GRID, 'rounded-md px-1 py-1.5 hover:bg-accent/50')}>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-xs">{themeTokenLabel(slug)}</span>
                    <code className="text-[10px] text-muted-foreground">--{slug}</code>
                    {note !== undefined && (
                      <span className="text-[11px] text-muted-foreground">{note}</span>
                    )}
                  </span>
                  {MODES.map((mode) => (
                    <TokenCell
                      key={mode}
                      slug={slug}
                      mode={mode}
                      block={theme[mode]}
                      set={theme[mode][slug]}
                      onSet={(value) => void write(mode, slug, value)}
                      onClear={() => void write(mode, slug, null)}
                    />
                  ))}
                </div>
              )
            })}
          </div>
        </section>
      ))}

      <ResetTheme remote={remote} />
    </>
  )
}

/**
 * Back to the standard look, in one act.
 *
 * **Not the same control as a row's reset**: a row's reset deletes one key,
 * this deletes both theme files.
 *
 * Confirmed, because deleting the COMMITTED file removes the shared theme for
 * collaborators too, on their next sync.
 */
function ResetTheme({ remote }: { remote: string }): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)

  const reset = (): void => {
    // The running app reverts itself: the file deletion fires the watcher, which
    // re-reads the (now empty) theme and clears the applied tokens.
    void trpc.theme.reset.mutate({ remote }).finally(() => setConfirming(false))
  }

  return (
    // **No rule of its own**: the view's footer draws one, and two would sit a
    // few pixels apart. Spacing separates it.
    <div className="mt-6 flex items-center justify-between gap-3">
      <SettingsNote>
        Clear every colour this vault has set, in both files and both modes.
      </SettingsNote>
      <Button
        variant="secondary"
        size="xs"
        className="shrink-0"
        onClick={() => setConfirming(true)}
      >
        Reset theme
      </Button>

      {confirming && (
        <Dialog open onClose={() => setConfirming(false)} size="sm">
          <div className="grid gap-4">
            <Dialog.Header>Reset theme?</Dialog.Header>
            <Dialog.Body>
              <p className="text-xs text-muted-foreground">
                Deletes <span className="font-mono">{THEME_FILE}</span> and{' '}
                <span className="font-mono">{THEME_LOCAL_FILE}</span>, returning the vault to the
                standard look. The shared theme is removed for collaborators on the next sync.
              </p>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={reset}>
                Reset theme
              </Button>
            </Dialog.Footer>
          </div>
        </Dialog>
      )}
    </div>
  )
}
