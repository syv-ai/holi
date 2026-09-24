---
name: pdf-comments
description: Read the review comments on a PDF in this vault, with who wrote each one and when. Use when a PDF has comments, highlights or notes to act on, when someone asks what reviewers said about a PDF, or when an ask quotes PDF comments.
---

# PDF comments

```sh
holi pdf comments <path>          # readable
holi pdf comments <path> --json   # the same, as data with ids and ISO timestamps
```

`<path>` is the PDF's path in the vault. It prints one block per comment thread,
in page order: the page, the kind of mark (highlight, note, strikeout, …), the
text the mark covers, the author and date, the comment, and any replies. A mark
with no comment is listed as `(no comment)`; it can still be feedback.

It reads the saved file, whichever tool wrote the comments. A mark made in Holi's
viewer in the last second or so may not be saved yet; run it again.

It only reads. It cannot reply to or resolve a comment in the PDF: to act on the
feedback, change the source (for a Typst export, the note it was made from) and
say which comments you addressed.
