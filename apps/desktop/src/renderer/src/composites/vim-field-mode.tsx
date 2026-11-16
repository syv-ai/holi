import { useAtomValue } from 'jotai'
import { Badge } from '@/components/ui/badge'
import type { NativeFieldMode } from '@/lib/native-field-vim'
import { vimCodeEditingAtom } from '@/state/preferences'

/** Compact status for the field that currently owns focus. */
export function VimFieldMode({ mode }: { mode: NativeFieldMode | null }) {
  const enabled = useAtomValue(vimCodeEditingAtom)
  if (!enabled) return null
  return (
    <span className={mode === null ? 'invisible' : undefined} aria-hidden={mode === null}>
      {mode === null ? (
        <Badge variant="secondary">INSERT</Badge>
      ) : (
        <Badge variant="secondary" aria-live="polite" aria-label={`Vim ${mode} mode`}>
          {mode.toUpperCase()}
        </Badge>
      )}
    </span>
  )
}
