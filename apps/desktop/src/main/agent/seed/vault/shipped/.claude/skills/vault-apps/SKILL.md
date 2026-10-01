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

  Write every key, and leave the ones the app does not use blank, so whoever
  opens the file sees everything an app can say:

  ```yaml
  description: Sprint retros # shown where the app is listed
  collections: # the records it keeps: see Keeping data
  dangerously-allow: # one person's data it reads: mail, calendar, location
  ```

  A blank key is unused, and an empty file is still a valid manifest. There is
  no `name` or `icon` key: the name is the folder, and the user sets an icon the
  way they do for any file. `holi apps init <path>` writes this file for you.

- It appears in the file tree and the apps list as soon as the manifest lands.
  No restart.

## The API

`window.holi` **already exists** in the page — do not add a script tag for it, do
not define it, do not check whether it loaded. Every call returns a promise.

```js
const docs = await holi.docs.list() // every markdown note
const text = await holi.docs.read(path) // that note's markdown, as a string
const html = await holi.docs.render(path) // that note as HTML (or use <holi-note>)
const tasks = await holi.tasks.list() // every task.*.md
await holi.tasks.complete(path) // done; a recurring task rolls forward instead
await holi.open('projects/q2.md') // opens that note in a Holi tab
await holi.open('board') // or a view: home, board, agenda, mail, settings, history
const recents = await holi.recents() // [{ kind: 'path'|'surface'|'session', key, id? }], newest first; an app is { kind: 'surface', key: 'app', id: bundle }
const hits = await holi.search('budget') // [{ path, match: 'name'|'body', snippet? }]
const settings = await holi.settings() // the vault's resolved settings
const people = await holi.members() // [{ login, avatarUrl? }], who can reach the vault
const commits = await holi.history({ path, limit }) // [{ sha, subject, date, author, files? }]
const sync = await holi.sync.status() // { kind: 'up-to-date' | 'pulling' | 'offline' | ... }
const sessions = await holi.agent.sessions() // [{ id, name, state: 'working'|'idle'|'needs-you' }]
const items = holi.store('items') // this app's own records (see Keeping data)
const off = holi.on('docs', () => redraw()) // see Hearing about changes
```

Plus `holi.google.agenda({ from, to })` and `holi.google.search(query)`, which
need an opt-in (see Reading someone's mail or calendar). That is the whole API.

`<holi-note path="projects/q2.md"></holi-note>` shows a note, rendered and themed,
with its `[[links]]` opening in Holi. It renders again when the note changes.

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

- **It cannot write the vault.** No file writing, no task editing, no note
  creation. An app shows; the agent changes. It writes two things only: its own
  records, through `holi.store` (below), and a task's completion, through
  `holi.tasks.complete`, which applies the board's rule.
- **It has no browser storage.** `localStorage` and `sessionStorage` _throw_ (the
  page has an opaque origin) and cookies do nothing. Anything that must survive
  a reload goes in `holi.store`; in-memory state within one session (a selected
  filter, a sort order) is fine.
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

**Links leave Holi.** A link to a web page or a `mailto:` opens in the person's
browser or mail app, whether it is a plain `<a href>`, `target="_blank"` or
`window.open`; the app stays where it is. Any other link out of the app does
nothing. To go somewhere inside Holi, use `holi.open` (below).

## Hearing about changes

`holi.on(topic, fn)` calls `fn` whenever that topic changes, and returns a
function that stops it. `fn` gets no arguments: read the data again.

| Topic                | When                                  |
| -------------------- | ------------------------------------- |
| `docs`               | a note was added, changed or removed  |
| `tasks`              | a task changed                        |
| `store:<collection>` | a record in this app's collection did |
| `sync`               | the sync state moved                  |
| `agent`              | a session started, ended or changed   |
| `recents`            | the user opened something             |
| `history`            | a commit landed                       |

Prefer this to polling. A put or delete from the app itself fires
`store:<collection>` too, a moment later.

## Reading someone's mail or calendar

`holi.google.agenda({ from, to })` (ISO instants, at most 92 days apart; none
means the next 7 days) and `holi.google.search(query)` (Gmail's search grammar;
none means the inbox; a page, `{ threads, nextPageToken }`) read
the Google account of **whoever has the app open**, not the vault's. So they are
off until the app opts in, in `app.yaml`:

```yaml
dangerously-allow: [mail, calendar] # either or both
```

Better, say why: written as a map, each one carries a short reason that the
person reads, quoted as the developer's explanation, in the dialog that asks them.
One plain sentence about what the app does with it (at most 200 characters):

```yaml
dangerously-allow:
  calendar: To show your next meeting
```

**There is no location.** `navigator.geolocation` is always refused in an app:
Holi cannot get a position on every platform, so it offers none. Ask the person
for a place (a search box), or estimate one from their IP address with a public
web service, and say that it is an estimate.

Then each person sees a dialog the first time they open the app, and Holi asks
again after 30 days and whenever the app's code changes. Until they allow it,
the call rejects. A personal app (`Name.local.app`) needs the flag but no dialog.

Before you add the flag to a shared app, tell the user plainly: whatever the app
keeps in its records syncs to everyone in the vault, so do not store someone's
mail in a shared app's store unless they asked for exactly that.

## Keeping data

An app keeps records in **collections** it declares in `app.yaml`. A record is a
plain JSON object, stored as one file at `<app>/data/<collection>/<id>.json`, so
it is readable, diffable and syncs with the vault like a note.

```yaml
description: Reading list
collections:
  books:
    schema: # optional, JSON Schema; Holi refuses a write that does not fit
      type: object
      required: [title]
      properties:
        title: { type: string }
        read: { type: boolean }
        rating: { type: integer, minimum: 1, maximum: 5 }
```

`collections: [books, notes]` declares collections with no schema. A collection
that is not declared is refused, so declare it before the app uses it.

```js
const books = holi.store('books')
const id = await books.put({ title: 'Dune', read: false }) // makes an id
await books.put('2026-09-30', { title: 'Log' }) // or use your own id
const book = await books.get(id) // the object, or null
const all = await books.list() // [{ id, value }], in id order
const unread = await books.query((r) => !r.value.read) // filter, in the page
await books.delete(id)
```

- A put **replaces** the record. To change one field, get it, change it, put it.
- An id is letters, digits, `.`, `_` and `-`. A made id sorts by time, so
  `list()` is oldest first. A readable id (a date, a slug) is a good choice when
  there is one.
- Keep records small and collections modest (hundreds, not millions): `list()`
  and `query()` read the whole collection.
- Two people editing **different fields** of one record merge cleanly. The same
  field edited on both sides becomes a sync conflict, so prefer small records
  over one big one that everybody edits.
- The app **cannot fetch** `data/`; the store is the only way in. You can read
  and edit those files yourself, and the check below tells you if one no longer
  fits its schema.

From the terminal, the same records:

```sh
holi store list <app> <collection>          # one line per record
holi store get <app> <collection> <id>
holi store put <app> <collection> '<json>' [<id>]
holi store delete <app> <collection> <id>
```

## Seeing whether it works

You have three things: a check that runs on every file you write, a command
that opens the app, and the app's log.

```sh
holi apps open <path>       # opens the app's tab in Holi, or reloads it if open
holi apps init <path>       # scaffolds <path>, a folder ending in .app
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
3. `holi apps open <path>`, e.g. `holi apps open Projects/Q2/Burndown.app`.
4. **Ask the user what they see.** You have no screenshot and no way to read
   the rendered page: opening the tab puts it in front of them, not you.
5. **Read the log**, `log.local.txt` at the app's root, when they say something
   is wrong. Holi writes into it what went wrong while the app ran on this
   machine: `console.error` and `console.warn`, uncaught errors and rejected
   promises (with their stacks), and every bridge call Holi refused, each line
   timed. `holi.log(...)` adds a line of your own, so log what you would want to
   know next time. It keeps the last day, never syncs, and the app cannot read
   it. No file means nothing has gone wrong here yet.

The log is your console, but only the user sees the page, so build so that a
failure is legible in the page itself too:

- **Wrap the startup in a try/catch and render the error into the page.** A
  visible message is the only diagnostic the user can read back to you.
- **Put something on screen before the first `await`**, so a failing call
  leaves a page with something on it rather than a blank one.
- Prefer plain DOM over anything clever: no build step, no bundler, no source
  map, and nothing that needs compiling.

## Editing an app that is already open

**Your edit does not appear until the tab is reloaded**, and there is no
auto-reload, deliberately: writing `index.html` and then `app.js` would
otherwise reload on the half-written state and show a broken app.

So when you have finished changing an app, run `holi apps open <path>` again. On
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

**Do not title the page with the app's name.** The tab above it and the file
tree already say it, so a heading repeating it is a line of nothing. Start with
the content; a heading is for a part of the page, not the page.

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

## The Home tab

Home is what `home:` in `.holi/settings/app.yaml` says, and it is also what the
vault opens on. By default it is `recents`, Holi's own list of what was opened
recently. It can instead be `daily` (today's note), `board`, `agenda`, `mail`,
or any app or file in the vault by its path.

When the user asks to change or customize their home page, and Home names an
app, edit that app. When Home is `recents` or another of Holi's views, build an
app for it (`Home.app` is the usual name) and point `home:` at its path; start
from what Home showed until now unless they ask for something else. If they
want Home to be something else entirely (their board, a note), change `home:`
instead.

- A home for everyone in the vault is the shared setting. A home for one person
  is `home:` in `.holi/settings/app.local.yaml`, which never syncs, pointing at
  a personal app (`Home.local.app`) or anything else.
- If Home says there is no app yet, the user can press **Create Home app**, or
  you can write the folder yourself.
- To see a change, ask the user to open Home again (or reload it from its tab).
  `holi apps open <path>` works too, but opens it in a tab of its own beside
  Home rather than reloading the Home tab.

## Before you say it is done

- **Write `app.yaml`**, if you have not. Without it the app does not open.
- **Open it: `holi apps open <path>`.** Then say what it should show, so the
  user can tell you when it does not — you have still never seen it render, so
  do not claim to have looked at it.
- **Check it fits the pane** (above): nothing with a pixel width, grids that
  wrap, long text that breaks, and one scrolling region rather than a page that
  scrolls. Ask the user to narrow the pane and say whether anything scrolls
  sideways.
- If they already had it open, `holi apps open` again reloads it (see above).
- Ask what the user wants it to answer before adding a second screen to it. A
  small app that answers one question beats a dashboard nobody reads.
