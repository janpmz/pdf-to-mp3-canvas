const { createHash } = require('node:crypto')
const { setTimeout: wait } = require('node:timers/promises')

const SAMPLE_RATE = 24000
const MAX_PCM_BYTES = SAMPLE_RATE * 2 * 180
const fail = (status, message) => Object.assign(new Error(message), { status })

// The shared service key stays in this process. No provider reply enters an error message.
function createFreeSpeech({ url, secret, fetchImpl = fetch, pollMs = 250, timeoutMs = 90000,
    maxPending = 4, maxCacheBytes = 64 * 1024 * 1024, cacheMs = 10 * 60 * 1000, now = Date.now } = {}) {
    const pending = new Map(), cache = new Map()
    let bytes = 0
    function trim() {
        for (const [key, item] of cache) {
            if (item.expires <= now() || bytes > maxCacheBytes) {
                cache.delete(key); bytes -= item.pcm.length
            }
        }
    }
    async function generate(text, voice) {
        const signal = AbortSignal.timeout(timeoutMs)
        const base = new URL(url)
        const headers = { 'x-api-key': secret }
        async function request(address, options = {}) {
            const response = await fetchImpl(address, { ...options, signal, redirect: 'error', headers: { ...headers, ...options.headers } })
            if (!response.ok) throw fail(502, 'Free speech could not finish. Please try again.')
            return response
        }
        try {
            const submitted = await (await request(base, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, voice, ref: null, callback_client: 'documentplayer' }) })).json()
            if (!/^[a-f0-9]{24}$/.test(submitted.job_id || '')) throw fail(502, 'Free speech returned an invalid job. Please try again.')
            const statusUrl = new URL(`${base.pathname.replace(/\/$/, '')}/jobs/${submitted.job_id}`, base)
            for (;;) {
                const job = await (await request(statusUrl)).json()
                if (job.status === 'done') break
                if (!['queued', 'processing'].includes(job.status)) throw fail(502, 'Free speech could not finish. Please try again.')
                await wait(pollMs, undefined, { signal })
            }
            const resultUrl = new URL(`${base.pathname.replace(/\/$/, '')}/result/${submitted.job_id}`, base)
            const response = await request(resultUrl)
            const chunks = []
            let size = 0
            for await (const chunk of response.body) {
                size += chunk.length
                if (size > MAX_PCM_BYTES) throw fail(502, 'This sentence returned too much audio. Try a shorter sentence.')
                chunks.push(Buffer.from(chunk))
            }
            if (!size || size % 2) throw fail(502, 'Free speech returned unreadable audio. Please try again.')
            return Buffer.concat(chunks)
        } catch (error) {
            if (signal.aborted) throw fail(504, 'Free speech is taking too long. Please try again shortly.')
            if (error.status) throw error
            throw fail(502, 'Free speech could not connect. Please try again shortly.')
        }
    }
    return {
        async synthesize(text, voice, canvasId) {
            if (!url || !secret) throw fail(503, 'Free speech is not set up on this server yet.')
            if (!text.trim() || text.length > 2000) throw fail(400, 'Keep each spoken sentence within 2,000 characters.')
            const key = createHash('sha256').update(JSON.stringify([canvasId, text, voice])).digest('hex')
            trim()
            const saved = cache.get(key)
            if (saved) { cache.delete(key); cache.set(key, saved); return saved.pcm }
            if (pending.has(key)) return pending.get(key)
            if (pending.size >= maxPending) throw fail(429, 'Free speech is busy. Please try again shortly.')
            const work = generate(text, voice).then(pcm => {
                if (pcm.length <= maxCacheBytes) {
                    cache.set(key, { pcm, expires: now() + cacheMs }); bytes += pcm.length; trim()
                }
                return pcm
            }).finally(() => pending.delete(key))
            pending.set(key, work)
            return work
        },
    }
}

module.exports = { createFreeSpeech, SAMPLE_RATE }
