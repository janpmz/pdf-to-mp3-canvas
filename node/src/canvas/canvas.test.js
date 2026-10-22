const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { MongoClient } = require('mongodb')
const express = require('express')
const { createCanvasRouter } = require('./router')

async function fixture(t, options = {}) {
    const mongo = new MongoClient(process.env.CANVAS_TEST_MONGO_URL || 'mongodb://127.0.0.1:27017', { serverSelectionTimeoutMS: 1500 })
    await mongo.connect()
    const db = mongo.db(`canvas_test_${randomUUID().replaceAll('-', '')}`)
    let now = Date.now()
    const app = express()
    app.use('/canvas-api', createCanvasRouter({ getDb: async () => db, websiteUrl: 'http://localhost:3000', now: () => now, rateLimit: false, ...options }))
    const server = app.listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    const base = `http://127.0.0.1:${server.address().port}/canvas-api`
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await db.dropDatabase(); await mongo.close() })
    const call = (method, route, body, code, headers = {}) => fetch(`${base}${route}`, { method,
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(code ? { Authorization: `Bearer ${code}` } : {}), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { db, call, base, advance: ms => { now += ms } }
}
const chapter = (title, text) => ({ title, pages: [{ title: 'Page', text }], subchapters: [] })

test('anonymous creation, nested document shape, reads, writes, and deletion stay separate from accounts', async t => {
    const f = await fixture(t)
    const response = await f.call('POST', '/canvases', { title: 'Remembering', chapters: [
        { title: 'First chapter', pages: [], subchapters: [chapter('First thought', 'One thought. Another thought.')] },
    ] })
    assert.equal(response.status, 201)
    const created = await response.json(), id = created._id
    assert.match(id, /^[A-Za-z0-9_-]{32}$/)
    assert.match(created.upload_code, /^[A-Za-z0-9_-]{43}$/)
    assert.match(created.manage_code, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(created.url, `http://localhost:3000/canvas/?id=${id}`)
    const saved = await f.db.collection('canvas_spaces').findOne({ _id: id })
    assert.equal(saved.upload_code, undefined)
    assert.equal(saved.manage_code, undefined)
    assert.equal(saved.expires_at, undefined)
    assert.notEqual(saved.upload_hash, created.upload_code)
    const page = created.chapters[0].subchapters[0].pages[0]
    assert.match(created.chapters[0]._id, /^chapter_/)
    assert.match(page._id, /^page_/)
    assert.equal(page.sentences.length, 2)
    assert.match(page.sentences[0]._id, /^sentence_/)
    assert.equal(page.sentences[0].start_ms, undefined)
    const readResponse = await f.call('GET', `/canvases/${id}`)
    const publicView = await readResponse.json()
    assert.equal(publicView.upload_code, undefined)
    assert.equal(publicView.manage_hash, undefined)
    assert.equal(publicView.upload_expires_at, undefined)
    assert.equal((await f.call('GET', `/canvases/${id}`, undefined, undefined, { 'If-None-Match': readResponse.headers.get('ETag') })).status, 304)
    const route = `/canvases/${id}/chapters/1`
    assert.equal((await f.call('PUT', route, { chapter: chapter('Next', 'Next thought.') })).status, 403)
    assert.equal((await f.call('PUT', route, { chapter: chapter('Next', 'Next thought.') }, created.upload_code)).status, 200)
    assert.equal((await f.call('DELETE', `/canvases/${id}`, undefined, created.upload_code)).status, 403)
    assert.deepEqual((await f.db.listCollections({}, { nameOnly: true }).toArray()).map(item => item.name), ['canvas_spaces'])
    assert.equal((await f.call('DELETE', `/canvases/${id}`, undefined, created.manage_code)).status, 204)
    assert.equal((await f.call('GET', `/canvases/${id}`)).status, 404)
})

test('upload expiry does not expire the canvas, and owner access renews only its upload code', async t => {
    const f = await fixture(t)
    const a = await (await f.call('POST', '/canvases', { title: 'One' })).json()
    const b = await (await f.call('POST', '/canvases', { title: 'Two' })).json()
    const route = `/canvases/${a._id}/chapters/0`, body = { chapter: chapter('First', 'Hello.') }
    assert.equal((await f.call('PUT', route, body, b.upload_code)).status, 403)
    f.advance(25 * 60 * 60 * 1000)
    assert.equal((await f.call('PUT', route, body, a.upload_code)).status, 403)
    assert.equal((await f.call('GET', `/canvases/${a._id}`)).status, 200)
    const renewed = await (await f.call('POST', `/canvases/${a._id}/upload-code`, {}, a.manage_code)).json()
    assert.notEqual(renewed.upload_code, a.upload_code)
    assert.equal((await f.call('PUT', route, body, renewed.upload_code)).status, 200)
    assert.equal((await f.call('PUT', route, body, a.upload_code)).status, 403)
    f.advance(365 * 24 * 60 * 60 * 1000)
    assert.equal((await f.call('GET', `/canvases/${a._id}`)).status, 200)
    assert.equal((await f.call('DELETE', `/canvases/${a._id}`, undefined, a.manage_code)).status, 204)
})

test('retries retain IDs, revisions prevent lost edits, and changed sentences get new IDs', async t => {
    const f = await fixture(t)
    const created = await (await f.call('POST', '/canvases', { title: 'Edits', chapters: [chapter('First', 'Hello there. Another thought.')] })).json()
    const route = `/canvases/${created._id}/chapters/0`
    const repeated = await (await f.call('PUT', route, { chapter: chapter('First', 'Hello there. Another thought.') }, created.upload_code)).json()
    assert.equal(repeated.revision, 0)
    assert.deepEqual(repeated.chapters, created.chapters)
    const updated = await (await f.call('PUT', route, { expected_revision: 0, chapter: chapter('First', 'Hello there. A new thought.') }, created.upload_code)).json()
    const old = created.chapters[0].pages[0], next = updated.chapters[0].pages[0]
    assert.equal(next._id, old._id)
    assert.equal(next.sentences[0]._id, old.sentences[0]._id)
    assert.notEqual(next.sentences[1]._id, old.sentences[1]._id)
    assert.equal((await f.call('PUT', route, { expected_revision: 0, chapter: chapter('First', 'Old edit.') }, created.upload_code)).status, 409)
    assert.equal((await f.call('PUT', `/canvases/${created._id}/chapters/2`, { chapter: chapter('Gap', 'Gap.') }, created.upload_code)).status, 409)
})

test('rejects keys, unknown fields, excessive nesting, oversized text, and malformed JSON without echoing values', async t => {
    const f = await fixture(t)
    const key = 'private-test-key-do-not-echo'
    for (const body of [{ title: 'Test', api_key: key }, { title: 'Test', user_id: 'someone' },
        { title: 'Test', chapters: [chapter('Long', 'a'.repeat(20001))] },
        { title: 'Test', chapters: [{ title: '1', subchapters: [{ title: '2', subchapters: [{ title: '3', subchapters: [chapter('4', 'Too deep.')] }] }] }] }]) {
        const reply = await f.call('POST', '/canvases', body)
        assert.equal(reply.status, 400)
        assert.equal((await reply.text()).includes(key), false)
    }
    const malformed = await fetch(`${f.base}/canvases`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: `${key} invalid JSON` })
    assert.equal(malformed.status, 400)
    assert.equal((await malformed.text()).includes(key), false)
    const oversized = await f.call('POST', '/canvases', { title: 'Large', text: 'x'.repeat(1100000) })
    assert.equal(oversized.status, 413)
    assert.equal(await f.db.collection('canvas_spaces').countDocuments(), 0)
})

test('public CORS supports a separately hosted reader, discovery has no account setup, and creation is limited', async t => {
    const f = await fixture(t, { rateLimit: true })
    const infoResponse = await f.call('GET', '/info', undefined, undefined, { Origin: 'https://own-canvas.example' })
    assert.equal(infoResponse.headers.get('Access-Control-Allow-Origin'), '*')
    assert.equal(infoResponse.headers.get('Access-Control-Allow-Credentials'), null)
    const info = await infoResponse.json()
    assert.equal(info.signup_required, false)
    assert.equal(info.canvas_expires, false)
    for (let i = 0; i < 10; i++) assert.equal((await f.call('POST', '/canvases', { title: 'Canvas' })).status, 201)
    assert.equal((await f.call('POST', '/canvases', { title: 'Limited' })).status, 429)
})


test('speech reads only saved sentences, checks languages, and never accepts provider keys or arbitrary text', async t => {
    const calls = []
    const f = await fixture(t, { speech: { async synthesize(...args) { calls.push(args); return Buffer.from([0, 0, 0, 64]) } } })
    const canvas = await (await f.call('POST', '/canvases', { title: 'Speech test', chapters: [chapter('Read', 'Read only this sentence.')] })).json()
    const sentence = canvas.chapters[0].pages[0].sentences[0]
    const path = `/canvases/${canvas._id}/sentences/${sentence._id}/speech`
    const reply = await f.call('POST', path, { voice: 'af_heart' })
    assert.equal(reply.status, 200)
    assert.equal(reply.headers.get('content-type'), 'audio/pcm;rate=24000;channels=1')
    assert.deepEqual(Buffer.from(await reply.arrayBuffer()), Buffer.from([0, 0, 0, 64]))
    assert.deepEqual(calls, [[sentence.text, 'af_heart', canvas._id]])
    assert.equal((await f.call('POST', path, { voice: 'bf_emma' })).status, 200)
    for (const body of [{ text: 'Do not send this.' }, { api_key: 'never-echo-this' }, { voice: 'Kore' }, { voice: 'ff_siwis' }]) {
        const bad = await f.call('POST', path, body)
        assert.equal(bad.status, 400)
        assert.equal((await bad.text()).includes('never-echo-this'), false)
    }
    assert.equal(calls.length, 2)
    assert.equal((await f.call('POST', `/canvases/${canvas._id}/sentences/missing/speech`, {})).status, 404)
    assert.equal((await f.call('POST', path, {}, undefined, { Origin: 'https://unrelated.example' })).status, 403)
})
