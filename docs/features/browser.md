# Browser

Web pages in a Holi tab, beside the notes, which the agent can use too: it opens a page, reads it as
text, clicks, types and takes screenshots with `holi browser`, in tabs the person sees and can take
over. It is the `browser` plugin, off until a vault turns it on, because the agent can act on any site
this machine is signed in to in it.

## How it works

**A page is main's.** Each tab is an Electron `WebContentsView`, which main lays over the tab's area of
Holi's window (`main/pages.ts`). The tab (`BrowserSurface.tsx`) says where that area is, every frame
it moves (`place`, a plugin message rather than a capability, since it is sent so often). A tab that is
hidden or unmounted takes its page out of the window, and the page keeps running, so the agent can
work in a tab nobody is looking at. The surface is kept mounted (`Surface.keepMounted`).

**Nothing of Holi's draws over a page.** A native view sits above the window's own page, so while a
menu, popover, hover card or dialog of Holi's (Radix's portals, a child of `<body>`) overlaps the tab,
the page is swapped for a still of itself (`browser.still`, a JPEG) and laid back once the overlay has
gone. A toast is not an overlay and is hidden behind a page.

**A page is the web, and nothing of Holi's.** Sandboxed, with no preload, no Node and Holi's IPC out
of its reach. A tab shows `http(s)` and the blank page only (`isPageUrl`): a navigation to anything
else is refused, and a `mailto:` or `tel:` link goes to the system. A page that opens a window gets a
new tab instead. Every permission is refused but writing to the clipboard. Downloads ask where to save,
as Electron does.

**One session for the machine.** Every vault's pages share `persist:holi-browser`, so a site signed in
to once stays signed in, across vaults and restarts. The user agent leaves out Electron and Holi.

**Its keys.** While a page has the keyboard, ⌘L goes to the address bar, ⌘R reloads and ⌘[ and ⌘] go
back and forward; the editing keys (⌘A, ⌘C, ⌘V, ⌘X, ⌘Z, ⌘Y) are the page's; any other ⌘ key is
pressed again in Holi's window, so ⌘K, ⌘W and the rest work from a page. Ctrl stands for ⌘ off macOS.
A right-click has a small menu of its own: open a link in a new tab or the system browser, copy,
paste, back, forward, reload.

**The tab.** Back, Forward, Reload (Stop while loading), the address bar and Open in your browser. A
typed address is read by `addressFor`: a web address as it is, a bare host over https (http for
`localhost`), anything else a DuckDuckGo search. A new tab is the empty state, its address bar
focused; a page that failed is an alert with Retry; a tab whose page is on its way is a skeleton. New
Browser Tab is in the command menu. A tab is named by its page's title, then its host.

**Tabs outlive a restart; pages do not.** Pages close with their vault. The shell keeps its tabs, and
the address each page last showed is remembered on this machine (`localStorage`), so a tab from
before opens again at it (`browser.open` with `reopen`); one with no address closes. Closing a page's
last tab closes the page, and a page the agent closes takes its tab.

## The agent

`holi browser` drives the same pages as the tab's buttons:

| Command                              | What it does                                                     |
| ------------------------------------ | ---------------------------------------------------------------- |
| `open [url]`                         | A new tab, revealed in Holi; `--tab <id>` goes there in that tab |
| `read`                               | The page as text, its controls numbered                          |
| `click <ref>`                        | Clicks control `<ref>` from the last read                        |
| `type <ref> <text> [--submit]`       | Replaces what a field holds; a select picks that option          |
| `press <key>`                        | `Enter`, `Escape`, `Tab`, `ArrowDown`, `Shift+Tab`…              |
| `scroll [down\|up\|top\|bottom]`     | Scrolls, and says when the page ends                             |
| `screenshot`                         | A PNG of the page; prints its path                               |
| `back`, `forward`, `reload`, `close` | As they say                                                      |
| `tabs`                               | The open tabs, the one in use first                              |

Every verb but `open` and `tabs` takes `--tab`. Left out, it is the tab last used: last acted on,
opened, or brought up by the person. The seeded `using-the-browser` skill tells the agent to pass
`--tab` when it uses more than one, or the person may be clicking around.

**Reading.** `page-script.js` runs in an isolated world, so the page's own scripts see neither it nor
its numbers. It walks the page in reading order: headings with `#`, list items with `-`, each link,
button, field, checkbox and select numbered with its name, value and state
(`[5] textbox "Email" placeholder="you@company.com"`). What is hidden is left out, and a password's
value is never read back. A read stops at 12,000 characters, under the CLI's spill, and says so. The
numbers hold until the next read or until the page changes.

**Acting.** A click is a real mouse event at the control's middle when the page is on screen and
nothing covers the control there, and the script's `click()` otherwise. Typing focuses the field,
selects what it holds and inserts the text as typed input; a field typing did not reach is filled
(the value set and `input` and `change` sent). Each action answers once its page has loaded, or
after 15 seconds, and a moment for the page's own drawing.

**Page text is untrusted.** At the CLI door a page's title and text are fenced (`fenceUntrusted`,
source `web`, `from` its host): a page is someone else's words, never instructions. The skill says
so, and to ask before paying, sending, deleting, accepting or typing a secret; a password is for the
person to type in the tab. Each `holi browser` is a Bash call, so the agent's own permission prompt
covers it as any other.

**Screenshots** are owner-only files in the OS temp directory, as `holi docs screenshot`'s are.

## Rules

- A tab shows `http(s)` and the blank page only, checked in main for every navigation and redirect.
- Holi's code never runs in a page's world; the agent's script runs in an isolated one.
- The agent's tab is revealed in Holi: what it does in a browser, the person can see.
- A page's words reach the agent fenced as untrusted.

## Rejected

- `<webview>`: it draws in the window's own layout, so Holi's menus would draw over it, but Electron
  discourages it.
- The DevTools protocol for the agent (a Playwright MCP server): any process on the machine could
  connect to the port, it bypasses the capability registry and its refusals, and it is harder to keep
  to the browser's own tabs.
- A session per vault: one sign-in per site per vault was not worth it, so each vault's agent can use
  the machine's logins.
