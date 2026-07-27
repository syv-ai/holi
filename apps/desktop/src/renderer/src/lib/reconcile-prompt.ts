/**
 * The reconcile seed message — turn one of an agent session started from the
 * "Ask Claude to reconcile" button. Passed as the positional prompt to `claude`
 * (see `buildAgentArgs`), so it is a plain first-person instruction to the agent,
 * not a system prompt.
 */
export function buildReconcilePrompt(paths: string[]): string {
  const list = paths.map((p) => `- \`${p}\``).join('\n')
  return [
    `A \`git pull\` hit a merge conflict, and the merge is now in progress in this repo. These files have conflict markers:`,
    '',
    list,
    '',
    "Resolve every `<<<<<<<` / `=======` / `>>>>>>>` marker in each file by combining both sides' intent — this is prose and YAML frontmatter, so merge on meaning, not by line position. When every file is resolved, stage them and finish the merge with `git add` and `git commit --no-edit`, then tell me what you changed.",
  ].join('\n')
}
