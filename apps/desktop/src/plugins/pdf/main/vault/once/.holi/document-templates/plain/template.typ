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

// The template's language, from `language` in its template.json (Holi passes
// it as `--input lang=…`); English when it says none.
#let lang = sys.inputs.at("lang", default: "en")

// A date in that language: "21. oktober 2026" in Danish, Typst's own
// "21 October 2026" otherwise. Typst's `display` names months in English
// whatever the language, so the Danish months are spelled out.
#let long-date(d) = {
  if lang == "da" {
    let months = ("januar", "februar", "marts", "april", "maj", "juni", "juli", "august", "september", "oktober", "november", "december")
    str(d.day()) + ". " + months.at(d.month() - 1) + " " + str(d.year())
  } else {
    d.display("[day padding:none] [month repr:long] [year]")
  }
}

#let doc(notePath, meta: (:), assets: "") = {
  set page(paper: "a4", margin: 2.5cm)
  set text(size: 11pt, lang: lang)

  // Metadata header: state each provided value cleanly, no key labels. `date`
  // arrives as a native datetime, formatted in the template's
  // language; `recipient` is shown as-is.
  // Fields the user left blank are absent from `meta`, so nothing prints.
  let lines = ()
  let d = meta.at("date", default: none)
  if d != none { lines.push(long-date(d)) }
  let r = meta.at("recipient", default: none)
  if r != none and r != "" { lines.push(r) }
  if lines.len() > 0 {
    align(right, text(size: 9pt, fill: luma(40%), lines.join(linebreak())))
    v(1em)
  }

  cmarker.render(strip-frontmatter(read(notePath)))
}
