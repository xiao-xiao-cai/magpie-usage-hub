import { request as requestHttp } from 'node:http'
import { request as requestHttps } from 'node:https'
import { Readable } from 'node:stream'

type DirectRequest = { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }

export function requestDirect(url: URL, init: DirectRequest, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const connect = url.protocol === 'https:' ? requestHttps : requestHttp
    const headers = new Headers(init.headers)
    if (!headers.has('Accept-Encoding')) headers.set('Accept-Encoding', 'identity')
    if (init.body !== undefined) headers.set('Content-Length', String(Buffer.byteLength(init.body, 'utf8')))
    const request = connect(url, {
      agent: false, method: init.method, headers: Object.fromEntries(headers), signal, rejectUnauthorized: true,
    }, response => {
      try {
        const status = response.statusCode
        if (status === undefined) throw new Error('missing_http_status')
        const responseHeaders = new Headers()
        for (const [name, value] of Object.entries(response.headers)) {
          for (const member of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
            responseHeaders.append(name, member)
          }
        }
        const empty = status === 204 || status === 205 || status === 304
        const body = empty ? null : Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>
        if (empty) response.resume()
        resolve(new Response(body, { status, headers: responseHeaders }))
      } catch (error) {
        response.destroy()
        reject(error)
      }
    })
    request.once('upgrade', (_message, socket) => {
      socket.destroy()
      reject(new Error('unexpected_http_upgrade'))
    })
    request.once('error', reject)
    request.end(init.body)
  })
}
