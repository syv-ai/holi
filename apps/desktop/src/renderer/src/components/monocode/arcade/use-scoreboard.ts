import { useAtomValue } from "jotai"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { trpc } from "@/lib/trpc"
import { sessionAtom } from "@/state/session"
import { activeRemoteAtom, snapshotAtom } from "@/state/vaults"

import type { ArcadeMode } from "./gridArcade"
import {
  isScoresPath,
  parsePlayerScores,
  recordRun,
  scoresPath,
  serializePlayerScores,
  type PlayerScores,
} from "./scoreboard"

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/**
 * The open vault's scoreboard (`scoreboard.ts`): every player's file, read
 * again when the snapshot says one changed (a colleague's record arriving
 * on a pull), and `record` for a finished run of this machine's player.
 * Without a vault or a signed-in player there is no board and nothing is
 * kept.
 */
export function useScoreboard(): {
  players: PlayerScores[]
  me: string | null
  /** A finished run. Resolves to the new best, or null when it was not one. */
  record: (mode: ArcadeMode, score: number) => Promise<number | null>
} {
  const remote = useAtomValue(activeRemoteAtom)
  const viewer = useAtomValue(sessionAtom)
  const files = useAtomValue(snapshotAtom).files
  const [players, setPlayers] = useState<PlayerScores[]>([])

  // The board's files and when each last changed: the key to read again by.
  const scoreFiles = useMemo(
    () => files.filter((file) => isScoresPath(file.path)),
    [files]
  )
  const key = scoreFiles.map((f) => `${f.path}@${f.updatedAt}`).join("|")

  useEffect(() => {
    if (remote === null) {
      setPlayers([])
      return
    }
    let live = true
    void Promise.all(
      scoreFiles.map((file) =>
        trpc.files.read
          .query({ remote, path: file.path })
          // The IPC carries the bytes; tRPC types them as a plain shape.
          .then((bytes) =>
            parsePlayerScores(decoder.decode(bytes as unknown as Uint8Array))
          )
          .catch(() => null)
      )
    ).then((read) => {
      if (live) setPlayers(read.filter((p): p is PlayerScores => p !== null))
    })
    return () => {
      live = false
    }
    // `key` stands for the files' paths and times.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote, key])

  const playersRef = useRef(players)
  playersRef.current = players

  const record = useCallback(
    async (mode: ArcadeMode, score: number): Promise<number | null> => {
      if (remote === null || !viewer) return null
      const mine =
        playersRef.current.find(
          (p) => p.login.toLowerCase() === viewer.login.toLowerCase()
        ) ?? null
      const next = recordRun(
        mine,
        viewer,
        mode,
        score,
        new Date().toISOString()
      )
      if (next === null) return null
      await trpc.files.write.mutate({
        remote,
        path: scoresPath(viewer.login),
        bytes: encoder.encode(serializePlayerScores(next)),
      })
      // Shown at once; the snapshot's read confirms it.
      setPlayers((all) => [
        ...all.filter((p) => p.login.toLowerCase() !== next.login.toLowerCase()),
        next,
      ])
      return score
    },
    [remote, viewer]
  )

  return { players, me: viewer?.login ?? null, record }
}
