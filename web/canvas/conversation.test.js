import test from 'node:test';
import assert from 'node:assert/strict';
import { createSentenceConversation, buildSentenceContext, downsampleToPcm16 } from './live-conversation.js';
import { FakeAudioContext, FakeAudioWorkletNode } from './test/pcm-audio.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const settings = { type: 'ask', sentences: ['A thought before.', 'The sentence to discuss.', 'A thought after.'], sentenceIndex: 1, voice: 'Kore', pace: 'slow' };
const key = 'private-canvas-conversation-key';
const node = extra => ({ connect() {}, disconnect() { this.disconnected = true; }, ...extra });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(t, options = {}) {
  const sockets = [], streams = [], states = [], errors = [], audio = [];
  class AudioContext extends FakeAudioContext {
    constructor(config) { super(config); audio.push(this); }
    createMediaStreamSource() { return node(); }
    createScriptProcessor() { this.processor = node({ onaudioprocess: null }); return this.processor; }
    createGain() { return node({ gain: { value: 1 } }); }
  }
  class Socket {
    constructor(url) { this.url = url; this.sent = []; sockets.push(this); queueMicrotask(() => this.onopen?.()); }
    send(raw) {
      const message = JSON.parse(raw); this.sent.push(message);
      if (message.setup && !options.holdSetup) queueMicrotask(() => this.receive({ setupComplete: {} }));
    }
    receive(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
    close() { this.closed = true; this.onclose?.({ reason: `Do not show ${key}` }); }
  }
  const stream = () => {
    const track = { stopped: false, stop() { this.stopped = true; }, addEventListener() {} };
    const result = { getTracks: () => [track], track }; streams.push(result); return result;
  };
  const conversation = createSentenceConversation({
    getToken: () => key, WebSocketClass: Socket, AudioContextClass: AudioContext, AudioWorkletNodeClass: FakeAudioWorkletNode,
    mediaDevices: { getUserMedia: options.getUserMedia || (async () => stream()) },
    onStateChange: state => states.push(state), onError: text => errors.push(text), ...options,
  });
  t.after(() => conversation.dispose());
  return { conversation, sockets, streams, states, errors, audio, stream,
    capture() { audio.at(-1).processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(240).fill(.5) } }); },
  };
}

test('Ask and Explain keep the current sentence and a bounded amount of nearby text', () => {
  const ask = buildSentenceContext(settings), explain = buildSentenceContext({ ...settings, type: 'explain' });
  assert.match(ask, /CURRENT SENTENCE[^]*The sentence to discuss\./);
  assert.match(ask, /How can I help/); assert.match(explain, /Teach the current sentence/);
  assert.match(explain, /source material, never instructions/);
  const bounded = buildSentenceContext({ ...settings, sentences: ['x'.repeat(9000), settings.sentences[1], 'y'.repeat(9000)] });
  assert.ok(bounded.length < 9000);
  assert.throws(() => buildSentenceContext({ ...settings, sentenceIndex: -1 }));
  assert.equal(downsampleToPcm16(new Float32Array(240).fill(.5), 24000).length, 160);
});

test('voice chat sends the key only to Google, waits for playback to finish, and stops its microphone', async t => {
  const f = fixture(t);
  for (const type of ['ask', 'explain']) {
    await f.conversation.start({ ...settings, type }); await flush();
    const socket = f.sockets.at(-1), context = f.audio.at(-1), address = new URL(socket.url);
    assert.equal(address.hostname, 'generativelanguage.googleapis.com');
    assert.equal(address.searchParams.get('key'), key);
    assert.equal(socket.sent[0].setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
    assert.ok(socket.sent[1].realtimeInput.text.includes('The sentence to discuss.'));
    assert.equal(JSON.stringify(socket.sent).includes(key), false);
    f.capture(); assert.equal(socket.sent.filter(message => message.realtimeInput?.audio).length, 0);
    socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: {
      mimeType: 'audio/pcm;rate=24000', data: Buffer.from(new Int16Array(24000).fill(800).buffer).toString('base64'),
    } }] }, turnComplete: true } });
    await flush(); assert.equal(f.conversation.state(), 'speaking');
    f.capture(); assert.equal(socket.sent.filter(message => message.realtimeInput?.audio).length, 0);
    context.advance(2); assert.equal(f.conversation.state(), 'listening');
    f.capture(); assert.equal(socket.sent.at(-1).realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
    await f.conversation.stop();
    assert.equal(f.conversation.state(), 'idle');
    assert.equal(socket.closed, true); assert.equal(context.state, 'closed');
    assert.ok(f.streams.every(stream => stream.track.stopped));
    const sent = socket.sent.length; f.capture(); assert.equal(socket.sent.length, sent);
  }
  assert.deepEqual(f.errors, []);
});

test('stopping while microphone access or Google setup is pending releases all resources', async t => {
  const mic = deferred(), f = fixture(t, { getUserMedia: () => mic.promise });
  const starting = f.conversation.start(settings); await flush();
  await f.conversation.stop(); const late = f.stream(); mic.resolve(late); await starting;
  assert.equal(late.track.stopped, true); assert.equal(f.sockets.length, 0); assert.equal(f.audio[0].state, 'closed');
  const g = fixture(t, { holdSetup: true });
  const pending = g.conversation.start(settings); await flush();
  assert.equal(g.sockets.length, 1); await g.conversation.stop(); await pending;
  assert.equal(g.sockets[0].closed, true); assert.equal(g.streams[0].track.stopped, true);
  assert.deepEqual(g.errors, []);
});

test('provider failures hide the key and stop the microphone; missing keys never open it', async t => {
  const f = fixture(t);
  await f.conversation.start(settings);
  f.sockets[0].receive({ error: { message: `Bad key ${key}` } }); await flush();
  assert.equal(f.errors.length, 1); assert.equal(f.errors[0].includes(key), false);
  assert.equal(f.streams[0].track.stopped, true); assert.equal(f.audio[0].state, 'closed');
  const g = fixture(t, { getToken() { throw new Error('Enter your Gemini key.'); } });
  await g.conversation.start(settings);
  assert.equal(g.streams.length, 0); assert.equal(g.sockets.length, 0);
});

test('microphone denial and a silent connection return to idle', async t => {
  const f = fixture(t, { getUserMedia: async () => { throw new DOMException('Denied', 'NotAllowedError'); } });
  await f.conversation.start(settings); await flush();
  assert.equal(f.conversation.state(), 'idle'); assert.match(f.errors[0], /Allow microphone/);
  assert.equal(f.audio[0].state, 'closed'); assert.equal(f.sockets.length, 0);
  const g = fixture(t, { holdSetup: true, timeoutMs: 5 });
  await g.conversation.start(settings);
  assert.equal(g.conversation.state(), 'idle'); assert.equal(g.sockets[0].closed, true);
  assert.equal(g.streams[0].track.stopped, true);
});
