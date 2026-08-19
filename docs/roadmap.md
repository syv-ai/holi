# Roadmap — what is designed and not built

The PRDs describe **the product that exists**. This file holds the other thing: work that is
wanted, mostly designed, and not built. The split exists because the two kinds of statement had
been living in the same sections, and a reader could not tell them apart — a PRD section that
reads as a specification is indistinguishable from one that reads as a plan, and both were being
believed.

**What is *not* here, deliberately:**

- **Non-goals stay in the PRDs.** "Holi is not a full email client" and "no permanent deletion of
  mail" are decisions about the product's *shape*, not gaps in it. They describe what exists as
  surely as any feature does, and moving them here would file a boundary as a shortfall.
- **Rejected alternatives stay in the PRDs.** They are the reason nobody should re-propose a thing,
  and they are only useful next to the design they were rejected in favour of.
- **Questions about behaviour that ships today stay in the PRDs**, as prose. "The idle debounce is
  2–3 seconds, tuned against real use" is a specification with an admitted uncertainty, not a gap.

So an entry here is a **feature or a wire that does not exist**. Each one names where its design and
its reasoning live, because the reasoning belongs with the pillar that owns it and not with the
backlog.

There is no ordering, no sizing, and no dates. It is a list of what is missing, which is the only
claim it can make honestly.

---

## Agent

**The reconcile → drawer handoff.** [`prd/agent.md`](prd/agent.md) §The agent as merge resolver
specifies it: pause the vault, re-run the merge for real, open the drawer with a seeded prompt
naming the conflicted paths. `EditorPane.onConflict` raises a banner and stops there. **Both ends
exist** — `sync.pause` on the active vault, and the drawer's seeded `prompt` — and the wire between
them does not. This is the last remaining code gap from D60, the decision that produced the pillar.

**A restart nudge for a pulled config change.** Which shared `.claude/` files Claude Code reads at
launch versus per-use is unknown, and the answer decides whether a config change arriving by pull
needs to tell the user to restart the session. Nothing nudges today. Answer the CC question first;
the affordance is small once it is known which files need it.

**Rename as an in-app slash command.** Rename reaches the agent as a vault skill
([`prd/notes-editor.md`](prd/notes-editor.md) FR-11). If the skill turns out to lose links often
enough in real use, moving rename into the app as a slash command buys the deterministic pass. Not
worth building on suspicion — the trigger is observed misses, not the possibility of them.

**Self-improvement / curator loop.** Designed around headless background forks and dropped from v1:
unproven value, and in a shared vault one person's background agent auto-editing **shared** skills
and memory is a real hazard. **If revived, the shape is already decided:** auto-edits are scoped to
the **personal** layer only, and shared-layer changes become **proposals requiring approval**.

**Agent theme proposals.** The agent authors a vault's theme today
([`architecture.md`](architecture.md) §9); having it *propose* one for approval is not built.

**Vault apps.** Agent-authored in-vault apps as first-class tabs, with a scoped `holi.*` bridge.
Designed in full in [`prd/vault-apps.md`](prd/vault-apps.md) — post-v1, and **its state model needs
redesign** before the design can be picked up: the differentiator was a per-app shared Yjs doc on
the relay, and there is no relay. The likely replacement is a synced `data.json` in the app
directory, with git as the merge mechanism. The one v1 accommodation it asks for is already
honoured: the pane/tab system does not assume a tab is a note.

## Notes & editor

**Split panes.** `Workspace` is `panes[] → tabs[]` and every operation acts on the active pane, but
only `panes[0]` is rendered (`Shell.tsx`). A split is therefore a second array element rather than a
rewrite, which was the whole point of paying for the shape early. **Open with it:** whether the
second pane gets its own tab strip, or the strip spans both.

**Multiplayer cursors, presence, and character-level co-editing.** Deferred with the collaboration
engine, and there is no design — the engine it would ride on does not exist. Listed so the deferral
is legible from here rather than only as a non-goal in
[`prd/notes-editor.md`](prd/notes-editor.md).

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

**Where large binaries live at scale.** Assets are committed straight to git today
([`prd/notes-editor.md`](prd/notes-editor.md) §Images and other binaries). Git LFS, or a reference
file that renders a blob from object storage, is the deferred answer — to be revisited when vault
bloat is a **measured** problem rather than an anticipated one. There is no object storage, so this
is a decision as much as a build.

## Tasks

**A time-grouped secondary board view** — "Today / This week / Later". Post-v1, and as an
*option*, never a mode to configure: one board layout is a stated property of the design
([`prd/tasks.md`](prd/tasks.md) §What the design deliberately excludes), and a second view earns
its place only by not multiplying the config space.

**Assignees**, and with them per-person reminders on shared tasks. A reminder on a shared task
notifies every member today, because a task has no assignee and so there is no one else it could
mean. If that proves noisy, **this** is the answer — not a private reminder channel.

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

**Output targets beyond PDF** — the `.typ` source, or a Google Docs export. Recorded because it was
asked once during design; **nobody has asked since**, and it should not be built until someone does.

## Daily notes

**Templates / configurable seed content.** The seed is `type: daily-note` frontmatter plus a title
heading, in code. Deferred post-v1.

**A "home" timezone preference for travellers.** "Today" is the device's local date, which is
correct for the common case and is already an *input* rather than something computed
([`prd/daily-notes.md`](prd/daily-notes.md) §Timezone & "today"), so an override would only change
who supplies it. Cheap, and unmotivated until someone is annoyed by it.

## Vaults & sync

**Squashing the autosave journal.** The vault's history is the straight `git log`, autosave commits
included, because the audience is developers and the fine-grained timeline *is* the history feature.
If the log becomes unreadable in practice, folding consecutive `Update …` commits — periodically or
on push — is the lever. **Leaning no**, and it is recorded so the next person reaches for the lever
rather than for a coarser debounce, which would trade readability for lost work.

**An OS network-status listener.** A failed push retries on the coalesce tick, on window focus, and
after a pull. There is no network-status subscription, so a machine coming back online waits for one
of those three. Add one only if that latency proves annoying.
