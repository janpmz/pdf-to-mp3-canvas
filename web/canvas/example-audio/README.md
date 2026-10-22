The public example uses the `kokoro-*.pcm` recordings.
Kokoro makes the audio and word times together with the Heart voice (`af_heart`).
`kokoro-manifest.json` holds the text, word times, length, and hash for each recording.
The player checks the hash before it plays a recording. It uses the returned word times without estimates.

Run `node node/tasks/generateCanvasExampleAudio.js` to make the files again.
The task uses the same speech service as the free player. It checks the word times against the returned audio.
The browser plays the saved files without a key or a new speech request.

The numbered MP3 files keep the old landing-page recordings for the saved Gemini code.
The public example does not load those files. The public player has no Ask or Explain buttons.

The saved Gemini clips `ask.mp3` and `explain-*.mp3` use the words in `feature-texts.json`.
They use the Enceladus voice and tell listeners how to add their Gemini key.
`feature-manifest.json` records each clip's text, length, and file hash.
