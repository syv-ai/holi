/**
 * The wizard's steps (docs/features/holis.md, The wizard): two that explain
 * what a Holi is and how it gets work, then who it is, what it does, what it
 * may do without asking, an optional habit, and a review. Each is a body for
 * the block's step panel; the wizard owns the draft and the footer.
 */
import {
  ArrowRight,
  Clock,
  IdCard,
  MessageSquareReply,
  Send,
  ShieldCheck,
  Sparkles,
  StickyNote,
  Terminal,
} from 'lucide-react'
import { HOLI_COLOURS, HOLI_MASCOTS } from '@holi/shared'
import { PixelPersona } from '@/composites/pixel-persona/pixel-persona'
import { Badge } from '@/components/reui/badge'
import { Frame, FramePanel } from '@/components/reui/frame'
import { IconTile } from '@/components/reui/icon-tile'
import { Fact } from './step-parts'

export function WhatStep(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <div aria-hidden="true" className="flex items-end justify-center gap-3">
        {HOLI_MASCOTS.slice(0, 5).map((m, i) => (
          <PixelPersona
            key={m}
            name={m}
            color={HOLI_COLOURS[i % HOLI_COLOURS.length]!}
            crop="full"
            scale={i === 2 ? 2 : 1}
            still={i !== 2}
          />
        ))}
      </div>
      <Frame stacked spacing="sm">
        <Fact icon={IdCard} title="A name and a face" file="holi.yaml">
          What it is called and how it looks, which documents it takes, and what it may do without
          asking you.
        </Fact>
        <Fact icon={Sparkles} title="A soul" file="SOUL.md">
          Its standing instructions: who it is and what it always keeps in mind. Every run reads it
          first.
        </Fact>
        <Fact icon={StickyNote} title="A memory" file="MEMORY.md">
          What it learns, one dated fact a line. Its runs keep it; it reaches them as notes, never
          as instructions.
        </Fact>
      </Frame>
      <p className="text-xs text-muted-foreground">
        All three live in <code className="font-mono">.holi/holis/&lt;its name&gt;/</code> and sync
        with the vault, so everyone who shares the vault shares its Holis.
      </p>
    </div>
  )
}

// ── 2. How it gets work ───────────────────────────────────────────────────

function Way({
  icon: Glyph,
  title,
  example,
  children,
}: {
  icon: typeof Clock
  title: string
  example: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <FramePanel>
      <div className="flex h-full flex-col gap-3">
        <IconTile size="sm">
          <Glyph className="size-3.5" />
        </IconTile>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">{title}</span>
          <p className="text-xs text-pretty text-muted-foreground">{children}</p>
        </div>
        <Badge variant="outline" className="mt-auto">
          {example}
        </Badge>
      </div>
    </FramePanel>
  )
}

/** One stop on a run's path, for the small diagram under the two ways. */
function Stop({ icon: Glyph, label }: { icon: typeof Clock; label: string }): React.JSX.Element {
  return (
    <li className="flex min-w-0 flex-1 flex-col items-center gap-1.5 text-center">
      <IconTile size="xs" variant="elevated">
        <Glyph className="size-3.5" />
      </IconTile>
      <span className="text-xs text-muted-foreground">{label}</span>
    </li>
  )
}

export function WorkStep(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <Frame spacing="sm" className="grid grid-cols-2">
        <Way icon={Send} title="Sent" example="Agent ▾ → Send to Holi">
          You send it a document from the menu beside a document's Agent button. It is offered the
          documents it takes, like <code className="font-mono">kunder/**/*.md</code>.
        </Way>
        <Way icon={Clock} title="On a schedule" example="Every weekday at 08:00">
          Habits: automations on a clock that it carries out, like a morning digest. Each machine
          turns a habit on for itself.
        </Way>
      </Frame>
      <div className="flex flex-col gap-3">
        <span className="text-xs font-medium text-muted-foreground">Every run</span>
        <ol aria-label="Every run" className="flex items-start gap-1">
          <Stop icon={Sparkles} label="Its soul, memory and rules" />
          <ArrowRight className="size-3.5 text-muted-foreground mt-1.5 shrink-0" />
          <Stop icon={Terminal} label="Claude Code in the vault" />
          <ArrowRight className="size-3.5 text-muted-foreground mt-1.5 shrink-0" />
          <Stop icon={ShieldCheck} label="Asks you what its rules do not allow" />
          <ArrowRight className="size-3.5 text-muted-foreground mt-1.5 shrink-0" />
          <Stop icon={MessageSquareReply} label="Reports what came of it" />
        </ol>
      </div>
      <p className="text-xs text-pretty text-muted-foreground">
        A Holi that is new here, or whose soul or rules changed, runs only after this machine
        approved what it says.
      </p>
    </div>
  )
}
