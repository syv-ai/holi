# Plan — Google connector (slice 1 of the mail/calendar pillar)

> **Status: done (2026-08-04), and all four slices followed the same day.** The
> spec's §Build status is the current record. Two things below were changed by
> building them: mail is rendered as **extracted plain text, not sanitized HTML**,
> and `holi-google` is a **generated shell script** rather than a shipped binary.
> The gotcha list survived intact and each item earned its test.

**Design:** `docs/specs/2026-08-04-google-mail-calendar-design.md` · **ADR:** D67 · **Date:** 2026-08-04

The tracer bullet everything else needs: obtain a Google grant on the desktop with no server, hold it in the keychain, and refresh it from exactly one place. Ends with "connected as X" in the UI and a live authenticated Google API call.

## Scope

**In:** the loopback+PKCE flow, `GoogleTokenStore`, `GoogleSession` (single-flight refresh, revoke-on-disconnect), the `google` tRPC sub-router, and the Connect/Disconnect UI.

**Deviation from the design doc, deliberate:** the **loopback ops channel** (main ↔ `holi-google` CLI) moves to **slice 4**, where its only consumer is built. Building a localhost server with no caller is machinery bought before it is needed; the design's other decisions are unaffected (main is still the sole token authority — slice 4 adds the second front door to the same session).

**Out:** any Gmail/Calendar API surface (slices 2–3), the CLI + skill (slice 4).

## Files

| File | What |
|---|---|
| `src/main/google/pkce.ts` | **new** — pure: `createVerifier()`, `challengeFor(verifier)` (S256), `randomState()` |
| `src/main/google/loopback-flow.ts` | **new** — the flow state machine; all deps injected |
| `src/main/google/loopback-server.ts` | **new** — the real `node:http` listener behind the `Listen` seam |
| `src/main/google/token-store.ts` | **new** — sibling of `github/token-store.ts`; keyed by `sub` |
| `src/main/google/session.ts` | **new** — `GoogleSession`: connect / getAccessToken / disconnect |
| `src/main/google/electron.ts` | **new** — production wiring (the only google file importing electron) |
| `src/main/router.ts` | **edit** — a `google` sub-router + `googleSession` on `RouterDeps` |
| `src/main/index.ts` | **edit** — instantiate and pass it |
| `src/renderer/src/features/google/GoogleConnection.tsx` | **new** — Connect/Disconnect UI |
| `src/renderer/src/features/vault/VaultSettings.tsx` | **edit** — mount it (see "Settings home" below) |

**Tests** (node project, `apps/desktop/test/` — never co-located): `google-pkce.test.ts`, `google-loopback-flow.test.ts`, `google-token-store.test.ts`, `google-session.test.ts`.

## Contracts

```ts
// loopback-flow.ts
interface GoogleTokens {
  accessToken: string; refreshToken: string; expiresAt: number
  scopes: string[]; sub: string; email: string
}
type LoopbackFlowResult =
  | { kind: 'granted'; tokens: GoogleTokens }
  | { kind: 'denied' }     // user pressed Cancel at Google
  | { kind: 'cancelled' }  // we stopped (window closed / superseded)
  | { kind: 'timeout' }    // the deadline passed with no redirect
interface LoopbackFlow { readonly authUrl: string; wait(): Promise<LoopbackFlowResult>; cancel(): void }

// the injectable listener — what makes this testable with no real browser/socket
interface LoopbackServer {
  readonly port: number
  waitForRedirect(): Promise<Record<string, string>>  // the redirect's query params
  close(): void
}
type Listen = () => Promise<LoopbackServer>
```

`startLoopbackFlow(deps)` resolves once the server is bound and the browser is opened (so the caller can paint "waiting for your browser…"); `wait()` resolves once. **A flow *outcome* never rejects; a protocol fault still throws** — the `device-flow.ts` rule, kept.

```ts
// token-store.ts — encrypted map, keyed by Google `sub`
interface StoredGoogleAuth {
  sub: string; email: string
  refreshToken: string; accessToken: string; expiresAt: number; scopes: string[]
}
type GoogleAccounts = Record<string, StoredGoogleAuth>

// session.ts
class GoogleSession {
  static load(deps): Promise<GoogleSession>
  get account(): { email: string } | null       // renderer-safe: no tokens, ever
  connect(): Promise<LoopbackFlow>
  getAccessToken(): Promise<string>             // single-flight; refreshes transparently
  disconnect(): Promise<void>                   // revoke at Google, then clear
  onChange(cb: (account: { email: string } | null) => void): () => void
}
```

## Gotchas (each one earns a test or a comment)

1. **`prompt=consent` + `access_type=offline`** — without both, a *re-connect* returns no refresh token and the session silently cannot renew. Test: the auth URL carries them.
2. **Random free port** — bind `:0` and read the assigned port; a fixed port collides. The `redirect_uri` sent to Google and the one exchanged must be byte-identical.
3. **`state` must be verified** on the redirect; a mismatch is a protocol fault (throw), not an outcome.
4. **PKCE `S256`**, never `plain`.
5. **Serve a real "you can close this tab" response and then close** — otherwise the browser hangs on a pending request.
6. **Single-flight refresh** — concurrent callers share one in-flight promise. This is *the* reason main is sole authority (rotating refresh tokens race). Test: two concurrent `getAccessToken()` calls, one token-endpoint hit.
7. **Rotation** — a refresh response *may* carry a new `refresh_token`; persist it when present, keep the old one when absent.
8. **`invalid_grant` on refresh = the grant is gone** → clear the entry and surface "reconnect", mirroring GitHub's `onUnauthorized` → `#forget()`.
9. **Skew margin** — refresh when `now() >= expiresAt - 60s`, not at exact expiry.
10. **`id_token` payload is decoded, not verified** — safe *only* because it came straight from Google's token endpoint over TLS (Google documents this). Comment it so nobody "fixes" it into a JWKS fetch, and nobody copies it to a context where it *is* unsafe.
11. **Never write plaintext / a file it cannot read is a disconnect** — the two `token-store.ts` invariants, carried verbatim into the Google store with its own `VERSION`.

## Settings home

The design says Connect/Disconnect belongs in **global/app settings** (account-scoped), not per-vault. There is no global-settings surface today (`VaultSettings.tsx` is per-vault). Rather than build one here, the connection UI mounts in `VaultSettings` under a clearly-labelled **"Google (account-wide)"** section that states it applies to every vault. Establishing a real global-settings panel is its own change; this keeps the slice honest without pretending the section is vault-scoped.

## Client id

`GOOGLE_CLIENT_ID` ships as a constant beside GitHub's, resolved as `deps.clientId ?? process.env.HOLI_GOOGLE_CLIENT_ID ?? GOOGLE_CLIENT_ID` (mirrors `GitHubSession.#clientId()`). **The real value from the existing registration must be filled in before a live connect works** — the code is complete and tested without it; only the live round-trip is blocked. Desktop clients also get a `client_secret` which is *not* confidential (PKCE is the protection) — same reasoning `github/session.ts` documents for the public client id; it is optional in the exchange and read from `HOLI_GOOGLE_CLIENT_SECRET` when the registration requires it.

## Verification

- `pnpm exec node node_modules/typescript/bin/tsc --noEmit`
- `pnpm exec vitest run --project node` (~130s — background it), `--project dom`, and `packages/shared`
- **Live check (hand to the user — cannot be verified here):** fill the client id, `pnpm dev`, open settings → Connect Google → browser consent → "connected as you@…". Per `holi-ui-verification-ceiling`, never claimed verified from tests alone.
