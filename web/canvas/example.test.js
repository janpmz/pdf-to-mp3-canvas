import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createCanvasExample } from './example.js';
import { EXAMPLE_RECORDINGS, EXAMPLE_VOICE } from './example-data.js';
import { createSentencePlayer } from './sentence-player.js';
import { FakeAudioContext, FakeAudioWorkletNode } from './test/pcm-audio.js';

const manifestUrl = new URL('./example-audio/kokoro-manifest.json', import.meta.url);
const fetchFiles = async url => new Response(await readFile(new URL(url)));

test('each saved example uses Kokoro audio and the word times for that exact audio', async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  assert.equal(manifest.source, 'kokoro');
  assert.equal(manifest.voice, EXAMPLE_VOICE);
  const example = createCanvasExample({ fetchAudio: fetchFiles });
  for (const [id, text] of EXAMPLE_RECORDINGS) {
    const clip = manifest.clips[id];
    const raw = await readFile(new URL(`./example-audio/${clip.file}`, import.meta.url));
    assert.equal(createHash('sha256').update(raw).digest('hex'), clip.audio_sha256);
    assert.equal(raw.length / 48000, clip.duration_seconds);
    let chunk;
    await example.playerOptions.speech.stream(text, { signal: new AbortController().signal,
      onChunk: (samples, rate, metadata) => { chunk = { samples, rate, metadata }; } });
    assert.equal(chunk.rate, 24000);
    assert.equal(chunk.samples.length / chunk.rate, clip.duration_seconds);
    assert.deepEqual(chunk.metadata.wordTimings.map(({ start, end }) => ({ start, end })),
      clip.words.map(({ start, end }) => ({ start, end })));
  }
});

test('example highlights follow the saved Kokoro word times on the audio clock', async t => {
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  const example = createCanvasExample({ fetchAudio: fetchFiles });
  let ready;
  const supplied = new Promise(resolve => { ready = resolve; });
  const player = createSentencePlayer({ ...example.playerOptions,
    speech: { stream: (...args) => example.playerOptions.speech.stream(...args).finally(ready) },
    AudioContextClass: FakeAudioContext, AudioWorkletNodeClass: FakeAudioWorkletNode,
    requireWordTimings: true, progressIntervalMs: 2,
  });
  t.after(() => player.dispose());
  const { data } = await example.request('/canvases/example');
  await player.load(data.chapters[0].pages[0].sentences, { play: false, sessionId: 'example' });
  await player.play();
  await supplied;
  await new Promise(resolve => setImmediate(resolve));
  const context = FakeAudioContext.latest;
  let previous = 0;
  for (const [index, word] of manifest.clips[EXAMPLE_RECORDINGS[0][0]].words.entries()) {
    const target = (word.start + word.end) / 2;
    context.advance(target - previous);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(player.getState().wordIndex, index, word.text);
    previous = target;
  }
});

test('changed audio never plays with the old word times', async () => {
  const example = createCanvasExample({ fetchAudio: async url => {
    const bytes = await readFile(new URL(url));
    if (new URL(url).pathname.endsWith('.pcm')) bytes[0] ^= 1;
    return new Response(bytes);
  } });
  let played = false;
  await assert.rejects(example.playerOptions.speech.stream(EXAMPLE_RECORDINGS[0][1], {
    signal: new AbortController().signal, onChunk: () => { played = true; },
  }), /speech and word times do not match/);
  assert.equal(played, false);
});
