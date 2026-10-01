/**
 * A vault's own hooks: its `.pre-commit-config.yaml`, run by the `pre-commit`
 * tool after Holi's transforms, as the last transform of every commit.
 *
 * **Code a teammate committed, so each person allows it.** Holi's transforms
 * ship in the binary; this config names commands, and a pull can change them.
 * The allowance is kept here in main, per vault, of a hash of the config and
 * of every vault file a `local` hook's `entry` names, so a changed config or
 * script lapses it and the person is asked again. Running `pre-commit install`
 * in a clone is the same per-person step; Holi asks in its settings instead.
 *
 * **Advisory, like every transform.** A hook that fails or rewrites files does
 * not stop the save: what it rewrote is restaged into the same commit, what it
 * complained about goes to the run log and the settings tab. Only the tool
 * breaking (not found mid-run, a timeout) throws, which the runner's breaker
 * counts.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  PRE_COMMIT_CONFIG,
  parsePreCommitConfig,
  vaultRelPath,
  type PreCommitHook,
  type PreCommitStatus,
} from '@holi/shared'
import { resolveBin, toolPath } from '../../bin'
import { jsonFileStore } from '../../json-file-store'
import type { Transform } from './runner'
import type { StagedChanges } from './staged'

const exec = promisify(execFile)

/** The transform's name in the run log. Not a settings key: whether it runs is
 *  the person's allowance, not a committed flag. */
export const PRE_COMMIT_TRANSFORM = 'pre-commit'

/**
 * The whole run, environments included, has to finish inside the commit
 * hook's `curl --max-time 10`, with Holi's own transforms before it. A run
 * that does not is killed and the save goes on without it.
 */
const RUN_TIMEOUT_MS = 7_000

/** Setting up a hook's environment (a Python venv, an npm install) takes
 *  minutes the first time, so it is done ahead, never inside a commit. */
const SETUP_TIMEOUT_MS = 10 * 60 * 1000

type Allowances = Record<string, { hash: string }>

export interface VaultPreCommit {
  status(remote: string, root: string): Promise<PreCommitStatus>
  /** Allow the config `hash` names. False, and nothing kept, when the config
   *  has changed since the person was shown it. */
  allow(remote: string, root: string, hash: string): Promise<boolean>
  disallow(remote: string): Promise<void>
  /** The last transform of every commit in the vault `remote`. */
  transform(remote: string): Transform
}

/** What the vault's config says, read now. */
async function readConfig(
  root: string,
): Promise<{ text: string; hooks: PreCommitHook[] } | { error: string } | null> {
  const text = await readFile(join(root, PRE_COMMIT_CONFIG), 'utf8').catch(() => null)
  if (text === null) return null
  const parsed = parsePreCommitConfig(text)
  return parsed.ok ? { text, hooks: parsed.hooks } : { error: parsed.error }
}

/**
 * What an allowance is of: the config, and each vault file a `local` hook runs
 * (the first word of its `entry`, when that is a file in the vault). A remote
 * repo's hooks are pinned by the config's `rev`, so the config covers them.
 */
async function configHash(root: string, text: string, hooks: PreCommitHook[]): Promise<string> {
  const hash = createHash('sha256').update(JSON.stringify(['config', text]))
  const scripts = new Set(
    hooks
      .filter((h) => h.repo === 'local' && h.entry !== undefined)
      .map((h) => h.entry!.trim().split(/\s+/)[0]!.replace(/^\.\//, '')),
  )
  for (const script of [...scripts].sort()) {
    let rel: string
    try {
      rel = vaultRelPath(script)
    } catch {
      continue
    }
    const bytes = await readFile(join(root, rel)).catch(() => null)
    if (bytes !== null) {
      const digest = createHash('sha256').update(bytes).digest('hex')
      hash.update(JSON.stringify(['script', rel, digest]))
    }
  }
  return hash.digest('hex')
}

/** One line per hook pre-commit reported, as it printed them; when it
 *  reported none (the tool refused the config), its first lines. */
function summarise(output: string): string {
  const lines = output.split('\n').map((line) => line.trimEnd())
  const hooks = lines.filter(
    (line) => /(Passed|Failed|Skipped)$/.test(line) || line.startsWith('- '),
  )
  return (hooks.length > 0 ? hooks : lines.filter(Boolean).slice(0, 3)).join('\n')
}

export function createVaultPreCommit(opts: {
  /** The allowances file in userData. */
  file: string
  env?: NodeJS.ProcessEnv
}): VaultPreCommit {
  const env = opts.env ?? process.env
  const store = jsonFileStore<Allowances>(opts.file, (raw) =>
    raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Allowances) : {},
  )
  const lastRuns = new Map<string, NonNullable<PreCommitStatus['lastRun']>>()
  /** Each vault's environment setup this session, by root. */
  const setups = new Map<string, Promise<void>>()
  const runEnv = { ...env, PATH: toolPath(env) }

  const tool = () => resolveBin('pre-commit', env)

  /** `pre-commit --version`, asked once per install path: the settings tab
   *  reads the status every time it shows. */
  const versions = new Map<string, Promise<string | null>>()
  const toolVersion = (): Promise<string | null> => {
    const bin = tool()
    if (bin === null) return Promise.resolve(null)
    let version = versions.get(bin)
    if (version === undefined) {
      version = exec(bin, ['--version'], { env: runEnv, timeout: 5_000 }).then(
        (r) => r.stdout.trim(),
        () => null,
      )
      versions.set(bin, version)
    }
    return version
  }

  /** `pre-commit install-hooks`, once per vault per session and again after an
   *  allowance, in the background. */
  const setUp = (root: string, again = false): Promise<void> => {
    const bin = tool()
    if (bin === null) return Promise.resolve()
    const running = setups.get(root)
    if (running !== undefined && !again) return running
    const setup = exec(bin, ['install-hooks'], {
      cwd: root,
      env: runEnv,
      timeout: SETUP_TIMEOUT_MS,
    }).then(
      () => undefined,
      (error: unknown) => {
        console.error('[pre-commit] install-hooks failed:', error)
      },
    )
    setups.set(root, setup)
    return setup
  }

  const allowance = async (remote: string, root: string) => {
    const config = await readConfig(root)
    if (config === null || 'error' in config) return { config, hash: null, allowed: false }
    const hash = await configHash(root, config.text, config.hooks)
    const kept = (await store.read())[remote]
    return {
      config,
      hash,
      allowed: kept?.hash === hash,
      changed: kept !== undefined && kept.hash !== hash,
    }
  }

  return {
    async status(remote, root) {
      const { config, hash, allowed, changed } = await allowance(remote, root)
      const version = await toolVersion()
      if (allowed && version !== null) void setUp(root)
      return {
        config: config === null ? 'absent' : 'error' in config ? 'invalid' : 'present',
        ...(config !== null && 'error' in config ? { error: config.error } : {}),
        hooks: config !== null && !('error' in config) ? config.hooks : [],
        tool: version,
        allowed: allowed ? 'yes' : changed === true ? 'changed' : 'no',
        hash,
        lastRun: lastRuns.get(root) ?? null,
      }
    },

    async allow(remote, root, hash) {
      const now = await allowance(remote, root)
      if (now.hash !== hash) return false
      await store.update((all) => ({ ...all, [remote]: { hash } }))
      void setUp(root, true)
      return true
    },

    async disallow(remote) {
      await store.update(({ [remote]: _gone, ...rest }) => rest)
    },

    transform: (remote) => ({
      name: PRE_COMMIT_TRANSFORM,
      async run(root: string, staged: StagedChanges) {
        const { config, allowed, changed } = await allowance(remote, root)
        if (config === null) return { changed: [], notes: [] }
        if (!allowed) {
          return {
            changed: [],
            notes:
              changed === true
                ? [
                    `${PRE_COMMIT_TRANSFORM}: ${PRE_COMMIT_CONFIG} changed since it was allowed; skipped`,
                  ]
                : [],
          }
        }
        const bin = tool()
        if (bin === null) {
          return { changed: [], notes: [`${PRE_COMMIT_TRANSFORM}: not installed here; skipped`] }
        }
        const paths = await existing(root, [
          ...staged.added,
          ...staged.modified,
          ...staged.renamed.map((r) => r.to),
        ])
        if (paths.length === 0) return { changed: [], notes: [] }

        // Wait for the environments only as long as a commit can; an unready
        // run is skipped, not started, since it would set them up itself.
        const ready = await Promise.race([
          setUp(root).then(() => true),
          new Promise<boolean>((r) => setTimeout(() => r(false), 2_000)),
        ])
        if (!ready) {
          return {
            changed: [],
            notes: [`${PRE_COMMIT_TRANSFORM}: still setting up its hooks; skipped this save`],
          }
        }

        // Rewrites are told apart from edits the save left unstaged: only a
        // path that was clean before the run and dirty after is restaged.
        const dirtyBefore = new Set(await unstaged(root, paths))
        let output: string
        let ok: boolean
        try {
          const run = await exec(bin, ['run', '--hook-stage', 'pre-commit', '--files', ...paths], {
            cwd: root,
            env: runEnv,
            timeout: RUN_TIMEOUT_MS,
            maxBuffer: 4 * 1024 * 1024,
          })
          output = run.stdout
          ok = true
        } catch (error) {
          const failed = error as { code?: unknown; killed?: boolean; stdout?: string }
          // Exit 1 is a hook failing or fixing something; anything else is
          // the tool itself.
          if (failed.code !== 1 || failed.killed === true) throw error
          output = failed.stdout ?? ''
          ok = false
        }
        const rewritten = (await unstaged(root, paths)).filter((p) => !dirtyBefore.has(p))
        const summary = summarise(output)
        // pre-commit calls a hook that only fixed files "Failed", for a person
        // to look and commit again. Here the fix is restaged into this commit,
        // so a run whose only complaint was its own fixes went well. A hook
        // that exited non-zero prints its exit code.
        const fine = ok || (rewritten.length > 0 && !/^- exit code:/m.test(output))
        lastRuns.set(root, { at: new Date().toISOString(), ok: fine, summary })
        const outcome = ok
          ? 'passed'
          : fine
            ? `fixed ${rewritten.join(', ')}`
            : 'reported problems (the save went on)'
        return {
          changed: rewritten.sort(),
          notes: [
            `${PRE_COMMIT_TRANSFORM}: ${outcome}`,
            ...(summary === '' ? [] : summary.split('\n').map((l) => `  ${l}`)),
          ],
        }
      },
    }),
  }
}

/** The paths that are still files: a staged rename's old side, or a file the
 *  save deleted after staging, is not something to hand a hook. */
async function existing(root: string, paths: string[]): Promise<string[]> {
  const kept: string[] = []
  for (const path of [...new Set(paths)]) {
    const info = await stat(join(root, path)).catch(() => null)
    if (info?.isFile() === true) kept.push(path)
  }
  return kept
}

/** Which of `paths` differ between the work tree and the index. */
async function unstaged(root: string, paths: string[]): Promise<string[]> {
  const { stdout } = await exec('git', ['diff', '--name-only', '-z', '--', ...paths], {
    cwd: root,
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout.split('\0').filter(Boolean)
}
