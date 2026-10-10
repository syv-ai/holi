/**
 * What makes a background session a quick agent (docs/features/quick-agent.md):
 * options on the one `claude --bg` every background session is, and nothing
 * written into the vault.
 *
 * - **`--settings`** with two hooks, always. `PreToolUse` on `AskUserQuestion`
 *   hands the question to Holi's bridge (`/ask`) and prints the answer Holi
 *   holds until the person picks one. Claude Code then takes the answers and
 *   never draws its own question box. With Holi gone, or a route that answers
 *   empty, the hook prints nothing and Claude Code asks the ordinary way.
 *   `Stop` hands Holi the turn's last message (`/quick-result`), which the
 *   panel shows, so the answer is read where the task was typed.
 * - **`--permission-mode auto`**, only when the person chose it in Settings
 *   (`autoApprove`). Otherwise the session follows the vault's own mode, and a
 *   permission prompt is Claude Code's, shown in the panel's terminal.
 * - **`--append-system-prompt`**, only when the person chose it
 *   (`instructions`): work alone, ask through AskUserQuestion so every
 *   question reaches the panel as a card, and be brief.
 *
 * Per launch rather than seeded: a shipped hook reaches an existing vault only
 * through `holi skills update`, and a merged settings key would put the hook in
 * every session in the vault. These reach exactly the sessions the panel
 * starts, in every vault, from the first one.
 *
 * No Electron import: this loads under plain Node like the rest of the plugin.
 */
import { shellReadBridgeEnv } from '../../../../main/plugin-api'

/** What a quick agent is told, after Claude Code's own system prompt, when
 *  the person chose `instructions`. */
export const QUICK_SYSTEM_PROMPT = [
  "You were started from Holi's quick panel. The person typed this task into a small floating",
  'panel and went back to what they were doing. While you work, the panel shows them only a',
  'colour: yellow while you work, green when you are done, red if you fail.',
  '',
  '- Work on your own. Make the reasonable choice and carry on; do not stop to report progress',
  '  or to confirm something you can decide yourself.',
  '- Ask only when you are blocked on a decision that is genuinely theirs: a preference, a',
  '  trade-off, or something only they know.',
  '- When you ask, always use the AskUserQuestion tool, never a question in your reply. The',
  '  panel shows it as a card they answer with one key; a question in plain text waits unseen.',
  '- Put your recommended option first and end its label with "(Recommended)". Keep labels',
  '  short.',
  '- Be as brief as possible in everything you write. No preamble, no restating the task, no',
  '  narrating your steps, no closing pleasantries. Question text and option descriptions are',
  '  one short line each.',
  '- When you are done, your last message is the result in one or two sentences, or just the',
  '  answer itself: the panel shows it to them, so it is all they read.',
].join('\n')

/** How long the hook may hold a question, in seconds: a day. A person may
 *  come back to a waiting panel much later; the session waits with it. */
export const ASK_TIMEOUT_S = 86_400

/**
 * A hook that posts its stdin, the hook's JSON, to the bridge's `route`: POSIX
 * sh, and only inside a Holi background session, with the vault's token (from
 * its `bridge.local.env`, parsed, never sourced) and the job id. `curl` is the
 * command up to its URL and `redirect` what follows it. Elsewhere, or with no
 * bridge, it does nothing and prints nothing.
 */
function bridgeHook(route: string, curl: string, redirect: string): string {
  const env = shellReadBridgeEnv(['HOLI_BRIDGE_PORT', 'HOLI_BRIDGE_TOKEN']).join('; ')
  const url = `"http://127.0.0.1:$HOLI_BRIDGE_PORT/${route}?t=$HOLI_BRIDGE_TOKEN&job=\${CLAUDE_JOB_DIR##*/}"`
  return [
    'input=$(cat)',
    `if [ -n "\${CLAUDE_JOB_DIR:-}" ]; then ${env}; if [ -n "$HOLI_BRIDGE_PORT" ] && [ -n "$HOLI_BRIDGE_TOKEN" ]; then ${curl} --data-binary "$input" ${url} ${redirect}; fi; fi`,
    'true',
  ].join('; ')
}

/**
 * The question hook, run with the tool call's JSON: it posts it to `/ask` and
 * prints whatever comes back. Holi answers empty (204) for a question it is
 * not taking, so every way of not answering prints nothing and falls through
 * to Claude Code's own question box.
 *
 * **`exec`, with the JSON as an argument rather than piped in**: the shell
 * becomes the `curl`, so when Claude Code ends the hook (a stop, a timeout)
 * the request ends with it and Holi lets go of the question. A piped `curl`
 * would outlive its shell, holding the question for a day.
 */
export const ASK_HOOK = bridgeHook(
  'ask',
  `exec curl -s -m ${ASK_TIMEOUT_S} -H 'content-type: application/json'`,
  '2>/dev/null',
)

/**
 * The result hook, run as a turn ends with the turn's JSON
 * (`last_assistant_message` among it): it posts it to `/quick-result` and
 * prints nothing, whatever happens, since a `Stop` hook's output is a decision
 * about whether the turn may end. Holi answers at once, and a Holi that does
 * not is waited on a few seconds.
 */
export const RESULT_HOOK = bridgeHook(
  'quick-result',
  "curl -s -m 3 -o /dev/null -H 'content-type: application/json'",
  '>/dev/null 2>&1',
)

/** The `--settings` JSON: the two hooks, and nothing else. */
export const QUICK_SETTINGS = JSON.stringify({
  hooks: {
    PreToolUse: [
      {
        matcher: 'AskUserQuestion',
        hooks: [{ type: 'command', command: ASK_HOOK, timeout: ASK_TIMEOUT_S }],
      },
    ],
    Stop: [{ hooks: [{ type: 'command', command: RESULT_HOOK }] }],
  },
})

/** A quick agent's options for `startBg`, from the person's choices. */
export function quickLaunch(choices: { autoApprove: boolean; instructions: boolean }): QuickLaunch {
  return {
    settings: QUICK_SETTINGS,
    ...(choices.autoApprove ? { permissionMode: 'auto' as const } : {}),
    ...(choices.instructions ? { appendSystemPrompt: QUICK_SYSTEM_PROMPT } : {}),
  }
}

export interface QuickLaunch {
  settings: string
  permissionMode?: 'auto'
  appendSystemPrompt?: string
}
