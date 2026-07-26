// Plain — a clean, unbranded document layout. The copy-to-customize starter
// every vault carries. It reads the markdown note, strips a leading YAML
// frontmatter block, and renders the body with cmarker (Typst reads markdown
// through this package). No bundled fonts — it rides Typst's defaults so it
// stays small. `assets` is accepted for a uniform template contract but unused
// here (Plain ships no assets); `meta` carries the two declared fields.
#import "@preview/cmarker:0.1.6"

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

#let doc(notePath, meta: (:), assets: "") = {
  set page(paper: "a4", margin: 2.5cm)
  set text(size: 11pt)

  // Optional metadata header. Plain declares `date` + `recipient` in
  // template.json; show each only when the user filled it, so an empty meta
  // renders nothing and Plain stays clean. Keys mirror template.json's fields.
  let lines = ()
  if meta.at("date", default: "") != "" { lines.push([Date: #meta.at("date")]) }
  if meta.at("recipient", default: "") != "" { lines.push([Recipient: #meta.at("recipient")]) }
  if lines.len() > 0 {
    align(right, text(size: 9pt, fill: luma(40%), lines.join(linebreak())))
    v(1em)
  }

  cmarker.render(strip-frontmatter(read(notePath)))
}
