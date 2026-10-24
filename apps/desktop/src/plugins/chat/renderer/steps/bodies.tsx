/**
 * What a tool step opens into, one body per kind of result: a command's
 * output and exit status, the lines a read returned, the paths a search
 * found (each opens as a tab), a fetch's answer, an MCP tool's JSON, and the
 * raw input and output of anything else. The renderer only draws: every
 * shape is the reducer's (`shared/tool-views.ts`).
 *
 * After MonoCode's tool rows and `ToolCall` detail (`features/sessions/ui/
 * AgentTranscript.tsx`, MIT, Copyright (c) 2026 Nick; see NOTICE.md).
 */
import { useState } from "react"

import { Badge } from "@/components/reui/badge"
import { cn } from "@/plugin-api"
import type { ToolView } from "../../shared/chat"
import { Markdown } from "../Markdown"
import { DiffBody } from "./DiffBody"
import { MonoBlock, MoreButton, PathLink, PEEK_LINES } from "./parts"

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-muted-foreground text-xs font-medium">
      {children}
    </span>
  )
}

function Section({
  label,
  children,
}: {
  label?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {label !== undefined ? <Label>{label}</Label> : null}
      {children}
    </div>
  )
}

function ShellBody({ view }: { view: Extract<ToolView, { type: "shell" }> }) {
  const status =
    view.interrupted === true
      ? { text: "Interrupted", variant: "warning-light" as const }
      : view.exitCode === undefined
        ? view.background === true
          ? { text: "In the background", variant: "info-light" as const }
          : null
        : view.exitCode === 0
          ? { text: "Exit 0", variant: "success-light" as const }
          : {
              text: `Exit ${view.exitCode}`,
              variant: "destructive-light" as const,
            }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Section label="Command">
        <MonoBlock text={`$ ${view.command}`} label="Command" max={6} />
      </Section>
      {view.stdout !== undefined ? (
        <Section label="Output">
          <MonoBlock text={view.stdout} label="Output" omitted={view.omitted} />
        </Section>
      ) : null}
      {view.stderr !== undefined ? (
        <Section label="Errors">
          <MonoBlock
            text={view.stderr}
            tone={view.exitCode === 0 ? undefined : "error"}
            label="Errors"
          />
        </Section>
      ) : null}
      {view.stdout === undefined &&
      view.stderr === undefined &&
      view.exitCode !== undefined ? (
        <p className="text-muted-foreground text-xs">No output.</p>
      ) : null}
      {status !== null ? (
        <span>
          <Badge variant={status.variant}>{status.text}</Badge>
        </span>
      ) : null}
    </div>
  )
}

function ReadBody({ view }: { view: Extract<ToolView, { type: "read" }> }) {
  const [all, setAll] = useState(false)
  const shown = all ? view.lines : view.lines.slice(0, PEEK_LINES)
  const end = view.startLine + view.lines.length - 1
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <PathLink path={view.path} />
        {view.lines.length > 0 ? (
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
            Lines {view.startLine}–{end}
            {view.totalLines !== undefined ? ` of ${view.totalLines}` : ""}
          </span>
        ) : null}
      </div>
      {view.lines.length > 0 ? (
        <div
          role="group"
          aria-label={`Lines read from ${view.path}`}
          className="bg-muted/30 grid min-w-0 grid-cols-[auto_1fr] overflow-hidden rounded-md py-1 font-mono text-xs leading-5"
        >
          {shown.map((line, i) => (
            <div key={i} className="col-span-2 grid grid-cols-subgrid">
              <span className="text-muted-foreground/70 px-2 text-end tabular-nums select-none">
                {view.startLine + i}
              </span>
              <span className="text-foreground/85 pe-3 break-all whitespace-pre-wrap">
                {line === "" ? " " : line}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">Nothing to show.</p>
      )}
      {view.lines.length > PEEK_LINES ? (
        <MoreButton
          open={all}
          total={view.lines.length}
          onToggle={() => setAll((v) => !v)}
        />
      ) : null}
    </div>
  )
}

function PathsBody({ view }: { view: Extract<ToolView, { type: "paths" }> }) {
  const [all, setAll] = useState(false)
  if (view.matches.length === 0) {
    return <p className="text-muted-foreground text-xs">No matches.</p>
  }
  const shown = all ? view.matches : view.matches.slice(0, PEEK_LINES)
  const total = view.total ?? view.matches.length + (view.omitted ?? 0)
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <ul className="-mx-2 flex min-w-0 flex-col" aria-label="Matches">
        {shown.map((m, i) => (
          <li key={`${m.path}:${m.line ?? i}`} className="min-w-0">
            <PathLink path={m.path} line={m.line}>
              {m.text !== undefined ? (
                <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">
                  {m.text}
                </span>
              ) : null}
            </PathLink>
          </li>
        ))}
      </ul>
      {view.matches.length > PEEK_LINES ? (
        <MoreButton
          open={all}
          total={view.matches.length}
          noun="matches"
          onToggle={() => setAll((v) => !v)}
        />
      ) : null}
      {total > view.matches.length ? (
        <p className="text-muted-foreground text-xs">
          {total - view.matches.length} more not shown.
        </p>
      ) : null}
    </div>
  )
}

function WebBody({ view }: { view: Extract<ToolView, { type: "web" }> }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {view.url !== undefined && /^https?:/i.test(view.url) ? (
          <a
            href={view.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground decoration-foreground/30 hover:decoration-foreground min-w-0 truncate font-mono text-xs underline underline-offset-4 transition-colors"
          >
            {view.url}
          </a>
        ) : null}
        {view.query !== undefined ? (
          <span className="text-foreground/85 min-w-0 truncate font-mono text-xs">
            “{view.query}”
          </span>
        ) : null}
        {view.status !== undefined ? (
          <Badge
            variant={
              view.status.startsWith("2") ? "success-light" : "warning-light"
            }
          >
            {view.status}
          </Badge>
        ) : null}
      </div>
      {view.summary !== undefined ? (
        <Markdown text={view.summary} className="text-muted-foreground" />
      ) : null}
      {view.links !== undefined ? (
        <ul className="flex min-w-0 flex-col gap-1" aria-label="Results">
          {view.links.map((l) => (
            <li key={l.url} className="min-w-0 truncate text-xs">
              <a
                href={l.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground decoration-foreground/30 hover:decoration-foreground underline underline-offset-4 transition-colors"
              >
                {l.title}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function McpBody({ view }: { view: Extract<ToolView, { type: "mcp" }> }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        <Badge variant="outline">{view.server}</Badge>
        <span className="text-foreground/85 font-mono">{view.tool}</span>
      </div>
      {view.input !== undefined ? (
        <Section label="Input">
          <MonoBlock text={view.input} label="Input" max={8} />
        </Section>
      ) : null}
      {view.result !== undefined ? (
        <Section label="Result">
          <MonoBlock text={view.result} label="Result" />
        </Section>
      ) : null}
    </div>
  )
}

function RawBody({ view }: { view: Extract<ToolView, { type: "raw" }> }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {view.input !== undefined ? (
        <Section label="Input">
          <MonoBlock text={view.input} label="Input" max={8} />
        </Section>
      ) : null}
      {view.output !== undefined ? (
        <Section label="Output">
          <MonoBlock text={view.output} label="Output" />
        </Section>
      ) : null}
    </div>
  )
}

/** Whether a view has anything to open into. */
export function hasBody(view: ToolView | undefined): view is ToolView {
  if (view === undefined) return false
  switch (view.type) {
    case "raw":
      return view.input !== undefined || view.output !== undefined
    case "agent":
      return true
    default:
      return true
  }
}

export function ToolBody({
  view,
  className,
}: {
  view: ToolView
  className?: string
}) {
  return (
    <div className={cn("min-w-0", className)}>
      {view.type === "shell" ? (
        <ShellBody view={view} />
      ) : view.type === "read" ? (
        <ReadBody view={view} />
      ) : view.type === "paths" ? (
        <PathsBody view={view} />
      ) : view.type === "diff" ? (
        <DiffBody files={view.files} />
      ) : view.type === "web" ? (
        <WebBody view={view} />
      ) : view.type === "mcp" ? (
        <McpBody view={view} />
      ) : view.type === "raw" ? (
        <RawBody view={view} />
      ) : null}
    </div>
  )
}
