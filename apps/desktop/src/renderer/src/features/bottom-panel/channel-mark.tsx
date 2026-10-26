import { SiClaude, SiGit, SiGithub } from '@icons-pack/react-simple-icons'
import { PuzzleIcon } from 'lucide-react'

import { BRAND_MONOGRAM } from '@/lib/brand-shapes'
import { cn } from '@/lib/cn'
import { channelLabel, type ActivityChannel } from '@/state/activity'

/**
 * An Output channel's mark: the brand's own where the channel is a brand's
 * (git, Claude for the agent, GitHub for sync, which is pull and push
 * against it, Holi for the app), a lucide glyph for plugins. Brand colours
 * are the palette with their `dark:` pair: categorical identity.
 */

function HoliGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox={`0 0 ${BRAND_MONOGRAM.width} ${BRAND_MONOGRAM.height}`}
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      {BRAND_MONOGRAM.paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}

function ChannelMark({ channel, className }: { channel: ActivityChannel; className?: string }) {
  const look = cn('size-3.5 shrink-0', className)
  switch (channel) {
    case 'git':
      return (
        <SiGit aria-hidden="true" className={cn(look, 'text-orange-600 dark:text-orange-500')} />
      )
    case 'sync':
      return <SiGithub aria-hidden="true" className={cn(look, 'text-foreground')} />
    case 'agent':
      return (
        <SiClaude aria-hidden="true" className={cn(look, 'text-orange-500 dark:text-orange-400')} />
      )
    case 'plugins':
      return <PuzzleIcon aria-hidden="true" className={cn(look, 'text-muted-foreground')} />
    case 'app':
      return <HoliGlyph className={cn(look, 'text-foreground w-auto')} />
  }
}

/** The mark and the channel's name, as a line or a heading shows it. */
export function ChannelTag({
  channel,
  className,
}: {
  channel: ActivityChannel
  className?: string
}) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <ChannelMark channel={channel} />
      <span className="truncate">{channelLabel(channel)}</span>
    </span>
  )
}
