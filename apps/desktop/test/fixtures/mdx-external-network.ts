import { Resolver } from 'node:dns/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:https'
import { connect } from 'node:net'
import tls from 'node:tls'
import { vi } from 'vitest'

// Public test fixture, valid only for the reserved names one.example and two.example.
const key = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIFbtFoP/7xss62YuffZkAvn8+1jm0FFte4BkcJHb2csJoAoGCCqGSM49
AwEHoUQDQgAEkRXrvSG6dtk5PvhH83B7A4v1gEsMaY8hWhT8QamyRMMM8GVw6otU
BbznjRXHeAwJ8up9RufaieRZXsD/P5oTcQ==
-----END EC PRIVATE KEY-----`
const cert = `-----BEGIN CERTIFICATE-----
MIIBmTCCAT+gAwIBAgIUQZtLp4oDUk+bjK1296/7FehGpjswCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLb25lLmV4YW1wbGUwIBcNMjAwMTAxMDAwMDAwWhgPMjEyMDAx
MDEwMDAwMDBaMBYxFDASBgNVBAMMC29uZS5leGFtcGxlMFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAEkRXrvSG6dtk5PvhH83B7A4v1gEsMaY8hWhT8QamyRMMM8GVw
6otUBbznjRXHeAwJ8up9RufaieRZXsD/P5oTcaNpMGcwHQYDVR0OBBYEFB8YkXjZ
pVmCONZBKYHteCFaxXZjMCMGA1UdEQQcMBqCC29uZS5leGFtcGxlggt0d28uZXhh
bXBsZTAMBgNVHRMBAf8EAjAAMBMGA1UdJQQMMAoGCCsGAQUFBwMBMAoGCCqGSM49
BAMCA0gAMEUCIDXb+CajVPWP/QwXm0ZUU2brUZMLtY94EqKHuI3NRmSrAiEA8K6d
a2l11piAxwsSy2hOah7eWqscrFppzWf8e8CLm48=
-----END CERTIFICATE-----`

const source = 'export default 42\n'
const v4 = '93.184.216.34'

export async function createMdxExternalNetworkFixture() {
  const dns4 = vi.spyOn(Resolver.prototype, 'resolve4').mockResolvedValue([v4])
  const dns6 = vi.spyOn(Resolver.prototype, 'resolve6').mockRejectedValue({ code: 'ENODATA' })
  const requests: IncomingMessage[] = []
  const names: string[] = []
  const dials: (string | undefined)[] = []
  const routes: {
    respond(req: IncomingMessage, res: ServerResponse): void
    handshake(): void
    // Null leaves the real loopback address in place to model a mismatched peer.
    peerAddress: ((dial: string | undefined) => string | undefined) | null
  } = {
    respond: (_, res) => {
      res.end(source)
    },
    handshake: () => {},
    peerAddress: (dial) => dial,
  }
  const context = tls.createSecureContext({ key, cert })
  const server = createServer(
    {
      key,
      cert,
      SNICallback: (name, done) => {
        names.push(name)
        routes.handshake()
        done(null, context)
      },
    },
    (req, res) => {
      requests.push(req)
      res.setHeader('Content-Type', 'text/javascript')
      routes.respond(req, res)
    },
  )
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject).listen(0, '127.0.0.1', resolve)
  })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('HTTPS fixture has no TCP address')
  const tlsConnect = tls.connect
  // This is a unit network adapter, not public-network or native acceptance evidence.
  // Simulate DNS, the TCP route and the client socket's peer metadata. Node still does
  // the real TLS handshake, certificate and SNI checks, and HTTP over local TCP/TLS.
  const dial = vi
    .spyOn(tls, 'connect')
    .mockImplementation((options: tls.ConnectionOptions | number) => {
      if (typeof options !== 'object') throw new Error('Expected HTTPS connection options')
      dials.push(options.host)
      const socket = tlsConnect({ ...options, ca: cert, socket: connect(addr.port, '127.0.0.1') })
      const reportPeer = routes.peerAddress
      if (reportPeer) {
        socket.once('secureConnect', () => {
          Object.defineProperty(socket, 'remoteAddress', { value: reportPeer(options.host) })
        })
      }
      return socket
    })
  return {
    entryURL: 'https://one.example/index.js',
    dns4,
    dns6,
    requests,
    names,
    dials,
    routes,
    async close() {
      dns4.mockRestore()
      dns6.mockRestore()
      dial.mockRestore()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
    },
  }
}
