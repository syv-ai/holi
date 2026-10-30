/**
 * The agent's two surfaces in a document: the prompt that opens on an empty
 * line (Space) or over a selection, and the status pill that says what a run is doing, with Stop.
 */
import { useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { ArrowUpIcon, SparklesIcon, SquareIcon, XIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupTextarea,
} from '@/components/ui/input-group'
import { Kbd } from '@/components/ui/kbd'
import { Spinner } from '@/components/ui/spinner'
import { showAgentSessionAtom } from '@/state/agent-service'
import { claudeFirstRunAtom } from '@/state/claude-first-run'
import type { AgentRun } from '@/state/document-runs'
import { activeRemoteAtom } from '@/state/vaults'

/** Where the person types what the agent should do: on the line they opened
 *  it from, or for a selection from the format bubble's Ask AI. Enter sends,
 *  Shift+Enter breaks the line, Escape closes. */
export function AgentPrompt({
  initial = '',
  heading = 'Ask Sonnet to write or change this document',
  placeholder = 'Draft an introduction, turn the list into a table…',
  onSubmit,
  onCancel,
}: {
  /** Written in already, for the person to send or change: an app
   *  command's instruction. */
  initial?: string
  /** What the prompt is for, above the field. */
  heading?: string
  placeholder?: string
  onSubmit: (request: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(initial)
  const send = () => {
    const request = text.trim()
    if (request !== '') onSubmit(request)
  }

  return (
    // Solid, over the glass: the input group's own fill is translucent.
    <InputGroup className="bg-popover dark:bg-popover">
      <InputGroupAddon align="block-start">
        <InputGroupText className="text-primary">
          <SparklesIcon aria-hidden="true" />
          {heading}
        </InputGroupText>
      </InputGroupAddon>
      <InputGroupTextarea
        autoFocus
        rows={1}
        value={text}
        aria-label="What should the agent do?"
        placeholder={placeholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          } else if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            send()
          }
        }}
        className="min-h-0 text-sm"
      />
      <InputGroupAddon align="block-end" className="justify-between">
        <InputGroupText className="text-xs">
          <Kbd>Esc</Kbd> to close
        </InputGroupText>
        <InputGroupButton
          variant="default"
          size="icon-xs"
          aria-label="Send"
          disabled={text.trim() === ''}
          onClick={send}
        >
          <ArrowUpIcon aria-hidden="true" />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  )
}

const WORKING: Record<AgentRun['kind'], string> = {
  write: 'Writing',
  rewrite: 'Rewriting',
  'vault-app': 'Creating the vault app',
}

/** What a run is doing, at the foot of the document. Stop ends it; a run
 *  waiting on a permission, and a vault app's at any time, can be opened in
 *  Agents. */
export function AgentStatus({
  run,
  onStop,
  onDismiss,
  onOpenApp,
}: {
  run: AgentRun
  onStop: () => void
  onDismiss: () => void
  onOpenApp: () => void
}) {
  const showSession = useSetAtom(showAgentSessionAtom)
  const remote = useAtomValue(activeRemoteAtom)
  const firstRun = useSetAtom(claudeFirstRunAtom)
  /** Claude Code refuses a background session in a folder it was never
   *  asked to trust: the fix is its own prompt, in a terminal. */
  const untrusted = run.status === 'failed' && /not trusted/i.test(run.message ?? '')
  const live = run.status === 'starting' || run.status === 'working' || run.status === 'needs-you'

  const text =
    run.status === 'starting'
      ? `Starting ${run.agent}…`
      : run.status === 'working'
        ? `${WORKING[run.kind]}…`
        : run.status === 'needs-you'
          ? 'Waiting for you in Agents'
          : run.status === 'failed'
            ? (run.message ?? 'The agent could not run.')
            : run.status === 'stopped'
              ? 'Stopped'
              : run.kind === 'vault-app'
                ? 'The vault app is ready'
                : 'Done'

  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-popover text-popover-foreground ring-foreground/10 flex max-w-full items-center gap-2 rounded-full py-1 ps-3 pe-1 text-sm shadow-md ring-1"
    >
      {live ? (
        <Spinner className="text-primary size-3.5 shrink-0" />
      ) : (
        <SparklesIcon aria-hidden="true" className="text-primary size-3.5 shrink-0" />
      )}
      <span className="min-w-0 truncate">
        {text}
        {live && run.kind !== 'vault-app' ? (
          <span className="text-muted-foreground"> · {run.label}</span>
        ) : null}
      </span>
      {/* A vault app's session is there to be watched and added to. */}
      {live &&
      run.sessionId !== null &&
      (run.status === 'needs-you' || run.kind === 'vault-app') ? (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => void showSession({ session: run.sessionId!, live: true })}
        >
          {run.kind === 'vault-app' ? 'Open session' : 'Open'}
        </Button>
      ) : null}
      {live ? (
        <Button variant="secondary" size="xs" onClick={onStop}>
          <SquareIcon aria-hidden="true" className="fill-current" />
          Stop
        </Button>
      ) : (
        <>
          {untrusted && remote !== null ? (
            <Button
              variant="secondary"
              size="xs"
              onClick={() => {
                onDismiss()
                firstRun(remote)
              }}
            >
              Trust in Claude Code
            </Button>
          ) : null}
          {run.kind === 'vault-app' && run.status === 'done' ? (
            <Button variant="secondary" size="xs" onClick={onOpenApp}>
              Open
            </Button>
          ) : null}
          <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={onDismiss}>
            <XIcon aria-hidden="true" />
          </Button>
        </>
      )}
    </div>
  )
}
