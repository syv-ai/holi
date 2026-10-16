/**
 * What the person said, as a bubble, and the pictures in it.
 */
import { FileText, ImageIcon } from 'lucide-react'
import { useState } from 'react'
import { Icon } from '@/primitives'
import { cn, vaultAssetUrl } from '@/plugin-api'
import { splitUserText, uploadVaultPath } from '../../../../agent/renderer/chat/attachments'

/**
 * A picture the person attached, drawn from the vault where it was saved
 * (`holi-vault://`), so a screenshot reads as a screenshot. A file that cannot
 * be read back (gone, or not an image after all) falls back to its name.
 */
export function AttachedImage({ path, label }: { path: string; label: string }): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <span
        data-chat-image=""
        className="flex w-fit items-center gap-1.5 rounded-lg bg-background/60 px-2 py-1 text-xs"
      >
        <Icon icon={ImageIcon} size="sm" />
        <span className="truncate">{label}</span>
      </span>
    )
  }
  return (
    <img
      data-chat-image=""
      src={vaultAssetUrl(path)}
      alt={label}
      draggable={false}
      onError={() => setFailed(true)}
      className="max-h-60 w-auto max-w-full rounded-lg object-contain"
    />
  )
}

/**
 * A person's message, as a bubble. A file it names (`@path`, which is how
 * Claude Code is given one) reads as a chip with the file's name, not as a
 * path, in the place the person put it; one with pictures pasted straight
 * into Claude Code's own input says how many.
 */
export function UserBubble({
  text,
  images = 0,
  pending = false,
}: {
  text: string
  /** Pictures that came with it, as the transcript counts them. */
  images?: number
  pending?: boolean
}): React.JSX.Element {
  const parts = splitUserText(text)
  const chip = 'flex w-fit items-center gap-1.5 rounded-lg bg-background/60 px-2 py-1 text-xs'
  return (
    <div
      data-chat-user=""
      className={cn(
        'flex max-w-[85%] flex-col gap-2 self-end rounded-2xl rounded-br-md bg-secondary px-3.5 py-2 text-sm text-secondary-foreground',
        pending && 'opacity-60',
      )}
    >
      {Array.from({ length: Number.isFinite(images) ? Math.max(0, images) : 0 }, (_, i) => (
        <span key={`image-${i}`} data-chat-image="" className={chip}>
          <Icon icon={ImageIcon} size="sm" />
          <span>Image {i + 1}</span>
        </span>
      ))}
      {parts.map((part, i) =>
        part.kind === 'text' ? (
          <span key={i} className="whitespace-pre-wrap">
            {part.text}
          </span>
        ) : part.image && uploadVaultPath(part.path) !== null ? (
          <AttachedImage key={i} path={uploadVaultPath(part.path)!} label={part.label} />
        ) : (
          <span key={i} data-chat-image={part.image ? '' : undefined} className={chip}>
            <Icon icon={part.image ? ImageIcon : FileText} size="sm" />
            <span className="truncate">{part.label}</span>
          </span>
        ),
      )}
    </div>
  )
}
