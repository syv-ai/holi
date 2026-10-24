---
name: using-links
description: Save, find and describe web links in this vault. A link is a link.<name>.md file holding a url, so a big Google Slides deck or any page is kept as its address, never downloaded. Use when asked to save, bookmark, keep, file or collect a link or URL, to find a saved link, or when writing a link file by hand.
---

# Links in this vault

**A saved link is a file**, `link.<name>.md`, anywhere in the vault. It holds the
address, never the page: a 189-slide deck stays in Google Slides, and the vault keeps
where it is. Holi shows a preview of the page (its image, title and description) when
someone hovers the file in the tree, a `[[link]]` to it, or any web address in a note,
and at the top of the file when it is open. That preview is fetched live; nothing of it
is stored.

## Saving one

The easiest way is the command, which reads the page's title once and writes the file
named after it, with an empty body:

```sh
holi links create "https://example.com/report" [folder]
```

It prints the new file's path. If the page needs a login (most Google Docs, Slides
and Drive links), it cannot read the title, and names the file after the address
instead: rename the file to what the user calls it, and write what it is in the body.

Or write the file yourself:

```markdown
---
url: https://docs.google.com/presentation/d/1hX.../edit
tags: [strategy, q3]
---

The 189-slide deck from the offsite. Section 4 has the pricing model.
```

- **The name is the title.** `link.Q3 strategy deck.md` is "Q3 strategy deck". Use the
  name the user would say, with spaces and capitals as they write it. There is no
  `title:` key.
- **`url` is required**, and must be an `http://` or `https://` address. A file without
  one shows as broken.
- `tags` is optional, a list like a note's.
- **The body is what the link is, in the user's words**: why it was saved, what is
  where in it, who sent it. Write it when the user tells you; otherwise leave it empty.
  Never copy the page's own description or text into it: the preview already shows it.
- Do not add other keys for what the page says (an image, a site name, a description
  copied from the page): the preview reads those fresh, and a copy would go stale.

## Finding them

Every link file matches `**/link.*.md`. Search their `url` lines to find one by address,
and their names and bodies to find one by what it is. Link to one from a note with
`[[link.Q3 strategy deck.md]]` (the whole path, `.md` included, as every wiki-link here).

## Changing one

Edit the file: change `url` to move the link, rename the file to retitle it. Ask for the
rename (or use Holi's rename) rather than `mv`, so the wiki-links to it follow.
