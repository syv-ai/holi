# Decision inbox

New load-bearing decisions land here first, as lightweight ADRs (context, decision, why, rejected alternatives). Once agreed with Nicolai, each entry is **consolidated natively into the owning living doc** — the relevant PRD, `architecture.md`, or `vision.md` — and purged from this file. The cycle then repeats.

The living docs are the truth; this file is only the staging area.

## D60 — The vault is a GitHub repo. There is no server.

**Context.** The rebuild was founded on two premises: that shared vaults require real-time co-editing, and that co-editing requires CRDTs over a Syv-hosted relay. Everything followed from there — Postgres as truth, Google SSO, a memberships table, a task *record* with a file projection, a server-side git mirror, snapshot history, an SSE fan-out, and a file↔CRDT bridge on every client. The premise held for the collaboration story and quietly took the rest of the product hostage: 4.7k LOC of server, and the desktop's most intricate subsystem, exist to reconcile files with a truth that isn't files. `vision2.md` withdraws the premise — **concurrent editing is deferred**, and a vault becomes what it looks like from the outside: a GitHub repo you clone.

**Decision.** Ten choices, agreed with Nicolai 2026-07-21, that stand or fall together:

1. **`apps/server` is deleted outright** — relay, Postgres, Drizzle, Google SSO, memberships, tasks table, reminder evaluator, snapshots, git mirror. v1 is a pure local Electron app talking to GitHub. Nothing needs a server: device-flow OAuth carries no client secret, and every query is a file read.
2. **Sync is auto-pull, explicit push.** Pull on an interval + on focus; your work leaves only when you **Publish**. Old Holi's failure was auto-committing and *never pulling* — the pull half is the half that was missing, and it is the half that makes a shared vault shared.
3. **Edits become local commits on idle or ⌘S.** The working tree is therefore always clean, so an incoming pull can always merge with no stash dance, a crash loses nothing, and the commit journal *is* the undo history that replaces snapshots.
4. **Pull merges, never rebases.** With ~30 autosave commits unpushed, a rebase replays each one and can conflict repeatedly on the same hunk — a failure mode manufactured entirely by autosave granularity. Merge resolves the divergence once. Non-linear history is the price, and nobody reads a vault's graph the way they read a codebase's.
5. **A conflicting merge is aborted immediately.** `git merge --abort` restores a clean tree; a banner reports the desync; **Ask Claude to reconcile** pauses autosave, re-runs the merge for real, and hands it to the agent in the drawer. The property that matters: *ignore the banner and you keep working on an unbroken vault* — the conflict never lands in a file you are typing into without your consent.
6. **The file is the task**, named `task.<name>.md`, living in the vault folder it is about. Its **path is its identity**, its **folder is its lane**, and its filename prefix is what makes it a task. This deletes the record/projection axis whole: `ProjectionStore`, version tokens, per-field patching, `RelatedRef`, `[[task:<id>]]` chips.
7. **External writes reconcile in the editor**: clean buffer reloads silently, dirty buffer takes a plain text 3-way merge, unmergeable overlap falls into the same Reconcile path as a git conflict. Needed regardless of the agent, because auto-pull can land on an open file. **Correction (2026-07-21, found during the deletion):** this was written assuming `shared/agent-merge` survived intact. It does not — its "3-way merge" forks a shadow `Y.Doc` and lets Yjs reconcile, so the merger *is* the CRDT. Only the 2-way diff survives; a conflict-reporting diff3 is new work.
8. **Reminders are evaluated locally by a tray-resident app**, with catch-up on launch. The delivered-watermark is machine-local and never committed — a fire that produced a commit is the same failure the version token was kept out of frontmatter to avoid. A reminder on a shared task notifies everyone; tasks have no assignee.
9. **GitHub is identity and access.** Device-flow OAuth, token in the OS keychain. The repo list is the vault switcher, the collaborator list is the members panel, and Holi enforces no access control of its own — if you can push, you are a member.
10. **The MCP server is deleted.** `task_list` is a glob, `task_set` is a file edit, `note_rename` becomes a vault skill in `.claude/`. Zero ops is the honest end state of "build only what Claude Code doesn't already do".

**Also settled:** clones live under a **Holi-managed root**, never an existing checkout you also use — because autosave-commit inside a tree where you keep WIP branches is destructive, and a managed clone makes that impossible by construction. **v1 keeps** daily notes (now a path check and a template), a read-only collaborators panel, and a **version-history surface over `git log`** — autosave commits are what give it material. **Google Drive is deferred**; adding an integration during the release whose purpose is removing one is how the release stops shipping.

**Why now.** The dial-back is not primarily about cost or scope — it is that the concurrency foundation had become the product's center of gravity while the things vision2 calls the product (a markdown vault, a task board, an agent that lives in it) were the parts most encumbered by it. Roughly half the codebase deletes, and the surviving half is the half you would describe to a customer.

**Rejected.** *Keep a thin server for scheduled reminders and Drive tokens* — you keep a deploy, a database and an auth seam for two features, and the ops burden survives the engine's death. *Strip Yjs but keep the server authoritative* — "truth lives on a Syv server" is precisely the model vision2 replaces. *Strangle behind the existing tRPC-over-IPC seam* — identity moves from `docId`/`vaultId` to paths, so nearly every signature changes anyway; a parallel implementation would be a rewrite pretending to be a migration, with two models alive at once. Execution is therefore **delete-first**: one commit removes the server and the CRDT stack, then main's router is rebuilt file-backed behind the seam the renderer already calls.

**Consolidated 2026-07-21** into `vision.md`, `architecture.md`, `glossary.md`, `prd/vaults-sync.md` (new, replacing `vaults-collaboration.md`), `prd/auth-identity.md`, `prd/tasks.md`, `prd/notes-editor.md`, `prd/agent.md`, `prd/daily-notes.md`, `prd/vault-apps.md`, and the phase-2 stubs. **Deleted:** `prd/server-data.md`, `prd/vaults-collaboration.md`, both `specs/`, the offline sync-hub plan, and the bridge spike.

**Verification 2026-07-25 (docs vs code).** Points 1–10 are all consolidated as prose in the living docs (`architecture.md` carries each; `glossary.md` and the PRDs carry the rest). The one docs gap has been closed: *Google Drive is deferred* was unstated and `vision.md` still framed Drive as a v1 integration — `vision.md` now moves it to *Beyond v1* with D60's own reasoning. What remains is **code that does not yet match**, and it is why this entry stays:

- **Reconcile → agent drawer (pt 5) — unbuilt.** `EditorPane.onConflict` raises only a banner (`Shell.tsx` wires it to a string); the pause-autosave → re-run-the-merge → hand-to-the-drawer path does not exist. The `pause` primitive is there (`active-vault.ts`, `sync.pause`); the drawer handoff is not.
- **Local reminder evaluator (pt 8) — landed (2026-07-31).** A tray-resident runtime sweeps every vault on a 60s tick + launch catch-up, raises native notifications, and stamps a machine-local, gitignored delivery watermark (`.holi/settings.local.json`) that never commits. Pure `sweep` behind injected seams (`main/reminders/{sweep,delivered-log,runtime,notify}.ts`), `tray.ts`, keep-alive + first-run launch-at-login in `index.ts`; the stale server-mirror types are gone. Spec/plan: `specs/2026-07-28-reminder-runtime-design.md`, `plans/2026-07-28-reminder-runtime.md`. (Native banner *display* is unverifiable under `electron-vite dev` — an unsigned-binary bundle-id collision — so confirm banners + notification-click in a packaged build.)
- **Version history over `git log` (also-settled) — landed & consolidated (2026-07-31).** The design now lives as prose in [`prd/vaults-sync.md`](../prd/vaults-sync.md) §History (per-file drawer + whole-vault commit dialog, flat log, inline `@codemirror/merge` diffs, restore-as-new-commit). Build plan: `plans/2026-07-28-version-history.md`.

Residue to retire: the `[[task:<id>]]` chip grammar (`wiki-links.ts`, `wikiLinkChips.ts`) still exists, where pt 4 wanted `note_rename` shipped as a `.claude/` vault skill instead. The `mcp__holi__*` tool surface is **already gone**. The pt-7 diff3 that this entry flagged as *new work* has **landed** (`packages/shared/src/merge3.ts`, wired via `lib/editor-reload.ts`).

*This entry stays in the inbox until the code matches it — with pt 8 and version history landed (2026-07-31), the one remaining code-gap is the reconcile → agent-drawer path (pt 5) above.*

---

## D62 — The vault is text-first by authorship; binaries are assets it holds and emits.

**Context.** v1 shipped arbitrary-file support: any non-markdown file lives in the vault, shows in the tree with a typed icon, and opens a typed `FilePlaceholder` (`VaultSnapshot.files`, `fileKind()`). That was Nicolai's explicit ask ("obviously we need other file types"), but it landed in tension with `prd/_phase2-pdf-docx-preview.md`, which declares the vault *"text by construction"* and prescribes converting incoming PDFs/`.docx` to markdown on entry with the original archived to object storage. Two irreconcilable stances about what a binary in the vault *is* — a first-class document to render, or a source to convert-and-archive — with every downstream file surface (in-place viewers vs. an import pipeline) forking on the answer.

**Decision.** Agreed with Nicolai 2026-07-25.

1. **"Text by construction" is refined, not retired.** It is an *authoring* principle — markdown is the source of truth, and what the agent writes — not a claim that only text may exist in the vault. The working document is always markdown; the finished, sendable artifact (a client proposal) is rendered *from* it.
2. **Binary assets are allowed and persisted as ordinary committed files.** Images that markdown references, and PDFs, live in the vault as-is. There is no convert-on-entry and no forced archival of an incoming binary.
3. **Images are first-class and render.** Inline in the editor's live preview (`![](path)` and `[[path]]`), and a standalone image view replaces the typed placeholder for image kinds. This is near-term work.
4. **PDFs are outputs first.** The primary PDF path is markdown→PDF via **Typst**, delivered as a seeded **`.claude/skills/md-to-pdf` vault skill** (ported near-directly from `syv-ai/1brain`'s `.claude/skills/md-to-pdf`), agent-invokable — not an in-app feature, in keeping with D60's "ops become vault skills". Rendered or incoming PDFs may sit in the vault; **in-place PDF viewing is deferred** (open externally for now).
5. **This supersedes `_phase2-pdf-docx-preview.md`'s convert-on-entry + archive framing.** The direction is reversed — author markdown, emit PDF — and the `.docx`-import pipeline is dropped unless a concrete need reappears.
6. **Non-markdown files stay out of the link graph.** They remain out of `docs` so link-aware ops (rename, backrefs, move) are markdown-only, exactly as shipped; images and PDFs are assets referenced by path, not wiki-linkable notes.

**Also settled.** Assets are **committed straight to git for now**; **vault-size management via blob storage + reference files** (Git LFS, or a lightweight reference that renders a blob from object storage) is the deferred answer to "where binaries live at scale", revisited when vault bloat is a measured problem rather than an anticipated one. The near-term build this authorizes — inline images, a standalone image viewer, and the md→PDF Typst vault skill — gets its own spec and plan; recording this decision does not build it.

**Why.** The convert-on-entry model was written before Typst was the plan and before the daily reality was clear: Syv's rich documents are *produced* by the vault (an agent drafts markdown, then renders a branded PDF), not *imported* into it. Forcing an incoming PDF through a lossy pdf→markdown converter and hiding the original in object storage is machinery serving a direction the work does not flow in. Keeping binaries as plain committed files is the honest, zero-infrastructure default; the blob-storage escape hatch is real but is scope bought before measurement asks for it — the same discipline D60 applied to the deleted index.

**Rejected.** *Render every binary in place (retire text-by-construction).* Makes the agent blind — a PDF it cannot read is a document it cannot help with — and puts binary bloat in git with no authoring story. *Honor the PRD literally (convert incoming pdf/docx→markdown + archive).* Builds an import pipeline and an object-storage dependency for a flow that runs the other way, and archives away originals users may need intact. *Two co-equal representations of one document (binary + markdown companion, both truth).* Raises "which is truth" on every edit and sync; markdown-as-source with PDF-as-output keeps a single truth.

**Consolidates into** (once the near-term surfaces exist): `vision.md` (binaries as assets the vault emits), `prd/notes-editor.md` (inline images + image viewer), `prd/_phase2-typst-export.md` (pulled forward, vault-skill delivery), and `prd/_phase2-pdf-docx-preview.md` (rewritten or retired — the convert-on-entry framing is dead).

*This entry stays in the inbox until the code matches it.*

---

## D63 — A task lane move is a note-style rename.

**Context.** The board's drag semantics have two axes (`prd/tasks.md` §Board UX): vertical rewrites `status`, horizontal moves the card to another lane — and because a task's **path is its identity**, moving lanes moves the `task.<name>.md` file into the target folder, which must rewrite every inbound `[[wiki-link]]` in the same pass or it silently breaks them. The board shipped with only the vertical axis; a cross-lane cell refused the drop, citing "the link rewrite it does not have yet". But the rewrite pass already exists — `notes.rename` (`vault/rename.ts` → `renameNote`) does exactly one-file-move + inbound-`[[link]]`-rewrite, and the daily-note archive sweep already reuses it rather than forking a second path.

**Decision.** Agreed with Nicolai 2026-07-27.

1. **`tasks.move({ remote, path, folder, status? }) → Task` reuses `renameNote`.** A lane change *is* a rename, so it takes the same single link-rewriting pass notes own — no bespoke task-move path (the same discipline `daily-notes.md` §Archiving applied to the archive sweep).
2. **The diagonal (lane + column in one gesture) lands as one write burst.** When a `status` rides along, it is written to the file **in place first**, then the single `renameNote` carries the final content to the destination — one route call, one autosave commit, so a card is never half-dropped. `status: done` routes through the existing `rollForward`, never a bare `done` write, so a recurring task advances instead of persisting done, exactly as the card checkbox does.
3. **Identity slug is preserved, collisions refuse.** The destination keeps the dragged file's basename (not a re-slug of `title` — they are allowed to disagree, per §Open questions), and a destination that already exists throws `CONFLICT` (mirroring `notes.rename`) rather than silently suffixing, which would change an existing task's identity.
4. **The board decides the branch with a pure `dropIntent` reducer** (`status` / `move` / `move`+status / `noop`), so the diagonal subtlety is tested in isolation rather than inline in the drop handler.

**Why.** Path-as-identity already bought the link rewrite for notes; a task lane move is the same operation on a `task.*.md` file, so a second implementation would be duplicated machinery with its own divergence risk. Writing status-in-place-then-rename keeps the diagonal atomic without a transaction: the existing autosave debounce coalesces the burst into one commit, satisfying the PRD's "a drag is one commit" without new debounce code.

**Rejected.** *A dedicated task-move helper that writes the destination directly* — re-implements `renameNote`'s backref-scan-and-rewrite loop for no gain, and drifts from it. *Auto-suffix on collision (like `freeTaskPath` does for create)* — create suffixes because a repeated title is normal; a move must not silently rename an existing task's identity. *Move then a separate status write for the diagonal* — two route calls risk two commits and a visibly half-dropped card.

**Consolidates into** `prd/tasks.md` §Board UX (the horizontal/diagonal drag semantics are now built, not deferred).

*This entry stays in the inbox until consolidated into the PRD.*

---

## D64 — A vault's theme is a whitelisted token map, not CSS.

**Context.** The ask was per-vault customization of the app's look — "just colors and chrome, no change to layout" — authorable by the vault agent on the user's behalf. The old repo carried per-vault theme *CSS* guarded by a substring-blocklist validator, named in `architecture.md` §10 as the weak point. Two forks decided everything downstream: **what** the theme file is (constrained token map vs. raw scoped CSS + sanitizer) and **where** it lives (committed vault file vs. machine-local pref).

**Decision.** Agreed with Nicolai 2026-08-02. **Landed** same day (`b160542`…`90efb2c`); design-of-record in [`specs/2026-08-02-per-vault-theming-design.md`](../specs/2026-08-02-per-vault-theming-design.md).

1. **A whitelisted token map, not CSS.** `.holi/theme.json` carries `light`/`dark` blocks of whitelisted token → CSS *value*. "No layout change" is therefore **structural, not a promise**: the vocabulary has no token that can express spacing/size/position, and because values only ever become custom-property values consumed through `var()`, **no CSS is injected** — the §10 injection risk is gone by construction, not by a validator.
2. **Colours + paint-only chrome only.** The 19 semantic colour tokens (+ `-foreground` pairs, `border`/`input`/`ring`), `scrollbar-thumb(-hover)`, `selection`; and `radius`, `shadow-popover`, `shadow-dialog`. Nothing else.
3. **Committed base + personal override.** `.holi/theme.json` is committed (shared, agent-writable); `.holi/theme.local.json` (gitignored `*.local.*`) overrides **per key within each block**. Chosen over a localStorage pref, which the agent cannot write and which does not travel with the vault.
4. **Applied on the document root.** Overriding the raw semantic tokens on `document.documentElement` re-cascades every `--color-*` utility (they are `var()` pointers via `@theme inline`) with zero component change — the onboarding-ritual mechanism generalised — and reaches Radix portals, which an inner wrapper would miss.
5. **Agent authors it with native tools.** A seeded `.claude/skills/theme/SKILL.md` documents the schema + vocabulary; there is no `theme.write` route and no authoring UI (per "users are developers"). The one control is **Reset theme** in vault settings — the escape hatch back to standard, which a file makes awkward.
6. **Two stores of the vocabulary, guarded.** The whitelist (TS) and the token defaults (CSS) must agree; a drift-guard test asserts every whitelisted token has a `--slug` definition, turning silent no-op drift into a red build.

**Why.** "No layout change" is the load-bearing constraint, and a token map makes it unfalsifiable where a sanitizer only makes it likely; the same move deletes the injection surface the old validator was chasing. Committing the file (vs. a local pref) is what makes "the agent does it on the user's behalf" and "syncs to the team" both true, since the agent edits files and files sync.

**Rejected.** *Raw scoped CSS + a sanitizer* — reintroduces the injection surface and downgrades "no layout" to best-effort. *Token map + a raw escape hatch* — two mental models for the same injection risk. *Titlebar/window-chrome as a knob* — the native macOS titlebar isn't CSS-reachable, so theming it needs a custom hidden titlebar, i.e. a layout change the constraint forbids; excluded until the constraint is relaxed. *A `theme:changed` push channel* — deferred; the renderer re-pulls on snapshot ticks (reapply is O(vault-activity)), which is correct and cheap for a local app.

**Consolidates into** `architecture.md` §9 (the token tier now carries per-vault overrides) and §10 (the Theme-injection note, now resolved by construction). *Stays in the inbox until consolidated.*

---

## D65 — Local-ness is legible from the name; no gitignored file wears a synced-looking name.

**Context.** `isLocalOnlyPath` special-cased `USER.md` as machine-local despite an ordinary, synced-looking name — hidden magic: a file that appears to be in git but silently isn't. Separately, *all* `*.local.*` files were excluded from the vault snapshot **entirely** (not merely hidden), so the show-hidden toggle could never reveal them — but a personal theme or config file is the user's *content*, not plumbing they should be unable to see. Surfaced while testing per-vault theming (`.holi/theme.local.json` was invisible even under show-hidden).

**Decision.** Agreed with Nicolai 2026-08-03. **Landed** same day.

1. **The `.local.` marker is the whole rule.** `isLocalOnlyPath` is now *only* the `.local.` basename test — the `USER.md` special case is deleted, and the personal user model is **`USER.local.md`**. `LOCAL_ONLY_IGNORE_LINES` is `['*.local.*']`. A file's git-vs-local status is now inspectable from its name, never a special case.
2. **Local files are content the tree shows under show-hidden.** `scanVault` filters on a new **`isNonContentPath`** (dirs/tmp/junk only); local files reach the snapshot as `files` — **out of the note graph** (local markdown like `USER.local.md` never becomes a linkable note). The tree's hidden gate is `isHiddenPath(p) || isLocalOnlyPath(p)`, so a root-level `USER.local.md` is gated by the toggle too, not shown always.
3. **The leak guarantee is unchanged, keyed only on `*.local.*`.** Commit is still `git add -A` gated by `.gitignore` — the snapshot is display-only. A bare `USER.md` now *travels* (ordinary content); a `.local.` file never commits. The leak test asserts both halves.
4. **The watcher still ignores local writes** (`.holi/context.local.json` is rewritten every agent turn — watching it would storm the rescan loop), except `theme.local.json`'s live-reload carve-out; local files refresh in the tree on the 30s heal rather than instantly.

**Why.** A reader must be able to tell whether a file is shared or private *from its name* — the same honesty every other `.local.` file already has; a normal name that is secretly ignored is exactly the trap that publishes a private file the day the ignore line drifts. And show-hidden should reveal a user's own local files, because they are content, not plumbing.

**Rejected.** *Keep `USER.md` special-cased* — the magic this fixes. *Exclude local files from the tree entirely* — treats user config as plumbing; wrong for a theme or a personal model the user edits. *Make local markdown first-class notes* — pollutes the link graph (backrefs, `[[ ]]` autocomplete, rename) with config files.

**Consolidates into** `architecture.md` §3 (the tree shows local files under show-hidden) and the config-layering/security prose, `glossary.md` + `prd/agent.md` + `prd/auth-identity.md` (`USER.local.md`), and the `path-safety` docstrings. **Supersedes** `specs/2026-07-26-hidden-files-toggle-design.md`'s "local files stay out of the tree entirely." *Stays in the inbox until consolidated.*

---

## D66 — PDF export templates live under a name that says what they are for.

**Context.** The vault's branded-document templates — the Typst folders behind Convert-to-PDF, each `template.json` + `template.typ` + `assets/` — sat under `.holi/templates/`. In a notes app "templates" invites the wrong question ("templates for *notes*?"): the name named the mechanism, not the purpose. Flagged before growing the seeded set past `plain` to letter/report/memo/proposal, so one folder renames instead of a set migrating.

**Decision.** Agreed with Nicolai 2026-08-04. **Landed** same day.

1. **The convention is `.holi/document-templates/<slug>/`.** The single source is `TEMPLATES_REL` in `main/pdf/templates.ts`; `seed-content.ts` seeds `plain` there, the `md-to-pdf` skill and the Convert-to-PDF empty-state copy point there.
2. **Flat, not categorised.** PDF export is the only kind of template Holi has, so the top-level name carries the purpose rather than a generic `templates/pdf/` nesting — a category segment is added only if a second template kind ever appears (YAGNI).
3. **Hard cutover, no back-compat alias.** The old path is not read as a fallback. Templates are seeded into vaults at runtime (there is no committed `.holi/templates/` in the repo), and pre-release there are no real vaults to migrate; a legacy alias would be a second name for one truth.
4. **The internal seed-source dir stays `main/agent/templates/plain/`.** It is build content bundled via `?raw`, not the vault convention; renaming it would churn import paths for no reader benefit.

**Why.** A folder name in `.holi/` is read by users authoring templates and by the agent; it should answer "for what?" on sight. `document-templates` says these produce documents; `templates` alone said nothing.

**Rejected.** *`.holi/pdf-templates`* — ties the name to today's only output when the pillar's aim is branded *documents* (Typst source and other targets are on the PRD's horizon). *`.holi/export-templates`* — "export" is the app's word, not the user's mental model of a branded letter/report. *Keep `.holi/templates` + a back-compat read* — carries the ambiguous name forever and doubles the truth.

**Consolidates into** `prd/agent.md` (already updated) and the `_phase2-typst-export.md` template-set work that follows. Dated `specs/2026-07-26-*` and `plans/*` keep the old path as historical record. *Stays in the inbox until consolidated.*

---

## Number allocation — **next free is D67**

Living docs carry decisions as **prose, never as numbers**. D-numbers exist for two purposes only: **code comments** and **git history**. So this ledger is the one place that records which numbers are spent. Check it before allocating.

**D1–D59 are spent, and D60 supersedes all of them.** They are not listed here any more, and that is deliberate: their subjects — the CRDT doc store, the file↔CRDT bridge, the task record and its file projection, the SSE event stream, server-side membership, snapshot history, the git mirror — do not exist. A ledger of decisions about a deleted system is archaeology pretending to be law, and the docs are law.

The reasoning is not lost. Every one of them was written up in full in this file and is recoverable from git history (`git log -p docs/decisions.md`); the ones whose *lessons* outlive their mechanism were carried into the rewritten docs as prose, unattributed to a number:

- **The task file is the whole task** — the projection's parser, serializer, and file grammar survive in `prd/tasks.md`, minus the record they reconciled against.
- **A store loaded by whoever renders it fails silently** (was D58) — `architecture.md` §9. The second consumer cannot tell an unloaded store from an empty one.
- **Machine tokens do not belong in a file a human edits** (was D33) — the same argument now keeps the reminder watermark out of the repo, because a write that fires on a timer becomes a commit.
- **Select by an explicit marker, never by filename shape** (was D46) — `prd/daily-notes.md`, and the reason `task.` is a filename prefix rather than a frontmatter key.
- **The client passes its local date; nothing else computes "today"** (was D44) — `prd/daily-notes.md`.
- **A rename must reject a colliding destination before moving anything** — `prd/notes-editor.md` FR-11.

**D59 was spent** on the offline main-as-sync-hub work (commits `f1584f6`…`9bc7eef`) without this ledger being updated. It is the clearest casualty of the pivot: four slices building a Yjs sync hub inside a machine that no longer has Yjs.

**D61 was spent** on making push automatic — amending D60 point 2's "explicit push" to a coalescing auto-push with a leave-point set, an optimistic non-fast-forward recovery, and an `offline — N waiting` / `no write access` failure taxonomy. Consolidated 2026-07-24 into `prd/vaults-sync.md` (§Summary, §Pushing, §State display, §Why these choices, §Open questions), `architecture.md` §Sync, and `glossary.md` (§Push replaces §Publish); the Publish button, `publish()`, `sync.publish`, and the `publishing`/`ahead` sync states are deleted from the code. Its reasoning is the §Why-these-choices "why push automatically" paragraph. **Fully realized in code 2026-07-25:** an audit found two survivors, now cleaned up — the agent seed (`agent/seed-content.ts` `AGENTS.md`) still told the agent commits "stay on this machine until the user presses **Publish**", now corrected to auto-push; and a dead duplicate `SyncState` union carrying the removed `ahead` kind lingered in `packages/shared/src/types.ts` (imported nowhere — the live union is in `main/vault/active-vault.ts`), now deleted.
