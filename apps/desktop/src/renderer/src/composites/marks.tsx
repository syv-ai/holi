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
import { Blocks, Plug, Puzzle } from 'lucide-react'
import { FileType, Icon } from '@/primitives'

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

const PLUGIN_MARKS: Record<string, () => ReactNode> = {
  agent: () => <Icon icon={SiClaude} size="lg" className="text-orange-500 dark:text-orange-400" />,
  pdf: () => <FileType type="pdf" size="xs" />,
  google: () => <Icon icon={GoogleG} size="lg" />,
  apps: () => <Icon icon={Blocks} size="lg" />,
  community: () => <Icon icon={Puzzle} size="lg" />,
}

/** The mark for a plugin, by id. */
export function pluginMark(id: string): ReactNode {
  return (PLUGIN_MARKS[id] ?? (() => <Icon icon={Plug} size="lg" />))()
}
