/** Server configuration — env vars with dev defaults. */
export const config = {
  relayPort: Number(process.env.RELAY_PORT ?? 4444),
  apiPort: Number(process.env.API_PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://holi:holi@localhost:5433/holi',
  /** IANA zone anchoring wall-clock reminder strings (documented stub — per-user tz later). */
  timezone: process.env.HOLI_TZ ?? 'Europe/Copenhagen',
  /** Interval snapshots on store: append when newest snapshot is older than this. */
  snapshotIntervalMs: Number(process.env.SNAPSHOT_INTERVAL_MS ?? 10 * 60_000),
  /** Sliding session lifetime (matches D7's ~30-day offline window). */
  sessionTtlMs: Number(process.env.SESSION_TTL_MS ?? 30 * 24 * 3_600_000),
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    /** OAuth redirect the desktop app listens on. */
    redirectUri: process.env.GOOGLE_REDIRECT_URI ?? 'http://127.0.0.1:42813/oauth/callback',
    /** Workspace hosted-domain restriction (D7). Unset ⇒ any Google account (dev only). */
    workspaceDomain: process.env.GOOGLE_WORKSPACE_DOMAIN,
  },
}
