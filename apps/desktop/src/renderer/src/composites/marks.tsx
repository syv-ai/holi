/**
 * The marks the app shows for the things it plugs into, each for an
 * `IconTile`: a brand's own mark in its own colours where there is a brand
 * (Claude, Google, a PDF), a lucide glyph in the foreground where the thing is
 * Holi's own (vault apps, community plugins), and a plug for anything new.
 *
 * Keyed by plugin id rather than read off the plugin, because a plugin's info
 * is shared and browser-free and a mark is a React element. A plugin with no
 * entry here still shows, with the plug.
 *
 * Brand colours are Tailwind's palette, each with its `dark:` pair: they are
 * categorical identity, the one job the palette keeps (`docs/ui-system.md`,
 * Colour).
 */
import type { ReactNode } from 'react'
import { SiClaude } from '@icons-pack/react-simple-icons'
import { Blocks, Plug, Puzzle, SquareTerminal } from 'lucide-react'
import { cn } from '@/lib/cn'
import { FileType } from '@/components/ui/file-type'
import type { IconGlyph } from '@/lib/icon-glyph'

/** Google's four-colour G. simple-icons draws it in one colour, which reads as
 *  a generic G; the four are the mark. */
function GoogleG({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        className="fill-blue-500"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z"
      />
      <path
        className="fill-green-500"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.25 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
      />
      <path
        className="fill-yellow-500"
        d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.1V7.06H2.18A11 11 0 0 0 1 12c0 1.78.43 3.45 1.18 4.94l3.66-2.84Z"
      />
      <path
        className="fill-red-500"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A10.6 10.6 0 0 0 12 1 11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z"
      />
    </svg>
  )
}

/** OpenAI's mark, for Codex. simple-icons no longer ships it. */
function OpenAIMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  )
}

/** Each coding agent's glyph and colour (`agentProvider`): Claude's orange,
 *  OpenAI's mark in the text colour, as it is drawn on both grounds. An
 *  agent with no entry gets a terminal. */
const AGENT_MARKS: Record<string, { glyph: IconGlyph; className?: string }> = {
  claude: { glyph: SiClaude, className: 'text-orange-500 dark:text-orange-400' },
  codex: { glyph: OpenAIMark, className: 'text-foreground' },
  pi: { glyph: SquareTerminal },
}

/** The mark of the agent a session runs, at a row's or a tab's size. */
export function AgentMark({
  agent,
  size = 'sm',
  className,
}: {
  agent: string | undefined
  size?: 'sm' | 'lg'
  className?: string
}) {
  const mark: { glyph: IconGlyph; className?: string } = AGENT_MARKS[agent ?? 'claude'] ?? {
    glyph: SquareTerminal,
  }
  const Glyph = mark.glyph
  return (
    <Glyph
      aria-hidden
      className={cn('shrink-0', size === 'lg' ? 'size-5' : 'size-3.5', mark.className, className)}
    />
  )
}

const PLUGIN_MARKS: Record<string, () => ReactNode> = {
  agent: () => <SiClaude aria-hidden className="size-5 text-orange-500 dark:text-orange-400" />,
  pdf: () => <FileType type="pdf" size="xs" />,
  google: () => <GoogleG className="size-5" />,
  apps: () => <Blocks aria-hidden className="size-5" />,
  community: () => <Puzzle aria-hidden className="size-5" />,
}

/** The mark for a plugin, by id. */
export function pluginMark(id: string): ReactNode {
  return (PLUGIN_MARKS[id] ?? (() => <Plug aria-hidden className="size-5" />))()
}
