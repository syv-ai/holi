import { describe, expect, it } from 'vitest'
import { inspectMdxCssResources } from '../src/main/mdx-css-resources'

describe('inspectMdxCssResources', () => {
  it('discovers imports in nested blocks and mixed font, image and media resources', () => {
    const result = inspectMdxCssResources(`@import "./base.css" layer(base);
@media screen {
  @import url("./nested.css");
  @font-face { src: url('./font.woff2') format('woff2'); }
  .hero { background: image-set(url(./hero.png) 1x, url('./hero@2x.png') 2x); }
  video { --poster: url(./clip.webm); }
}`)
    expect(result.diagnostics).toEqual([])
    expect(result.dependencies).toEqual([
      { specifier: './base.css', kind: 'css', line: 1, column: 9 },
      { specifier: './nested.css', kind: 'css', line: 3, column: 11 },
      { specifier: './font.woff2', kind: 'asset', line: 4, column: 21 },
      { specifier: './hero.png', kind: 'asset', line: 5, column: 33 },
      { specifier: './hero@2x.png', kind: 'asset', line: 5, column: 53 },
      { specifier: './clip.webm', kind: 'asset', line: 6, column: 21 },
    ])
  })

  it('decodes CSS escapes while ignoring comments and ordinary strings', () => {
    const result = inspectMdxCssResources(String.raw`/* @import 'fake.css'; url(fake.png) */
@import './b\61 se.css';
a { content: 'url(not-an-edge.png)'; /* url(ignored) */
  background: url(./im\61 ge\(1\).png), URL("./quoted\"name.png");
  --font: u\72l("./font.woff2");
}`)
    expect(result.diagnostics).toEqual([])
    expect(result.dependencies.map(({ specifier, kind }) => ({ specifier, kind }))).toEqual([
      { specifier: './base.css', kind: 'css' },
      { specifier: './image(1).png', kind: 'asset' },
      { specifier: './quoted"name.png', kind: 'asset' },
      { specifier: './font.woff2', kind: 'asset' },
    ])
  })

  it.each([
    '@import var(--theme);',
    '@import url(var(--theme));',
    'a { background: url(var(--image)); }',
    'a { background: url("./image.png" extra); }',
    'a { background: url(./bad name.png); }',
    'a { background: url("./missing.png"; }',
    'a { background: url("unterminated); }',
    'a { background: url(); }',
    'a { background: url(data:image/png;base64,AAAA); }',
    'a { background: url(blob:https://example.com/id); }',
    'a { background: url(#filter); }',
  ])('rejects unsupported or malformed resource syntax without partial edges: %s', (css) => {
    const result = inspectMdxCssResources(`@import './valid.css';\n${css}`)
    expect(result.dependencies).toEqual([])
    expect(result.diagnostics.length).toBeGreaterThan(0)
    expect(result.diagnostics[0]).toMatchObject({ line: 2 })
    expect(result.diagnostics[0].column).toBeGreaterThan(0)
  })

  it.each([
    'image-set',
    '-webkit-image-set',
    String.raw`im\61 ge-set`,
    String.raw`-webkit-im\61 ge-set`,
  ])('discovers string candidates in %s without treating MIME hints as resources', (name) => {
    const result = inspectMdxCssResources(
      `a { background: ${name}("https://other.example/photo.png" 1x type("image/png"), url(./large.png) 2x) }`,
    )
    expect(result.diagnostics).toEqual([])
    expect(result.dependencies.map(({ specifier, kind }) => ({ specifier, kind }))).toEqual([
      { specifier: 'https://other.example/photo.png', kind: 'asset' },
      { specifier: './large.png', kind: 'asset' },
    ])
    const invalid = inspectMdxCssResources(
      `@import './valid.css'; a { background: ${name}("data:image/png;base64,AAAA" 1x) }`,
    )
    expect(invalid.diagnostics.length).toBeGreaterThan(0)
    expect(invalid.dependencies).toEqual([])
  })

  it('accepts ordinary CSS without resources and preserves duplicate edges', () => {
    expect(inspectMdxCssResources('a { color: var(--color); content: "hello" }')).toEqual({
      diagnostics: [],
      dependencies: [],
    })
    const result = inspectMdxCssResources('a { background: url(x.png), url(x.png) }')
    expect(result.diagnostics).toEqual([])
    expect(result.dependencies.map((edge) => edge.specifier)).toEqual(['x.png', 'x.png'])
  })

  it.each([
    '/*' + 'x'.repeat(300_000) + '*/',
    Array.from({ length: 100 }, (_, i) => `@import './${i}.css';`).join('\n'),
    'a { background: url("' + 'x'.repeat(5000) + '"); }',
    'a { color: ' + 'f('.repeat(200) + 'red' + ')'.repeat(200) + '; }',
    'a { color: ' + 'red '.repeat(12_000) + '; }',
  ])('fails closed when source, edges, specifiers, nesting or work exceed bounds', (css) => {
    const result = inspectMdxCssResources(css)
    expect(result.dependencies).toEqual([])
    expect(result.diagnostics.length).toBeGreaterThan(0)
    expect(result.diagnostics.length).toBeLessThanOrEqual(32)
  })
})
