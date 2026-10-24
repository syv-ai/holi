/**
 * What a page's head says about it (docs/features/links.md). No network: the
 * pages are written here, and the fetch is a fake.
 */
import { describe, expect, it } from 'vitest'
import { fetchPreview, parseHead } from '../main/unfurl'

describe('parseHead', () => {
  it("reads a page's og tags, resolving its addresses", () => {
    const html = `<!doctype html><html><head>
      <title>Plain title</title>
      <meta property="og:title" content="The &amp; title">
      <meta property="og:description" content="  What it is.  ">
      <meta property="og:image" content="/img/card.png">
      <meta property="og:site_name" content="Example">
      <link rel="shortcut icon" href="favicon.svg">
    </head><body><meta property="og:title" content="not this"></body></html>`
    expect(parseHead(html, 'https://example.com/a/page')).toEqual({
      title: 'The & title',
      description: 'What it is.',
      image: 'https://example.com/img/card.png',
      siteName: 'Example',
      icon: 'https://example.com/a/favicon.svg',
    })
  })

  it('falls back to the title, the description and the host', () => {
    const html =
      '<head><title>\n Plain\n title </title><meta name="description" content="Desc"></head>'
    expect(parseHead(html, 'https://www.example.com/')).toEqual({
      title: 'Plain title',
      description: 'Desc',
      siteName: 'example.com',
      icon: 'https://www.example.com/favicon.ico',
    })
  })

  it('leaves out an image that is not a web address', () => {
    const html = '<meta property="og:image" content="javascript:alert(1)">'
    expect(parseHead(html, 'https://example.com/').image).toBeUndefined()
  })
})

describe('fetchPreview', () => {
  /** Every host is a public one, unless named here. */
  const resolve = async (host: string): Promise<string[]> =>
    host === 'router.example' ? ['192.168.1.1'] : ['93.184.216.34']
  const page = (body: string, type = 'text/html; charset=utf-8', status = 200): typeof fetch =>
    (async () => new Response(body, { status, headers: { 'content-type': type } })) as typeof fetch
  const bare = { url: 'https://example.com/x', siteName: 'example.com' }

  it('reads an HTML page', async () => {
    const { preview, keep } = await fetchPreview(
      'https://example.com/',
      page('<head><title>Hi</title></head>'),
      resolve,
    )
    expect(preview.title).toBe('Hi')
    expect(preview.url).toBe('https://example.com/')
    expect(keep).toBe(true)
  })

  it('is the address alone for what it cannot read, and never throws', async () => {
    expect(await fetchPreview(bare.url, page('%PDF', 'application/pdf'), resolve)).toEqual({
      preview: bare,
      keep: true,
    })
    // A login wall stays one; the site's own error may pass.
    expect((await fetchPreview(bare.url, page('', 'text/html', 401), resolve)).keep).toBe(true)
    expect((await fetchPreview(bare.url, page('', 'text/html', 503), resolve)).keep).toBe(false)
    const refused = (async () => {
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    expect(await fetchPreview(bare.url, refused, resolve)).toEqual({ preview: bare, keep: false })
  })

  it('never fetches what is not a web address, or is inside this network', async () => {
    const asked: string[] = []
    const spy = (async (url: string) => {
      asked.push(url)
      return new Response('')
    }) as unknown as typeof fetch
    await fetchPreview('file:///etc/passwd', spy, resolve)
    await fetchPreview('http://127.0.0.1:8080/', spy, resolve)
    await fetchPreview('http://169.254.169.254/latest/meta-data/', spy, resolve)
    await fetchPreview('http://[::1]/', spy, resolve)
    await fetchPreview('http://router.example/reboot', spy, resolve)
    expect(asked).toEqual([])
  })

  it('follows a redirect by hand, held to the same rules, and only so far', async () => {
    const hops = (to: (n: number) => string): typeof fetch => {
      let n = 0
      return (async () =>
        new Response(null, { status: 302, headers: { location: to(++n) } })) as typeof fetch
    }
    // Into this network: refused at the hop, not fetched.
    const inward = await fetchPreview(
      'https://example.com/',
      hops(() => 'http://127.0.0.1/admin'),
      resolve,
    )
    expect(inward.preview.title).toBeUndefined()
    // Forever: given up after five.
    let asked = 0
    const forever = (async () => {
      asked++
      return new Response(null, { status: 302, headers: { location: `/again${asked}` } })
    }) as typeof fetch
    await fetchPreview('https://example.com/', forever, resolve)
    expect(asked).toBe(6)
  })
})
