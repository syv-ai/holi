// brand.typ — syv.ai document brand foundation.
//
// Ported from 1brain's `syvai-tilbud.typ`. Shared by the proposal and report
// templates: the palette, the Raleway typography + heading/table styling (as
// `with-brand`, which WRAPS a document body so its set/show rules apply to it —
// a bare setup function would not, since set/show only affect content placed
// after them in the same scope), the signature helpers, and `render-body` — the
// markdown pipeline (frontmatter/hr/heading-number strip + @@FIG@@/@@SIG@@ tokens).

#import "@preview/cmarker:0.1.6"

// ---- Palette ----
#let ink = rgb("111111")
#let muted = rgb("555555")
#let rule-grey = rgb("595959")
#let link-blue = rgb("1155CC")
#let accent = rgb("EFEEEA") // light grey header bar
#let accent-tint = rgb("F7F6F3") // tinted label column
#let col-sep = rgb("DBDBDB") // fine vertical separators

// ---- Signature block (contracts): a write-on line with a small label under it.
#let sig-felt(label) = {
  v(2.2em)
  line(length: 100%, stroke: 0.6pt + ink)
  v(0.35em)
  text(size: 9pt, fill: muted, label)
}

// Two+ columns, one per party, Navn/Titel/Dato stacked. Used via @@SIG:a|b@@.
#let underskrifter(parter) = {
  v(1.0em)
  grid(
    columns: parter.map(_ => 1fr),
    column-gutter: 1.8cm,
    ..parter.map(p => {
      text(weight: 700, size: 11pt)[For #p:]
      sig-felt("Navn")
      sig-felt("Titel")
      sig-felt("Dato")
    }),
  )
}

// ---- Brand typography/tables, applied to `body` ----
// Call as `with-brand(content)`; the set/show rules below wrap `content`.
#let with-brand(body) = {
  set text(font: "Raleway", size: 10.5pt, fill: ink, lang: "da")
  set par(justify: true, leading: 0.85em, spacing: 1.15em, first-line-indent: 0pt)
  set list(marker: text(fill: ink, size: 1.35em, baseline: 0.06em)[•], indent: 0.4em, body-indent: 0.5em)
  set enum(indent: 0.4em, body-indent: 0.5em)

  show link: set text(fill: link-blue)
  // Clause paragraphs ("5.1 ...") arrive as blockquotes: plain indent, no bar.
  show quote.where(block: true): it => pad(left: 0.7em, it.body)

  set heading(numbering: none)
  let seccount = counter("sektion")
  // Level 1 = document title.
  show heading.where(level: 1): it => {
    set text(size: 28pt, weight: 800, fill: ink)
    set par(justify: false, leading: 0.3em)
    block(above: 0.2em, below: 1.2em, it.body)
  }
  // Level 2 = numbered sections (1., 2., ...).
  show heading.where(level: 2): it => {
    seccount.step()
    set text(size: 22pt, weight: 800, fill: ink)
    set par(justify: false, leading: 0.3em)
    block(above: 1.5em, below: 1.0em)[
      #context seccount.display("1"). #h(0.3em) #it.body
    ]
  }
  // Level 3 = subheadings.
  show heading.where(level: 3): it => {
    set text(size: 13pt, weight: 700, fill: ink)
    block(above: 1.15em, below: 0.85em, it.body)
  }

  // ---- Tables: light header bar, hairline rows, thin column separators ----
  set table(
    inset: (x: 11pt, y: 8.5pt),
    align: left + horizon,
    stroke: (x, y) => (
      left: if x > 0 and y > 0 { 0.5pt + col-sep } else { 0pt },
      top: if y == 0 { 1pt + ink } else { 0pt },
      bottom: if y == 0 { 1pt + ink } else { 0.5pt + rgb("E6E6E6") },
    ),
    fill: (x, y) => {
      if y == 0 { accent } else if x == 0 { accent-tint } else { white }
    },
  )
  show table.cell: set par(justify: false, leading: 0.55em)
  show table.cell.where(y: 0): set text(weight: 700, fill: ink, size: 10pt)
  show table.cell.where(x: 0): set text(weight: 700, fill: ink)

  body
}

// ---- Markdown → content pipeline ----
// Drop a leading `---\n … \n---\n` YAML block, if present. Pure string ops.
#let strip-frontmatter(s) = {
  if s.starts-with("---\n") {
    let rest = s.slice(4)
    if rest.contains(regex("\n---[ \t]*\n")) {
      let idx = rest.position(regex("\n---[ \t]*\n"))
      return rest.slice(idx).replace(regex("^\n---[ \t]*\n"), "")
    }
  }
  s
}

// Read the note and render it. Order matters:
//   1. strip frontmatter FIRST — its `---` delimiters would be eaten by the
//      horizontal-rule strip below and leak the YAML as body text;
//   2. strip `---` horizontal rules (visual separators in markdown);
//   3. strip manual heading numbers ("## 1. Foo" -> "## Foo") so the level-2
//      show-rule's own numbering does not double up;
//   4. split on @@FIG:name@@ / @@SIG:a|b@@ and insert native Typst blocks.
#let render-body(md-file, figures: (:)) = {
  let src = strip-frontmatter(read(md-file))
  src = src.replace(regex("(?m)^[-*_]{3,}[ \t]*$"), "")
  src = src.replace(regex("(?m)^(#{2,3}) \d+(\.\d+)*\.? "), m => m.captures.at(0) + " ")
  let prev = 0
  for m in src.matches(regex("@@(FIG|SIG):([^@]+)@@")) {
    cmarker.render(src.slice(prev, m.start), smart-punctuation: true)
    let kind = m.captures.at(0)
    let arg = m.captures.at(1)
    if kind == "FIG" {
      let f = figures.at(arg, default: none)
      if f != none { f() }
    } else {
      underskrifter(arg.split("|"))
    }
    prev = m.end
  }
  cmarker.render(src.slice(prev), smart-punctuation: true)
}
