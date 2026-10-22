import assert from 'node:assert/strict';
import test from 'node:test';
import { createSentencePlayer, lookaheadSentences } from './sentence-player.js';
import { FakeAudioContext, FakeAudioWorkletNode } from './test/pcm-audio.js';
import { canvasSentences, canvasPrompt, canvasPage } from './model.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const tick = () => new Promise(resolve => setTimeout(resolve, 12));
const sentences = ['First thought.', 'Second thought.', 'Third thought.', 'Fourth thought.'].map((text, index) => ({
  _id: `sentence_${index}`, text, chapterId: index < 2 ? 'chapter_a' : 'chapter_b',
}));
function fixture(t) {
  const calls = [], saved = new Map();
  const player = createSentencePlayer({ AudioContextClass: FakeAudioContext, AudioWorkletNodeClass: FakeAudioWorkletNode,
    progressIntervalMs: 2, prefetchWithoutAutoplay: true,
    cacheKey: async text => text, cache: { get: async key => saved.get(key), put: async (key, audio) => saved.set(key, audio) },
    speech: { stream(text, { signal, onChunk }) { return new Promise((resolve, reject) => {
      const call = { text, signal, chunk() { onChunk(new Float32Array(24000).fill(.2), 24000); }, done() { resolve(); } };
      calls.push(call); signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')));
    }); } },
  });
  t.after(() => player.dispose());
  return { player, calls, saved, get context() { return FakeAudioContext.latest; } };
}

test('stored sentence IDs support silent chapter jumps and local position restore', async t => {
  const f = fixture(t);
  await f.player.load(sentences, { play: false, sentenceIndex: 1, sessionId: 'canvas-one' });
  assert.equal(f.player.getState().sentences[1]._id, 'sentence_1');
  assert.equal(f.calls.length, 0);
  f.player.selectSentence(2);
  assert.equal(f.player.getState().sentenceIndex, 2);
  assert.equal(f.calls.length, 0);
  await f.player.play(); await flush();
  assert.equal(f.calls[0].text, 'Third thought.');
});

test('only current and next two sentences stream; pausing cancels pending lookahead', async t => {
  const f = fixture(t); f.player.setAutoplay(true);
  await f.player.load(sentences, { play: false }); await f.player.play(); await flush();
  assert.equal(f.calls.length, 1);
  f.calls[0].chunk(); f.context.advanceFrames(12000); await tick();
  assert.equal(f.calls.length, 3);
  assert.equal(f.player.getState().playing, true);
  assert.ok(f.player.getState().wordIndex >= 0);
  f.player.pause();
  assert.equal(f.calls[1].signal.aborted, true);
  assert.equal(f.calls[2].signal.aborted, true);
  assert.deepEqual(lookaheadSentences([{ words: [] }, { words: Array(121).fill({}) }, { words: [{}] }], 0), []);
});

test('AI appends do not restart current sound; edits preserve place and stop old work', async t => {
  const f = fixture(t);
  await f.player.load(sentences.slice(0, 2), { play: false, sessionId: 'canvas-one' });
  await f.player.play(); await flush(); f.calls[0].chunk();
  const first = f.calls[0];
  await f.player.updateSentences(sentences, { sessionId: 'canvas-one' });
  assert.equal(first.signal.aborted, false);
  assert.equal(f.player.getState().sentences.length, 4);
  assert.equal(f.player.getState().sentenceIndex, 0);
  await f.player.updateSentences([{ ...sentences[0], text: 'Edited words.', _id: 'sentence_new' }, ...sentences.slice(1)]);
  assert.equal(first.signal.aborted, true);
  assert.equal(f.player.getState().playing, false);
  assert.equal(f.player.getState().sentences[0].text, 'Edited words.');
});

test('chapter nesting maps to sentence jumps and prompts keep provider keys out of the API', () => {
  const model = canvasSentences({ chapters: [{ _id: 'chapter_a', title: 'Parent', pages: [], subchapters: [
    { _id: 'chapter_b', title: 'Child', pages: [{ _id: 'page_a', sentences: [sentences[0]] }], subchapters: [] },
  ] }] });
  assert.equal(model.chapters[0].startIndex, 0);
  assert.equal(model.chapters[0].endIndex, 1);
  assert.equal(model.chapters[1].depth, 1);
  assert.equal(model.sentences[0].chapterId, 'chapter_b');
  const prompt = canvasPrompt({ canvas: { _id: 'abc', url: 'http://localhost:3000/canvas/?id=abc' },
    apiBase: 'http://localhost:8702/canvas-api', uploadCode: 'upload-only', expiresAt: '2026-10-20T12:00:00Z' });
  assert.match(prompt, /Bearer UPLOAD_CODE/);
  assert.match(prompt, /Never ask for a speech key/);
  assert.match(prompt, /http:\/\/localhost:3000\/canvas\/guide.html/);
});

test('seeking a sentence starts speech from idle or paused, and can restart the current sentence', async t => {
  const f = fixture(t);
  await f.player.load(sentences, { play: false, sessionId: 'canvas-clicks' });
  await f.player.seekSentence(1); await flush();
  assert.equal(f.player.getState().sentenceIndex, 1);
  assert.equal(f.player.getState().loading, true);
  assert.equal(f.calls[0].text, 'Second thought.');
  f.calls[0].chunk(); f.calls[0].done(); await flush();
  f.context.advanceFrames(12000); await tick();
  f.player.pause();
  assert.equal(f.player.getState().status, 'paused');
  await f.player.seekSentence(2); await flush();
  assert.equal(f.player.getState().sentenceIndex, 2);
  assert.equal(f.player.getState().loading, true);
  assert.ok(f.calls.some(call => call.text === 'Third thought.' && !call.signal.aborted));
  f.player.pause();
  await f.player.seekSentence(2); await flush();
  assert.equal(f.player.getState().loading, true);
  assert.equal(f.player.getState().sentenceIndex, 2);
});

test('clicking the playing sentence stops sound; another sentence starts from its beginning', async t => {
  const f = fixture(t);
  await f.player.load(sentences, { play: false, sessionId: 'canvas-click-stop' });
  await f.player.clickSentence(); await flush();
  f.calls[0].chunk(); f.calls[0].done(); await flush();
  f.context.advanceFrames(12000); await tick();
  assert.equal(f.player.getState().playing, true);
  const position = f.player.getState().position;
  const speechCalls = f.calls.length;
  await f.player.clickSentence();
  assert.equal(f.player.getState().status, 'paused');
  assert.equal(f.context.state, 'suspended');
  f.context.advanceFrames(12000); await tick();
  assert.equal(f.player.getState().position, position);
  assert.equal(f.calls.length, speechCalls);

  await f.player.clickSentence(1); await flush();
  assert.equal(f.player.getState().sentenceIndex, 1);
  assert.equal(f.player.getState().position, 0);
  assert.equal(f.player.getState().loading, true);
  assert.equal(f.context.state, 'running');
  const second = f.calls.findLast(call => call.text === 'Second thought.' && !call.signal.aborted);
  assert.ok(second);
  second.chunk(); second.done(); await flush();
  f.context.advanceFrames(12000); await tick();
  assert.equal(f.player.getState().playing, true);
  await f.player.clickSentence(1);
  assert.equal(f.player.getState().status, 'paused');
  assert.equal(f.context.state, 'suspended');

  await f.player.clickSentence(1); await flush();
  assert.equal(f.player.getState().sentenceIndex, 1);
  assert.equal(f.player.getState().position, 0);
  f.context.advanceFrames(24000); await tick();
  assert.equal(f.player.getState().status, 'ended');
  await f.player.clickSentence(); await flush();
  assert.equal(f.player.getState().sentenceIndex, 1);
  assert.equal(f.player.getState().position, 0);
  assert.equal(f.player.getState().loading, true);
});

test('clicking a sentence while its sound loads stops it before sound arrives', async t => {
  const f = fixture(t);
  await f.player.load(sentences, { play: false });
  await f.player.clickSentence(0); await flush();
  assert.equal(f.player.getState().loading, true);
  await f.player.clickSentence(0);
  assert.equal(f.player.getState().status, 'paused');
  f.calls[0].chunk(); f.calls[0].done(); await flush();
  f.context.advanceFrames(12000); await tick();
  assert.equal(f.player.getState().status, 'paused');
  assert.equal(f.player.getState().position, 0);
  assert.equal(f.context.state, 'suspended');
  assert.equal(f.calls.length, 1);
});

test('page ranges keep chapters separate and locate the page after a sentence change or saved position', () => {
  const model = canvasSentences({ chapters: [
    { _id: 'a', title: 'First chapter', pages: [
      { _id: 'a1', title: 'First page', sentences: sentences.slice(0, 2) },
      { _id: 'a2', title: 'Second page', sentences: sentences.slice(2, 3) },
    ], subchapters: [] },
    { _id: 'b', title: 'Section', pages: [], subchapters: [
      { _id: 'c', title: 'Child chapter', pages: [{ _id: 'c1', sentences: sentences.slice(3) }], subchapters: [] },
    ] },
  ] });
  assert.equal(model.pages.length, 3);
  assert.equal(canvasPage(model, 1).id, 'a1');
  assert.equal(canvasPage(model, 2).id, 'a2');
  assert.equal(canvasPage(model, 2).number, 2);
  assert.equal(canvasPage(model, 2).total, 2);
  assert.equal(canvasPage(model, 3).chapterId, 'c');
  assert.equal(canvasPage(model, 3).number, 1);
  assert.equal(model.chapters[1].startIndex, model.pages[2].startIndex);
  assert.equal(canvasPage(model, 4), undefined);
  const empty = canvasSentences({ chapters: [] });
  assert.deepEqual(empty.pages, []);
  assert.deepEqual(empty.chapters, []);
  assert.equal(canvasPage(empty, 0), undefined);
});
