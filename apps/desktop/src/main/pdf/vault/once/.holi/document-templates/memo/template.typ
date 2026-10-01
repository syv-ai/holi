// memo/template.typ — syv.ai branded internal memo.
//
// A To/From/Date/Re header block under a small logo + MEMO rule, then the note
// as the body. No letterhead ceremony. Brand from ../_brand.
#import "../_brand/brand.typ": *

#let doc(notePath, meta: (:), assets: "") = {
  let d = meta.at("date", default: none)
  let to = meta.at("to", default: none)
  let from = meta.at("from", default: none)
  let re = meta.at("re", default: none)

  set page(
    paper: "a4",
    margin: (left: 2.4cm, right: 2.4cm, top: 2.4cm, bottom: 2.2cm),
    footer: {
      set text(size: 9pt, fill: muted)
      h(1fr)
      context counter(page).display("1")
    },
  )

  with-brand[
    #grid(
      columns: (auto, 1fr),
      align(left + horizon, image("../_brand/logo.png", height: 1.0cm)),
      align(right + horizon, text(size: 20pt, weight: 800, fill: ink)[MEMO]),
    )
    #v(0.4em)
    #line(length: 100%, stroke: 1pt + ink)
    #v(0.8em)

    #let dateStr = if d != none { d.display("[day] [month repr:long] [year]") } else { none }
    #let row(k, val) = if val != none and val != "" {
      grid(columns: (3.2cm, 1fr), text(weight: 700)[#k], [#val])
    }
    #row("Til", to)
    #row("Fra", from)
    #row("Dato", dateStr)
    #row("Emne", re)
    #v(0.8em)

    #render-body(notePath, figures: (:))
  ]
}
