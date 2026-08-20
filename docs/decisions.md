# Decision inbox

New load-bearing decisions land here first, as lightweight ADRs (context, decision, why, rejected alternatives). Once agreed with Nicolai, each entry is **consolidated natively into the owning living doc** — the relevant PRD, `architecture.md`, or `vision.md` — and purged from this file. The cycle then repeats.

The living docs are the truth; this file is only the staging area.

**Two entries, drafted 2026-08-20**, both raised by building vault apps slice 1 and neither settled. Consolidation is owed once agreed.

---

## D75 — Holi owns its own documentation; a managed file it wrote is refreshed, not frozen

**Context.** `ensureSeeded` is create-if-missing, and that is what makes it safe to run on every vault open (D70). It also means a managed file can never be improved. Slice 1 shipped a `vault-apps` skill; reading it back the same day found four gaps, three of which an agent gets *wrong* rather than merely misses. Fixing them reached only vaults that had never opened — `privat`'s copy had to be deleted by hand, and there is no way to do that for anyone else's machine. **The authoring skill is the main lever this feature has for being usable, and it is write-once per vault.**

**Decision.** Split `SEED_FILES` by **who owns the file after it is written**:

- **Holi-managed** — `.claude/skills/**`, `.claude/hooks/**`, and (D76) `.holi/git-hooks/**`. These are documentation and code Holi ships. They are **refreshed on open**.
- **Seeded once** — `AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, `.holi/theme.json`, `.holi/document-templates/**`. These become the user's the moment they exist. Unchanged behaviour.
- `.claude/settings.json` keeps its own third rule (merged, not replaced).

**A managed file is overwritten only when Holi can prove nobody edited it.** On write, record the content hash in `.holi/seed-state.local.json` (machine-local — it is a fact about this clone). On open, refresh a managed file iff its on-disk hash equals the recorded one. A hash that differs means a human or an agent changed it: leave it, and say so. `holi seed refresh [path]` (D-slice-2) does it on demand, `--force` overrides an edit after showing the diff.

**Why a hash rather than a version marker in the file.** A `<!-- holi-seed: v2 -->` comment is visible in a document people read, can be edited around, and answers "which version" rather than "was this touched". The hash answers exactly the question being asked and is invisible.

**Rejected: fetch the canonical copy from `syv-ai/holi`.** It is private, so the vault's agent would need a token to the product repo — a far larger grant than it appears. And it is the wrong source even if public: seeded content is bundled into the binary (`?raw` imports), so **the running app already has the canonical bytes on disk**. Fetching adds an offline dependency, a supply-chain surface, and version skew against the build actually running.

---

## D76 — vault hooks are a managed capability: Holi ships the code, the vault enables it

**Context.** Three vault-wide transforms want a commit boundary: rewrite `[[links]]` for a file moved outside Holi, archive done tasks, normalize markdown. Git's `pre-commit` is where that belongs, and it is not exotic — this repo runs exactly that shape today (`simple-git-hooks` + `lint-staged` → eslint, restaging what it fixes). Git rename detection (`git diff --cached -M`) also hands over the `from→to` map for free, which Holi's watcher **cannot** see: to the watcher a move is a delete plus an add.

**Decision, in four parts.**

1. **The script body ships in the binary.** Hooks are seeded into `.holi/git-hooks/` as D75-managed files and `core.hooksPath` is pointed there on vault open. The vault's committed config declares **which transforms are enabled** (`.holi/settings.json`) — data, never code. **A vault-tracked arbitrary script is refused.** `core.hooksPath` into the tracked tree means a teammate's push runs code on your laptop, every commit, with your filesystem — which is D74's escalation argument with a different filename, and D74 spent its whole trust section preventing exactly that for `.claude/hooks/`. A teammate enabling a transform runs *their own Holi's* copy of it.
2. **`.holi/git-hooks/` joins the agent surface** (`isAgentSurfacePath`). Slice-1 apps cannot write at all, but writes are coming; without this, an app that could write a pre-commit hook would walk straight around the rule that stopped it writing `google-send-gate.mjs`.
3. **Transforms are active, and they never block.** They rewrite and restage. A transform that *fails* logs, tells the agent, and **lets the commit through**: Holi's auto-commit is the user's save, and a lint opinion must not outrank it. Only a future integrity check would earn the right to stop a commit, and it would still need a UI surface rather than a silent refusal.
4. **Every run is legible.** A capped, machine-local `.holi/hooks.local.log` the agent can read, plus a push to the running agent over the hook server. The agent is the fast path; the sync status bar (`pause(reason)`, already built) is the floor for when no session is open. A transform that fails N times in a row disables itself for the session and says so.

**Scope: exactly three transforms** — `relink`, `archive-done`, `normalize-md`. Not a general hook framework. Designing the config surface before a second hook has asked for one is the argument that killed `manifest.json` in D74, and it applies here unchanged.

---

## Number allocation — **next free is D77**

Living docs carry decisions as **prose, never as numbers**. D-numbers exist for two purposes only: **code comments** and **git history**. So this ledger is the one place that records which numbers are spent. Check it before allocating.

**Spent and purged from this file, with where each one's prose now lives** — a number vanishing from the inbox means it was consolidated, not withdrawn:

| | Consolidated into |
|---|---|
| D60 — the vault is a GitHub repo; there is no server | `vision.md`, `architecture.md`, `glossary.md` and every PRD (2026-07-21). Held open afterwards only to track code that had not caught up; the last gap, the reconcile → agent-drawer handoff, is now recorded in [`prd/agent.md`](prd/agent.md) §The agent as merge resolver where it belongs |
| D61 | spent amending D60 pt 2 (auto-push) — see D60 |
| D62 — text-first by authorship; binaries are assets | `vision.md` §Key design choices, [`prd/notes-editor.md`](prd/notes-editor.md) §Images and other binaries, [`prd/pdf-export.md`](prd/pdf-export.md), and [`not-built.md`](not-built.md) (the surviving blob-storage question, and the import-conversion stub D62 superseded — that stub is deleted, and its reasoning is in this row plus git history) |
| D63 — a task lane move is a note-style rename | [`prd/tasks.md`](prd/tasks.md) §Board UX |
| D64 — a vault's theme is a whitelisted token map | [`architecture.md`](architecture.md) §9, §10 |
| D65 — local-ness is legible from the name | [`architecture.md`](architecture.md) §3 + config layering, [`glossary.md`](glossary.md), [`prd/agent.md`](prd/agent.md), [`prd/auth-identity.md`](prd/auth-identity.md) |
| D66 — document-templates lives under a name that says what it is for | [`prd/agent.md`](prd/agent.md) |
| D67 — one main-held Google connector; the agent reaches it via a CLI, not MCP | [`prd/google-mail-calendar.md`](prd/google-mail-calendar.md) §The engine, §Calendar, §How a message is rendered, §Rejected; [`prd/agent.md`](prd/agent.md) §Tool surface; [`prd/auth-identity.md`](prd/auth-identity.md); [`prd/tasks.md`](prd/tasks.md) |
| D68 — mail is read-write within a bounded set | [`prd/google-mail-calendar.md`](prd/google-mail-calendar.md) §Goals — as built, §The engine; [`prd/auth-identity.md`](prd/auth-identity.md) (the scope-widening trap) |
| D69 — a cached list is defined by every filter that narrows it | [`prd/google-mail-calendar.md`](prd/google-mail-calendar.md) §The engine, §How a message is rendered |
| D70 — the agent may do anything the user can undo | [`prd/agent.md`](prd/agent.md) §Tool surface, §Permissions; [`prd/google-mail-calendar.md`](prd/google-mail-calendar.md) |
| D71 — the mail composer: markdown is the source | [`prd/google-mail-calendar.md`](prd/google-mail-calendar.md) §Composing |
| D72 — a vault agent inherits the vault, not the machine | [`prd/agent.md`](prd/agent.md) §Config layering, §Runtime, §Auth, §Permissions |
| D73 — a mail thread and a calendar event are joined by the invite's UID | [`prd/google-mail-calendar.md`](prd/google-mail-calendar.md) §Goals — as built, §How a message is rendered |
| D74 — a vault app is a web app the user wrote, bounded by its own origin and barred from the agent surface | [`prd/vault-apps.md`](prd/vault-apps.md) §Trust & isolation, §Anatomy, §Runtime & surfaces, §The `holi.*` bridge, §State deferred, §Slice 1; [`glossary.md`](glossary.md) §Agent surface. Settles the isolation model (a per-app `holi-app://` origin, `allow-scripts` never with `allow-same-origin`), the reach (all vault content except `AGENTS.md`/`CLAUDE.md`/`MEMORY.md`/`USER.local.md`/`.claude/`, read *and* write, because a writable send-gate hook is an app escalating to the assistant), network allowed with its exfiltration cost stated, bridge + theme injected on serve, the tab union's singleton-by-subtraction bug, no manifest in slice 1, and personal apps split by location rather than by the `.local.` marker. **Deliberately does not decide where app state lives** — that is per-app rather than per-platform, so slice 1 ships no state API and the question waits for real apps |

**D1–D59 are spent, and D60 supersedes all of them.** They are not listed here any more, and that is deliberate: their subjects — the CRDT doc store, the file↔CRDT bridge, the task record and its file projection, the SSE event stream, server-side membership, snapshot history, the git mirror — do not exist. A ledger of decisions about a deleted system is archaeology pretending to be law, and the docs are law.

The reasoning is not lost. Every one of them was written up in full in this file and is recoverable from git history (`git log -p docs/decisions.md`); the ones whose *lessons* outlive their mechanism were carried into the rewritten docs as prose, unattributed to a number:

- **The task file is the whole task** — the projection's parser, serializer, and file grammar survive in `prd/tasks.md`, minus the record they reconciled against.
- **A store loaded by whoever renders it fails silently** (was D58) — `architecture.md` §9. The second consumer cannot tell an unloaded store from an empty one.
- **Machine tokens do not belong in a file a human edits** (was D33) — the same argument now keeps the reminder watermark out of the repo, because a write that fires on a timer becomes a commit.
- **Select by an explicit marker, never by filename shape** (was D46) — `prd/daily-notes.md`, and the reason `task.` is a filename prefix rather than a frontmatter key.
- **The client passes its local date; nothing else computes "today"** (was D44) — `prd/daily-notes.md`.
- **A rename must reject a colliding destination before moving anything** — `prd/notes-editor.md` FR-11.

**D59 was spent** on the offline main-as-sync-hub work (commits `f1584f6`…`9bc7eef`) without this ledger being updated. It is the clearest casualty of the pivot: four slices building a Yjs sync hub inside a machine that no longer has Yjs.

**D61 was spent** on making push automatic — amending D60 point 2's "explicit push" to a coalescing auto-push with a leave-point set, an optimistic non-fast-forward recovery, and an `offline — N waiting` / `no write access` failure taxonomy. Consolidated 2026-07-24 into `prd/vaults-sync.md` (§Summary, §Pushing, §State display, §Why these choices; the debounce and budget numbers it left open now sit in FR-4 and FR-13), `architecture.md` §Sync, and `glossary.md` (§Push replaces §Publish); the Publish button, `publish()`, `sync.publish`, and the `publishing`/`ahead` sync states are deleted from the code. Its reasoning is the §Why-these-choices "why push automatically" paragraph. **Fully realized in code 2026-07-25:** an audit found two survivors, now cleaned up — the agent seed (`agent/seed-content.ts` `AGENTS.md`) still told the agent commits "stay on this machine until the user presses **Publish**", now corrected to auto-push; and a dead duplicate `SyncState` union carrying the removed `ahead` kind lingered in `packages/shared/src/types.ts` (imported nowhere — the live union is in `main/vault/active-vault.ts`), now deleted.
