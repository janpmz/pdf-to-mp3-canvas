const { ObjectId } = require('mongodb')

function newChapterId() {
    return `chapter_${new ObjectId()}`
}

function newPageId() {
    return `page_${new ObjectId()}`
}

function newSentenceId() {
    return `sentence_${new ObjectId()}`
}

function* iterChapters(chapters) {
    for (const chapter of chapters || []) {
        yield chapter
        yield* iterChapters(chapter.subchapters)
    }
}

function* iterLeafChapters(chapters) {
    for (const chapter of iterChapters(chapters)) {
        if (!chapter.subchapters?.length) yield chapter
    }
}

function* iterPages(chapters) {
    for (const chapter of iterChapters(chapters)) {
        yield* (chapter.pages || [])
    }
}

function findChapter(chapters, chapterId) {
    return [...iterChapters(chapters)].find((chapter) => chapter?._id === chapterId) || null
}

function renameChapterInTree(chapters, chapterId, title) {
    const chapter = findChapter(chapters, chapterId)
    if (!chapter) return { found: false, changed: false }
    if (chapter.title === title) return { found: true, changed: false }
    chapter.title = title
    return { found: true, changed: true }
}

function findPage(chapters, pageId) {
    for (const chapter of iterChapters(chapters)) {
        const page = (chapter.pages || []).find((item) => item?._id === pageId)
        if (page) return { chapter, page }
    }
    return null
}

function findSentence(chapters, sentenceId) {
    for (const chapter of iterChapters(chapters)) {
        for (const page of chapter.pages || []) {
            const sentence = (page.sentences || []).find((item) => item?._id === sentenceId)
            if (sentence) return { chapter, page, sentence }
        }
    }
    return null
}

function firstPageId(chapters) {
    return iterPages(chapters).next().value?._id || null
}

function makeChapter({ title = '', number = '', position = 0, subchapters = [], pages = [], ...fields } = {}) {
    return {
        _id: newChapterId(),
        title,
        number,
        position,
        subchapters,
        pages,
        ...fields,
    }
}

function makePage({ text, position = 0, title = '', ...fields }) {
    return {
        _id: newPageId(),
        position,
        title,
        text,
        sentences: [],
        ...fields,
    }
}

function validateDocumentStructure(chapters) {
    if (!Array.isArray(chapters) || chapters.length === 0) throw new Error('A document must have at least one chapter')
    const seen = new Set()
    const oldChapterFields = ['children', 'doc_id', 'sentence_audio_job', 'has_been_split_to_sentences']
    const oldPageFields = ['chapter_id', 'audio_info', 'sentence_audio']
    for (const chapter of iterChapters(chapters)) {
        validateId(chapter, 'chapter_', seen)
        if (oldChapterFields.some((field) => field in chapter)) throw new Error('A chapter contains an old field')
        if (!Array.isArray(chapter.subchapters) || !Array.isArray(chapter.pages)) {
            throw new Error('Each chapter must have subchapters and pages lists')
        }
        for (const page of chapter.pages) {
            // Keep saved IDs so existing audio and bookmarks still refer to this page.
            validateId(page, page._id?.startsWith('paragraph_') ? 'paragraph_' : 'page_', seen)
            if (oldPageFields.some((field) => field in page)) throw new Error('A page contains an old field')
            if (!Array.isArray(page.sentences)) throw new Error('Each page must have a sentences list')
            let previousSentenceEnd = 0
            for (const [sentencePosition, sentence] of page.sentences.entries()) {
                validateId(sentence, 'sentence_', seen)
                validateTiming(sentence, 'sentence')
                if (sentence.position !== sentencePosition || typeof sentence.text !== 'string') {
                    throw new Error('Each sentence must have an ordered position and text')
                }
                if (sentence.start_ms !== previousSentenceEnd) {
                    throw new Error('Sentence timings must be continuous')
                }
                if (!Array.isArray(sentence.words)) throw new Error('Each sentence must have a words list')
                let previousWordStart = 0
                for (const [wordPosition, word] of sentence.words.entries()) {
                    validateTiming(word, 'word')
                    if (word.position !== wordPosition || typeof word.text !== 'string') {
                        throw new Error('Each word must have an ordered position and text')
                    }
                    validateSourcePositions(word)
                    const midpointMs = (word.start_ms + word.end_ms) / 2
                    if (midpointMs < sentence.start_ms || midpointMs > sentence.end_ms) {
                        throw new Error('A word midpoint must stay inside its sentence')
                    }
                    if (word.start_ms < previousWordStart) throw new Error('Word timings must follow their stored order')
                    previousWordStart = word.start_ms
                }
                previousSentenceEnd = sentence.end_ms
            }
        }
    }
    return true
}

function validateId(item, prefix, seen) {
    if (typeof item?._id !== 'string' || !item._id.startsWith(prefix) || seen.has(item._id)) {
        throw new Error(`Invalid or repeated ${prefix.slice(0, -1)} id`)
    }
    seen.add(item._id)
}

function validateTiming(item, name) {
    if (!Number.isFinite(item?.start_ms) || !Number.isFinite(item?.end_ms)
        || item.start_ms < 0 || item.end_ms < item.start_ms) {
        throw new Error(`Invalid ${name} timing`)
    }
}

function validateSourcePositions(word) {
    const positions = word?.source_positions
    if (positions === undefined) return
    if (!Array.isArray(positions)
        || positions.some((position) => !Number.isInteger(position) || position < 0)
        || positions.some((position, index) => index > 0 && positions[index - 1] >= position)) {
        throw new Error('Invalid word source positions')
    }
}

module.exports = {
    newChapterId,
    newPageId,
    newSentenceId,
    iterChapters,
    iterLeafChapters,
    iterPages,
    findChapter,
    renameChapterInTree,
    findPage,
    findSentence,
    firstPageId,
    makeChapter,
    makePage,
    validateDocumentStructure,
}
