import { createSentenceConversation } from './live-conversation.js';

export function createExampleConversation(options = {}) {
  const AudioClass = options.AudioClass || globalThis.Audio;
  const createLive = options.createLive || createSentenceConversation;
  let audio = null, live = null, revision = 0;

  function clearAudio() {
    if (!audio) return;
    audio.onplaying = audio.onended = audio.onerror = null;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    audio = null;
  }
  async function stop() {
    revision++;
    clearAudio();
    await live?.stop();
    options.onStateChange?.('idle');
  }
  async function start(settings) {
    const run = ++revision;
    clearAudio();
    let key;
    try { key = await options.getToken(); }
    catch (error) { if (error.code !== 'CANVAS_KEY_REQUIRED') throw error; }
    if (run !== revision) return;
    if (key) {
      live ||= createLive(options);
      return live.start(settings);
    }
    const text = settings.sentences?.[settings.sentenceIndex]?.text;
    const file = settings.type === 'ask' ? options.askFile : options.explanationFiles.get(text);
    if (!file || !AudioClass) {
      options.onError?.('The example audio could not load. Please try again.');
      options.onStateChange?.('idle');
      return;
    }
    const current = audio = new AudioClass(file);
    const finish = () => {
      if (run !== revision) return;
      clearAudio();
      options.onStateChange?.('idle');
    };
    current.onplaying = () => { if (run === revision) options.onStateChange?.('speaking'); };
    current.onended = finish;
    current.onerror = () => {
      if (run !== revision) return;
      options.onError?.('The example audio could not load. Please try again.');
      finish();
    };
    options.onStateChange?.('connecting');
    try { await current.play(); }
    catch { current.onerror?.(); }
  }
  return { requiresKey: false, start, stop, dispose: stop };
}
