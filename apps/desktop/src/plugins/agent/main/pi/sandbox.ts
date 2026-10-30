/**
 * The boundary a Pi job runs in on macOS: a Seatbelt profile for
 * `/usr/bin/sandbox-exec -p` (docs/features/agent-sessions.md, Pi).
 *
 * Stock Pi has no sandbox and no per-tool prompts: its tools run with its
 * process's permissions. So the process is the boundary. Everything is denied
 * unless named here:
 *
 * - **programs**: the Node that runs Pi and Pi's own script, named by path,
 *   and nothing else.
 * - **reads**: the system's libraries and tools, Pi's install and the Node
 *   that runs it, and the job's folders (Pi's own folder for the job among
 *   them, never the person's). A folder may carry `hidden` paths that stay
 *   unreadable inside it, a writable one included: in the vault, every path
 *   with a segment that starts with a dot (git, Holi's and the agents'
 *   folders, secret files), and every local one.
 * - **writes**: the job's folders and nothing else, and `/dev/null`.
 * - **network**: outbound to an address, for Pi's calls to its model, and
 *   the system's resolver. A job's tools have no way onto it but a shell,
 *   which a job is given only when it asks.
 *
 * Paths are as the kernel sees them: absolute and with every symlink
 * resolved (`/tmp` is `/private/tmp`); the caller resolves them.
 *
 * NOTE: pure, so its test reads the text it builds.
 */

/** What a profile allows. Every path absolute and real. */
export interface SandboxSpec {
  /** The programs it may run: the runtime and the script it runs. */
  exec: readonly string[]
  /** Folders whose files may be read, and paths in them that may not. */
  read: readonly { dir: string; hidden?: readonly RegExp[] }[]
  /** Single files that may be read. */
  readFiles: readonly string[]
  /** Folders that may be read and written. */
  write: readonly string[]
}

/** What any program needs to start on macOS. */
const SYSTEM_READ = [
  '/usr/lib',
  '/usr/share',
  '/usr/bin',
  '/bin',
  '/System',
  '/Library/Preferences',
  '/private/etc',
  '/private/var/db/timezone',
  '/private/var/db/dyld',
  // Homebrew's own libraries, which a Homebrew Node links at run time.
  '/opt/homebrew/Cellar',
  '/opt/homebrew/opt',
  '/usr/local/Cellar',
  '/usr/local/opt',
]

const DEVICES = ['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom']

/** A path as an SBPL string literal. */
const quote = (path: string): string => `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** A regex as an SBPL regex literal: JavaScript's `\\/` is a plain `/`. A
 *  `#"…"` literal has no escape for `"`, so a path with one is refused. */
const regex = (re: RegExp): string => {
  if (re.source.includes('"')) {
    throw new Error(
      'A folder the job reads has a double quote in its path, which its sandbox cannot name.',
    )
  }
  return `#"${re.source.replace(/\\\//g, '/')}"`
}

/** Escape a path for a regex: what a hidden pattern is anchored under. */
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The profile's text. The last rule that matches wins in Seatbelt, so the
 * hidden paths are denied after every folder is allowed, a writable one
 * included.
 * @public exported for its test
 */
export function sandboxProfile(spec: SandboxSpec): string {
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow sysctl-read)',
    // A name and a size, never contents: Node stats its way up every path.
    '(allow file-read-metadata)',
    `(allow file-read* (literal "/") ${[...SYSTEM_READ.map((p) => `(subpath ${quote(p)})`), ...DEVICES.map((p) => `(literal ${quote(p)})`)].join(' ')})`,
  ]
  if (spec.exec.length > 0) {
    lines.push(`(allow process-exec ${spec.exec.map((p) => `(literal ${quote(p)})`).join(' ')})`)
  }
  const reads = [
    ...spec.read.map(({ dir }) => `(subpath ${quote(dir)})`),
    ...spec.readFiles.map((file) => `(literal ${quote(file)})`),
  ]
  if (reads.length > 0) lines.push(`(allow file-read* ${reads.join(' ')})`)
  if (spec.write.length > 0) {
    lines.push(
      `(allow file-read* file-write* ${spec.write.map((p) => `(subpath ${quote(p)})`).join(' ')})`,
    )
  }
  const hidden = spec.read.flatMap(({ hidden = [] }) => hidden)
  if (hidden.length > 0) {
    lines.push(
      `(deny file-read* file-write* ${hidden.map((re) => `(regex ${regex(re)})`).join(' ')})`,
    )
  }
  lines.push(
    '(allow file-write-data (literal "/dev/null"))',
    '(allow system-socket)',
    '(allow network-outbound (remote ip))',
    '(allow network-outbound (literal "/private/var/run/mDNSResponder"))',
  )
  return `${lines.join('\n')}\n`
}

/** A word matched in any case: Seatbelt's regexes take no flags. */
const anyCase = (word: string): string =>
  [...word].map((c) => `[${c.toLowerCase()}${c.toUpperCase()}]`).join('')

/**
 * What in a vault stays unreadable to a job that reads it, at any depth and
 * in any segment, as the shared rules read a path: every segment that starts
 * with a dot (`isHiddenPath`: git, Holi's and the agents' folders), a
 * segment with the `.local` marker (`isLocalOnlyPath`, a personal app's
 * folder included), and a secret file's or folder's name in any case
 * (`isSecretPath`). The marker is matched in any case too: the disk is
 * case-blind.
 * @public exported for its test
 */
export function vaultHidden(root: string): RegExp[] {
  const segment = `^${escapeRegex(root)}/(.*/)?`
  return [
    new RegExp(`${segment}\\.[^/]*(/|$)`),
    new RegExp(`${segment}[^/]*\\.${anyCase('local')}(\\.[^/]*)?(/|$)`),
    new RegExp(`${segment}\\.(${anyCase('env')}|${anyCase('secrets')})(\\.[^/]*)?(/|$)`),
  ]
}
