// letter/template.typ — syv.ai branded letter (letterhead).
//
// Logo + date header, an optional recipient block, the note as the letter body,
// and a closing + sender sign-off. Brand (typography, palette) from ../_brand.
#import "../_brand/brand.typ": *

#let doc(notePath, meta: (:), assets: "") = {
  let d = meta.at("date", default: none)
  let recipient = meta.at("recipient", default: none)
  let closing = meta.at("closing", default: none)
  let sender = meta.at("sender", default: none)

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

  with-brand[
    #if recipient != none and recipient != "" {
      set par(justify: false)
      // A recipient may carry address lines separated by newlines.
      par(recipient.split("\n").join(linebreak()))
      v(1.0em)
    }
    #render-body(notePath, figures: (:))
    #if closing != none and closing != "" { v(1.5em); par(closing) }
    #if sender != none and sender != "" { v(1.6em); text(weight: 600, sender) }
  ]
}
