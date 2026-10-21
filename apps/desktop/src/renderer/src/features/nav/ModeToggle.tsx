/**
 * The sidebar's two modes (docs/features/sidebar.md): Documents, writing in
 * the vault, and Agents, the work being done for you. The Agents side is the
 * agent plugin's (`agentsMode`), and so is what it reports here from either
 * mode: an amber count while something needs you, a turning ring while agents
 * work. Without a plugin providing it there is one mode and no toggle.
 *
 * Tabs, because each mode is the sidebar's panel below it: the stock list,
 * the active segment raised in place.
 */
import { atom, useAtom, useAtomValue } from 'jotai'
import { FileText } from 'lucide-react'
import { HOLI_COLOURS } from '@holi/shared'
import { PixelMascot, type MascotStatus } from '@/composites'
import { Icon, Tabs, TabsList, TabsTrigger } from '@/primitives'
import type { AgentsStatus } from '@/plugin-api/types'
import { appModeAtom, type AppMode } from '@/state/app-mode'
import { runningPluginsAtom } from '@/state/plugins'

const IDLE = atom<AgentsStatus>({ needsYou: 0, working: 0 })

/** The plugin's Agents mode, if one runs. */
export function useAgentsMode() {
  return useAtomValue(runningPluginsAtom).find((p) => p.agentsMode !== undefined)?.agentsMode
}

/** What the agents report: needing you, working. Idle without the plugin. */
export function useAgentsStatus(): AgentsStatus {
  return useAtomValue(useAgentsMode()?.status ?? IDLE)
}

export function ModeToggle(): React.JSX.Element | null {
  const agents = useAgentsMode()
  const [mode, setMode] = useAtom(appModeAtom)
  const status = useAgentsStatus()
  if (agents === undefined) return null

  const said =
    status.needsYou > 0
      ? `, ${status.needsYou} need${status.needsYou === 1 ? 's' : ''} you`
      : status.working > 0
        ? `, ${status.working} working`
        : ''

  return (
    <Tabs value={mode} onValueChange={(next) => setMode(next as AppMode)}>
      {/* One chrome row tall, state by fill only (no ring, no shadow), in the
          sidebar's type: the toggle reads as part of the rows below it. */}
      <TabsList aria-label="Mode" className="h-8 w-full p-0.5">
        <TabsTrigger value="documents" className="text-nav data-[state=active]:shadow-none">
          <Icon icon={FileText} size="sm" />
          <span className="truncate">Documents</span>
        </TabsTrigger>
        <TabsTrigger
          value="agents"
          aria-label={`Agents${said}`}
          className="text-nav data-[state=active]:shadow-none"
        >
          {/* The agents have a face, as each Holi does: idle it bobs,
              working it hops, waiting on you it gets an idea. */}
          <PixelMascot
            name="invader"
            color={HOLI_COLOURS[0]}
            status={agentsFace(status)}
            className="size-3.5"
          />
          <span className="truncate">Agents</span>
          {status.needsYou > 0 ? (
            <span className="flex items-center gap-1 text-xs text-amber-600 tabular-nums dark:text-amber-400">
              {/* Steady, not breathing: it waits on you until you look, and a
                  loop that never ends stops being read. */}
              <span className="size-1.5 rounded-full bg-current" />
              {status.needsYou}
            </span>
          ) : status.working > 0 ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
              <span className="size-2.5 rounded-full border-[1.5px] border-foreground/20 border-t-foreground motion-orbit" />
              {status.working}
            </span>
          ) : null}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )
}

/** What the Agents face is doing: what the agents report, the most urgent
 *  first. */
function agentsFace(status: AgentsStatus): MascotStatus {
  if (status.needsYou > 0) return 'needs-you'
  if (status.working > 0) return 'working'
  return 'idle'
}
