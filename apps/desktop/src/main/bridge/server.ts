/**
 * The bridge: a tiny localhost HTTP server that whatever runs inside a vault
 * (the `holi` command, the agent's Claude Code hooks, git's pre-commit hook and
 * merge driver) POSTs to, to reach the running Holi.
 *
 * Every request carries the vault's standing token (query `?t=`), which names
 * the vault it speaks for and rejects any other local process: the port is
 * ephemeral, but this closes the "some other localhost thing toggles our sync
 * pause" gap. The token is checked on the headers, before any body is read.
 *
 * **Two kinds of path.** The `holi` command's `/cli` is built in: it reads
 * argv against the capabilities open at the CLI door (`cli.ts`) and runs one
 * through `dispatch`, so every verb anyone can type is a capability and not a
 * route. A route is for a caller that is not an agent verb: the agent's turn
 * and status-line hooks, which answer empty, or with what the hook reads and
 * never prints, because a printed body would be injected into Claude's
 * context (the agent plugin's `claude/routes.ts`), and git's
 * pre-commit hook and merge driver (`vault/git-routes.ts`). Each owner
 * registers its own routes from the composition root.
 *
 * NOTE: no runtime `electron` import: this loads under vitest.
 */
import { createServer, type RequestListener, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'
import { realpath } from 'node:fs/promises'
import type { Dispatch } from '../capabilities/dispatch'
import type { CliCommand } from '../capabilities/registry'
import { CapabilityError } from '../capabilities/error'
import { refusalText, resolveArgv } from './cli'
import { SPILL_BYTES, spillNotice, spillOutput } from './spill'
import { projectJsonFields } from './json-fields'

/** What a route answers. No body is an empty one. */
interface Reply {
  status: number
  body?: string
  /** `text/plain` when absent. */
  contentType?: string
}

export interface Route {
  /** `discard` drains the body unread (a turn signal sends nothing worth
   *  reading); `text` hands it over as UTF-8. */
  body: 'discard' | 'text'
  /** For the vault the token names. `query` is the URL's, token included.
   *  `signal` aborts when the caller hangs up before the answer: a route that
   *  holds its answer (the agent's question hook waits for a person) lets go
   *  of what it was holding. */
  handle(
    remote: string,
    query: URLSearchParams,
    body: string,
    signal: AbortSignal,
  ): Reply | Promise<Reply>
}

export interface BridgeServerDeps {
  /** The CLI door. Absent leaves `/cli` a 404. */
  cli?: {
    dispatch: Dispatch
    /** The capabilities open at the CLI door, read per call. */
    commands(remote?: string): readonly CliCommand[]
    /** The vault's clone, where an answer too long to print is spilled
     *  (`spill.ts`). Null prints it whole. */
    rootFor(remote: string): Promise<string | null>
    /** Optional machine-only CLI composition. Never used by vault routes. */
    machine?: {
      token(): string
      resolveTarget(
        selector: string | null,
        cwd: string | null,
      ): Promise<{ remote: string; root: string; live: boolean } | null>
      listVaults?(): Promise<readonly { remote: string; name: string; live: boolean }[]>
    }
  }
  log?: (msg: string) => void
}

export interface BridgeServer {
  /** Bind 127.0.0.1 on an ephemeral port. */
  start(): Promise<void>
  stop(): Promise<void>
  /** The bound port, or null before `start()`. */
  port(): number | null
  /**
   * This vault's standing token, minted once and stable for the app's life.
   *
   * Git's hooks in the clone read it while Holi runs, and so do the agent's
   * sessions, so it has to keep working across agent sessions and vault
   * switches. Never revoked.
   */
  tokenForVault(remote: string): string
  /** Serve one exact path. Throws if it is taken. Returns the undo. */
  route(path: string, route: Route, remote?: string): () => void
}

/** Cap the request body: a guard against a runaway sender holding the socket
 *  open. A turn signal sends nothing and a status JSON is a few kilobytes, but
 *  the record merge driver sends three versions of a record of up to 256 KiB
 *  (the apps plugin's `MAX_RECORD_BYTES`), URL-encoded (which can triple
 *  JSON), so the cap sits above that rather than failing a merge git could
 *  have made cleanly. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

const CLI_PATH = '/cli'

const TEXT = 'text/plain; charset=utf-8'
const CLOSED_READS = new Set(['docs.list', 'docs.read', 'docs.inspect', 'docs.render'])

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Candidate selector values are resolved only to obtain that target's CLI grammar.
 * resolveArgv then decides whether each candidate is really a selector or an option value. */
function requestedVaultCandidates(argv: readonly string[]): string[] {
  const candidates: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]!
    if (word.startsWith('--vault=')) candidates.push(word.slice('--vault='.length))
    else if (word === '--vault' && argv[i + 1] !== undefined) candidates.push(argv[++i]!)
  }
  return candidates
}

function commandSucceeded(commands: readonly CliCommand[], name: string, value: unknown): boolean {
  const predicate = commands.find((command) => command.name === name)?.succeeded
  return predicate?.(value) ?? true
}

export function createBridgeServer(deps: BridgeServerDeps = {}): BridgeServer {
  const log = deps.log ?? ((msg: string) => console.log(`[bridge] ${msg}`))
  /** token → the vault it speaks for. */
  const tokens = new Map<string, string>()
  /** remote → its standing token. */
  const vaultTokens = new Map<string, string>()
  type RouteLease = { route: Route }
  const routes = new Map<string, RouteLease>()
  const scopedRoutes = new Map<string, Map<string, RouteLease>>()
  let server: Server | null = null
  let boundPort: number | null = null

  /**
   * `holi <namespace> <verb> ...`: argv arrives as repeated `argv` fields, in
   * order, and a background session's job id as `job`. The output is the
   * answer itself, so it answers text: 200 with it (or, past `SPILL_BYTES`,
   * with where it was written, as JSON when the answer was asked for as JSON),
   * 422 with a refusal and its next step, 400 with usage (200 when usage was
   * what was asked for), or 428, having run
   * nothing, when the command reads a param from stdin that was not given.
   */
  const MACHINE_LIST: CliCommand = {
    name: 'vault.list',
    cli: { args: [], summary: 'managed vaults' },
  }

  async function runCli(remote: string, body: string, machine = false): Promise<Reply> {
    const cli = deps.cli!
    const form = new URLSearchParams(body)
    const argv = form.getAll('argv')
    const globalCommands = machine ? cli.commands() : cli.commands(remote)
    const terminator = argv.indexOf('--')
    const helpArgv =
      terminator < 0
        ? argv.filter((word) => word !== '--help' && word !== '-h')
        : [
            ...argv.slice(0, terminator).filter((word) => word !== '--help' && word !== '-h'),
            ...argv.slice(terminator),
          ]
    const help =
      argv.length === 0 ||
      argv
        .slice(0, terminator < 0 ? undefined : terminator)
        .some((word) => word === '--help' || word === '-h')
    const namedGlobally =
      globalCommands.some((command) => command.name.startsWith(`${argv[0]}.`)) ||
      globalCommands.some(
        (command) =>
          command.cli.standalone === true &&
          command.name.slice(0, command.name.indexOf('.')) === argv[0],
      )
    const targetedHelp = machine && help && argv.length > 0 && !namedGlobally
    if (machine && help && !targetedHelp) {
      const request = resolveArgv(argv, globalCommands, form.get('stdin'), form.get('job'))
      if (request.kind === 'help') return { status: 200, body: request.text }
    }
    const listing = argv[0] === 'vault' && argv[1] === 'list'
    if (machine && !listing && argv[0]?.startsWith('-')) {
      const request = resolveArgv(
        help ? helpArgv : argv,
        globalCommands,
        form.get('stdin'),
        form.get('job'),
      )
      if (request.kind === 'usage') return { status: 400, body: request.text }
    }
    let targetRemote = remote
    let machineTarget: { remote: string; root: string; live: boolean } | null = null
    let targetRequest: ReturnType<typeof resolveArgv> | undefined
    let requestCwd: string | null = null
    if (machine && !listing && (!help || targetedHelp)) {
      if (!cli.machine) return { status: 403 }
      requestCwd = form.get('cwd')
      if (
        requestCwd !== null &&
        (!requestCwd || (!requestCwd.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(requestCwd)))
      ) {
        return { status: 400, body: 'holi: cwd must be an absolute physical path' }
      }
      const candidates = requestedVaultCandidates(argv)
      let targetError: unknown
      for (const candidate of candidates) {
        try {
          const target = await cli.machine.resolveTarget(candidate, requestCwd)
          if (!target) continue
          const targetCommands = [...cli.commands(target.remote), MACHINE_LIST]
          const request = resolveArgv(argv, targetCommands, form.get('stdin'), form.get('job'))
          const selectorRequest =
            request.kind === 'help'
              ? resolveArgv(helpArgv, targetCommands, form.get('stdin'), form.get('job'))
              : request
          if (
            (request.kind === 'run' || request.kind === 'stdin' || request.kind === 'help') &&
            (selectorRequest.kind === 'run' || selectorRequest.kind === 'stdin') &&
            selectorRequest.vault?.toLowerCase() === candidate.toLowerCase()
          ) {
            machineTarget = target
            targetRequest = request
            break
          }
        } catch (error) {
          targetError = error
        }
      }
      if (!machineTarget) {
        try {
          machineTarget = await cli.machine.resolveTarget(null, requestCwd)
        } catch (error) {
          targetError = error
        }
      }
      if (!machineTarget) {
        if (targetError !== undefined)
          return {
            status: candidates.length === 0 ? 400 : 422,
            body: `holi: ${message(targetError)}`,
          }
        return {
          status: candidates.length === 0 ? 400 : 422,
          body:
            candidates.length === 0
              ? 'holi: target required; run inside a managed vault or pass --vault owner/repo'
              : 'holi: unknown vault target; check --vault owner/repo',
        }
      }
      targetRemote = machineTarget.remote
      if (targetedHelp) {
        const selectorRequest = resolveArgv(
          helpArgv,
          [...cli.commands(targetRemote), MACHINE_LIST],
          form.get('stdin'),
          form.get('job'),
        )
        if (
          (selectorRequest.kind === 'run' || selectorRequest.kind === 'stdin') &&
          selectorRequest.vault !== null &&
          selectorRequest.vault.toLowerCase() !== machineTarget.remote.toLowerCase()
        ) {
          return { status: 422, body: 'holi: unknown vault target; check --vault owner/repo' }
        }
      }
    }
    const request =
      targetRequest ??
      resolveArgv(
        argv,
        machine
          ? [
              ...(listing || (help && !targetedHelp) ? globalCommands : cli.commands(targetRemote)),
              MACHINE_LIST,
            ]
          : cli.commands(remote),
        form.get('stdin'),
        form.get('job'),
      )
    if (request.kind === 'usage') return { status: 400, body: request.text }
    if (request.kind === 'help') return { status: 200, body: request.text }
    const commandName =
      request.kind === 'run' ? request.name : form.getAll('argv').slice(0, 2).join('.')
    if (machine && request.kind === 'run' && request.name === MACHINE_LIST.name) {
      if (request.vault !== null)
        return { status: 422, body: 'holi vault list: --vault is not allowed' }
      try {
        const vaults = await cli.machine!.listVaults?.()
        if (!vaults) return { status: 403, body: 'holi: machine vault listing is unavailable' }
        const value =
          request.json && request.fields !== undefined
            ? projectJsonFields(vaults, request.fields)
            : vaults
        const json = request.json
          ? JSON.stringify(value, null, 2)
          : vaults
              .map((vault) => `${vault.remote}\t${vault.name}\t${vault.live ? 'open' : 'closed'}`)
              .join('\n')
        return { status: 200, body: json }
      } catch (error) {
        return { status: 422, body: `holi vault list: ${message(error)}` }
      }
    }
    const selector = request.vault
    if (machineTarget && !machineTarget.live && !CLOSED_READS.has(commandName)) {
      return {
        status: 422,
        body: `holi ${commandName}: vault is closed; open it in Holi before running this command`,
      }
    }
    if (
      machine &&
      !listing &&
      selector !== null &&
      selector.toLowerCase() !== machineTarget?.remote.toLowerCase()
    ) {
      return { status: 422, body: 'holi: unknown vault target; check --vault owner/repo' }
    }
    if (!machine && selector !== null && selector.toLowerCase() !== remote.toLowerCase()) {
      return { status: 422, body: 'holi: a vault-local credential cannot select another vault' }
    }
    if (request.kind === 'stdin') return { status: 428 }
    let output: string
    try {
      const result = await cli.dispatch({
        door: 'cli',
        remote: targetRemote,
        name: request.name,
        params: request.params,
        ...(machine && machineTarget
          ? {
              beforeInvoke: async (invocation) => {
                const invokedRoot =
                  invocation.root === machineTarget!.root
                    ? invocation.root
                    : await realpath(invocation.root).catch(() => null)
                if (
                  invocation.remote !== machineTarget!.remote ||
                  invokedRoot !== machineTarget!.root
                ) {
                  throw new CapabilityError(
                    'UNAVAILABLE',
                    'vault invocation does not match the resolved target',
                  )
                }
                const current = await cli.machine!.resolveTarget(machineTarget!.remote, null)
                if (
                  !current ||
                  current.remote.toLowerCase() !== machineTarget!.remote.toLowerCase() ||
                  current.root !== machineTarget!.root
                ) {
                  throw new CapabilityError(
                    'UNAVAILABLE',
                    'vault target changed or is no longer available',
                  )
                }
                if (!current.live && !CLOSED_READS.has(commandName))
                  throw new CapabilityError(
                    'UNAVAILABLE',
                    'vault is closed; open it in Holi before running this command',
                  )
              },
            }
          : {}),
      })
      const succeeded = commandSucceeded(cli.commands(targetRemote), request.name, result.value)
      // A command that answered with its own failure: 422, the answer whole.
      if (!succeeded) return { status: 422, body: JSON.stringify(result.value, null, 2) }
      const value =
        request.json && request.fields !== undefined
          ? projectJsonFields(result.value, request.fields)
          : result.value
      output = request.json ? JSON.stringify(value, null, 2) : result.text
    } catch (error) {
      return { status: 422, body: refusalText(request, error) }
    }
    if (Buffer.byteLength(output) <= SPILL_BYTES) return { status: 200, body: output }
    let root: string | null = machine ? null : await cli.rootFor(remote)
    let absoluteNotice = false
    if (machine && machineTarget) {
      try {
        const current = await cli.machine!.resolveTarget(machineTarget.remote, null)
        const valid =
          current !== null &&
          current.remote.toLowerCase() === machineTarget.remote.toLowerCase() &&
          current.root === machineTarget.root
        if (valid) {
          root = machineTarget.root
          absoluteNotice =
            selector !== null ||
            (requestCwd !== null && resolvePath(requestCwd) !== resolvePath(machineTarget.root))
        }
      } catch {
        root = null
      }
    }
    // The command has already run, and may have written: a failed spill
    // prints the answer whole rather than turning a success into an error.
    const spilled =
      root === null
        ? null
        : await spillOutput(root, request.label, output).catch((error: unknown) => {
            log(`spill failed: ${message(error)}`)
            return null
          })
    return {
      status: 200,
      body:
        spilled === null
          ? output
          : spillNotice(
              request.label,
              absoluteNotice ? { ...spilled, path: resolvePath(root!, spilled.path) } : spilled,
              request.json,
            ),
    }
  }

  const routeIsCurrent = (path: string, remote: string, lease: RouteLease): boolean =>
    path === CLI_PATH
      ? deps.cli !== undefined
      : scopedRoutes.get(remote)?.get(path) === lease || routes.get(path) === lease

  /** The route for a path: a registered one, or the built-in CLI door. */
  const routeFor = (pathname: string, remote: string, machine = false): RouteLease | undefined => {
    const exact = scopedRoutes.get(remote)?.get(pathname) ?? routes.get(pathname)
    if (exact !== undefined) return exact
    if (deps.cli === undefined || pathname !== CLI_PATH) return undefined
    return {
      route: { body: 'text', handle: (remote, _query, body) => runCli(remote, body, machine) },
    }
  }

  const handle: RequestListener = (req, res) => {
    if (req.method !== 'POST') {
      req.resume()
      res.writeHead(405).end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    // **The token is checked on the headers, before a byte of body is read.**
    // Draining first would mean an unauthenticated local process could make us
    // buffer up to the cap on every request just by being wrong about the token.
    const queryToken = url.searchParams.get('t')
    const vaultRemote = tokens.get(queryToken ?? '')
    const headerToken = req.headers['x-holi-cli-token']
    const machineToken = deps.cli?.machine?.token()
    const hasMachineCredential = Object.hasOwn(req.headers, 'x-holi-cli-token')
    const machineAuth =
      req.method === 'POST' &&
      url.pathname === CLI_PATH &&
      machineToken !== undefined &&
      typeof headerToken === 'string' &&
      headerToken.length > 0 &&
      headerToken === machineToken &&
      queryToken === null
    if (hasMachineCredential && !machineAuth) {
      req.resume()
      res.writeHead(403).end()
      return
    }
    const remote = machineAuth ? null : vaultRemote
    if (remote === undefined) {
      req.resume()
      res.writeHead(403).end()
      return
    }
    const route = routeFor(url.pathname, remote ?? '', machineAuth)
    if (route === undefined) {
      req.resume()
      res.writeHead(404).end()
      return
    }

    // A response that closes before it was finished is a caller that went
    // away: its process ended, or its `curl` timed out.
    const hungUp = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) hungUp.abort()
    })

    let body = ''
    let received = 0
    req.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > MAX_BODY_BYTES) {
        req.destroy()
        return
      }
      if (route.route.body === 'text') body += chunk.toString('utf8')
    })

    req.on('end', () => {
      void Promise.resolve()
        .then(() => {
          if (!routeIsCurrent(url.pathname, remote ?? '', route)) return { status: 404 }
          return route.route.handle(
            remote ?? '',
            new URLSearchParams(url.search),
            body,
            hungUp.signal,
          )
        })
        .then((reply) => {
          if (hungUp.signal.aborted) return
          if (reply.body === undefined || reply.body === '') {
            res.writeHead(reply.status).end()
            return
          }
          res.writeHead(reply.status, { 'content-type': reply.contentType ?? TEXT }).end(reply.body)
        })
        .catch((error: unknown) => {
          // Only reached if a route throws outside its own handling: a bug in
          // Holi, not an answer to the caller.
          log(`${url.pathname} failed: ${String(error)}`)
          res.writeHead(500).end()
        })
    })
  }

  return {
    tokenForVault(remote) {
      let token = vaultTokens.get(remote)
      if (token === undefined) {
        token = randomBytes(16).toString('hex')
        vaultTokens.set(remote, token)
        tokens.set(token, remote)
      }
      return token
    },
    route(path, route, remote) {
      if (path === CLI_PATH) throw new Error(`bridge route ${path} is reserved`)
      if (remote === undefined) {
        if (routes.has(path) || [...scopedRoutes.values()].some((scoped) => scoped.has(path)))
          throw new Error(`bridge route ${path} is already taken`)
        const lease = { route }
        routes.set(path, lease)
        return () => {
          if (routes.get(path) === lease) routes.delete(path)
        }
      }
      if (routes.has(path)) throw new Error(`bridge route ${path} is already taken`)
      const scoped = scopedRoutes.get(remote) ?? new Map<string, RouteLease>()
      if (scoped.has(path)) throw new Error(`bridge route ${path} is already taken for ${remote}`)
      const lease = { route }
      scoped.set(path, lease)
      scopedRoutes.set(remote, scoped)
      return () => {
        if (scoped.get(path) === lease) scoped.delete(path)
        if (scoped.size === 0 && scopedRoutes.get(remote) === scoped) scopedRoutes.delete(remote)
      }
    },
    port: () => boundPort,
    start: () =>
      new Promise<void>((resolve, reject) => {
        const s = createServer(handle)
        s.once('error', reject)
        s.listen(0, '127.0.0.1', () => {
          const addr = s.address()
          boundPort = typeof addr === 'object' && addr ? addr.port : null
          server = s
          log(`listening on 127.0.0.1:${boundPort}`)
          resolve()
        })
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        const s = server
        server = null
        boundPort = null
        if (!s) return resolve()
        s.close(() => resolve())
      }),
  }
}
