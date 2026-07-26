// Plain — a clean, unbranded document layout. The copy-to-customize starter
// every vault carries. It reads the markdown note, strips a leading YAML
// frontmatter block, and renders the body with cmarker (Typst reads markdown
// through this package). No bundled fonts — it rides Typst's defaults so it
// stays small. `assets` is accepted for a uniform template contract but unused
// here; `meta` carries the declared fields as native Typst values.
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

  // Metadata header: state each provided value cleanly, no key labels. `date`
  // arrives as a native datetime, formatted here; `recipient` is shown as-is.
  // Fields the user left blank are absent from `meta`, so nothing prints.
  let lines = ()
  let d = meta.at("date", default: none)
  if d != none { lines.push(d.display("[day] [month repr:long] [year]")) }
  let r = meta.at("recipient", default: none)
  if r != none and r != "" { lines.push(r) }
  if lines.len() > 0 {
    align(right, text(size: 9pt, fill: luma(40%), lines.join(linebreak())))
    v(1em)
  }

  cmarker.render(strip-frontmatter(read(notePath)))
}
