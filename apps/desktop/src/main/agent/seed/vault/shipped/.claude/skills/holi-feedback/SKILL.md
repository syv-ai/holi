---
name: holi-feedback
description: Send feedback to the Holi team as a GitHub issue on syv-ai/holi, drafted by you and submitted by the user. Use when you or the user want to report a Holi bug, a missing capability, or a skill or instruction that is unclear or wrong, or when asked how to reach the people who build Holi.
---

# Feedback for the Holi team

Holi is open source at https://github.com/syv-ai/holi. Its `docs/` explain how
Holi works, and its issues are where feedback goes. Claude Code's own feedback
tools reach Anthropic, not the Holi team.

**The repository is public.** An issue is readable by anyone, so nothing from
the vault goes in it: no note contents, names, mail, or paths that say more than
the problem needs. Describe the situation in general terms.

## Draft it first

Write the issue and show it to the user before it goes anywhere:

- **Title:** one line naming the problem, not the fix.
- **Kind:** one of `Something is missing`, `Something is broken`,
  `A skill or instruction is unclear or wrong`, `Other`.
- **Feedback:** what you were doing, where it got stuck, and what would have
  made it easy.
- **Context:** the skill, `holi` command or Holi feature involved, and
  `claude --version`.

One issue per problem, so each can be closed on its own.

## Then one of two ways

**A link the user submits (the default).** It works for anyone with a GitHub
account and needs nothing installed. Percent-encode each value:

```
https://github.com/syv-ai/holi/issues/new?template=vault-assistant.yml&title=<title>&kind=<kind>&feedback=<feedback>&context=<context>
```

Give the user the link. The form opens filled in, and they submit it.

**`gh`, when the user asks you to file it.** Only if `gh auth status` succeeds,
and only after the user has approved the text:

```sh
gh issue create -R syv-ai/holi --label vault-assistant --title '<title>' --body-file <draft.md>
```

The issue is then posted under the user's GitHub account, so it is theirs to
approve.
