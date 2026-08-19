# Not built — designed, wanted, absent

The PRDs describe **the product that exists**. This file holds the other thing: work that is
wanted, mostly designed, and not built. The split exists because the two kinds of statement had
been living in the same sections, and a reader could not tell them apart — a PRD section that
reads as a specification is indistinguishable from one that reads as a plan, and both were being
believed.

> **Being built next: vault apps.** Slice 1 is **stateless apps** — app tabs, the sandboxed webview,
> `holi.docs` / `holi.tasks` / `holi.theme` / `holi.open`, and the agent's authoring skill. **`holi.data`
> is deliberately out of scope**, because where app state lives is undecided: the relay that was going
> to hold it is gone, and the honest answers (a synced `data.json` merged by git, versus a
> machine-local `node:sqlite` store in `userData` like the Google cache) differ per app rather than
> per platform — a retro board's state is shared by nature, a CSV explorer's is nobody else's
> business. That decision is worth making against real apps instead of hypotheticals, so slice 1
> proves the risky part (an agent writes an app into `.holi/apps/` and you open it) without needing
> it. Design in [`prd/vault-apps.md`](prd/vault-apps.md).

Below this line there is **no ordering, no sizing, and no dates**. It is a list of what is missing,
which is the only claim it can make honestly.

## What belongs here, and what does not

An entry answers **"what could we build next"**. If a thing is absent and the honest statement is
**"why it isn't here, and what would change that"**, it is a boundary with a trigger condition —
product shape — and **the PRD owns it alone**. Squashing the autosave journal, an OS network-status
listener, a template output target nobody has asked for, and rename-as-a-slash-command are all of
that kind: each is deliberately absent, each names the observation that would revive it, and each is
complete in its own PRD. Filing them here too would be a second copy of a claim, which is exactly
what the consolidate-then-purge rule exists to prevent.

So this file also does not hold **non-goals** ("Holi is not a full email client" describes the
product's shape as surely as any feature does), **rejected alternatives** (only useful beside the
design that beat them), or **admitted uncertainty about behaviour that ships** ("the debounce is 3
seconds, tuned rather than derived").

Each entry names where its design and its reasoning live, because the reasoning belongs with the
pillar that owns it and not with the backlog.

**When something here gets built, this file purges it.** The entry's reasoning — including any
sub-question it carried — folds into the owning PRD as a description of what now exists, and the
entry is deleted. This is the same cycle [`decisions.md`](decisions.md) runs, for the same reason the
[README](README.md) gives: "not built" is a *claim about how things are*, so two copies of it can
contradict each other. A plan, by contrast, records what was done on a date and cannot go stale.

---

## Agent

**The reconcile → drawer handoff.** [`prd/agent.md`](prd/agent.md) §The agent as merge resolver
specifies it: pause the vault, re-run the merge for real, open the drawer with a seeded prompt
naming the conflicted paths. `EditorPane.onConflict` raises a banner and stops there. **Both ends
exist** — `sync.pause` on the active vault, and the drawer's seeded `prompt` — and the wire between
them does not. This is the last remaining code gap from D60, the decision that produced the pillar.

**Vault apps.** Agent-authored in-vault apps as first-class tabs, with a scoped `holi.*` bridge.
Designed in full in [`prd/vault-apps.md`](prd/vault-apps.md); slice 1 and the deferred state model
are in the callout at the top of this file. The one v1 accommodation the design asks for is already
honoured: the pane/tab system does not assume a tab is a note.

**Self-improvement / curator loop.** Designed around headless background forks and dropped from v1:
unproven value, and in a shared vault one person's background agent auto-editing **shared** skills
and memory is a real hazard. **If revived, the shape is already decided:** auto-edits are scoped to
the **personal** layer only, and shared-layer changes become **proposals requiring approval**.

**Agent theme proposals.** The agent authors a vault's theme today
([`architecture.md`](architecture.md) §9); having it *propose* one for approval is not built.

## Notes & editor

**Split panes.** `Workspace` is `panes[] → tabs[]` and every operation acts on the active pane, but
only one pane is rendered (`Shell.tsx`). A split is therefore a second array element rather than a
rewrite, which was the whole point of paying for the shape early. **Open with it:** whether the
second pane gets its own tab strip, or the strip spans both.

**Viewing a binary Holi cannot render.** A PDF or `.docx` in a vault gets a typed placeholder
naming what it is. Opening one in place — page nav for a PDF, `mammoth`-rendered HTML for a
`.docx` — is not built. **The framing this inherited is dead:** an earlier design converted
incoming PDFs and `.docx` files to markdown on entry and archived the original to object storage,
and D62 killed it — the vault is text-first *by authorship*, so rich documents are what it
**emits** ([`prd/pdf-export.md`](prd/pdf-export.md)), not what it imports. What survives is the
viewer, and it is genuinely optional: given how rarely an original is opened, "reveal it in the
Finder and let the OS open it" may be the whole feature. The old viewer is the reason to be
careful — the previous app's EmbedPDF integration was ~1550 LOC with worker-engine and StrictMode
hangs on "Loading PDF…".

## Tasks

**A time-grouped secondary board view** — "Today / This week / Later". Post-v1, and it returns as
an *option*, never a mode to configure: a second view earns its place only by not multiplying the
config space that [`prd/tasks.md`](prd/tasks.md) §What the design deliberately excludes closes off.

**Assignees**, and with them per-person reminders on shared tasks. This is the answer if
vault-wide reminders prove noisy — **not** a private reminder channel, which would make a shared
task mean different things to different members.

## Google mail & calendar

**Create a task from an event**, seeded with the link in its body. `tasks.create` takes an optional
`description` for exactly this, so the plumbing exists and the affordance does not.

**A task that lights up for a recurring event series** — the reminders and agenda tie-in across
[`prd/tasks.md`](prd/tasks.md) and [`prd/daily-notes.md`](prd/daily-notes.md). Untouched by
D67–D70.

## PDF export

**Template distribution across vaults.** Templates are per-vault committed content, which is what
makes a team consistent *within* a vault and does nothing across five of them. A shared brand repo
cloned as a vault is the obvious answer and has not been designed.

**A template set beyond `plain`.** Letter, report, memo and proposal were the original ask; one
template ships. This is content work rather than engineering — but the field schema in
`template.json` has only ever been exercised by one consumer, so the second template is also the
first real test of it.

## Daily notes

**Templates / configurable seed content.** The seed is `type: daily-note` frontmatter plus a title
heading, in code. Deferred post-v1.
