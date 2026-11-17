/** Internal, invocation-scoped Git provenance evidence. */
/** Parse the raw commit headers once for both provenance paths. */
export function rawCommitParents(raw: string): string[] {
  const separator = raw.indexOf('\n\n')
  if (separator < 0) throw new Error('Malformed commit object')
  return raw
    .slice(0, separator)
    .split('\n')
    .filter((line) => line.startsWith('parent '))
    .map((line) => line.slice('parent '.length))
}

/**
 * Parse a separately captured, bounded Trace2 stream. Incomplete stream
 * delivery is rejected by the caller; this parser never sees diagnostics.
 */
export function traceHasOnlyManagedBuiltins(
  trace: string,
  rootCommand: 'merge' | 'commit',
  code: number,
): boolean {
  const maxBytes = 256 * 1024
  if (Buffer.byteLength(trace) > maxBytes || !trace.endsWith('\n')) return false
  const events: Record<string, unknown>[] = []
  for (const line of trace.split('\n')) {
    if (line === '') continue
    if (!line.startsWith('{')) return false
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return false
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    const event = parsed as Record<string, unknown>
    if (typeof event.event !== 'string' || typeof event.sid !== 'string') return false
    events.push(event)
    if (events.length > 2048) return false
  }
  if (events.length === 0) return false

  const sessions = new Map<string, { started: boolean; command: string | null; exits: number[] }>()
  const childStarts = new Map<
    string,
    { command: string; sid: string; childId: number; index: number }
  >()
  const childExits = new Map<string, number>()
  let rootSid: string | null = null
  let rootExit: number | null = null
  for (const event of events) {
    const sid = event.sid as string
    const state = sessions.get(sid) ?? { started: false, command: null, exits: [] }
    sessions.set(sid, state)
    switch (event.event) {
      case 'start':
        if (state.started) return false
        state.started = true
        if (rootSid === null) rootSid = sid
        break
      case 'cmd_name':
        if (typeof event.name !== 'string' || state.command !== null) return false
        state.command = event.name
        break
      case 'child_start': {
        if (
          !Number.isInteger(event.child_id) ||
          event.use_shell !== false ||
          !Array.isArray(event.argv)
        )
          return false
        const argv = event.argv
        const command =
          argv.length === 3 && argv[0] === 'git' && argv[1] === 'stash' && argv[2] === 'create'
            ? 'stash'
            : argv[0] === 'git' &&
                argv[1] === 'maintenance' &&
                argv[2] === 'run' &&
                argv[3] === '--auto' &&
                argv[4] === '--no-quiet' &&
                (argv.length === 5 ||
                  (argv.length === 6 && ['--detach', '--no-detach'].includes(String(argv[5]))))
              ? 'maintenance'
              : null
        if (command === null || sid !== rootSid) return false
        const key = `${sid}:${event.child_id}`
        if (
          childStarts.has(key) ||
          [...childStarts.values()].some((child) => child.command === command)
        )
          return false
        childStarts.set(key, {
          command,
          sid,
          childId: event.child_id as number,
          index: events.indexOf(event),
        })
        break
      }
      case 'child_exit': {
        if (!Number.isInteger(event.child_id) || !Number.isInteger(event.code)) return false
        const key = `${sid}:${event.child_id}`
        if (!childStarts.has(key)) return false
        // Git versions can report maintenance's completion twice. Identical
        // repeated parent notifications do not make the child ambiguous.
        const previous = childExits.get(key)
        if (previous !== undefined && previous !== event.code) return false
        childExits.set(key, event.code as number)
        break
      }
      case 'exit':
        if (!Number.isInteger(event.code)) return false
        state.exits.push(event.code as number)
        if (sid === rootSid) rootExit = event.code as number
        break
    }
  }
  if (rootSid === null || rootExit !== code) return false
  const root = sessions.get(rootSid)
  if (!root?.started || root.command !== rootCommand || root.exits.length !== 1) return false
  if (root.exits[0] !== code || childExits.size !== childStarts.size) return false
  const rootExitIndex = events.findIndex((event) => event.event === 'exit' && event.sid === rootSid)
  if (
    [...childStarts.values()].some(
      (child) =>
        events.findIndex(
          (event) =>
            event.event === 'child_exit' &&
            event.sid === rootSid &&
            event.child_id === child.childId,
        ) >= rootExitIndex,
    )
  )
    return false

  // Child processes must have their own complete Trace2 session, and no nested
  // child execution is allowed under an otherwise-recognized builtin.
  for (const child of childStarts.values()) {
    const candidates = [...sessions.entries()].filter(
      ([sid, session]) => sid !== rootSid && session.command === child.command,
    )
    if (candidates.length !== 1) return false
    const [sid, session] = candidates[0]!
    if (sid !== `${rootSid}/${child.childId}` || !session.started || session.exits.length === 0)
      return false
    if (session.exits.some((exitCode) => exitCode !== session.exits[0])) return false
    const matchingStart = [...childStarts.entries()].find(
      ([, value]) => value.command === child.command,
    )
    if (matchingStart === undefined || childExits.get(matchingStart[0]) !== session.exits[0])
      return false
    const startIndex = events.findIndex((event) => event.event === 'start' && event.sid === sid)
    const exitIndex = events.findIndex((event) => event.event === 'exit' && event.sid === sid)
    const childExitIndex = events.findIndex(
      (event) =>
        event.event === 'child_exit' && event.sid === rootSid && event.child_id === child.childId,
    )
    if (startIndex <= child.index || exitIndex <= startIndex || childExitIndex <= exitIndex)
      return false
    if (events.some((event) => event.event === 'child_start' && event.sid === sid)) return false
  }
  const expectedSids = new Set([
    rootSid,
    ...[...childStarts.values()].map((child) => `${rootSid}/${child.childId}`),
  ])
  if (sessions.size !== expectedSids.size) return false
  for (const [sid, session] of sessions) {
    if (!expectedSids.has(sid)) return false
    if (sid !== rootSid && (!session.started || session.exits.length !== 1)) return false
  }
  return true
}
