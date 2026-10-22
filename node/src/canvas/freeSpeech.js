const { createHash } = require('node:crypto')
const { setTimeout: wait } = require('node:timers/promises')

const SAMPLE_RATE = 24000
const MAX_PCM_BYTES = SAMPLE_RATE * 2 * 180
const fail = (status, message) => Object.assign(new Error(message), { status })

function checkedWordTimes(data, pcm) {
    const duration = pcm.length / (SAMPLE_RATE * 2)
    if (data?.source !== 'kokoro' || data.version !== 1 || data.sample_rate !== SAMPLE_RATE ||
        !Number.isFinite(data.duration_seconds) || Math.abs(data.duration_seconds - duration) > 1 / SAMPLE_RATE ||
        data.audio_sha256 !== createHash('sha256').update(pcm).digest('hex') ||
        !Array.isArray(data.words) || !data.words.length || data.words.length > 4000) {
        throw fail(502, 'Free speech returned word times for different or unreadable audio.')
    }
    let previous = 0
    return data.words.map(word => {
        if (typeof word?.text !== 'string' || !word.text.trim() || !Number.isFinite(word.start) || !Number.isFinite(word.end) ||
            word.start < previous || word.end < word.start || word.end > duration) {
            throw fail(502, 'Free speech returned invalid word times.')
        }
        previous = word.start
        return { text: word.text, start: word.start, end: word.end }
    })
}

// The shared service key stays in this process. No provider reply enters an error message.
function createFreeSpeech({ url, secret, fetchImpl = fetch, pollMs = 250, timeoutMs = 90000,
    maxPending = 4, maxCacheBytes = 64 * 1024 * 1024, cacheMs = 10 * 60 * 1000, now = Date.now } = {}) {
    const pending = new Map(), cache = new Map()
    let bytes = 0
    let supportedLanguages, languagesExpire = 0, languagesRequest
    function trim() {
        for (const [key, item] of cache) {
            if (item.expires <= now() || bytes > maxCacheBytes) {
                cache.delete(key); bytes -= item.bytes
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
            if (!supportedLanguages || now() >= languagesExpire) {
                if (!languagesRequest) {
                    const address = new URL(`${base.pathname.replace(/\/$/, '')}/capabilities`, base)
                    languagesRequest = request(address).then(reply => reply.json()).then(data => {
                        if (!Array.isArray(data.word_timing_languages)) throw fail(502, 'Free speech could not check word times.')
                        supportedLanguages = data.word_timing_languages; languagesExpire = now() + 30000
                    }).finally(() => { languagesRequest = null })
                }
                await languagesRequest
            }
            const language = { a: 'en', b: 'en', d: 'de', e: 'es', f: 'fr', i: 'it', p: 'pt', h: 'hi', j: 'ja', z: 'zh' }[voice[0]]
            const withTimes = supportedLanguages.includes(language)
            const submitted = await (await request(base, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, voice, ref: null, callback_client: 'documentplayer', ...(withTimes ? { include_word_timings: true } : {}) }) })).json()
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
            const pcm = Buffer.concat(chunks)
            let words = []
            if (withTimes) {
                const timingsUrl = new URL(`${base.pathname.replace(/\/$/, '')}/timings/${submitted.job_id}`, base)
                words = checkedWordTimes(await (await request(timingsUrl)).json(), pcm)
            }
            return { pcm, words }
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
            if (saved) { cache.delete(key); cache.set(key, saved); return saved.audio }
            if (pending.has(key)) return pending.get(key)
            if (pending.size >= maxPending) throw fail(429, 'Free speech is busy. Please try again shortly.')
            const work = generate(text, voice).then(audio => {
                const size = audio.pcm.length + Buffer.byteLength(JSON.stringify(audio.words))
                if (size <= maxCacheBytes) {
                    cache.set(key, { audio, bytes: size, expires: now() + cacheMs }); bytes += size; trim()
                }
                return audio
            }).finally(() => pending.delete(key))
            pending.set(key, work)
            return work
        },
    }
}

module.exports = { createFreeSpeech, SAMPLE_RATE, checkedWordTimes }
