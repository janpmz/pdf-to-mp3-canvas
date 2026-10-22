const express = require('express')
const cors = require('cors')
const { z } = require('zod')
const { createCanvasStore } = require('./store')
const { createFreeSpeech, SAMPLE_RATE } = require('./freeSpeech')
const { resolveVoiceAndLang, getCatalog } = require('./voices')
const { iterPages } = require('../documentStructure')

function createCanvasRouter({ getDb, websiteUrl, now = Date.now, rateLimit = true, speech = createFreeSpeech({ url: process.env.FREETTS_URL, secret: process.env.FREETTS_SECRET }) }) {
    const router = express.Router()
    const store = createCanvasStore({ getDb, websiteUrl, now })
    const creates = new Map(), requests = new Map()
    router.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'],
        allowedHeaders: ['Authorization', 'Content-Type', 'If-None-Match'], exposedHeaders: ['ETag'] }))
    router.use((req, res, next) => {
        res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' })
        if (!rateLimit) return next()
        const time = now(), isCreate = req.method === 'POST' && req.path === '/canvases'
        const limits = isCreate ? creates : requests
        const duration = isCreate ? 60 * 60 * 1000 : 60 * 1000
        for (const [ip, record] of limits) if (record.until <= time) limits.delete(ip)
        const ip = req.ip || 'unknown', record = limits.get(ip) || { count: 0, until: time + duration }
        if (limits.size >= 10000 && !limits.has(ip) || ++record.count > (isCreate ? 10 : 180)) {
            res.set('Retry-After', String(Math.max(1, Math.ceil((record.until - time) / 1000))))
            return res.status(429).json({ error: 'Too many requests. Try again later.' })
        }
        limits.set(ip, record); next()
    })
    router.use(express.json({ limit: '1mb' }))
    const code = req => /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1]
    const run = action => async (req, res, next) => { try { await action(req, res) } catch (error) { next(error) } }
    router.get('/info', (req, res) => res.json({ name: 'PDFTOMP3 Canvas', version: 1, signup_required: false,
        create_url: new URL('/canvas-api/canvases', websiteUrl).href,
        guide_url: new URL('/canvas/guide.html', websiteUrl).href,
        upload_lifetime_hours: 24, canvas_expires: false, max_text_characters: 500000,
        speech: 'The server uses its free Kokoro service. No user key is needed. Press Play to listen.' }))
    router.get('/voices', (req, res) => res.json(getCatalog()))
    router.post('/canvases/:id/sentences/:sentenceId/speech', run(async (req, res) => {
        if (req.headers.origin && req.headers.origin !== new URL(websiteUrl).origin) {
            return res.status(403).json({ error: 'Open the Canvas page to listen.' })
        }
        const body = z.object({ voice: z.string().max(40).optional() }).strict().parse(req.body)
        const canvas = await store.get(req.params.id)
        const sentence = [...iterPages(canvas.chapters)].flatMap(page => page.sentences)
            .find(item => item._id === req.params.sentenceId)
        if (!sentence) return res.status(404).json({ error: 'This sentence changed or no longer exists. Reload the canvas.' })
        const { voice } = resolveVoiceAndLang(body.voice ? { voice: body.voice } : { lang: canvas.language })
        const language = getCatalog().languages.find(item => item.voices.includes(voice)).tag.split('-')[0]
        if (language !== canvas.language.split('-')[0]) return res.status(400).json({ error: 'Choose a voice in the reading language.' })
        const pcm = await speech.synthesize(sentence.text, voice, canvas._id)
        res.set({ 'Content-Type': `audio/pcm;rate=${SAMPLE_RATE};channels=1`, 'X-Content-Type-Options': 'nosniff' }).send(pcm)
    }))
    router.post('/canvases', run(async (req, res) => res.status(201).json(await store.create(req.body))))
    router.get('/canvases/:id', run(async (req, res) => {
        const canvas = await store.get(req.params.id), etag = `"${canvas._id}:${canvas.revision}"`
        res.set('ETag', etag)
        if (req.headers['if-none-match'] === etag) return res.status(304).end()
        res.json(canvas)
    }))
    router.put('/canvases/:id/chapters/:index', run(async (req, res) => {
        const index = /^(?:0|[1-9][0-9]?)$/.test(req.params.index) ? Number(req.params.index) : NaN
        res.json(await store.writeChapter(req.params.id, index, code(req), req.body))
    }))
    router.post('/canvases/:id/upload-code', run(async (req, res) => {
        z.object({}).strict().parse(req.body)
        res.json(await store.renewUpload(req.params.id, code(req)))
    }))
    router.delete('/canvases/:id', run(async (req, res) => { await store.remove(req.params.id, code(req)); res.status(204).end() }))
    router.use((error, req, res, next) => {
        if (error.status === 429) res.set('Retry-After', '2')
        const status = error.status || (error instanceof z.ZodError ? 400 : 500)
        // Replies never echo submitted values, headers, or provider messages.
        const message = error instanceof z.ZodError ? 'Check the canvas text format. Send only the fields listed in the guide.'
            : status === 413 ? 'This request is too large. Send one chapter at a time.'
            : error.type === 'entity.parse.failed' ? 'Send valid JSON with the fields listed in the guide.'
            : status >= 500 ? (req.path.endsWith('/speech') ? ({ 503: 'Free speech is not set up on this server yet.', 504: 'Free speech is taking too long. Try again shortly.' }[status] || 'Free speech could not finish. Try again shortly.') : 'Could not save this canvas. Try again.') : error.message
        res.status(status).json({ error: message })
    })
    return router
}

module.exports = { createCanvasRouter }
