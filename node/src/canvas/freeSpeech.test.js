const test = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { createFreeSpeech, checkedWordTimes } = require('./freeSpeech')
const id = 'a'.repeat(24), pcm = Buffer.from([0, 0, 0, 64, 0, 192])
const words = [{ text: 'Read', start: 0, end: pcm.length / 48000 }]
const timings = () => ({ source: 'kokoro', version: 1, sample_rate: 24000,
    duration_seconds: pcm.length / 48000, audio_sha256: createHash('sha256').update(pcm).digest('hex'), words })
const capabilities = () => Response.json({ word_timing_languages: ['en'] })
function fixture(options = {}) {
    const calls = []
    let polls = 0
    const speech = createFreeSpeech({ url: 'https://speech.test/api/tts', secret: 'server-only-secret', pollMs: 1,
        fetchImpl: async (url, init) => {
            calls.push({ url: String(url), ...init })
            if (String(url).endsWith('/capabilities')) return capabilities()
            if (init.method === 'POST') return Response.json({ job_id: id }, { status: 202 })
            if (String(url).includes('/jobs/')) return Response.json({ status: ++polls === 1 ? 'queued' : 'done' })
            if (String(url).includes('/timings/')) return Response.json(timings())
            return new Response(pcm)
        }, ...options })
    return { speech, calls }
}
test('one job supplies audio and verified word times, duplicates share the job, and repeat keeps both', async () => {
    const { speech, calls } = fixture()
    const first = speech.synthesize('Read this exact sentence.', 'af_heart', 'canvas-one')
    const repeated = speech.synthesize('Read this exact sentence.', 'af_heart', 'canvas-one')
    const expected = { pcm, words }
    assert.deepEqual(await first, expected); assert.deepEqual(await repeated, expected)
    assert.deepEqual(await speech.synthesize('Read this exact sentence.', 'af_heart', 'canvas-one'), expected)
    const posts = calls.filter(call => call.method === 'POST')
    assert.equal(posts.length, 1)
    assert.deepEqual(JSON.parse(posts[0].body), { text: 'Read this exact sentence.', voice: 'af_heart', ref: null,
        callback_client: 'documentplayer', include_word_timings: true })
    assert.ok(calls.every(call => call.headers['x-api-key'] === 'server-only-secret'))
    assert.ok(calls.every(call => !call.url.includes('server-only-secret')))
    assert.ok(calls.some(call => call.url.endsWith(`/result/${id}`)))
    assert.ok(calls.some(call => call.url.endsWith(`/timings/${id}`)))
    await speech.synthesize('Read this exact sentence.', 'af_heart', 'canvas-two')
    assert.equal(calls.filter(call => call.method === 'POST').length, 2)
    assert.equal(calls.filter(call => call.url.endsWith('/capabilities')).length, 1)
})
test('word times must match this audio, including its hash, length, order, and word intervals', () => {
    assert.deepEqual(checkedWordTimes(timings(), pcm), words)
    for (const patch of [{ audio_sha256: 'wrong-audio' }, { duration_seconds: 8 }, { sample_rate: 16000 },
        { words: [] }, { words: [{ text: 'Read', start: -1, end: 0 }] },
        { words: [{ text: 'Read', start: 0, end: 4 }] },
        { words: [{ text: 'a', start: .0001, end: .00012 }, { text: 'b', start: 0, end: .00001 }] }]) {
        assert.throws(() => checkedWordTimes({ ...timings(), ...patch }, pcm), error => error.status === 502)
    }
})
test('languages without word times still get audio and never ask for unsupported timings', async () => {
    const { speech, calls } = fixture()
    assert.deepEqual(await speech.synthesize('Hello.', 'hf_alpha', 'canvas-one'), { pcm, words: [] })
    assert.equal(JSON.parse(calls.find(call => call.method === 'POST').body).include_word_timings, undefined)
    assert.equal(calls.some(call => call.url.includes('/timings/')), false)
})
test('missing setup, long sentences, upstream failures and timeouts fail without leaking keys', async () => {
    await assert.rejects(createFreeSpeech().synthesize('Hello.', 'af_heart'), error => error.status === 503)
    const { speech, calls } = fixture()
    await assert.rejects(speech.synthesize('x'.repeat(2001), 'af_heart'), error => error.status === 400)
    assert.equal(calls.length, 0)
    const failed = fixture({ fetchImpl: async () => { throw new Error('server-only-secret at private URL') } }).speech
    await assert.rejects(failed.synthesize('Hello.', 'af_heart'), error => error.status === 502 && !error.message.includes('server-only-secret'))
    const stalled = fixture({ timeoutMs: 5, pollMs: 20, fetchImpl: async (url, init) =>
        String(url).endsWith('/capabilities') ? capabilities() : Response.json(init.method === 'POST' ? { job_id: id } : { status: 'queued' }) }).speech
    await assert.rejects(stalled.synthesize('Hello.', 'af_heart'), error => error.status === 504)
    const invalid = fixture({ fetchImpl: async (url, init) => String(url).endsWith('/capabilities') ? capabilities() : init.method === 'POST'
        ? Response.json({ job_id: id }) : String(url).includes('/jobs/') ? Response.json({ status: 'done' }) : new Response(new Uint8Array([1])) }).speech
    await assert.rejects(invalid.synthesize('Hello.', 'af_heart'), error => error.status === 502)
})
test('only a small number of distinct jobs can wait, finished jobs release their slot, and cached sound expires', async () => {
    let release, time = 0
    const gate = new Promise(resolve => { release = resolve })
    const { speech, calls } = fixture({ maxPending: 1, cacheMs: 10, now: () => time,
        fetchImpl: async (url, init) => {
            calls.push({ method: init.method })
            if (String(url).endsWith('/capabilities')) return capabilities()
            if (init.method === 'POST') { await gate; return Response.json({ job_id: id }) }
            if (String(url).includes('/jobs/')) return Response.json({ status: 'done' })
            if (String(url).includes('/timings/')) return Response.json(timings())
            return new Response(pcm)
        } })
    const first = speech.synthesize('One.', 'af_heart', 'canvas-one')
    await assert.rejects(speech.synthesize('Two.', 'af_heart', 'canvas-one'), error => error.status === 429)
    release(); await first
    time = 20
    await speech.synthesize('One.', 'af_heart', 'canvas-one')
    assert.equal(calls.filter(call => call.method === 'POST').length, 2)
})
