/**
 * The in-app stand-in for a file we can't yet render (image, PDF, office doc).
 * A real renderer replaces this per kind later (spec §Arbitrary files); it is
 * deliberately NOT a "reveal in Finder" shortcut — the file stays in-app, in the
 * vault, and syncs like everything else.
 */
import type { FileKind } from '@holi/shared'
import { DocIcon, ImageIcon, PdfIcon } from './tree/icons'

type RichKind = Exclude<FileKind, 'markdown' | 'text'>

const COPY: Record<RichKind, { label: string; Icon: () => JSX.Element }> = {
  image: { label: 'Image', Icon: ImageIcon },
  pdf: { label: 'PDF', Icon: PdfIcon },
  doc: { label: 'Document', Icon: DocIcon },
}

export function FilePlaceholder({ path, kind }: { path: string; kind: RichKind }) {
  const { label, Icon } = COPY[kind]
  const name = path.slice(path.lastIndexOf('/') + 1)
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-neutral-500">
      <div className="scale-[2.5] text-neutral-600">
        <Icon />
      </div>
      <p className="mt-2 font-mono text-sm text-neutral-300">{name}</p>
      <p className="text-xs">{label} preview isn’t available yet — it lives in the vault and syncs.</p>
    </div>
  )
}
