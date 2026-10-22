const test = require('node:test')
const assert = require('node:assert/strict')
const { createFreeSpeech } = require('./freeSpeech')
const id = 'a'.repeat(24), pcm = Buffer.from([0, 0, 0, 64, 0, 192])
function fixture(options = {}) {
    const calls = []
    let polls = 0
    const speech = createFreeSpeech({ url: 'https://speech.test/api/tts', secret: 'server-only-secret', pollMs: 1,
        fetchImpl: async (url, init) => {
            calls.push({ url: String(url), ...init })
            if (init.method === 'POST') return Response.json({ job_id: id }, { status: 202 })
            if (String(url).includes('/jobs/')) return Response.json({ status: ++polls === 1 ? 'queued' : 'done' })
            return new Response(pcm)
        }, ...options })
    return { speech, calls }
}
test('queued speech stays on the server, duplicate requests share one job, and repeat uses the cache', async () => {
    const { speech, calls } = fixture()
    const first = speech.synthesize('Read this exact sentence.', 'af_heart', 'canvas-one')
    const repeated = speech.synthesize('Read this exact sentence.', 'af_heart', 'canvas-one')
    assert.deepEqual(await first, pcm); assert.deepEqual(await repeated, pcm)
    assert.deepEqual(await speech.synthesize('Read this exact sentence.', 'af_heart', 'canvas-one'), pcm)
    const posts = calls.filter(call => call.method === 'POST')
    assert.equal(posts.length, 1)
    assert.deepEqual(JSON.parse(posts[0].body), { text: 'Read this exact sentence.', voice: 'af_heart', ref: null, callback_client: 'documentplayer' })
    assert.ok(calls.every(call => call.headers['x-api-key'] === 'server-only-secret'))
    assert.ok(calls.every(call => !call.url.includes('server-only-secret')))
    assert.equal(calls.at(-1).url, `https://speech.test/api/tts/result/${id}`)
    await speech.synthesize('Read this exact sentence.', 'af_heart', 'canvas-two')
    assert.equal(calls.filter(call => call.method === 'POST').length, 2)
})
test('missing setup, long sentences, upstream failures and timeouts fail without leaking keys', async () => {
    await assert.rejects(createFreeSpeech().synthesize('Hello.', 'af_heart'), error => error.status === 503)
    const { speech, calls } = fixture()
    await assert.rejects(speech.synthesize('x'.repeat(2001), 'af_heart'), error => error.status === 400)
    assert.equal(calls.length, 0)
    const failed = fixture({ fetchImpl: async () => { throw new Error('server-only-secret at private URL') } }).speech
    await assert.rejects(failed.synthesize('Hello.', 'af_heart'), error => error.status === 502 && !error.message.includes('server-only-secret'))
    const stalled = fixture({ timeoutMs: 5, pollMs: 20, fetchImpl: async (url, init) =>
        Response.json(init.method === 'POST' ? { job_id: id } : { status: 'queued' }) }).speech
    await assert.rejects(stalled.synthesize('Hello.', 'af_heart'), error => error.status === 504)
    const invalid = fixture({ fetchImpl: async (url, init) => init.method === 'POST'
        ? Response.json({ job_id: id }) : String(url).includes('/jobs/') ? Response.json({ status: 'done' }) : new Response(new Uint8Array([1])) }).speech
    await assert.rejects(invalid.synthesize('Hello.', 'af_heart'), error => error.status === 502)
})
test('only a small number of distinct jobs can wait, finished jobs release their slot, and cached sound expires', async () => {
    let release, time = 0
    const gate = new Promise(resolve => { release = resolve })
    const { speech, calls } = fixture({ maxPending: 1, cacheMs: 10, now: () => time,
        fetchImpl: async (url, init) => {
            calls.push({ method: init.method })
            if (init.method === 'POST') { await gate; return Response.json({ job_id: id }) }
            return String(url).includes('/jobs/') ? Response.json({ status: 'done' }) : new Response(pcm)
        } })
    const first = speech.synthesize('One.', 'af_heart', 'canvas-one')
    await assert.rejects(speech.synthesize('Two.', 'af_heart', 'canvas-one'), error => error.status === 429)
    release(); await first
    time = 20
    await speech.synthesize('One.', 'af_heart', 'canvas-one')
    assert.equal(calls.filter(call => call.method === 'POST').length, 2)
})
