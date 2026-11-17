const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
const html = fs.readFileSync(process.env.HOLI_FILE, 'utf8')
http.createServer((request, response) => {
  if (request.url === '/__fixture') { response.end('community-native-fixture'); return }
  response.setHeader('content-type', 'text/html; charset=utf-8')
  response.end(html)
}).listen(port, '127.0.0.1')
console.log(`community fixture serving ${path.basename(process.env.HOLI_FILE)} on ${port}`)
