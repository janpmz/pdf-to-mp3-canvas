import test from 'node:test';
import assert from 'node:assert/strict';
import { createSentencePlayer } from './sentence-player.js';
import { encodeCachedAudio, decodeCachedAudio } from './audio-cache.js';
import { FakeAudioContext, FakeAudioWorkletNode } from './test/pcm-audio.js';

const wordTimings = [{ index: 0, start: .2, end: .4 }, { index: 1, start: 1.4, end: 1.8 }];
const flush = () => new Promise(resolve => setImmediate(resolve));
const tick = () => new Promise(resolve => setTimeout(resolve, 12));
function fixture(t, options = {}) {
  const player = createSentencePlayer({ AudioContextClass: FakeAudioContext, AudioWorkletNodeClass: FakeAudioWorkletNode,
    requireWordTimings: true, progressIntervalMs: 2,
    cacheKey: async () => 'same-audio', cache: { get: async () => null, put: async () => {} },
    speech: { async stream(text, { onChunk }) { onChunk(new Float32Array(48000), 24000, { wordTimings }); } }, ...options,
  });
  t.after(() => player.dispose());
  return player;
}
async function start(player) {
  await player.load([{ _id: 'sentence-a', text: 'Longword tiny.' }], { play: false, sessionId: 'canvas-a' });
  await player.play(); await flush();
}
test('highlights use actual word starts and ends, stay off during pauses, and resume on the audio clock', async t => {
  const player = fixture(t); await start(player);
  const context = FakeAudioContext.latest;
  context.advance(.1); await tick(); assert.equal(player.getState().wordIndex, -1);
  context.advance(.2); await tick(); assert.equal(player.getState().wordIndex, 0);
  player.pause(); context.advance(.3); await tick(); assert.equal(player.getState().wordIndex, 0);
  await player.play(); context.advance(.4); await tick(); assert.equal(player.getState().wordIndex, -1);
  context.advance(.8); await tick(); assert.equal(player.getState().wordIndex, 1);
  context.advance(.4); await tick(); assert.equal(player.getState().wordIndex, -1);
  context.advance(.2); await tick(); assert.equal(player.getState().status, 'ended'); assert.equal(player.getState().wordIndex, -1);
});
test('saving and reopening audio keeps its word times, and a replay does not request speech again', async t => {
  const saved = new Map(); let calls = 0;
  const cache = { get: async key => saved.has(key) ? decodeCachedAudio(saved.get(key)) : null,
    put: async (key, audio) => saved.set(key, encodeCachedAudio(audio)) };
  const first = fixture(t, { cache, speech: { async stream(text, { onChunk }) { calls++; onChunk(new Float32Array(48000), 24000, { wordTimings }); } } });
  await start(first); await flush();
  assert.deepEqual(saved.get('same-audio').wordTimings, wordTimings);
  await first.dispose();
  const reopened = fixture(t, { cache, speech: { async stream() { calls++; throw new Error('Cached audio must not ask for speech.'); } } });
  await start(reopened);
  FakeAudioContext.latest.advance(.7); await tick(); assert.equal(reopened.getState().wordIndex, -1);
  FakeAudioContext.latest.advance(.8); await tick(); assert.equal(reopened.getState().wordIndex, 1);
  await reopened.replay(); await flush(); FakeAudioContext.latest.advance(.3); await tick();
  assert.equal(reopened.getState().wordIndex, 0); assert.equal(calls, 1);
});
test('free speech with no matching times plays without estimated word highlights', async t => {
  const player = fixture(t, { speech: { async stream(text, { onChunk }) { onChunk(new Float32Array(48000), 24000, { wordTimings: [] }); } } });
  await start(player); FakeAudioContext.latest.advance(1); await tick(); assert.equal(player.getState().wordIndex, -1);
});
