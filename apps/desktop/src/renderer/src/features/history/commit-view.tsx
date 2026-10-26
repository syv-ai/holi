import { useEffect, useState } from "react"
import { FileWarningIcon } from "lucide-react"

import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockCopyButton,
} from "@/components/reui/code-block/code-block"
import { Skeleton } from "@/components/ui/skeleton"
import { trpc } from "@/lib/trpc"

import { codeLanguage } from "./code-language"
import { lineDiff, type LineDiff } from "./line-diff"
import { ErrorState } from "@/composites/empty-state"

/** Past this, a version shows as plain text rather than tokenizing a
 *  generated file or a lockfile line by line. */
const HIGHLIGHT_LIMIT = 300_000

type Load =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; before: string; after: string }

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1)
}

/**
 * One commit of a file, from git (`history.fileDiff`): what it removed and
 * added among the lines it kept, as ReUI's code block draws a diff
 * (`lineDiff`), or the whole file as that commit left it.
 */
export function CommitView({
  path,
  sha,
  show,
}: {
  path: string
  sha: string
  show: "diff" | "file"
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    setLoad({ kind: "loading" })
    trpc.history.fileDiff
      .query({ path, sha })
      .then(({ before, after }) => live && setLoad({ kind: "ready", before, after }))
      .catch(
        (err: unknown) =>
          live &&
          setLoad({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          })
      )
    return () => {
      live = false
    }
  }, [path, sha, attempt])

  if (load.kind === "loading") {
    return (
      <div className="flex flex-col gap-2.5 py-2" role="status" aria-label="Loading the commit">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-2/5" />
      </div>
    )
  }
  if (load.kind === "error") {
    return (
      <ErrorState
        title="This commit could not be read"
        message={load.message}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    )
  }

  if (show === "file") {
    return (
      <CodeBlock
        code={load.after}
        language={codeLanguage(path)}
        highlight={load.after.length <= HIGHLIGHT_LIMIT}
        showLineNumbers
        label={`${nameOf(path)} at ${sha.slice(0, 7)}`}
      >
        <CodeBlockContent />
        <CodeBlockCopyButton />
      </CodeBlock>
    )
  }

  const diff: LineDiff = lineDiff(load.before, load.after)
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs tabular-nums">
        <span className="text-success-foreground">+{diff.added.length}</span>{" "}
        <span className="text-destructive">−{diff.removed.length}</span>{" "}
        lines in {nameOf(path)}
      </p>
      <CodeBlock
        code={diff.code}
        language={codeLanguage(path)}
        highlight={diff.code.length <= HIGHLIGHT_LIMIT}
        diff={{ added: diff.added, removed: diff.removed }}
        showLineNumbers
        label={`Changes to ${nameOf(path)}`}
      >
        <CodeBlockContent />
      </CodeBlock>
    </div>
  )
}
