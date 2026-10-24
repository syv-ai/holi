# Links

A link file saves a web address in the vault without the thing it points at: a 189-slide deck stays in Google Slides, and the vault keeps where it is and what someone wrote about it. Holi shows a preview of the page (its image, site, title and description) when the pointer rests on a link file in the tree, on a wiki-link to one, or on any web address in a note, and at the top of a link file's own tab.

## How it works

**The file.** `link.<name>.md`, anywhere in the vault, recognised by its name alone, as a task is by `task.`. Its frontmatter holds `url` (required, http or https) and, like a note's, `tags`; its body is what the link is, in someone's words. The name is the title: `link.Q3 strategy deck.md` is "Q3 strategy deck". A file with no `url`, or one that is not a web address, is reported as broken by the scan rather than dropped. `link.<name>.local.md` is a private link, a [local file](../glossary.md#local-file) like any other.

**New Link.** The explorer's **+** offers New Link, whose name field takes an address, and a link dragged onto the tree from a browser (its `text/uri-list`) is saved in the folder it lands on, opened when it is one. Core only knows that a claim's create takes a dropped address (`ClaimCreate.fromUrl`). `links.create` fetches the page once, names the file after the page's title (an address's host and path when the page names none) and writes the page's description as the body, taking "title 2", "title 3" when the name is used. The agent has the same as `holi links create <url> [folder]`, or writes the file itself, as the seeded `using-links` skill describes.

**Previews.** `links.preview` fetches a page with Node's own `fetch`, never Electron's session, so no cookie or sign-in goes with it. Only http and https are fetched, with a five-second timeout, at most five redirects and at most a megabyte, and only the `<head>` of an HTML answer is read. It takes `og:` tags first, then `twitter:` tags, `<title>` and `<meta name="description">`, and the site's icon or `/favicon.ico`, with relative addresses resolved against where the page ended up. Redirects are followed by hand, and every hop is held to the same rules. An address that resolves into this machine or its network (loopback, private, link-local, carrier NAT) is never fetched: a hover is all it takes, and the address may be in a note someone else wrote. Anything that fails (a timeout, a refusal, a page that is not HTML, a login wall) is the address alone, its host as the site, and never an error. Previews are cached on this machine for a day, in memory and in `userData/links/previews.json` (at most 500); a failure that may pass (offline, a timeout, the site's own 5xx) is not kept, and a renderer asks again for a page that said nothing.

**The card** is one component, `PreviewCard`, drawn in three places:

- The tree: a link file's row shows it on rest, through the row's claim (`PathClaim.hover`).
- The editor: a hover over a markdown link (`[text](https://…)`, `<https://…>`), a bare `https://…`, or a wiki-link to a link file. The address is read off the syntax tree, so one in code never has a card. The wiki-link card replaces the ordinary one for a saved link (`LinkChip.url`). This hover is the plugin's, added to every note (`RendererPlugin.editorExtensions`).
- A link file's tab: between the frontmatter and the body, centred, with the address in full. It follows the `url` as the text says it now, so editing the row redraws it. The `url` row wraps over as many lines as the address takes (a control of the claim's own), where a one-line field would cut it off.

The image and icon load straight from the page's site with no referrer; one that will not load is left out. Text a site escaped twice (GitHub's descriptions) is decoded again. A title is cut at a whole word for a file name, without the separators (`·`, `-`) it strings its parts with.

**Opening.** The card is the link: a click anywhere on it opens the page in the browser, wherever it is shown, and it answers the pointer (its surface lifts, the image eases in, the arrow nudges out). ⌘-click on a wiki-link to a link file opens the page in the browser; a plain click opens the file, as for any wiki-link. A link file's row menu has Open in Browser, which reads the file when chosen. ⌘-click on a row keeps meaning open in a new pane.

## Rules

- Nothing the page says is stored in the vault: no title, image, site name or description key. A copy would go stale against the page, and the card reads it fresh.
- The name decides what a link file is, never frontmatter a copy and paste could carry.
- Only http and https are fetched or opened, checked in main whatever the renderer sends, and never an address inside this machine's network, at every redirect. A page whose name resolves differently between the check and the fetch is not caught.
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

Links is a plugin (`apps/desktop/src/plugins/links/`, default on; [architecture](../architecture.md#plugins)). With it off, a link file opens as a plain note, and nothing fetches.

- `plugins/links/shared/link-file.ts`: the format (`isLinkFilePath`, `linkFilePath`, `parseLinkFile`, `linkFileText`, the snapshot claim). `shared/preview.ts`: the `LinkPreview` shape and `isWebUrl`.
- `plugins/links/main/unfurl.ts`: fetching and reading a page's head. `main/cache.ts`: the cache. `main/capabilities.ts`: `links.preview` (UI door) and `links.create` (UI and CLI). `main/seed.ts`, `main/vault/shipped/.claude/skills/using-links/`: the skill.
- `plugins/links/renderer/claim.tsx`: the claim (New Link, the row card and menu, chips, `@` mentions, frontmatter rows, the tab's card) and the tree's marks. `renderer/PreviewCard.tsx`, `use-preview.ts`, `url-hover.ts` (the editor hover), `header.ts` (the tab's card).
- `plugins/links/test/`: the format and the page reading.
