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
  /** 32-byte hex key for at-rest encryption of GitHub tokens + deploy keys.
   * The dev default is PUBLIC — set HOLI_ENCRYPTION_KEY in any real deployment. */
  encryptionKeyHex:
    process.env.HOLI_ENCRYPTION_KEY ??
    '00000000000000000000000000000000000000000000000000000000000000ff',
  /** Base URL GitHub can reach for webhooks + the OAuth callback (prod: public HTTPS; dev needs a tunnel for real webhook delivery). */
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://127.0.0.1:4000',
  github: {
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
  },
  git: {
    /** Mirror clones live here, one subdir per vault id. Derived state — safe to delete. */
    mirrorDir: process.env.GIT_MIRROR_DIR ?? './data/git-mirrors',
    botName: 'Holi',
    botEmail: 'holi-relay@syv.ai',
    /** Export when a vault has been quiet this long… */
    quietMs: Number(process.env.GIT_QUIET_MS ?? 45_000),
    /** …or unconditionally when it's been dirty longer than this. */
    maxQuietMs: Number(process.env.GIT_MAX_QUIET_MS ?? 5 * 60_000),
    /** Scheduler poll interval. */
    tickMs: Number(process.env.GIT_TICK_MS ?? 15_000),
    /** Webhook-miss backstop: fetch at least this often. */
    fetchBackstopMs: Number(process.env.GIT_FETCH_BACKSTOP_MS ?? 60 * 60_000),
  },
}
