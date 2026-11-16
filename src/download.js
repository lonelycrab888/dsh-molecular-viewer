import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { BlockList, isIP } from 'node:net'

export const MAX_STRUCTURE_BYTES = 40 * 1024 * 1024

const reserved = new BlockList()
for (const [network, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
]) reserved.addSubnet(network, bits)
for (const [network, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  reserved.addSubnet(network, bits, 'ipv6')
}
const globalIPv6 = new BlockList()
globalIPv6.addSubnet('2000::', 3, 'ipv6')

function publicAddress({ address, family }) {
  if (family === 4) return !reserved.check(address)
  return family === 6 && globalIPv6.check(address, 'ipv6') && !reserved.check(address, 'ipv6')
}

async function get(url, signal) {
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Structure downloads require an HTTPS URL without credentials.')
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const family = isIP(hostname)
  const addresses = family ? [{ address: hostname, family }] : await lookup(hostname, { all: true })
  const endpoint = addresses.find(publicAddress)
  if (!endpoint) throw new Error('Structure downloads require a public network address.')
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    // Use the checked address for the connection while retaining the URL hostname for TLS.
    const req = request(url, {
      agent: false,
      family: endpoint.family,
      lookup: (_host, _options, callback) => callback(null, endpoint.address, endpoint.family),
      headers: { 'user-agent': 'DSH-Molecular-Viewer (DeepSeek Harness plugin)' },
      signal,
    }, resolve)
    req.on('error', reject)
    req.end()
  })
}

async function readStructureBytes(stream, length) {
  const chunks = []
  let size = 0
  if (Number(length) > MAX_STRUCTURE_BYTES) throw new Error('Structure file exceeds the 40 MiB limit.')
  for await (const chunk of stream) {
    size += chunk.length
    if (size > MAX_STRUCTURE_BYTES) throw new Error('Structure file exceeds the 40 MiB limit.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

export async function downloadStructureBytes(input, signal, label) {
  let url = new URL(input)
  const timeout = AbortSignal.timeout(45_000)
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout
  for (let hop = 0; hop <= 5; hop += 1) {
    const response = await get(url, deadline)
    try {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        url = new URL(response.headers.location, url)
        continue
      }
      if (response.statusCode !== 200) throw new Error(`${label} returned HTTP ${response.statusCode}.`)
      return { bytes: await readStructureBytes(response, response.headers['content-length']), url }
    } finally {
      if (!response.complete) response.destroy()
    }
  }
  throw new Error(`${label} exceeded the redirect limit.`)
}
