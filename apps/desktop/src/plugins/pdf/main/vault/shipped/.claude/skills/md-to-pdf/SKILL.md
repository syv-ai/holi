---
name: md-to-pdf
description: Render a vault note to a PDF using Holi's bundled Typst engine and the vault's templates. Use when asked to export, print, or make a PDF of a note.
---

# Render a note to PDF

`holi pdf render <note> [<template>]` renders a vault note through one of the
vault's Typst templates, the same way Holi's own Convert to PDF does: wiki-links
read as their text, and a ```` ```mermaid ```` block comes out as its diagram. It
prints where the PDF went and how big it is, and a line for anything that did
not come out as written (a diagram mermaid could not draw shows as code). If
the command fails, tell the user what it printed.

## Templates

A template is a folder under `.holi/document-templates/<slug>/`:

- `template.typ` — exports `doc(notePath, meta, assets)`.
- `template.json` — a manifest declaring the fields the template accepts.

List them with `ls .holi/document-templates/`, and read a template's
`template.json` for the fields it takes. Every vault ships six:

- `plain` — a clean, unbranded layout.
- `proposal` — the branded syv.ai proposal (tilbud): Raleway, numbered sections, logo + date
  header. Supports two markdown tokens, each on its own line:
  - `@@SIG:syv.ai ApS|ACME A/S@@` — a signature block, one column per `|`-separated party.
  - `@@FIG:agent-flow@@` / `@@FIG:custom-arkitektur@@` — an embedded syv architecture diagram.
- `report` — a branded long-form report/whitepaper: cover page, table of contents, running header.
  Fields: `title`, `subtitle`, `date`.
- `letter` — a branded letter: letterhead, recipient block, closing + signature. Fields:
  `recipient`, `date`, `closing`, `sender`.
- `memo` — a branded internal memo: a To/From/Date/Re header, no letterhead. Fields: `to`, `from`,
  `re`, `date`.
- `contract` — a branded contract (kontrakt): like `proposal`, plus automatic indentation of
  numbered clause paragraphs (`5.1 …`, `7.2.1 …`) and `@@SIG:a|b@@` signature blocks. Field: `date`.

(`_brand/` holds the shared fonts/logo/module the branded templates import — not a template itself.)

A `template.json` may set `language` (`"da"`, `"en"`): the language the
template writes its dates and its own labels in (Contents, To/From, the
signature lines). Only `da` and `en` have their own words; any other code
sets the text language but writes English labels and dates. The branded
templates are Danish and `plain` is English until that key says otherwise.
Change it in the manifest when a user wants a template in another language;
there is no flag for it. Field defaults are manifest text too: switching the
letter to `en` also means changing its `closing` default ("Med venlig hilsen").

Each `template.json` field has a `key`, `label`, `type`, and optional `required`,
`default`, and `options`. Give a field as `--<key> <value>`. A field you leave
out takes the note's frontmatter value for the same key, else its `default`
(a `date` defaults to today). A field the template does not declare is refused,
and so is a render missing a required one; the error names them.

| type       | value to give                     |
|------------|-----------------------------------|
| `text`     | `--recipient "Acme Inc"`          |
| `textarea` | the text, with real line breaks   |
| `select`   | one of the manifest's `options`   |
| `number`   | `--amount 42`                     |
| `date`     | `--date 2026-07-27`               |
| `checkbox` | `--signed true` or `false`        |

## Recipe

1. Choose a template (default `plain`) and read its `template.json` for the fields.
2. Render it:

   ```sh
   holi pdf render notes/the-note.md proposal --date 2026-07-27
   ```

   Without `--out` the PDF goes next to the note (`notes/the-note.pdf`). `--out`
   takes a path ending in `.pdf`, absolute or relative to the vault root.
3. Tell the user where it is.

`holi pdf typst` prints the path of the Typst engine Holi uses, downloading it
first if this machine does not have it yet, for anything `holi pdf render`
does not cover.

**Where the PDF goes.** In the vault, next to the note (`notes/the-note.pdf` for
`notes/the-note.md`), the same place Holi's own Convert to PDF offers. There it
can be read and commented on in Holi (the pdf-comments skill reads those comments
back), and it is committed and synced like any file. Leave it outside the vault
when the user asks, or when it comes out large (over about 10 MB, usually from
images): a repository keeps every version of a binary forever, so say how big it
is and ask before moving one that size in. When a note carries large images,
render it outside the vault first (`--out "$(mktemp -d)/the-note.pdf"`), check
the size it prints, and move it in only once that is settled.
