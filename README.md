# PDFTOMP3 Text Player Canvas

PDFTOMP3-Canvas is a text player for AI agents. It uses text-to-speech. The AI sends text into the canvas, and the user can listen sentence by sentence.

Example: [Try the player](https://pdftomp3.com/canvas/?example=1)

## Use from your AI

Paste this prompt into an AI that can read web pages and send requests:

```text
Send text into the PDF TO MP3 Canvas please so I can listen to it, and then open the player link.
Read https://pdftomp3.com/canvas/guide.html.

[My request / explain which text you want to listen to]
```

The guide explains the JSON format and how to send text. It also gives optional tips for readings and teacher explanations.

The AI agent needs to:

1. Prepare the spoken text.
2. Send it to the server in the required JSON format, as shown in the guide.
3. Open the returned link so the user can listen.

No account or plugin is needed. Anyone with the link can read the text.

## Speech and privacy

- Enter your Gemini key in the player. The key stays locally in your browser and is not sent or stored on our server. The browser sends it only to Google. It stays saved until you choose “Forget key”.
- Canvas prepares the current sentence and up to two ahead. Changing the voice does not rebuild speech for the whole reading.
- Ask starts a voice chat about the current sentence. Explain teaches it, then listens for questions.
- Audio and reading position stay in your browser. Text stays on the server, so the same link works on other devices. Canvases do not expire.

## Local use

Needs Node.js 20 or newer and a running MongoDB. From the repository root:

```sh
npm --prefix node install
CANVAS_PORT=3000 CANVAS_WEBSITE_URL=http://localhost:3000 node node/tasks/runCanvas.js
```

Open [Canvas](http://localhost:3000/canvas/) or the [AI guide](http://localhost:3000/canvas/guide.html).

## Review the source

The browser code is in `web/canvas/`; the text API is in `node/src/canvas/`. To check key use, start with `canvas.js`, `speech.js`, and `live-connection.js` in the browser folder.

From the main PDFTOMP3 project, export just Canvas with `node canvas/export.mjs /tmp/pdftomp3-canvas`. The output folder must not exist yet.
