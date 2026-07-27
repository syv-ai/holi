---
name: md-to-pdf
description: Render a vault note to a PDF using Holi's bundled Typst engine and the vault's templates. Use when asked to export, print, or make a PDF of a note.
---

# Render a note to PDF

Holi ships a Typst engine; its absolute path is in the `$TYPST_BIN` environment
variable. If `$TYPST_BIN` is empty, Typst is not installed yet — tell the user to
run **Convert to PDF** once from a note's ⋯ menu (that installs it), then retry.

## Templates

A template is a folder under `.holi/templates/<slug>/`:

- `template.typ` — exports `doc(notePath, meta, assets)`.
- `template.json` — a manifest declaring the fields the template accepts.

List them with `ls .holi/templates/`. Every vault ships the `plain` template.

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
   #import "/ABS/VAULT/.holi/templates/plain/template.typ": doc
   #doc(
     "/ABS/VAULT/notes/the-note.md",
     meta: (recipient: "Acme Inc"),
     assets: "/ABS/VAULT/.holi/templates/plain/assets",
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
