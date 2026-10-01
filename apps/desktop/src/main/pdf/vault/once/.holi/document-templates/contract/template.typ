// contract/template.typ — syv.ai branded contract (kontrakt).
//
// Like the proposal (Raleway, numbered sections, logo + date header, page
// footer, @@SIG:a|b@@ signature blocks), plus automatic indentation of numbered
// clause paragraphs ("5.1 …"). Brand from ../_brand.
#import "../_brand/brand.typ": *

#let doc(notePath, meta: (:), assets: "") = {
  let d = meta.at("date", default: none)
  set page(
    paper: "a4",
    margin: (left: 2.4cm, right: 2.4cm, top: 3.0cm, bottom: 2.2cm),
    header: {
      set text(size: 9.5pt, fill: muted)
      grid(
        columns: (1fr, 1fr),
        align(left + horizon, image("../_brand/logo.png", height: 1.25cm)),
        align(right + horizon, if d != none { d.display("[day] [month repr:long] [year]") } else { [] }),
      )
      v(-0.1cm)
    },
    footer: {
      set text(size: 9pt, fill: muted)
      h(1fr)
      context counter(page).display("1")
    },
  )
  with-brand(render-body(notePath, figures: (:), clauses: true))
}
