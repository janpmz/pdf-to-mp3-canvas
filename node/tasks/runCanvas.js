// Canvas test server. The free speech service settings load only on the server.
const express = require('express')
const { MongoClient } = require('mongodb')
const path = require('node:path')
const { readFile } = require('node:fs/promises')
const { statSync } = require('node:fs')
const { createCanvasRouter } = require('../src/canvas/router')

require('dotenv').config({ path: process.env.CANVAS_ENV_FILE || path.resolve(__dirname, '../.env'), quiet: true })

async function main() {
    const port = Number(process.env.CANVAS_PORT || 8702)
    const websiteUrl = process.env.CANVAS_WEBSITE_URL || 'http://localhost:3000'
    const client = new MongoClient(process.env.CANVAS_MONGO_URL || 'mongodb://127.0.0.1:27017')
    await client.connect()
    const db = client.db(process.env.CANVAS_DB_NAME || 'documentplayer_mono')
    const app = express()
    app.set('trust proxy', 'loopback')
    app.use('/canvas-api', createCanvasRouter({ getDb: async () => db, websiteUrl }))
    const web = path.resolve(__dirname, '../../web')
    app.get(['/canvas/', '/canvas/index.html', '/canvas/guide.html'], async (req, res) => {
        const file = req.path.endsWith('guide.html') ? 'guide.html' : 'index.html'
        const html = await readFile(path.join(web, 'canvas', file), 'utf8')
        res.type('html').send(html.replace('name="canvas-api" content=""', 'name="canvas-api" content="/canvas-api"')
            .replaceAll('https://pdftomp3.com/canvas-api', new URL('/canvas-api', websiteUrl).href))
    })
    app.use('/canvas', express.static(path.join(web, 'canvas')))
    for (const file of require('../../web/canvas/shared-files.json')) {
        const source = path.join(web, file)
        if (statSync(source).isDirectory()) app.use(`/${file}`, express.static(source))
        else app.get(`/${file}`, (req, res) => res.sendFile(source))
    }
    app.get('/favicon.ico', (req, res) => res.sendFile(path.join(web, 'favicon.ico')))
    app.get('/', (req, res) => res.redirect('/canvas/'))
    const server = app.listen(port, process.env.CANVAS_BIND || '127.0.0.1', () => console.log(`Canvas API ready on port ${port}`))
    async function stop() { server.closeAllConnections(); server.close(); await client.close(); process.exit(0) }
    process.once('SIGINT', stop); process.once('SIGTERM', stop)
}
main().catch(() => { console.error('Could not start Canvas. Check MongoDB and the chosen port.'); process.exitCode = 1 })
