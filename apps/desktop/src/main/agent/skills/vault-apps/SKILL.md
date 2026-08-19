---
name: vault-apps
description: Build a small web app that opens as a tab inside Holi and reads this vault's notes and tasks. Use when asked for a dashboard, a viewer, a chart, a board, a calculator, or any custom screen over the vault's own content.
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
const docs  = await holi.docs.list()      // [{ path, kind: 'note'|'daily', updatedAt }]
const text  = await holi.docs.read(path)  // the note's markdown, as a string
const tasks = await holi.tasks.list()     // [{ title, status, due, path, ... }]
await holi.open('projects/q2.md')         // opens that note in a Holi tab
```

That is the whole API. There is nothing else on `holi`.

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
      button { all: unset; cursor: pointer; color: var(--primary); }
    </style>
  </head>
  <body>
    <p><span class="n" id="docs">…</span> notes</p>
    <p><span class="n" id="open">…</span> open tasks</p>
    <ul id="recent"></ul>
    <script>
      ;(async () => {
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
      })()
    </script>
  </body>
</html>
```

## Before you say it is done

- Open it yourself: it is in the sidebar under **apps**.
- A call that rejects should render as a message in the page, not as a blank
  screen — the user cannot see your console.
- Ask what the user wants it to answer before adding a second screen to it. A
  small app that answers one question beats a dashboard nobody reads.
