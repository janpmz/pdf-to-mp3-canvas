# Free Canvas test

This local `free-canvas` branch uses the existing Kokoro service. Users send text, open Canvas, and press Play. They need no key or account. Canvas uses the website’s player layout and its unchanged player-page.css: chapter sidebar, one page at a time, page arrows, and word highlights. Click a sentence to play it. Chapter and page jumps keep speech paused when it was paused. Canvas opens in dark focus mode at every window size; add `focus=0` to the link to open the page view. The focus button uses the website’s focus view and keeps the same speech and word times. Escape returns to the page view. Voice selection and the Canvas menu stay available in focus mode at every window size. Ask and Explain are absent. Speed stays at Normal for this test.

## Run locally

Needs Node.js 20 or newer and MongoDB. Install the packages, copy `node/.env.example` to `node/.env`, and set the two `FREETTS_` values to the existing service settings. Keep that file out of Git.

```sh
npm --prefix node install
npm --prefix node start
```

Open [Canvas](http://localhost:3000/canvas/) or [the live speech test](http://localhost:3000/canvas/?example=1). The test creates a reading and uses real Kokoro speech; it does not play the old recorded demo. The default server still uses port 8702 unless `CANVAS_PORT=3000` is set in `node/.env`.

The [AI guide](http://localhost:3000/canvas/guide.html) covers text uploads. Text and sharing work as before. Anyone with the reading link can read and listen.

## Speech

The browser requests speech for a saved sentence. The server reads that sentence, checks the voice against the reading language, queues Kokoro, checks its progress, and returns 24 kHz mono PCM sound. The service key stays on the server. The browser never talks to Google or asks for a key.

Playback waits for the current sentence, then prepares up to two more within a 120-word limit. Repeat uses saved audio. A bounded server cache reuses recent sound. Both sites still share the existing speech queue, so other jobs can delay this test. Word highlights use Kokoro’s word start and end times, checked against the audio length and file hash. The browser saves those times with the sound. If the service has no word times for a language, the sentence still plays without word highlights.

`node/src/canvas/freeSpeech.js` handles the service. `web/canvas/free-speech.js` plays its replies. The voice list comes unchanged from the existing `freetts/node/src/voices.js` in the local free speech project.

## Checks

```sh
npm --prefix node test
```

The tests use fake speech unless you start the local server with the real service settings. This branch has not been pushed or deployed.
