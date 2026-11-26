import { describe, expect, it } from 'vitest'
import { rewriteMarkdownMoveLinks } from '../src/markdown-move-links'

describe('Markdown move targets', () => {
  it('relocates inline links/images without changing frontmatter, code or source layout', () => {
    const source =
      '\uFEFF---\r\ntitle: "[x](cover.png)"\r\n---\n![photo](../assets/a%20b.png?raw=1#part)\r\n[a](<sub/file.md> "title")\n`[x](code.md)`\n```md\n[x](example.md)\n```\r\n[web](https://example.com/a.md) [heading](#top) [root](/root.md)\n'
    expect(
      rewriteMarkdownMoveLinks(source, 'old/note.md', 'old/note.md', 'archive/deep/note.md'),
    ).toBe(
      '\uFEFF---\r\ntitle: "[x](cover.png)"\r\n---\n![photo](../../assets/a%20b.png?raw=1#part)\r\n[a](<../../old/sub/file.md> "title")\n`[x](code.md)`\n```md\n[x](example.md)\n```\r\n[web](https://example.com/a.md) [heading](#top) [root](/root.md)\n',
    )
  })

  it('updates incoming targets and self-links without redirecting unrelated notes', () => {
    const source = '[target](../old/note.md?q=1#h) ![peer](peer.png) [other](../other.md)'
    expect(rewriteMarkdownMoveLinks(source, 'notes/in.md', 'old/note.md', 'new/note.md')).toBe(
      '[target](../new/note.md?q=1#h) ![peer](peer.png) [other](../other.md)',
    )
    expect(
      rewriteMarkdownMoveLinks(
        '[self](note.md#h) [peer](peer.md)',
        'old/note.md',
        'old/note.md',
        'old/renamed.md',
      ),
    ).toBe('[self](renamed.md#h) [peer](peer.md)')
  })

  it('retains destination semantics for escaped, encoded and nested names', () => {
    const source =
      '[escaped](a\\(b\\).md) [nested](dir/a(b).md) [encoded](a%23b%3Fc.md#part) [unicode](路径.md)'
    expect(
      rewriteMarkdownMoveLinks(source, 'old/note.md', 'old/note.md', 'new/nested/note.md'),
    ).toBe(
      '[escaped](../../old/a%28b%29.md) [nested](../../old/dir/a%28b%29.md) [encoded](../../old/a%23b%3Fc.md#part) [unicode](../../old/%E8%B7%AF%E5%BE%84.md)',
    )
  })

  it('decodes Markdown entities without changing suffix spelling or encoded delimiters', () => {
    const source =
      '[amp](a&amp;b.md?x=1&amp;y=2) [hash](a&#35;part) [encoded](a%23b.md) [escaped](a\\&amp;b.md)'
    expect(rewriteMarkdownMoveLinks(source, 'old/note.md', 'old/note.md', 'new/note.md')).toBe(
      '[amp](../old/a%26b.md?x=1&amp;y=2) [hash](../old/a&#35;part) [encoded](../old/a%23b.md) [escaped](../old/a%26amp%3Bb.md)',
    )
  })

  it('leaves non-inline and unresolved paths untouched', () => {
    const source =
      '[ref][target]\n\n[target]: peer.md\n\n<a href="peer.md">html</a>\n[bad](%ZZ.md) [escape](../../../outside.md) [separator](a%2Fb.md)'
    expect(rewriteMarkdownMoveLinks(source, 'old/note.md', 'old/note.md', 'new/note.md')).toBe(
      source,
    )
  })
})
