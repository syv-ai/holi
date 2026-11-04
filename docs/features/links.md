# Links

A link file saves a web address in the vault without the thing it points at: a 189-slide deck stays in Google Slides, and the vault keeps where it is and what someone wrote about it. Main reads a preview of the page (its image, site, title and description), and the renderer shows it as a card.

## How it works

**The file.** `link.<name>.md`, anywhere in the vault, recognised by its name alone, as a task is by `task.`. Its frontmatter holds `url` (required, http or https) and, like a note's, `tags`; its body is what the link is, in someone's words. A name Holi makes follows the shared file-name rule (`fileSlug`, as a task's does): lower case, dashes for spaces, æ ø å written as ae oe aa, other accents dropped, everything else a separator. `Q3 Strategy Deck` is `link.q3-strategy-deck.md`. A chip or the `@` menu reads the name with spaces; the card shows the page's own title. A file with no `url`, or one that is not a web address, is reported as broken by the scan rather than dropped. `link.<name>.local.md` is a private link, a [local file](../glossary.md#local-file) like any other.

**Creating one.** `links.create` fetches the page once, names the file after the page's title (an address's host and path when the page names none) and leaves the body empty for what someone will say about it (the page's description is the card's to show), taking `-2`, `-3` when the name is used. Core only knows that a claim's create takes a dropped address (`ClaimCreate.fromUrl`). The agent has the same as `holi links create <url> [folder]`, or writes the file itself, as the seeded `using-links` skill describes.

**Previews.** `links.preview` fetches a page with Node's own `fetch`, never Electron's session, so no cookie or sign-in goes with it. Only http and https are fetched, with a five-second timeout, at most five redirects and at most a megabyte, and only the `<head>` of an HTML answer is read. It takes `og:` tags first, then `twitter:` tags, `<title>` and `<meta name="description">`, and the site's icon or `/favicon.ico`, with relative addresses resolved against where the page ended up. Redirects are followed by hand, and every hop is held to the same rules. An address that resolves into this machine or its network (loopback, private, link-local, carrier NAT) is never fetched: a hover is all it takes, and the address may be in a note someone else wrote. Anything that fails (a timeout, a refusal, a page that is not HTML, a login wall) is the address alone, its host as the site, and never an error. Previews are cached on this machine for a day, in memory and in `userData/links/previews.json` (at most 500); a failure that may pass (offline, a timeout, the site's own 5xx) is not kept, and a renderer asks again for a page that said nothing. An image or icon that points inside this machine's network is dropped by main, as a page there would be, and text a site escaped twice (GitHub's descriptions) is decoded again.

**In the window.** New Link in the files list's New menu asks for the address in a dialog (`ClaimCreate.asksName`), and a refusal stays under the field. A web address dragged in from a browser is saved as a link where it lands, a folder's row or the empty space below the rows (`ClaimCreate.fromUrl`, read from `text/uri-list`). A link's page shows as a card (`preview-card.tsx`): in a hover card on its row in the tree (`PathClaim.hover`) and at the top of its tab, above what someone wrote about it (`PathClaim.banner`). A click on the card opens the page in the browser, as does Open in Browser in the row's menu, which reads the address from the file when chosen. Not rebuilt: the card over a web address written in a note, and a link file's chip in the editor ([not-built](../not-built.md)).

## Rules

- Nothing the page says is stored in the vault beyond the name it gave the file: no title, image, site name or description key. A copy would go stale against the page, and the card reads it fresh.
- The name decides what a link file is, never frontmatter a copy and paste could carry.
- Only http and https are fetched, and only they (and `mailto:`, for mail) are opened, checked in main whatever the renderer sends, and never an address inside this machine's network, at every redirect. A page whose name resolves differently between the check and the fetch is not caught.
- A preview never fails anything: the worst case is the address alone.

## Rejected

- Downloading the file, or a thumbnail of it, into the vault: the point is to keep big things out, and a thumbnail is a binary in every clone's history.
- A machine-wide store of bookmarks outside the vault: links are vault content, shared, searchable and linked like notes.
- An OS shortcut file (`.webloc`, `.url`): it opens outside Holi, but has nowhere for a description or tags.
- One file of many links: a link would not be a file of its own, so it could not be linked to, moved or tagged.
- Embedding the page: most sites refuse to be framed, and Google's need a session.
- Reading Google Drive's own metadata for its links: it needs a Drive scope on the Google sign-in. Private Google links show the plain card.
- Making a bare address ⌘-clickable: it has a card, but stays text, as before.

## Code

Links is a plugin (`apps/desktop/src/plugins/links/`, default on; [architecture](../architecture.md#plugins)). With it off, a link file is a plain note, and nothing fetches.

- `plugins/links/shared/link-file.ts`: the format (`isLinkFilePath`, `linkFilePath`, `parseLinkFile`, `linkFileText`, the snapshot claim). `shared/preview.ts`: the `LinkPreview` shape and `isWebUrl`.
- `plugins/links/main/unfurl.ts`: fetching and reading a page's head. `main/cache.ts`: the cache. `main/capabilities.ts`: `links.preview` (UI door) and `links.create` (UI and CLI). `main/seed.ts`, `main/vault/shipped/.claude/skills/using-links/`: the skill.
- `plugins/links/renderer/claim.tsx`: the claim (New Link, the dropped address, the cards, Open in Browser). `renderer/preview-card.tsx`: the card. `renderer/use-preview.ts`: asking main, once per session.
- `plugins/links/test/`: the format and the page reading.
