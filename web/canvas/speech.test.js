import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveSpeech, decodePcm, LIVE_MODEL } from './speech.js';

class FakeSocket {
  static instances = [];
  constructor(url) { this.url = url; this.sent = []; FakeSocket.instances.push(this); queueMicrotask(() => this.onopen?.()); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.closed = true; }
  receive(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function audio() { return { inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.from(new Int16Array([0, 16384, -16384]).buffer).toString('base64') } }; }

test('a key goes only to a Google socket; setup precedes one exact-reading request', async () => {
  const key = 'private-gemini-test-key';
  const chunks = [];
  const speech = createLiveSpeech({ getToken: () => key, WebSocketClass: FakeSocket });
  const work = speech.stream('Read only this sentence.', { voice: 'Kore', pace: 'normal', onChunk: chunk => chunks.push(chunk) });
  await flush();
  const socket = FakeSocket.instances.at(-1), url = new URL(socket.url);
  assert.equal(url.hostname, 'generativelanguage.googleapis.com');
  assert.equal(url.protocol, 'wss:');
  assert.equal(url.searchParams.get('key'), key);
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].setup.model, `models/${LIVE_MODEL}`);
  assert.equal(socket.sent[0].setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
  assert.equal(JSON.stringify(socket.sent).includes(key), false);
  socket.receive({ setupComplete: {} }); await flush();
  assert.deepEqual(socket.sent[1], { realtimeInput: { text: 'Read only this sentence.' } });
  socket.receive({ serverContent: { modelTurn: { parts: [audio()] }, turnComplete: true } });
  const result = await work;
  assert.equal(result.sampleRate, 24000); assert.equal(chunks.length, 1); assert.equal(socket.closed, true);
  assert.deepEqual([...chunks[0]], [0, .5, -.5]);
});

test('cancellation closes the live connection and provider errors never reveal credentials', async () => {
  const speech = createLiveSpeech({ getToken: () => 'private-test-key', WebSocketClass: FakeSocket });
  const controller = new AbortController();
  const work = speech.stream('Cancel me.', { signal: controller.signal });
  const rejected = assert.rejects(work, error => error.name === 'AbortError');
  await flush(); const socket = FakeSocket.instances.at(-1);
  controller.abort(); await rejected; assert.equal(socket.closed, true);
  const failure = speech.stream('Fail safely.');
  const safe = assert.rejects(failure, error => !error.message.includes('private-test-key'));
  await flush();
  FakeSocket.instances.at(-1).receive({ error: { message: 'Bad private-test-key at a provider URL' } });
  await safe;
});

test('no key means no socket, and invalid or wrong-rate audio cannot play', async () => {
  const count = FakeSocket.instances.length;
  const missing = createLiveSpeech({ getToken: () => { throw new Error('Key needed'); }, WebSocketClass: FakeSocket });
  await assert.rejects(missing.stream('No key.'), /Key needed/);
  assert.equal(FakeSocket.instances.length, count);
  assert.throws(() => decodePcm(Buffer.from([1]).toString('base64')));
  const speech = createLiveSpeech({ getToken: () => 'test-key', WebSocketClass: FakeSocket });
  const work = speech.stream('Wrong rate.'); const rejected = assert.rejects(work, /Speech could not start/);
  await flush();
  FakeSocket.instances.at(-1).receive({ serverContent: { modelTurn: { parts: [{ inlineData: { ...audio().inlineData, mimeType: 'audio/pcm;rate=16000' } }] } } });
  await rejected;
});
