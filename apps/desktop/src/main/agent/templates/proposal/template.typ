// proposal/template.typ — syv.ai branded proposal (tilbud).
//
// Numbered sections, logo + date in the header, page number in the footer,
// @@SIG:a|b@@ signature blocks and @@FIG:name@@ diagram tokens. The brand
// (typography, palette, tables, the markdown pipeline) lives in ../_brand;
// relative paths resolve against this file's location, so the seeded _brand
// sibling is found without the wrapper injecting any path.
#import "../_brand/brand.typ": *
#import "../_brand/figures.typ": agent-flow, custom-arkitektur

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
  with-brand(render-body(
    notePath,
    figures: (agent-flow: agent-flow, custom-arkitektur: custom-arkitektur),
  ))
}
