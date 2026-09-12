# Motion system — design

**Date** 2026-09-12 · **Status** designed, not built
**Answers** [`../upcoming.md`](../upcoming.md) item 7, "Add animations to essentially everything",
whose own note said it was undesigned and needed scoping before any code.

## What this is, and what it replaces

The goal, in his words, is that **the app feels alive**. Not a consistency pass, not motion-as-
explanation: character. That rules out the framing this started with, which was "close the gap
between the surfaces that already move and the ones that do not".

There is no gap to close, because **there is no system to extend**. Outside the onboarding ritual,
nothing that moves today moves on purpose: `Button` carries `transition-all`, tree rows carry
`transition-colors`, the mailbox refresh carries `animate-spin`, the overlays carry Radix's
defaults, and the `@theme` motion tier in `index.css` was extracted from the ritual's inventory,
so it describes a one-time ceremony rather than the daily app. This is a **ground-up definition of
the motion dimension**, and the existing scattered `transition-*` are things to replace.

Two deliverables, and the second is the larger one:

1. **One central vocabulary.** Two curves, five durations and a stagger step. No component
   defines its own numbers, and the linter enforces it.
2. **An inventory**: every place in the app where motion helps, each assigned exactly one of four
   behaviours. 62 places, listed below.

## The four behaviours

Every animation in Holi names which of these it is. **Anything that cannot name one does not
animate.** That makes review a yes/no question rather than a taste argument, and it is the whole
of why the vocabulary is four things rather than seven.

|       | Name            | What it means                                                      | Rule that keeps it honest                                                                                                                                      |
| ----- | --------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R** | **Respond**     | It notices you. Under your pointer or caret, and nowhere else.     | Always a `transition`, never an `animation`, so it reverses the instant you leave. Reversible means it can never be in your way.                               |
| **A** | **Arrive**      | It has weight. Something enters or leaves the layout.              | Direction is mandatory: a thing comes from where it belongs. Leaving is faster than arriving, because a thing on its way out is in your way. **No overshoot.** |
| **K** | **Acknowledge** | It answers back. One beat, once, for a discrete act you committed. | Never blocks and never queues. A second event restarts it. A failure nudges the thing that failed rather than opening a dialog.                                |
| **F** | **In flight**   | It breathes. The only looping motion in the app.                   | Bound to a real in-flight state (agent working, syncing, loading). When the state ends the motion ends. Nothing loops decoratively, so nothing can nag.        |

**No overshoot is a decision, not an omission.** Weight comes from direction and easing, not from a
bounce. `--ease-spring` and the `pop` keyframe's 1.05 overshoot are therefore retired from the daily
app. They survive only inside `features/onboarding/onboarding-ritual.css`, which is where they are
already used and the only place they are: a one-time ceremony is allowed one spring.

## The vocabulary

```css
/* curves */
--ease-settle: cubic-bezier(0.22, 1, 0.36, 1); /* everything except loops */
--ease-loop: cubic-bezier(0.45, 0, 0.55, 1); /* symmetric, for F only */

/* durations */
--motion-respond: 150ms; /* R */
--motion-arrive: 300ms; /* A, in  */
--motion-leave: 190ms; /* A, out */
--motion-ack: 800ms; /* K */
--motion-inflight: 2400ms; /* F, one loop */
--motion-stagger: 45ms; /* per item, capped */
```

**300ms is chosen, not defaulted.** The three candidate paces (160 brisk, 220 middle, 300
deliberate) were compared side by side in the running browser before the number was fixed, and
every other duration in the set is scaled off it. Holi should read as calm and considered rather
than as quick.

**The stagger is capped.** A folder with two hundred children must not take nine seconds to open,
so a staggered list applies the delay to the first N items (N ≈ 8) and the remainder arrive with
the last one. The cap is a pure function on a count and is the one piece of this that is unit
testable in isolation.

### Replacing the old tokens

`--duration-micro / base / enter` are size-named, which tells a reader nothing about when to reach
for them, and that is how the current pile happened. They are replaced by the purpose-named set
above. This is cheap: they have exactly three consumers.

| Consumer                                                                       | Today | Becomes                  | Why                                                                                                                                                             |
| ------------------------------------------------------------------------------ | ----- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TabStrip` reorder FLIP (`--duration-micro`, read in JS at `TabStrip.tsx:107`) | 160ms | `--motion-respond` 150ms | The preview shift tracks where your pointer is and reverses when you move back. That is R.                                                                      |
| `TabStrip` overflow fade                                                       | 160ms | `--motion-respond` 150ms | R.                                                                                                                                                              |
| Heading `#` slide (`editor/theme.ts:176`, `--duration-base`)                   | 240ms | `--motion-respond` 150ms | **A reclassification.** D92 chose `--duration-base` before there was a vocabulary. The slide is gated on a caret move and reverses, so it is R, and R is 150ms. |

The `@theme` named animations (`rise`, `pop`, `wake`, `scale-in`, `scale-out`, `fade-in`,
`fade-out`) are rebuilt as the four behaviours. `pop` and `wake` have no consumer outside the
ritual and simply go.

## What stays still, on purpose

This list is as load-bearing as the vocabulary. It was reviewed and agreed as written.

- **Prose, headings, code and table text inside a document**, and the reveal-raw swap. That is
  [`../prd/notes-editor.md`](../prd/notes-editor.md)'s existing rule and it is unchanged.
- **Direct manipulation, while it is happening**: a resize handle, a dragged tab or card,
  scrolling. These track the pointer 1:1 and are never eased. **Motion applies to the release, not
  to the drag.**
- **Anything that would delay input.** A dialog accepts typing the instant it starts arriving, not
  when it lands. No animation is ever on the critical path of an action.
- **Diff and mail bodies.** Content you are reading.
- **Inside CodeMirror: paint only.** Colour, opacity, box-shadow, and transforms that do not
  change the layout box. Never width, height, font-size or margin, because that is what pegs CM's
  measure loop, which is the lesson the notes-editor PRD already paid for. The heading slide is
  the single exception and it earns it the way D92 records.

## Where the line falls: chrome, plus the objects in a document

Motion is not confined to the chrome. The rule is **"is it a thing you can click"**, not "is it in
the editor". Inside a note, the objects animate (wiki-link chips, task orbs, checkboxes, images,
the table widget, the frontmatter rows, the autocomplete popups) and the prose does not. Every one
of those is a stable DOM element that CodeMirror keeps across a decoration swap, so paint-only
transitions on them cost nothing in the measure loop, which is exactly the argument that made D92
affordable.

## The inventory

62 places. **R** respond, **A** arrive/leave, **K** acknowledge, **F** in flight, **still**
deliberately motionless.

### Shell and chrome

| Place                                                |       | Notes                                               |
| ---------------------------------------------------- | ----- | --------------------------------------------------- |
| Sidebar collapse/expand                              | A     | width, from the left edge                           |
| Sidebar and pane resize drag                         | still | tracks the pointer 1:1                              |
| Rail buttons (board, mail, calendar, settings, gear) | R     | hover, press depth                                  |
| Open-task count badge                                | K     | when the number changes                             |
| Footer sync indicator                                | F / K | breathing while syncing, one beat when a push lands |
| Vault switcher                                       | A + R | menu arrives, items respond                         |
| Conflict banner                                      | A / K | arrives from the top, one beat on resolve           |

### Explorer

| Place                                |       | Notes                                                                           |
| ------------------------------------ | ----- | ------------------------------------------------------------------------------- |
| Tree rows                            | R     | background, name colour, the `···` affordance                                   |
| Folder expand/collapse               | R + A | chevron responds, children stagger in, capped                                   |
| New file/folder inline input         | A     | at the place you clicked (`upcoming.md` item 8's behaviour, now with a texture) |
| Row created / deleted / renamed      | A     | in at 300, out at 190                                                           |
| Drag a file over a folder            | R     | the drop _target_ warms; the dragged thing stays direct                         |
| Icon (emoji) popover, header actions | A + R |                                                                                 |
| Apps panel rows and collapse         | R + A |                                                                                 |

### Tabs and panes

| Place                                     |     | Notes                                      |
| ----------------------------------------- | --- | ------------------------------------------ |
| Tab hover, close button, active indicator | R   |                                            |
| Tab opened / closed                       | A   | from the right, out faster                 |
| Reorder preview while dragging            | R   | today's FLIP (D84), now named and at 150ms |
| Drop                                      | A   | the settle into place                      |
| Overflow fade edges                       | R   |                                            |
| Pane split created / closed               | A   | grows from the split                       |
| History / turn-review / agent panels      | A   | each from its own edge                     |

### Overlays

| Place                                           |       | Notes                                                                 |
| ----------------------------------------------- | ----- | --------------------------------------------------------------------- |
| Dialog                                          | A     | scrim fade plus content, **no zoom overshoot**, out at 190            |
| Dropdown, context menu, select, popover         | A     | from the trigger's own transform-origin, which Radix already provides |
| Menu item hover                                 | R     |                                                                       |
| Tooltip                                         | A     | keeps its existing open delay                                         |
| Agent notices / toasts (`lib/agent-notices.ts`) | A + K |                                                                       |

### Agent

| Place                                  |       | Notes                        |
| -------------------------------------- | ----- | ---------------------------- |
| Drawer open/close                      | A     |                              |
| "Claude is working"                    | F     | the canonical in-flight case |
| Turn finishes                          | K     | the turn chip blooms         |
| `TurnChip` appearing                   | A     |                              |
| Turn review rows; accept/reject a hunk | R + K |                              |
| PTY output                             | still | it is terminal text          |

### Tasks and board

| Place                                 |           | Notes                                                                        |
| ------------------------------------- | --------- | ---------------------------------------------------------------------------- |
| Card hover                            | R         |                                                                              |
| Card drag / drop                      | still / A | direct while dragging, settles on release, neighbours shift at A             |
| Complete a task                       | K + A     | check, strike, then the card leaves for Done. The best single ack in the app |
| Column `+` summoning the create input | A         |                                                                              |
| Filter changes the visible set        | A         | in, out, and the survivors move                                              |
| Lane collapse                         | A         | staggered                                                                    |

### Mail, calendar, history, settings

| Place                                                        |       | Notes                                 |
| ------------------------------------------------------------ | ----- | ------------------------------------- |
| Thread rows, commit rows, agenda events, settings rail items | R     |                                       |
| Open a thread, section swap, compose dialog                  | A     |                                       |
| Mailbox sync                                                 | F     | replaces the current `animate-spin`   |
| Send, reply, restore, revert                                 | K     |                                       |
| Selection bar on multi-select                                | A     | from the bottom                       |
| Churn bars                                                   | A     | staggered, on first paint only        |
| A setting written to disk                                    | K     | it is a file write, so it gets a beat |
| Diff and mail body text                                      | still |                                       |

### Inside a document (paint only)

| Place                                   |       | Notes                                                 |
| --------------------------------------- | ----- | ----------------------------------------------------- |
| Wiki-link chip                          | R / K | hover responds; missing becoming existing gets a beat |
| Task status orb                         | R / K |                                                       |
| Note checkbox toggle                    | K     |                                                       |
| Image load                              | A     | fade with the box reserved, so nothing shifts         |
| Table widget: cell hover; add row/col   | R / A |                                                       |
| Frontmatter field rows; a field written | R / K |                                                       |
| Slash and mention autocomplete          | A     | a popup over the editor, not a decoration             |
| Heading `#` slide (D92)                 | R     | reclassified, 240ms becomes 150ms                     |

## Mechanism, and why the linter is part of the design

The vocabulary lives in `index.css`, and components reach it through **four semantic utilities**
rather than by writing numbers: a respond transition, an arrive/leave pair, an ack set, and an
in-flight set. Naming them after the behaviours rather than after the properties is what makes
"which of the four is this" answerable by reading the class.

**The renderer ESLint gate rejects motion literals**, exactly as it already rejects arbitrary
colour literals:

- arbitrary durations and easings in class names (`duration-[220ms]`, `ease-[cubic-bezier(...)]`),
- `transition` / `animation` / `transitionDuration` in inline `style` objects,
- `@keyframes` declared anywhere but `index.css`,
- with a **scoped exemption for `features/onboarding/`**, which owns its own ceremony CSS.

Convention alone was considered and rejected: it is precisely how the current pile arose. A lint
error is the only version of "centralized" that survives six months of edits, and the colour-literal
rule is the proof that this shape works in this codebase.

Many of the 62 rows land inside `primitives/`, and the layering rule (`primitives/` →
`composites/` → `features/`) means those reach the whole app without any feature opting in. That is
a consequence of where the rows fall, not a separate mechanism.

## Reduced motion

**Reduce, not remove**, and this is the design's position rather than an agreed decision: it was
raised and set aside as premature, so it is flagged here for a ruling before implementation.

Under `prefers-reduced-motion: reduce`:

- **F stops dead.** Everything that loops is exactly what the setting exists to suppress.
- **A becomes instant.** Travel is the vestibular problem.
- **R and K survive as paint only.** Colour and opacity are not motion in the sense the setting
  means, and removing them makes the app worse for a user who did not ask for that.

Today this is honoured in two files (`editor/askAgent.ts`, `editor/theme.ts`) as special cases. It
becomes one media query beside the token definitions, plus one hook for the JavaScript-driven cases
(`TabStrip`'s FLIP, the stagger).

## Testing

Motion is mostly judged by eye in the running app, and the honest plan says so. What is genuinely
testable is tested, and the rest is reviewed:

- **Pure and unit tested**: the stagger cap (a function on a count), and the reduced-motion
  resolution (a function on a media-query match).
- **Lint rule**: gets its own fixture cases, both directions.
- **dom project**: that a component wears the right utility, which is a class assertion and
  therefore stable; not that it visually animates, which jsdom cannot tell you.
- **Reviewed in the running app**, by him, surface by surface. `jsdom` does not run a compositor
  and `cdp.mjs` screenshots a single frame, so neither can answer "does this feel right". Every
  previous motion bug in this repo (all three of D92's) was found by eye within minutes, and the
  plan should expect that and sequence for it rather than pretend otherwise.

## Open questions

1. **Reduced motion** needs the ruling above.
2. **Sequencing.** 62 places is a large single landing, and the review loop is human and visual.
   The implementation plan should decide whether the vocabulary plus the primitives lands first as
   a reviewable tier, or whether it goes in as one sweep.
