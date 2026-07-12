# Vault git mirror + remote-edit ingress — design

**Date:** 2026-07-13 · **Status:** approved by Nicolai (brainstorming session) · **Decision:** D32 (amends D3, addends D7)

## Why

Claude Code web/cloud sessions (claude.ai/code, desktop app cloud sessions) operate on GitHub repositories via the Claude GitHub App: pick a repo, the sandbox clones it, works on a branch, opens a PR. If every vault can be a GitHub repo, employees can spin up remote sessions against vault content from anywhere — without their machine, without the desktop app.

This returns git to the architecture **only** in the role D3 explicitly left open (an export mirror), plus one addition: the mirror is also the **ingress** for remote-session edits. Git as a *sync mechanism between Holi clients* stays dead — that is what caused the old app's divergence and conflict pain (see D1/D3).

## Decision reconciliation

| Decision | Effect |
|---|---|
| D1 (CRDT relay is truth) | **Untouched.** The relay remains the single durable source of truth. |
| D3 (git dropped) | **Amended, not reversed.** Git-as-sync stays dead. The deferred "export mirror" ships, extended to a bidirectional mirror/ingress with exactly one git writer: the relay. History is still Yjs snapshots; backup is still Postgres; client working copies still have no `.git`. |
| D7 (Google SSO) | **Addendum.** Sign-in stays Google Workspace SSO. A user may additionally link a GitHub account (OAuth); only vault owners enabling git need it. |
| D4 (tasks are records) | **Untouched.** Tasks do not appear in the repo. Remote sessions cannot see or edit tasks in v1 — accepted and documented. |
| D25/D26 (bridge protocol, merge safety net) | **Reused.** Ingest applies foreign commits with the exact spike-proven diff-against-frozen-base → positioned-Yjs-ops shape, guarded by D26 auto-snapshots and overlap flags. |
| D23 (full materialization), D28 (text by construction) | **Load-bearing.** They are what make "the whole vault fits in a repo" true. |

**Structural invariant:** exactly **one git writer per vault** — the relay. No client ever pushes. The old failure modes (N clients auto-pushing, whole-vault link-rewrite commits colliding) cannot recur by construction.

## Scope

- **In:** per-user GitHub account linking; per-vault owner-driven repo connection (user-provided GitHub repo URL); server-side mirror clone; debounced continuous export; webhook-driven auto-ingest of foreign commits on the default branch; sync status surface; disconnect flow.
- **Out (v1):** task visibility in repos; non-GitHub hosts; local `.git` in client working copies; ingesting from non-default branches; per-user commit attribution; any PR/branch/history UI inside Holi (GitHub is the UI for git things).

## Architecture

All new code lives in `apps/server` except thin settings UI in `apps/desktop`.

### Data model

- **`github_connections`** — `user_id`, GitHub user id + login, encrypted OAuth token, timestamps. One row per linked user.
- **`vault_git`** — `vault_id`, `repo_url` (github.com only), `default_branch`, encrypted deploy private key, webhook id + secret, `base_commit` (the last commit exported **or** ingested — the diff base for both directions), `status` (`ok | paused | attention`), `enabled_by` (user id), timestamps.

### Wiring flow (owner, one-time)

1. Owner (with a linked GitHub account) pastes a repo URL in vault settings.
2. Server verifies the owner has admin access to that repo using **the owner's OAuth token**.
3. Server generates an SSH keypair, installs the public half as a **write deploy key** and registers a **push webhook** (with secret) via the GitHub API — again with the owner's token.
4. Server clones the repo into the vault's **mirror clone** and performs the initial export commit.

**Connecting a non-empty repo:** files that exist in the repo but not the vault are **ingested as new docs** (paths permitting — `VaultPath`, text-only); files that exist in **both** are **vault-wins** — the initial export commit overwrites them, and the repo's prior version stays recoverable in git history. Boring and predictable; no content merging at connect time.

Day-to-day operations use **only the deploy key**. The owner's personal token is touched only at wiring and un-wiring time. Disconnecting removes the deploy key + webhook (best-effort) and deletes the mirror clone and `vault_git` row.

Remote sessions themselves are the employee's business: they install the Claude GitHub App on the repo (it's their repo) and use claude.ai/code / desktop cloud sessions normally. Holi's job ends at keeping the mirror fresh and ingesting what lands.

### Exporter (vault → repo)

- Subscribes to doc changes on git-enabled vaults; debounces ~30–60 s of quiet per vault.
- Materializes changed docs into the mirror clone, commits as the **Holi bot identity** (message lists changed paths), pushes to the default branch.
- **Exported:** all docs with folder tree preserved, `.claude/**`, `.holi/settings.json`.
- **Never exported:** tasks, `*.local.*` files, Yjs/internal state.
- **Non-fast-forward push** (a remote commit landed first): fetch, hand foreign commits to the ingester, regenerate the export on the new head, push. The per-vault lock makes this a sequential loop, not a race.

### Ingester (repo → vault)

- Webhook push event → HMAC signature check → ignore commit batches authored entirely by the bot (loop prevention).
- **Pre-ingest D26 snapshot** on affected docs, auto-labeled "before remote-session changes merged".
- Per changed file: `diff(base, new)` where **base = the file at `base_commit`** (immutable by nature — stronger than D25's frozen file base), applied as **positioned Yjs ops on the live doc**. Concurrent live edits merge per the spike-verified semantics; overlapping-range merges raise the D26 non-blocking "let Claude reconcile?" flag.
- After a successful ingest, `base_commit` advances to the ingested head.
- **Webhook-miss backstop:** every export cycle begins with a fetch (the non-fast-forward path already ingests anything a webhook missed), plus a low-frequency periodic fetch (~hourly) for vaults with no local edit activity. Webhooks are latency optimization, not correctness.

### Edge policy (deliberately boring)

- **New file** → new doc at that path. **Deleted file** → doc delete (pre-snapshot covers recovery).
- **Rename** (git similarity detection) → doc **path move preserving CRDT identity** (snapshots/history survive). No automatic link rewrite on ingest: if the remote session rewrote links, those edits are in the same diff; if it didn't, dangling links render as dangling — same as any external edit.
- **Binary / non-text files** → ignored on ingest; warning surfaced in vault settings (vault is text by construction, D28).
- **Force-push / rewritten history** → status `attention`, sync pauses; owner resolves in settings (re-baseline = fresh export commit). Never guess.
- **Path safety** → every ingested path passes the shared `VaultPath` validation; a hostile path in a commit cannot escape the vault root.

### Concurrency

One async lock per vault serializes exporter and ingester work. Mirror-clone state and `last_exported_commit` advance atomically together (the spike's "atomic base advancement" finding, applied server-side).

## UX

- **App settings:** "Connect GitHub" (standard OAuth redirect), per user.
- **Vault settings (owner-only):** "Connect repository" — URL field + explainer of exactly what will be installed (deploy key, webhook) and what gets exported; disconnect button; warnings list (ignored binaries, attention states).
- **Status:** last export / last ingest / attention state shown alongside the existing sync indicator.
- No PR, branch, or git-history UI in Holi.

## Testing

- **Unit:** exporter materialization; ingest diffing fixtures — create / edit / rename / delete / binary / hostile path; export-set filtering (`*.local.*`, tasks absent).
- **Integration:** local bare repo standing in for GitHub (no network): full export → foreign commit → webhook-shaped ingest → CRDT state assertions; non-fast-forward push loop; force-push → `attention`.
- **Concurrency:** the D25 spike harness re-aimed server-side — live editors typing while a foreign commit ingests → convergence + overlap flag.
- **Webhook handler:** recorded GitHub payloads, signature pass/fail.

## Open follow-ups (post-v1 candidates)

- Read-only task export (`.holi/tasks.json`) so remote sessions can at least see tasks.
- Ingest from named branches / PR-review surface inside Holi.
- Commit attribution mapping vault members to co-authors.
