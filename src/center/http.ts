const noStore = { 'Cache-Control': 'no-store' }

export function jsonReply(payload: unknown, status = 200): Response {
  return Response.json(payload, { status, headers: noStore })
}

export function failure(status: number, code: string): Response {
  return jsonReply({ error: { code } }, status)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export async function readBoundedJson(message: Request | Response, maxBytes: number): Promise<unknown> {
  if (Number(message.headers.get('content-length')) > maxBytes) {
    void message.body?.cancel().catch(() => {})
    throw new RangeError('body_too_large')
  }
  const reader = message.body?.getReader()
  if (!reader) throw new SyntaxError('missing_body')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let text = ''
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) throw new RangeError('body_too_large')
      text += decoder.decode(value, { stream: true })
    }
    return JSON.parse(text + decoder.decode())
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
}

export async function readJsonBody(request: Request, maxBytes: number): Promise<{ value: unknown } | Response> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) {
    return failure(415, 'unsupported_media_type')
  }
  try {
    return { value: await readBoundedJson(request, maxBytes) }
  } catch (error) {
    return error instanceof RangeError ? failure(413, 'source_request_too_large') : failure(400, 'invalid_source')
  }
}
