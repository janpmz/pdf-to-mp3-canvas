const { createHash, randomBytes, timingSafeEqual } = require('node:crypto')
const { z } = require('zod')
const { makeChapter, makePage, newSentenceId, iterChapters, iterPages } = require('../documentStructure')

const UPLOAD_LIFETIME_MS = 24 * 60 * 60 * 1000
const MAX_CHARACTERS = 500000
const idPattern = /^[A-Za-z0-9_-]{32}$/
const secretPattern = /^[A-Za-z0-9_-]{43}$/
const title = z.string().trim().min(1).max(160)
const pageSchema = z.object({ title: title.default(''), text: z.string().trim().max(20000).optional(),
    spoken_text: z.string().trim().min(1).max(20000).optional() }).strict()
    .refine(page => Boolean(page.spoken_text || page.text), 'Each page needs text.')
function chapterSchema(depth = 1) {
    return z.object({ title, pages: z.array(pageSchema).max(100).default([]),
        subchapters: z.array(depth < 3 ? chapterSchema(depth + 1) : z.never()).max(depth < 3 ? 100 : 0).default([]),
    }).strict().refine(chapter => chapter.pages.length || chapter.subchapters.length, 'Each chapter needs text or subchapters.')
}
const chapter = chapterSchema()
const createSchema = z.object({ title: title.default('Untitled canvas'),
    language: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/).default('en'),
    chapters: z.array(chapter).max(100).default([]) }).strict()
const writeSchema = z.object({ chapter, expected_revision: z.number().int().nonnegative().optional() }).strict()
const hash = value => createHash('sha256').update(value).digest('hex')
const secret = () => randomBytes(32).toString('base64url')
const fail = (status, message) => Object.assign(new Error(message), { status })
function matches(value, saved) {
    return typeof value === 'string' && secretPattern.test(value) && typeof saved === 'string'
        && timingSafeEqual(Buffer.from(hash(value)), Buffer.from(saved))
}

function prepareChapter(input, position, previous) {
    const result = makeChapter({ title: input.title, position, pages: [], subchapters: [] })
    if (previous) result._id = previous._id
    result.pages = input.pages.map((inputPage, pagePosition) => {
        const spokenText = inputPage.spoken_text || inputPage.text
        const oldPage = previous?.pages?.[pagePosition]
        const page = makePage({ title: inputPage.title, position: pagePosition, text: inputPage.text || spokenText,
            ...(inputPage.spoken_text ? { agent_spoken_text: spokenText } : {}) })
        if (oldPage) page._id = oldPage._id
        const previousSentences = new Map()
        for (const sentence of oldPage?.sentences || []) {
            const sameText = previousSentences.get(sentence.text) || []
            sameText.push(sentence); previousSentences.set(sentence.text, sameText)
        }
        const spans = [...new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(spokenText)]
        page.sentences = spans.map(span => span.segment.trim()).filter(Boolean).map((text, sentencePosition) => ({
            _id: previousSentences.get(text)?.shift()?._id || newSentenceId(),
            position: sentencePosition, text, words: [],
        }))
        return page
    })
    result.subchapters = input.subchapters.map((item, index) => prepareChapter(item, index, previous?.subchapters?.[index]))
    return result
}
function checkSize(chapters) {
    if ([...iterChapters(chapters)].length > 100) throw fail(400, 'Keep each canvas within 100 chapters and subchapters.')
    const pages = [...iterPages(chapters)]
    if (pages.reduce((sum, page) => sum + page.sentences.length, 0) > 20000) throw fail(400, 'Keep each canvas within 20,000 sentences.')
    const characters = pages.reduce((sum, page) => sum + page.text.length
        + (page.agent_spoken_text?.length || 0), 0)
    if (characters > MAX_CHARACTERS) throw fail(400, 'Keep each canvas within 500,000 text characters.')
}

function createCanvasStore({ getDb, websiteUrl, now = Date.now }) {
    const collection = async () => (await getDb()).collection('canvas_spaces')
    function view(record) {
        return { _id: record._id, title: record.title, language: record.language, chapters: record.chapters,
            revision: record.revision, created_at: record.created_at, updated_at: record.updated_at,
            url: new URL(`/canvas/?id=${record._id}`, websiteUrl).href }
    }
    async function read(id) {
        if (!idPattern.test(id || '')) throw fail(404, 'Canvas not found.')
        const record = await (await collection()).findOne({ _id: id })
        if (!record) throw fail(404, 'Canvas not found.')
        return record
    }
    function authorize(record, code, manageOnly = false) {
        if (matches(code, record.manage_hash)) return
        if (!manageOnly && matches(code, record.upload_hash) && record.upload_expires_at.getTime() > now()) return
        throw fail(403, manageOnly ? 'The owner code is required.' : 'The upload code is missing, invalid, or expired.')
    }
    async function create(input) {
        const data = createSchema.parse(input)
        const uploadCode = secret(), manageCode = secret()
        const chapters = data.chapters.map((item, index) => prepareChapter(item, index))
        checkSize(chapters)
        const time = new Date(now())
        const record = { _id: randomBytes(24).toString('base64url'), title: data.title, language: data.language,
            chapters, revision: 0, upload_hash: hash(uploadCode), manage_hash: hash(manageCode),
            upload_expires_at: new Date(now() + UPLOAD_LIFETIME_MS), created_at: time, updated_at: time }
        await (await collection()).insertOne(record)
        return { ...view(record), upload_code: uploadCode, manage_code: manageCode, upload_expires_at: record.upload_expires_at }
    }
    async function writeChapter(id, index, code, input) {
        if (!Number.isInteger(index) || index < 0 || index > 99) throw fail(400, 'Use a chapter index from 0 to 99.')
        const data = writeSchema.parse(input)
        const record = await read(id)
        authorize(record, code)
        if (index > record.chapters.length) throw fail(409, 'Send chapters in order, starting at 0.')
        if (data.expected_revision !== undefined && data.expected_revision !== record.revision) throw fail(409, 'The canvas changed. Read it again before saving.')
        const savedChapter = prepareChapter(data.chapter, index, record.chapters[index])
        if (JSON.stringify(savedChapter) === JSON.stringify(record.chapters[index])) return view(record)
        record.chapters[index] = savedChapter
        checkSize(record.chapters)
        const updated = await (await collection()).updateOne({ _id: id, revision: record.revision }, {
            $set: { chapters: record.chapters, updated_at: new Date(now()) }, $inc: { revision: 1 },
        })
        if (!updated.matchedCount) throw fail(409, 'The canvas changed. Read it again before saving.')
        return view(await read(id))
    }
    async function renewUpload(id, code) {
        const record = await read(id); authorize(record, code, true)
        const uploadCode = secret(), expires = new Date(now() + UPLOAD_LIFETIME_MS)
        await (await collection()).updateOne({ _id: id }, { $set: { upload_hash: hash(uploadCode), upload_expires_at: expires } })
        return { upload_code: uploadCode, upload_expires_at: expires }
    }
    async function remove(id, code) {
        const record = await read(id); authorize(record, code, true)
        await (await collection()).deleteOne({ _id: id })
    }
    return { create, get: async id => view(await read(id)), writeChapter, renewUpload, remove }
}

module.exports = { createCanvasStore, UPLOAD_LIFETIME_MS }
