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

export async function readJsonBody(
  request: Request, maxBytes: number, invalidCode: string, sizeCode: string,
): Promise<{ value: unknown } | Response> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) {
    return failure(415, 'unsupported_media_type')
  }
  if (Number(request.headers.get('content-length')) > maxBytes) return failure(413, sizeCode)
  const reader = request.body?.getReader()
  if (!reader) return failure(400, invalidCode)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let text = ''
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) return failure(413, sizeCode)
      text += decoder.decode(value, { stream: true })
    }
    return { value: JSON.parse(text + decoder.decode()) }
  } catch {
    return failure(400, invalidCode)
  } finally {
    reader.releaseLock()
  }
}

export function isHexDigest(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value)
}

export function isSourceId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
    && value.length === 36
}
