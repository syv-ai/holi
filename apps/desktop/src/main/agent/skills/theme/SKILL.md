---
name: theme
description: Recolour this vault's Holi app — set colours and chrome (corner radius, shadows, scrollbar, selection). Use when asked to theme, restyle, recolour, or change the look of the app for this vault. Colours and chrome only; it cannot change layout.
---

# Theme this vault

Each vault carries its own colour + chrome theme. Edit a YAML file and the running
app re-themes live — no restart. You can only change **colours and chrome**; there
is deliberately no way to move, resize, or re-space anything, so a theme can never
break the layout.

## The files

- **`.holi/settings/theme.yaml`** — the vault's theme. Committed, so it travels
  with the vault and everyone who clones it sees it. This is the one to edit for
  a shared look.
- **`.holi/settings/theme.local.yaml`** — a personal override, gitignored (never
  committed). If it exists, its keys win over `theme.yaml` **per key**, so a
  one-line local file can recolour just `primary` and inherit the rest.

Both already exist in every vault. Edit them; never create them.

## Read the file — it lists every token

**The file is the vocabulary, so do not work from memory and do not guess a token
name.** Every token this vault can set is already in both files, grouped, with a
note on the ones whose name is not enough. A token this vault has not set is a
commented line:

```yaml
# The dark palette.
dark:

  # ── Brand and action: The colour this vault is, and the things you can press.
  #   The brand as a FILL, with primary-foreground on top of it.
  primary: "#8b5cf6"
  # primary-foreground:
  #   The same brand as TEXT. A fill dark enough to carry pale text is too dark to be text.
  # brand:
  # ring:
```

**Setting a token is deleting its `# `.** `primary` above is set; the three below
it are not, and Holi's own value is in force for them. Clearing one is putting
the `# ` back, or just deleting the line — the next write restores it as a
comment either way.

Two blocks, `light` and `dark`, both listing the same tokens. The app is dark
today, so put your values under `dark` unless you are asked otherwise.

A **hex value has to be quoted** — a bare `#` starts a YAML comment. Any CSS
colour works: `"#3b82f6"`, `rgb(...)`, `hsl(...)`, `oklch(...)`, or a name like
`transparent`. `radius` is a length (`0.75rem`, `10px`, `0`) and the two
`shadow-*` tokens are box-shadow values.

Malformed YAML, unknown keys and invalid values are ignored — the app falls back
to its default — so a typo is safe, but check your work: a dropped key simply
does not take effect. `divider` and `selection` are derived from other tokens by
default and want a flat colour if you set them; `color-mix(...)` is not accepted.

## The comments are generated

Holi rewrites this file whenever a setting changes, and **regenerates the group
headings, the token notes and every commented line** as it goes. That is what
keeps the list complete when Holi adds a token.

It also means **a note of your own inside a palette does not survive**. If a
colour choice needs explaining, put it in a note in the vault, not in this file.

## Tips

- Change just `primary` for the biggest shift with the least effort: buttons,
  focus rings, active states and (by default) text selection all follow it.
- Set `brand` whenever you set `primary`. They are the same colour in two roles,
  and a fill dark enough to carry pale text is too dark to BE text.
- Keep enough contrast between `background` and `foreground` to stay readable.
- After saving, glance at the app — the change applies within a moment. If it
  did not, the value was probably invalid and got dropped; fix and re-save.
