---
name: theme
description: Recolour this vault's Holi app — set colours and chrome (corner radius, shadows, scrollbar, selection). Use when asked to theme, restyle, recolour, or change the look of the app for this vault. Colours and chrome only; it cannot change layout.
---

# Theme this vault

Each vault carries its own colour + chrome theme. Edit a JSON file and the running
app re-themes live — no restart. You can only change **colours and chrome**; there
is deliberately no way to move, resize, or re-space anything, so a theme can never
break the layout.

## The files

- **`.holi/theme.json`** — the vault's theme. Committed, so it travels with the
  vault and everyone who clones it sees it. This is the one to edit for a shared
  look.
- **`.holi/theme.local.json`** — a personal override, gitignored (never
  committed). If it exists, its keys win over `theme.json` **per key**, so a
  one-line local file can recolour just `primary` and inherit the rest.

Both files already exist in every vault, seeded empty (`{"dark":{},"light":{}}`)
— edit them, no need to create. Malformed JSON, unknown keys, and invalid values
are ignored (the app falls back to defaults) — so a typo is safe, but check your
work: a dropped key just won't take effect.

## Shape

Two blocks, `light` and `dark`. The app is dark today, so put your values under
`dark` (fill `light` too if you want to be ready for a future light mode). Every
value is a plain CSS value.

```json
{
  "dark": {
    "primary": "#8b5cf6",
    "primary-foreground": "#ffffff",
    "background": "oklch(0.15 0.01 285)",
    "ring": "#8b5cf6",
    "radius": "0.75rem",
    "selection": "#8b5cf6",
    "shadow-popover": "0 8px 24px rgb(0 0 0 / 0.5)"
  },
  "light": {}
}
```

## The tokens you can set

**Colours** (any CSS colour — hex `#3b82f6`, `rgb(...)`, `hsl(...)`, `oklch(...)`,
or a named colour like `transparent`):

| token | what it colours |
|-------|-----------------|
| `background` / `foreground` | app canvas + its text |
| `card` / `card-foreground` | raised card surfaces + text |
| `popover` / `popover-foreground` | menus, dropdowns, tooltips + text |
| `primary` / `primary-foreground` | the brand action colour (buttons, active states) + text on it |
| `secondary` / `secondary-foreground` | secondary surfaces + text |
| `muted` / `muted-foreground` | muted surfaces + de-emphasised text |
| `accent` / `accent-foreground` | subtle hover surface + text |
| `destructive` / `destructive-foreground` | danger actions + text |
| `border` | hairlines and dividers |
| `input` | form field borders |
| `ring` | focus rings |
| `scrollbar-thumb` / `scrollbar-thumb-hover` | the scrollbar handle |
| `selection` | highlighted (selected) text background |

**Chrome:**

| token | value | effect |
|-------|-------|--------|
| `radius` | a length (`0.5rem`, `10px`, `0`) | corner roundness everywhere |
| `shadow-popover` | a box-shadow value | elevation of menus/dropdowns/tooltips |
| `shadow-dialog` | a box-shadow value | elevation of modal dialogs |

That's the whole vocabulary. Anything else (widths, padding, positions, fonts) is
**not** themeable — by design, so the layout stays intact.

## Tips

- Change just `primary` for the biggest visual shift with the least effort:
  buttons, focus rings, active states, and (by default) the text selection all
  follow it.
- Keep enough contrast between `background` and `foreground` to stay readable.
- After saving, glance at the app — the change applies within a moment. If it
  didn't, the value was probably invalid and got dropped; fix and re-save.
