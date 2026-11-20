// report/template.typ — syv.ai branded long-form report / whitepaper.
//
// A distinct layout on the shared brand: a cover/title page, a table of
// contents, and a running header on the body pages. No signature tokens.
// Brand (typography, palette, tables, the markdown pipeline) lives in ../_brand.
#import "../_brand/brand.typ": *

#let doc(notePath, meta: (:), assets: "") = {
  let title = meta.at("title", default: none)
  let subtitle = meta.at("subtitle", default: none)
  let d = meta.at("date", default: none)

  set page(paper: "a4", margin: (left: 2.4cm, right: 2.4cm, top: 3.0cm, bottom: 2.2cm))

  // ---- Cover page (no header/footer) ----
  with-brand[
    #v(1fr)
    #align(center)[
      #image("../_brand/logo.png", height: 1.6cm)
      #v(1.2cm)
      #if title != none { text(size: 30pt, weight: 800, fill: ink)[#title] }
      #if subtitle != none { v(0.4cm); text(size: 15pt, fill: muted)[#subtitle] }
      #if d != none { v(0.8cm); text(size: 11pt, fill: muted)[#d.display("[day] [month repr:long] [year]")] }
    ]
    #v(2fr)
  ]
  pagebreak()

  // ---- Body pages: running header (logo + title) + page number ----
  set page(
    header: {
      set text(size: 9pt, fill: muted)
      grid(
        columns: (1fr, 1fr),
        align(left + horizon, image("../_brand/logo.png", height: 0.8cm)),
        align(right + horizon, if title != none { title } else { [] }),
      )
      v(-0.1cm)
    },
    footer: {
      set text(size: 9pt, fill: muted)
      h(1fr)
      context counter(page).display("1")
    },
  )

  with-brand[
    #outline(title: [Indhold], depth: 2)
    #v(0.6cm)
    #render-body(notePath, figures: (:))
  ]
}
