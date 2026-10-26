/**
 * A document's agent runs: a background Claude Code session on Sonnet 5.5,
 * started through the agent plugin's `agent.launch` capability, with no
 * terminal and permission to touch only the files the run is about.
 *
 * Three kinds. **write**: the person pressed Space on an empty line and asked
 * for something; a marker line in the file says where. **rewrite**: a quick
 * command on a selection (simplify, fix grammar). **artifact**: a vault app
 * made from the document, beside it. The first two edit the document, so it
 * is locked while they run; an artifact leaves it alone.
 *
 * A run's state is read off the agent's session rows: working, waiting on
 * the person (a permission prompt it was not pre-allowed), or done once the
 * session goes idle after working or ends. Runs live in an atom keyed by
 * path, so a run outlives its tab being switched away.
 */
import { atom, useAtomValue, useSetAtom } from "jotai"
import { useCallback, useEffect } from "react"

import { parentOf } from "@/lib/tree-paths"
import { trpc } from "@/lib/trpc"
import { useAgentService } from "@/state/agent-service"
import { activeRemoteAtom } from "@/state/vaults"

import { AGENT_MARKER } from "./markdown"

export const AGENT_MODEL = "claude-sonnet-5-5"


export type AgentRunKind = "write" | "rewrite" | "artifact"

export type AgentRunStatus =
  | "starting"
  | "working"
  | "needs-you"
  | "done"
  | "stopped"
  | "failed"

export interface AgentRun {
  kind: AgentRunKind
  /** What the person asked, for the status line. */
  label: string
  sessionId: string | null
  status: AgentRunStatus
  /** Set once the session was seen working, so its idle means done. */
  seenWorking: boolean
  message?: string
}

const runsAtom = atom<Readonly<Record<string, AgentRun>>>({})

export function isRunLive(run: AgentRun | undefined): boolean {
  return (
    run !== undefined &&
    (run.status === "starting" ||
      run.status === "working" ||
      run.status === "needs-you")
  )
}

/** Whether a run is editing the document, so it is locked. */
export function locksDocument(run: AgentRun | undefined): boolean {
  return isRunLive(run) && run?.kind !== "artifact"
}

const SYSTEM = [
  "You are Holi's document agent, running in the background on one markdown document in this vault.",
  "Nobody is watching this session: do not ask questions, do the work and finish.",
  "Write GitHub-flavoured markdown. Link other notes as [[Note name]]. Keep the document's YAML frontmatter exactly as it is.",
  "Touch only the files named in the request.",
].join(" ")

/** `notes/Plan.md` → `notes/Plan Artifact.app`. */
export function artifactPathFor(path: string): string {
  const folder = parentOf(path)
  const name = path.slice(folder === "" ? 0 : folder.length + 1)
  const dot = name.lastIndexOf(".")
  const title = dot > 0 ? name.slice(0, dot) : name
  return `${folder === "" ? "" : `${folder}/`}${title} Artifact.app`
}

function promptFor(
  kind: AgentRunKind,
  path: string,
  request: string,
  passage?: string
): { prompt: string; allow: string[] } {
  const file = `./${path}`
  const own = [`Read(${file})`, `Edit(${file})`, `Write(${file})`]
  if (kind === "write") {
    return {
      prompt: [
        `In \`${path}\`, the line \`${AGENT_MARKER}\` marks where the person asked for this:`,
        "",
        request,
        "",
        "Do it: write at that spot, or change the document as the request says.",
        `Remove the \`${AGENT_MARKER}\` line when you are done, and change nothing else unless the request asks for it.`,
      ].join("\n"),
      allow: own,
    }
  }
  if (kind === "rewrite") {
    return {
      prompt: [
        `In \`${path}\`, ${request} this passage, and change nothing else in the document:`,
        "",
        passage ?? "",
      ].join("\n"),
      allow: own,
    }
  }
  const app = artifactPathFor(path)
  return {
    prompt: [
      `Read \`${path}\` and make an artifact of it: a Holi vault app beside it, the folder \`${app}\`.`,
      "Write `index.html` first: one self-contained page (inline CSS and JS, no network) that presents the document's content as a polished, readable, interactive page, using the theme tokens Holi injects into apps.",
      "Write `app.yaml` last, with a one-line `description`: it is what marks the app finished.",
      `Do not change \`${path}\`.`,
    ].join("\n"),
    allow: [`Read(${file})`, `Write(./${app}/**)`, `Edit(./${app}/**)`],
  }
}

async function capability<T>(
  remote: string,
  name: string,
  params: unknown
): Promise<T> {
  return (await trpc.cap.run.mutate({
    remote,
    name,
    paramsJson: JSON.stringify(params),
  })) as T
}

/** Take the marker line out of the file, for a run that ended without doing
 *  so itself. */
async function clearMarker(remote: string, path: string): Promise<void> {
  const text = await trpc.notes.read.query({ remote, path }).catch(() => null)
  if (text === null || !text.includes(AGENT_MARKER)) return
  const cleaned = text
    .split("\n")
    .filter((line) => line.trim() !== AGENT_MARKER)
    .join("\n")
  await trpc.notes.write.mutate({ remote, path, text: cleaned })
}

/**
 * The run on `path`, kept in step with its session, and the ways to start
 * and stop one. `start` expects the document already saved: for a write, with
 * the marker in place.
 */
export function useDocumentAgent(path: string) {
  const remote = useAtomValue(activeRemoteAtom)
  const runs = useAtomValue(runsAtom)
  const setRuns = useSetAtom(runsAtom)
  const service = useAgentService()
  const sessions = useAtomValue(service?.sessions ?? EMPTY_SESSIONS)
  const run = runs[path]

  const update = (patch: Partial<AgentRun>) =>
    setRuns((all) => {
      const current = all[path]
      return current === undefined
        ? all
        : { ...all, [path]: { ...current, ...patch } }
    })

  // Follow the session: working, waiting on the person, then done.
  useEffect(() => {
    if (!run || !isRunLive(run) || run.sessionId === null) return
    const row = sessions.find((session) => session.id === run.sessionId)
    if (row === undefined) {
      if (run.seenWorking) update({ status: "done" })
      return
    }
    if (row.state === "working") {
      if (run.status !== "working" || !run.seenWorking)
        update({ status: "working", seenWorking: true })
    } else if (row.state === "needs-you") {
      if (run.status !== "needs-you") update({ status: "needs-you" })
    } else if (run.seenWorking) {
      update({ status: "done" })
    }
    // `update` writes the same atom this reads; the run and rows are the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, sessions])

  // A write that ended without removing its marker leaves no trace of it.
  useEffect(() => {
    if (!run || isRunLive(run) || run.kind !== "write" || remote === null)
      return
    void clearMarker(remote, path)
  }, [run, remote, path])

  const start = async (
    kind: AgentRunKind,
    request: string,
    passage?: string
  ) => {
    if (remote === null) return
    const label =
      kind === "artifact"
        ? "Making an artifact"
        : kind === "rewrite"
          ? request.charAt(0).toUpperCase() + request.slice(1)
          : request
    setRuns((all) => ({
      ...all,
      [path]: { kind, label, sessionId: null, status: "starting", seenWorking: false },
    }))
    const { prompt, allow } = promptFor(kind, path, request, passage)
    const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "")
    try {
      const result = await capability<
        { ok: true; sessionId: string } | { ok: false; message: string }
      >(remote, "agent.launch", {
        name: kind === "artifact" ? `${name}: artifact` : `${name}: ${label}`,
        prompt,
        model: AGENT_MODEL,
        allow,
        system: SYSTEM,
      })
      if (result.ok) update({ sessionId: result.sessionId })
      else update({ status: "failed", message: result.message })
    } catch (err) {
      update({
        status: "failed",
        message: err instanceof Error ? err.message : "The agent did not start.",
      })
    }
  }

  const stop = async () => {
    if (!run || remote === null) return
    if (run.sessionId !== null) {
      await capability(remote, "agent.stop", { id: run.sessionId }).catch(
        () => undefined
      )
    }
    update({ status: "stopped" })
  }

  const dismiss = useCallback(
    () =>
      setRuns((all) => {
        const { [path]: _gone, ...rest } = all
        return rest
      }),
    [path, setRuns]
  )

  return { run, start, stop, dismiss, available: service !== null }
}

const EMPTY_SESSIONS = atom(
  [] as readonly { id: string; state: "needs-you" | "working" | "idle" }[]
)
