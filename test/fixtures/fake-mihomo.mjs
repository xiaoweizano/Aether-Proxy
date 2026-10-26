#!/usr/bin/env node
import http from 'node:http'

const args = process.argv.slice(2)
const get = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

if (args.includes('-t')) {
  const file = get('-f')
  const fs = await import('node:fs')
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  if (text.includes('__INVALID__')) { console.error('parse error'); process.exit(1) }
  console.log('configuration file test is successful')
  process.exit(0)
}

const controller = get('-f') ? process.env.FAKE_CONTROLLER : undefined
const port = Number(process.env.FAKE_PORT ?? 0)
const secret = process.env.FAKE_SECRET ?? ''
if (process.env.FAKE_CRASH_AFTER_MS) {
  setTimeout(() => process.exit(1), Number(process.env.FAKE_CRASH_AFTER_MS))
}

const server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${secret}`) {
    res.writeHead(401).end()
    return
  }
  if (req.url === '/version') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ version: 'v1.19.32-fake', meta: true }))
    return
  }
  res.writeHead(404).end()
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`listening ${server.address().port}\n`)
})

process.on('SIGTERM', () => server.close(() => process.exit(0)))
