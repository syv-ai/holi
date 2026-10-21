---
name: show-the-user
description: Open a file in a Holi tab for the user with `holi docs open`, or see how it renders with `holi docs screenshot`. Use when you want the user to look at a note, task, PDF or app you wrote or found, rather than telling them where it is, and when you need to check how a note's diagram, a table or an app you built actually looks.
---

# Showing the user a file

```sh
holi docs open <path>         # opens it in a Holi tab, beside this conversation
holi docs screenshot <path>   # opens it too, and prints the path of a PNG of its tab
```

- **Open it rather than name it.** When the user should look at a note, a task,
  a PDF or an app, open it: a path in a reply is something they have to go and
  find.
- **Look before you say it works.** A screenshot is the tab as the user sees
  it. Read the PNG it prints to check a diagram, a table or an app you built.
  It does not move the user's caret.
- Both take a vault path. Neither opens this machine's state under
  `.holi/state/` or a secret file such as `.env`.
- Both need Holi to have this vault open. Outside it, say where the file is.
