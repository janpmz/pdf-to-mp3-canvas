import test from 'node:test';
import assert from 'node:assert/strict';
import { createFreeSpeech, decodeFreePcm, freeAudioCacheKey, mapWordTimes } from './free-speech.js';
import { createSentencePlayer } from './sentence-player.js';
import { FakeAudioContext, FakeAudioWorkletNode } from './test/pcm-audio.js';

test('the browser sends only a voice for a saved sentence and decodes the server audio', async () => {
  const calls = [], chunks = [];
  const speech = createFreeSpeech({ apiBase: 'http://localhost:3000/canvas-api', fetchImpl: async (url, init) => {
    calls.push({ url, ...init });
    return Response.json({ sample_rate: 24000, audio: Buffer.from([0, 0, 0, 64, 0, 192]).toString('base64'),
      timing_source: 'kokoro', words: [{ text: 'Read', start: 0, end: 3 / 24000 }] });
  } });
  await speech.stream('Read', { sessionId: 'canvas-a', sentenceId: 'sentence-a', voice: 'af_heart',
    onChunk: (samples, rate, metadata) => { chunks.push([...samples]); assert.equal(rate, 24000);
      assert.deepEqual(metadata.wordTimings, [{ index: 0, start: 0, end: 3 / 24000 }]); } });
  assert.equal(calls[0].url, 'http://localhost:3000/canvas-api/canvases/canvas-a/sentences/sentence-a/speech');
  assert.deepEqual(JSON.parse(calls[0].body), { voice: 'af_heart' });
  assert.equal(calls[0].credentials, 'omit');
  assert.deepEqual(chunks, [[0, .5, -.5]]);
  assert.throws(() => decodeFreePcm(new Uint8Array([1]).buffer));
  assert.notEqual(await freeAudioCacheKey('Hello.', { sessionId: 'a', voice: 'af_heart' }),
    await freeAudioCacheKey('Hello.', { sessionId: 'a', voice: 'af_bella' }));
});
test('failed and cancelled speech never plays audio or displays upstream replies', async () => {
  const speech = createFreeSpeech({ apiBase: '/canvas-api', fetchImpl: async () => new Response('private-key-in-upstream-error', { status: 502 }) });
  await assert.rejects(speech.stream('Hello.', { sessionId: 'a', sentenceId: 'b' }), error => !error.message.includes('private-key'));
  let called = false;
  const controller = new AbortController(); controller.abort();
  await assert.rejects(speech.stream('Hello.', { sessionId: 'a', sentenceId: 'b', signal: controller.signal,
    onChunk: () => { called = true; } }), error => error.name === 'AbortError');
  assert.equal(called, false);
});
test('the sentence player passes Kokoro voice and stored sentence ID without asking for a key', async t => {
  const calls = [];
  const player = createSentencePlayer({ defaultVoice: 'af_heart', voices: ['af_heart', 'af_bella'],
    AudioContextClass: FakeAudioContext, AudioWorkletNodeClass: FakeAudioWorkletNode,
    cacheKey: async text => text, cache: { get: async () => null, put: async () => {} },
    speech: { async stream(text, options) { calls.push({ text, ...options }); options.onChunk(new Float32Array(24000), 24000); } },
  });
  t.after(() => player.dispose());
  await player.load([{ _id: 'sentence-a', text: 'Hello there.' }], { play: false, sessionId: 'canvas-a' });
  assert.equal(calls.length, 0);
  await player.setVoice('af_bella'); await player.play(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0].voice, 'af_bella'); assert.equal(calls[0].sentenceId, 'sentence-a'); assert.equal(calls[0].sessionId, 'canvas-a');
});


test('word times map contractions and punctuation to displayed words without making up times', () => {
  assert.deepEqual(mapWordTimes("Don't rush, café.", [
    { text: 'Do', start: .1, end: .2 }, { text: "n't", start: .2, end: .4 },
    { text: 'rush', start: 1, end: 1.1 }, { text: 'café', start: 1.2, end: 1.8 },
  ], 2), [{ index: 0, start: .1, end: .4 }, { index: 1, start: 1, end: 1.1 }, { index: 2, start: 1.2, end: 1.8 }]);
  assert.deepEqual(mapWordTimes('Read.', [{ text: 'Different', start: 0, end: .5 }], 1), []);
  assert.deepEqual(mapWordTimes('Read.', [{ text: 'Read', start: -1, end: .5 }], 1), []);
});
