const port = Number(Bun.argv[2])
if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error('Invalid fixture port')

const model = 'phase4-fixture-v1'
const usage = { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
const encoder = new TextEncoder()

Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/v1/models') {
      return Response.json({ object: 'list', data: [{ id: model, object: 'model', owned_by: 'usage-hub-test' }] })
    }
    if (request.method !== 'POST' || path !== '/v1/chat/completions') return new Response(null, { status: 404 })

    const body: unknown = await request.json().catch(() => null)
    if (!body || typeof body !== 'object' || !('model' in body) || body.model !== model) {
      return Response.json({ error: { message: 'Unsupported fixture request' } }, { status: 400 })
    }
    const completion = { id: `chatcmpl-${crypto.randomUUID()}`, created: Math.floor(Date.now() / 1000), model }
    if ('stream' in body && body.stream === true) {
      const chunk = { ...completion, object: 'chat.completion.chunk' }
      const events = [
        { ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
        { ...chunk, choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }] },
        { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        { ...chunk, choices: [], usage },
      ]
      const frames = [...events.map(event => JSON.stringify(event)), '[DONE]'].values()
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          const frame = frames.next()
          if (frame.done) controller.close()
          else controller.enqueue(encoder.encode(`data: ${frame.value}\n\n`))
        },
      })
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
    }

    return Response.json({
      ...completion,
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage,
    })
  },
})
