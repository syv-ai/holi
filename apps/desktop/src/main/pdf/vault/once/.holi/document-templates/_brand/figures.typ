// syvai-figurer.typ — diagrammer i syv.ai-stil (monokrom, Raleway)
// Bruges via cmarker scope og indlejres i markdown med:
//   <!-- raw-typst #agent-flow() -->
//   <!-- raw-typst #custom-arkitektur() -->

#let ink = rgb("111111")
#let subink = rgb("555555")
#let boxfill = luma(245)
#let boxstroke = 0.7pt + rgb("2B2B2B")

// En node/boks med titel og valgfri undertekst
#let node(title, sub: none, w: 100%, fill: boxfill) = box(
  width: w,
  inset: (x: 9pt, y: 7pt),
  radius: 3pt,
  fill: fill,
  stroke: boxstroke,
)[
  #set align(center)
  #set par(justify: false, leading: 0.45em)
  #text(weight: 700, size: 9.5pt, fill: ink)[#title]
  #if sub != none {
    linebreak()
    text(size: 8pt, fill: subink)[#sub]
  }
]

#let arrow = align(center, text(size: 11pt, fill: ink)[#sym.arrow.b])

// ---- Diagram 1: agentens flow på en email ----
#let agent-flow() = block(width: 100%, above: 1.1em, below: 1.2em)[
  #set text(font: "Raleway")
  #align(center, box(width: 82%)[
    #stack(
      spacing: 6pt,
      node([Indkommende email], w: 68%),
      arrow,
      node([Klassificér], sub: [kategori · prioritet · konfidens], w: 68%),
      arrow,
      node([Opslag via integrationer], sub: [ordre · faktura · kontrakt · produktdata], w: 82%),
      arrow,
      node([Ræsonnér over sagen], w: 68%),
      arrow,
      grid(
        columns: (1fr, 1fr),
        column-gutter: 10pt,
        node([Svarudkast], sub: [medarbejder godkender og sender]),
        node([Flag til menneske], sub: [lav konfidens · manglende data · følsom], fill: white),
      ),
    )
  ])
]

// ---- Diagram 2: custom stand-alone arkitektur ----
#let custom-arkitektur() = block(width: 100%, above: 1.1em, below: 1.2em)[
  #set text(font: "Raleway")
  #align(center, box(width: 92%)[
    #stack(
      spacing: 6pt,
      node([Medarbejder · delt postkasse], w: 58%),
      arrow,
      box(
        width: 100%,
        inset: (x: 10pt, top: 8pt, bottom: 11pt),
        radius: 5pt,
        stroke: (paint: rgb("2B2B2B"), thickness: 0.7pt, dash: "dashed"),
      )[
        #align(left, text(size: 7.5pt, weight: 700, fill: subink, tracking: 0.6pt)[HETZNER · EU (TYSKLAND)])
        #v(5pt)
        #stack(
          spacing: 6pt,
          node([Frontend — React], sub: [godkendelse · dashboard · kørselslog]),
          arrow,
          node([Backend — Python / FastAPI], sub: [orkestrering · klassificering · routing · svargenerering]),
          arrow,
          grid(
            columns: (1fr, 1fr, 1fr),
            column-gutter: 8pt,
            node([Integrationer], sub: [ERP · portal]),
            node([LLM-inferens], sub: [EU · ZDR]),
            node([Data], sub: [PostgreSQL · vektor-db]),
          ),
        )
      ],
    )
  ])
]
