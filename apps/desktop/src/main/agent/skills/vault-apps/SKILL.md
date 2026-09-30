---
name: vault-apps
description: Build a small web app that opens as a tab inside Holi, over this vault's own notes and tasks. Use when asked for a dashboard, a chart or graph, a table or overview, a report, a viewer or explorer, a board, a tracker, a calculator, a widget, or any custom screen or small tool — including "visualise this", "show me", and "build me something to track X" phrasings.
---

# Build an app for this vault

A vault app is a web page that lives in the vault and opens as a tab in Holi. It
reads the vault's notes and tasks through a small bridge, and it is styled by the
vault's own theme without doing anything.

Write one when a question is better answered by a screen than by a note: "how many
tasks are open per project", "show me every note tagged draft", "a burndown of this
month". The user does not have to know anything about how it works; you write the
files and it appears in their file tree.

An app is for the people who use this vault, inside Holi. It need not read the
vault (a calculator is fine). Someone outside the vault would never see it, so
when the user wants to share one, build the app first and then, if you have the
Artifact tool, publish an artifact as its shareable copy: the same page with the
data it showed written in, since an artifact cannot reach the vault.

## Where it goes

An app is a folder whose name ends in `.app`, and it can go anywhere in the vault.
Put it next to the notes it is about: a burndown for a project goes in that
project's folder. The folder name, without `.app`, is what the app is called.

```
Projects/Q2/Burndown.app/index.html   ← required: the entry document
Projects/Q2/Burndown.app/app.js       ← anything else you like, beside it
Projects/Q2/Burndown.app/style.css
Projects/Q2/Burndown.app/app.yaml     ← required: write this LAST
```

- The name is yours to choose: `Burndown.app`, `Retro board.app`. It cannot sit
  inside another `.app` folder, nor under `.claude/` or `memory/`.
- A personal app, one only this person should have, is named `Name.local.app`.
  The `.local.` keeps the whole folder on this machine: it never syncs, and it is
  still called `Name`. Everything else about it is the same.
- `index.html` is required. A folder without one is not an app, so write the
  entry document even if it is a stub.
- Every other file is served beside it, untouched. Relative `src`/`href` work:
  `<script src="app.js">`, `<link rel="stylesheet" href="style.css">`.
- `app.yaml` is what **finishes** the app, and you write it **last**. Until it
  exists the app does not open, which is the point: you write an app one file at
  a time, and without a marker it would open onto half a page the moment
  `index.html` landed.

  ```yaml
  description: Sprint retros # optional: shown where the app is listed
  ```

  An **empty file is enough**, so if you have nothing to say, write nothing.
  There is no `name` or `icon` key: the name is the folder, and the user sets an
  icon the way they do for any file. `holi app init <path>` scaffolds one for you.

- It appears in the file tree and the apps list as soon as the manifest lands.
  No restart.

## The API

`window.holi` **already exists** in the page — do not add a script tag for it, do
not define it, do not check whether it loaded. Every call returns a promise.

```js
const docs = await holi.docs.list() // every markdown note
const text = await holi.docs.read(path) // that note's markdown, as a string
const tasks = await holi.tasks.list() // every task.*.md
await holi.open('projects/q2.md') // opens that note in a Holi tab
```

That is the whole API. There is nothing else on `holi`.

### Exactly what comes back

`holi.docs.list()` — one entry per markdown note. Task files are **not** in this
list (they are `holi.tasks.list()`), and neither are the agent's own files.

```js
{ path: 'projects/q2/roadmap.md', kind: 'note' | 'daily', updatedAt: '2026-08-20T…' }
```

`holi.tasks.list()` — one entry per `task.*.md` file:

```js
{
  path: 'projects/q2/task.fix-login.md',
  title: 'Fix login',                       // never empty
  status: 'todo' | 'doing' | 'done',        // exactly these three
  due?: '2026-08-24',                       // YYYY-MM-DD
  priority?: 'low' | 'medium' | 'high',
  tags: ['auth'],                           // always an array, may be empty
  reminder?: '2d',
  description: 'the markdown body',
}
```

**An open task is `status !== 'done'`** — not `!t.done`, not `'complete'`, not
`'open'`. A task's "area" is just the folder its path sits in.

`holi.docs.read(path)` takes a vault-relative path exactly as `docs.list` gave it,
and **rejects** for a missing file or a refused one (below). `holi.open(path)`
takes the same kind of path.

## What an app cannot do

These are not oversights — build within them rather than around them.

- **It cannot write anything.** No file writing, no task editing, no note
  creation. An app shows; the agent changes.
- **It cannot store anything.** `localStorage` and `sessionStorage` _throw_ (the
  page has an opaque origin), cookies do nothing, and there is no `holi.data`.
  Reloading the tab starts the app from scratch, so it must be useful holding
  nothing: derive the view from the vault every time rather than keeping state.
  In-memory state within one session (a selected filter, a sort order) is fine.
- **It cannot submit a form.** The frame is sandboxed without forms, so a
  `<form>` is blocked before its submit handler runs, and pressing Enter or the
  button does nothing at all. Use a plain button's click, and a `keydown` on the
  input for Enter.
- **It cannot read the agent's files.** `AGENTS.md`, `CLAUDE.md`, `MEMORY.md`,
  `USER.local.md` and everything under `.claude/` **and `memory/`** are refused —
  `holi.docs.read` rejects, and they are absent from `holi.docs.list()`. The
  vault's memory is on that list for the same reason as the rest of it:
  what the user told the assistant does not become readable to untrusted code by
  being spread over more files. An app that wants to show what the vault knows
  has to be told it, not read it.
- **It cannot reach the rest of the vault directly.** No `fetch` of vault files,
  no access to Holi's own window. The bridge is the only route.

It _can_ use the network — a CDN, an API — but a vault is often used offline, so
prefer writing the code inline over depending on something remote.

## Seeing whether it works

You have two things and no more: a check that runs on every file you write, and
a command that opens the app.

```sh
holi app open <path>        # opens the app's tab in Holi, or reloads it if open
holi app init <path>        # scaffolds <path>, a folder ending in .app
```

**The check speaks on its own.** Every time you write a file inside a `.app`
folder, a `vault-app check` runs and tells you what will not work — a
syntax error and its line, a `.ts` file that has no bundler to build it, a
`localStorage` call that will throw, a `<form>` that will never submit, a
missing manifest. It never blocks a
write and it says nothing at all when there is nothing wrong, so **if it is
quiet, that is the answer**.

**What it cannot tell you is whether the app is right.** It parses; it does not
run. So the loop is:

1. Write the files, manifest last.
2. Read what the check says, if it says anything.
3. `holi app open <path>`, e.g. `holi app open Projects/Q2/Burndown.app`.
4. **Ask the user what they see.** You still have no console, no screenshot
   and no way to read the rendered page — opening the tab puts it in front of
   them, not in front of you.

Because step 4 is the only real verification, build so that a failure is
legible in the page itself:

- **Wrap the startup in a try/catch and render the error into the page.** A
  visible message is the only diagnostic the user can read back to you.
- **Put something on screen before the first `await`**, so a failing call
  leaves a page with a heading on it rather than a blank one.
- Prefer plain DOM over anything clever: no build step, no bundler, no source
  map, and nothing that needs compiling.

## Editing an app that is already open

**Your edit does not appear until the tab is reloaded**, and there is no
auto-reload, deliberately: writing `index.html` and then `app.js` would
otherwise reload on the half-written state and show a broken app.

So when you have finished changing an app, run `holi app open <path>` again. On
an app that is already open it reloads the tab, so the user sees the new
version. Outside Holi, where the command is not there, ask them to reload it
with the ⟳ button at the top right of the tab.

## Styling

The vault's theme is already applied as CSS custom properties on `:root`. Use the
tokens and the app looks like the rest of Holi, in whatever palette this vault has
chosen:

`--background` `--foreground` `--card` `--card-foreground` `--muted`
`--muted-foreground` `--primary` `--primary-foreground` `--brand` `--secondary`
`--accent` `--destructive` `--border` `--input` `--ring` `--radius`

**`--primary` is a fill, `--brand` is text.** `--primary` is the colour you put
_behind_ something, paired with `--primary-foreground` on top of it; on a dark
theme it is dark enough to carry near-white text, which makes it far too dark to
_be_ text on a dark background. When you want the brand colour on a number, a
link or a label, reach for `--brand`.

```css
*,
*::before,
*::after {
  box-sizing: border-box;
}
body {
  background: var(--background);
  color: var(--foreground);
  font:
    14px/1.5 system-ui,
    sans-serif;
  margin: 0;
  padding: 1rem;
}
.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 1rem;
}
```

Never hard-code a colour: a literal `#1e1e1e` is the one thing that will look
wrong in a vault themed differently from yours.

A filled button is `background: var(--primary); color: var(--primary-foreground)`.
A text button is `color: var(--brand)` with no background. Mixing the two —
`color: var(--primary)` on the page background — is the one combination that
reliably comes out unreadable.

## Fitting the pane

The tab is the page's whole viewport, and it is whatever size the user's pane
is: anywhere from 240px wide to the full window, and it changes when they split
a pane or drag a divider. Build for every width, never for a screen.

**Never scroll sideways.** A horizontal scrollbar means something is wider than
the pane, and it is always one of these:

- **Padding added to a width.** `box-sizing: border-box` on everything (as in the
  styles above), so `width: 100%` plus padding is still 100%.
- **A fixed width.** No `width` in pixels wider than about 200px, and no `100vw`
  (it counts a scrollbar the pane may have). Use `%`, `fr`, `max-width` and
  `min()`: `width: min(40rem, 100%)`.
- **Columns that do not wrap.** A grid of cards is
  `grid-template-columns: repeat(auto-fit, minmax(min(14rem, 100%), 1fr))`, which
  goes from one column to many on its own. A row of things is
  `display: flex; flex-wrap: wrap`.
- **Text that will not break.** A flex or grid child holding text needs
  `min-width: 0`, or its longest word holds the column open. Paths and URLs need
  `overflow-wrap: anywhere`; a one-line label gets
  `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`.
- **A chart with a pixel size.** An SVG gets a `viewBox` and
  `width: 100%; height: auto`. A canvas is sized from its container's
  `clientWidth` when it draws, and redrawn on `resize`.
- **A wide table.** Fewer columns first, and cells that wrap. If it is still
  wider than the pane, put it in a `div` with `overflow-x: auto`, so the table
  scrolls and the page does not.

**Fit the height, and scroll inside it.** A page that runs a little past the
bottom of the pane scrolls for nothing. Make the app one screen that fills the
pane, with the one part that can grow (a list, a table) scrolling inside it:

```css
html,
body {
  height: 100%;
}
body {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.grows {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
```

Charts take a share of the height rather than a fixed one:
`height: clamp(10rem, 35vh, 22rem)` (`vh` is the pane's height here). Keep the
page's own padding modest (`1rem`): two rems on each side is a quarter of a narrow
pane.

## A whole app

`Vault dashboard.app/index.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      *,
      *::before,
      *::after {
        box-sizing: border-box;
      }
      body {
        background: var(--background);
        color: var(--foreground);
        font:
          14px/1.5 system-ui,
          sans-serif;
        margin: 0;
        padding: 1rem;
      }
      .n {
        color: var(--brand);
        font-size: 2.5rem;
        font-weight: 600;
      }
      .err {
        color: var(--destructive);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      button {
        all: unset;
        cursor: pointer;
        color: var(--brand);
      }
    </style>
  </head>
  <body>
    <!-- Rendered before anything awaits, so a failure still leaves a page. -->
    <h1>vault dashboard</h1>
    <p><span class="n" id="docs">…</span> notes</p>
    <p><span class="n" id="open">…</span> open tasks</p>
    <ul id="recent"></ul>
    <p class="err" id="err"></p>
    <script>
      ;(async () => {
        try {
          const [docs, tasks] = await Promise.all([holi.docs.list(), holi.tasks.list()])
          document.getElementById('docs').textContent = docs.length
          document.getElementById('open').textContent = tasks.filter(
            (t) => t.status !== 'done',
          ).length
          for (const doc of docs.slice(0, 5)) {
            const li = document.createElement('li')
            const b = document.createElement('button')
            b.textContent = doc.path
            b.onclick = () => holi.open(doc.path)
            li.append(b)
            document.getElementById('recent').append(li)
          }
        } catch (err) {
          // The only diagnostic there is — do not leave this out.
          document.getElementById('err').textContent = `failed: ${err.message ?? err}`
        }
      })()
    </script>
  </body>
</html>
```

## Before you say it is done

- **Write `app.yaml`**, if you have not. Without it the app does not open.
- **Open it: `holi app open <path>`.** Then say what it should show, so the
  user can tell you when it does not — you have still never seen it render, so
  do not claim to have looked at it.
- **Check it fits the pane** (above): nothing with a pixel width, grids that
  wrap, long text that breaks, and one scrolling region rather than a page that
  scrolls. Ask the user to narrow the pane and say whether anything scrolls
  sideways.
- If they already had it open, `holi app open` again reloads it (see above).
- Ask what the user wants it to answer before adding a second screen to it. A
  small app that answers one question beats a dashboard nobody reads.
