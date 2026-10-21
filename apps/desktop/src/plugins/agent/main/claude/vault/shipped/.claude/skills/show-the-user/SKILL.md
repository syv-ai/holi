---
name: show-the-user
description: Show the user a file in Holi, or see what they see. Use when the user should look at something, or to check how it renders.
---

- `holi docs open <path>` shows a file to the person, in a Holi tab.
- `holi docs screenshot <path>` captures what they see: it prints the absolute path of a PNG of that tab, in the OS temp directory
  rather than the vault. Read it from there; never copy it into the vault.
