import { useAtom, useAtomValue } from 'jotai'
import { useEffect } from 'react'

import { trpc } from '@/lib/trpc'
import { useAgentService } from '@/state/agent-service'
import { claudeFirstRunAtom } from '@/state/claude-first-run'
import { tabKey } from '@/state/tab-descriptor'
import { activeRemoteAtom, snapshotLoadedAtom } from '@/state/vaults'

/**
 * Answer the onboarding's request for Claude Code's first run
 * (`state/claude-first-run.ts`): once the new vault is the open one, its
 * files are in and its agent is running, open a terminal on `claude /login`
 * there and show it as a tab. Claude Code asks to trust the folder, then to
 * sign in; a refusal leaves the request standing for the next open.
 */
export function useClaudeFirstRun(openTab: (id: string) => void): void {
  const [pending, setPending] = useAtom(claudeFirstRunAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const loaded = useAtomValue(snapshotLoadedAtom)
  const agent = useAgentService()

  useEffect(() => {
    if (pending === null || pending !== remote || !loaded || agent === null) return
    let live = true
    void trpc.cap.run
      .mutate({
        remote,
        name: 'agent.open',
        paramsJson: JSON.stringify({ login: true }),
      })
      .then((result) => {
        const opened = result as { ok: true; terminalId: string } | { ok: false; message: string }
        if (!live || !opened.ok) return
        setPending(null)
        openTab(tabKey({ kind: 'surface', surface: 'agent', id: opened.terminalId }))
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
    // `openTab` is the shell's, new each render; the request is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, remote, loaded, agent])
}
