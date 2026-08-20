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
```

- `<id>` is the app's name and **must match `[a-z0-9-]+`** — lowercase letters,
  digits and dashes. `retro-board` is fine; `Retro_Board` is not an app at all
  and will not appear.
- `index.html` is required. A directory without one is ignored, so write the
  entry document even if it is a stub.
- Every other file is served beside it, untouched. Relative `src`/`href` work:
  `<script src="app.js">`, `<link rel="stylesheet" href="style.css">`.
- It appears in the sidebar as soon as you save it. No restart, no registration.

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

## You cannot see the app run

There is no console you can read, no screenshot, and **no way for you to open the
app yourself**. If it throws, the tab is blank and nothing tells either of you
what happened. So build for that:

- **Wrap the startup in a try/catch and render the error into the page.** A
  visible message is the only diagnostic that exists here.
- **Put something on screen before the first `await`**, so a failing call leaves
  a page with a heading on it rather than a blank one.
- Prefer plain DOM over anything clever: no build step, no bundler, no source map.
- Re-read the files you wrote before saying it is done. That is the only check
  available to you.

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
`--muted-foreground` `--primary` `--primary-foreground` `--secondary` `--accent`
`--destructive` `--border` `--input` `--ring` `--radius`

```css
body { background: var(--background); color: var(--foreground);
       font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 1rem; }
.card { background: var(--card); border: 1px solid var(--border);
        border-radius: var(--radius); padding: 1rem; }
```

Never hard-code a colour: a literal `#1e1e1e` is the one thing that will look
wrong in a vault themed differently from yours.

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
      .n { color: var(--primary); font-size: 2.5rem; font-weight: 600; }
      .err { color: var(--destructive); white-space: pre-wrap; }
      button { all: unset; cursor: pointer; color: var(--primary); }
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

- **Ask the user to open it** — it is in the sidebar, under **apps**. You cannot
  open it yourself, so do not claim to have looked at it.
- Say what it should show, so they can tell you when it does not.
- If they already had it open, tell them to reload the tab (see above).
- Ask what the user wants it to answer before adding a second screen to it. A
  small app that answers one question beats a dashboard nobody reads.
