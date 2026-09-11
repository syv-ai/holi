---
name: md-to-pdf
description: Render a vault note to a PDF using Holi's bundled Typst engine and the vault's templates. Use when asked to export, print, or make a PDF of a note.
---

# Render a note to PDF

Holi ships a Typst engine; its absolute path is in the `$TYPST_BIN` environment
variable. If `$TYPST_BIN` is empty, Typst is not installed yet — tell the user to
run **Convert to PDF** once from a note's ⋯ menu (that installs it), then retry.

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

Each `template.json` field has a `key`, `label`, `type`, and optional `required`,
`default`, and `options`. The six field types and the Typst value each becomes:

| type       | Typst value example                        |
|------------|--------------------------------------------|
| `text`     | `"Acme Inc"`                               |
| `textarea` | `"Line one\nLine two"`                     |
| `select`   | `"one of the manifest's options"`          |
| `number`   | `42`                                       |
| `date`     | `datetime(year: 2026, month: 7, day: 27)`  |
| `checkbox` | `true` / `false`                           |

Omit an optional field to leave it unset — the template reads
`meta.at(key, default: none)`.

## Recipe

1. Choose a template (default `plain`) and read its `template.json` for the fields.
2. Write a wrapper `.typ` in a scratch dir **outside the vault** (PDFs are outputs,
   never committed). Use ABSOLUTE paths so `--root /` can read everything:

   ```typ
   #import "/ABS/VAULT/.holi/document-templates/plain/template.typ": doc
   #doc(
     "/ABS/VAULT/notes/the-note.md",
     meta: (recipient: "Acme Inc"),
     assets: "/ABS/VAULT/.holi/document-templates/plain/assets",
   )
   ```

3. Compile with the bundled engine:

   ```sh
   DIR=$(mktemp -d)
   # …write "$DIR/wrapper.typ" per above…
   "$TYPST_BIN" compile "$DIR/wrapper.typ" "$DIR/the-note.pdf" --root /
   ```

4. Report the absolute path of the resulting PDF to the user. Do not move it into
   the vault.
