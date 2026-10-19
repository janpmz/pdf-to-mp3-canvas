import test from 'node:test';
import assert from 'node:assert/strict';
import { createExampleConversation } from './example-conversation.js';

function fixture(options = {}) {
  const clips = [], states = [], errors = [];
  class Audio {
    constructor(src) { this.src = src; this.paused = true; clips.push(this); }
    async play() { this.paused = false; this.onplaying?.(); }
    pause() { this.paused = true; }
    removeAttribute() { this.src = ''; }
    load() {}
  }
  const conversation = createExampleConversation({
    getToken() { throw Object.assign(new Error('Key needed'), { code: 'CANVAS_KEY_REQUIRED' }); },
    AudioClass: Audio, askFile: '/ask.mp3', explanationFiles: new Map([['First.', '/first.mp3'], ['Second.', '/second.mp3']]),
    onStateChange: state => states.push(state), onError: error => errors.push(error),
    createLive() { throw new Error('A saved demo must not open a live connection.'); }, ...options,
  });
  const settings = { type: 'explain', sentences: [{ text: 'First.' }, { text: 'Second.' }], sentenceIndex: 1 };
  return { conversation, clips, states, errors, settings };
}

test('saved Explain clips follow the selected sentence; Ask plays its own clip without a key', async () => {
  const f = fixture();
  await f.conversation.start(f.settings);
  assert.equal(f.clips[0].src, '/second.mp3');
  assert.equal(f.states.at(-1), 'speaking');
  f.clips[0].onended();
  assert.equal(f.states.at(-1), 'idle');
  await f.conversation.start({ ...f.settings, type: 'ask' });
  assert.equal(f.clips[1].src, '/ask.mp3');
  await f.conversation.stop();
  assert.equal(f.clips[1].paused, true);
  assert.equal(f.clips[1].src, '');
  assert.equal(f.states.at(-1), 'idle');
  assert.deepEqual(f.errors, []);
});

test('adding a key switches the example to live Ask and Explain', async () => {
  const calls = [];
  const f = fixture({ getToken: () => 'test-key', createLive: () => ({
    start: settings => calls.push(settings), stop: () => calls.push('stop'),
  }) });
  await f.conversation.start(f.settings);
  assert.deepEqual(calls, [f.settings]);
  assert.equal(f.clips.length, 0);
  await f.conversation.stop();
  assert.equal(calls.at(-1), 'stop');
});

test('stopping while a key check is pending prevents late playback', async () => {
  let resolve;
  const f = fixture({ getToken: () => new Promise(done => { resolve = done; }) });
  const starting = f.conversation.start(f.settings);
  await f.conversation.stop();
  resolve(''); await starting;
  assert.equal(f.clips.length, 0);
  assert.deepEqual(f.states, ['idle']);
});
