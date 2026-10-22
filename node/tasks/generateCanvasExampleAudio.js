// Make the saved example with the same Kokoro service as the free player.
const { createHash } = require('node:crypto')
const { mkdir, mkdtemp, readFile, rename, rm, writeFile } = require('node:fs/promises')
const path = require('node:path')
const { createFreeSpeech, SAMPLE_RATE } = require('../src/canvas/freeSpeech')

require('dotenv').config({ path: process.env.CANVAS_ENV_FILE || path.resolve(__dirname, '../.env'), quiet: true })

async function main() {
    const { EXAMPLE_VOICE, EXAMPLE_RECORDINGS } = await import('../../web/canvas/example-data.js')
    const { mapWordTimes } = await import('../../web/canvas/free-speech.js')
    const output = path.resolve(__dirname, '../../web/canvas/example-audio')
    const speech = createFreeSpeech({ url: process.env.FREETTS_URL, secret: process.env.FREETTS_SECRET })
    await mkdir(output, { recursive: true })
    const temporary = await mkdtemp(path.join(output, '.kokoro-build-'))
    const manifest = { version: 1, source: 'kokoro', voice: EXAMPLE_VOICE, sample_rate: SAMPLE_RATE, clips: {} }
    try {
        for (const [id, text] of EXAMPLE_RECORDINGS) {
            const { pcm, words } = await speech.synthesize(text, EXAMPLE_VOICE, 'saved-canvas-example')
            const duration = pcm.length / (SAMPLE_RATE * 2)
            if (!words.length || !mapWordTimes(text, words, duration).length) {
                throw new Error('Kokoro did not return matching word times. The saved example did not change.')
            }
            const sha256 = createHash('sha256').update(pcm).digest('hex')
            const file = `kokoro-${id}-${sha256.slice(0, 16)}.pcm`
            await writeFile(path.join(temporary, file), pcm)
            manifest.clips[id] = { text, file, bytes: pcm.length, duration_seconds: duration, audio_sha256: sha256, words }
            console.log(`Prepared ${id}: ${duration.toFixed(2)} seconds, ${words.length} word times.`)
        }
        const files = Object.values(manifest.clips).map(clip => clip.file)
        for (const file of files) await writeFile(path.join(output, file), await readFile(path.join(temporary, file)))
        await writeFile(path.join(temporary, 'kokoro-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
        await rename(path.join(temporary, 'kokoro-manifest.json'), path.join(output, 'kokoro-manifest.json'))
        console.log('Saved the Kokoro example and its word times.')
    } finally {
        await rm(temporary, { recursive: true, force: true })
    }
}

main().catch(error => {
    console.error(error.status ? `Kokoro example failed with status ${error.status}.` : error.message)
    process.exitCode = 1
})
