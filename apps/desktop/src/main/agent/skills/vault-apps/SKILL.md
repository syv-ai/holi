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
files and it appears in their sidebar.

## Where it goes

```
.holi/apps/<id>/index.html      ← required: the entry document
.holi/apps/<id>/app.js          ← anything else you like, beside it
.holi/apps/<id>/style.css
.holi/apps/<id>/app.yaml        ← required: write this LAST
```

- `<id>` is the app's name and **must match `[a-z0-9-]+`** — lowercase letters,
  digits and dashes. `retro-board` is fine; `Retro_Board` is not an app at all
  and will not appear.
- `index.html` is required. A directory without one is ignored, so write the
  entry document even if it is a stub.
- Every other file is served beside it, untouched. Relative `src`/`href` work:
  `<script src="app.js">`, `<link rel="stylesheet" href="style.css">`.
- `app.yaml` is what **registers** the app, and you write it **last**. Until it
  exists the app does not appear, which is the point: you write an app one file
  at a time, and without a marker it would show up in the sidebar the moment
  `index.html` landed and open onto half a page.

  ```yaml
  name: Retro board          # optional — the label; defaults to the directory
  icon: kanban               # optional — any lucide icon name
  description: Sprint retros # optional — the sidebar tooltip
  ```

  Every key is optional. An **empty file registers the app**, so if you have
  nothing to say, write nothing. `holi app init <id>` scaffolds one for you.
- It appears in the sidebar as soon as the manifest lands. No restart.

## The API

`window.holi` **already exists** in the page — do not add a script tag for it, do
not define it, do not check whether it loaded. Every call returns a promise.

```js
const docs  = await holi.docs.list()      // every markdown note
const text  = await holi.docs.read(path)  // that note's markdown, as a string
const tasks = await holi.tasks.list()     // every task.*.md
await holi.open('projects/q2.md')         // opens that note in a Holi tab
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
- **It cannot store anything.** `localStorage` and `sessionStorage` *throw* (the
  page has an opaque origin), cookies do nothing, and there is no `holi.data`.
  Reloading the tab starts the app from scratch, so it must be useful holding
  nothing: derive the view from the vault every time rather than keeping state.
  In-memory state within one session (a selected filter, a sort order) is fine.
- **It cannot read the agent's files.** `AGENTS.md`, `CLAUDE.md`, `MEMORY.md`,
  `USER.local.md` and everything under `.claude/` are refused — `holi.docs.read`
  rejects, and they are absent from `holi.docs.list()`.
- **It cannot reach the rest of the vault directly.** No `fetch` of vault files,
  no access to Holi's own window. The bridge is the only route.

It *can* use the network — a CDN, an API — but a vault is often used offline, so
prefer writing the code inline over depending on something remote.

## Seeing whether it works

You have two things and no more: a check that runs on every file you write, and
a command that opens the app.

```sh
holi app open <id>          # opens (or focuses) the app's tab in Holi
holi app init <id>          # scaffolds .holi/apps/<id>/ with a manifest
```

**The check speaks on its own.** Every time you write a file under
`.holi/apps/`, a `vault-app check` runs and tells you what will not work — a
syntax error and its line, a `.ts` file that has no bundler to build it, a
`localStorage` call that will throw, a missing manifest. It never blocks a
write and it says nothing at all when there is nothing wrong, so **if it is
quiet, that is the answer**.

**What it cannot tell you is whether the app is right.** It parses; it does not
run. So the loop is:

1. Write the files, manifest last.
2. Read what the check says, if it says anything.
3. `holi app open <id>`.
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
auto-reload — deliberately, because writing `index.html` and then `app.js` would
otherwise reload on the half-written state and show a broken app.

So whenever you change an app the user may already have open, tell them: *reload
it with the ⟳ button at the top right of the tab*. Otherwise they are looking at
the old version while you describe the new one, and you will both conclude the
fix did not work.

## Styling

The vault's theme is already applied as CSS custom properties on `:root`. Use the
tokens and the app looks like the rest of Holi, in whatever palette this vault has
chosen:

`--background` `--foreground` `--card` `--card-foreground` `--muted`
`--muted-foreground` `--primary` `--primary-foreground` `--brand` `--secondary`
`--accent` `--destructive` `--border` `--input` `--ring` `--radius`

**`--primary` is a fill, `--brand` is text.** `--primary` is the colour you put
*behind* something, paired with `--primary-foreground` on top of it; on a dark
theme it is dark enough to carry near-white text, which makes it far too dark to
*be* text on a dark background. When you want the brand colour on a number, a
link or a label, reach for `--brand`.

```css
body { background: var(--background); color: var(--foreground);
       font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 1rem; }
.card { background: var(--card); border: 1px solid var(--border);
        border-radius: var(--radius); padding: 1rem; }
```

Never hard-code a colour: a literal `#1e1e1e` is the one thing that will look
wrong in a vault themed differently from yours.

A filled button is `background: var(--primary); color: var(--primary-foreground)`.
A text button is `color: var(--brand)` with no background. Mixing the two —
`color: var(--primary)` on the page background — is the one combination that
reliably comes out unreadable.

## A whole app

`.holi/apps/vault-dashboard/index.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { background: var(--background); color: var(--foreground);
             font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 2rem; }
      .n { color: var(--brand); font-size: 2.5rem; font-weight: 600; }
      .err { color: var(--destructive); white-space: pre-wrap; }
      button { all: unset; cursor: pointer; color: var(--brand); }
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
          document.getElementById('open').textContent =
            tasks.filter((t) => t.status !== 'done').length
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

- **Write `app.yaml`**, if you have not. Without it the app does not exist.
- **Open it: `holi app open <id>`.** Then say what it should show, so the
  user can tell you when it does not — you have still never seen it render, so
  do not claim to have looked at it.
- If they already had it open, tell them to reload the tab (see above).
- Ask what the user wants it to answer before adding a second screen to it. A
  small app that answers one question beats a dashboard nobody reads.
