/**
 * The first turn of the session Holi starts when leaving or deleting a vault is
 * blocked because its work will not reach GitHub (D109). Passed as the
 * positional prompt to `claude`, like the reconcile seed, so it is a plain
 * first-person ask.
 */
export function buildStuckPushPrompt(intent: 'leave' | 'delete'): string {
  const act = intent === 'leave' ? 'leave' : 'delete'
  return [
    `I want to ${act} this vault, but Holi will not remove it while work here has not reached GitHub, and pushing it failed.`,
    '',
    'Find out why: look at `git status`, the commits ahead of `origin`, and what `git push` says. Then help me get the work onto the remote. Tell me what you find before you discard, reset or force-push anything.',
  ].join('\n')
}
