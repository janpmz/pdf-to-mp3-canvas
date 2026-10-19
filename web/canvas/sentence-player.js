import { createLiveSpeech, OUTPUT_SAMPLE_RATE } from "./speech.js";
import { audioCacheKey, createAudioCache } from "./audio-cache.js";
import { PcmPlaybackQueue } from "./pcm-playback-queue.js";
import { PACES, VOICES, normalizePace, normalizeVoice, paceFromSpeed } from "./speech-options.js";

export const MAX_LOOKAHEAD_SENTENCES = 2;
export const MAX_LOOKAHEAD_WORDS = 120;

export function lookaheadSentences(sentences, currentIndex) {
  const result = [];
  let words = 0;
  for (let index = currentIndex + 1; index < sentences.length && result.length < MAX_LOOKAHEAD_SENTENCES; index += 1) {
    words += sentences[index].words.length;
    if (words > MAX_LOOKAHEAD_WORDS) break;
    result.push(index);
  }
  return result;
}

export function splitSentences(value) {
  const text = String(value || "");
  const spans = typeof Intl.Segmenter === "function"
    ? Array.from(new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(text), ({ segment, index }) => ({ text: segment, start: index }))
    : Array.from(text.matchAll(/[^.!?。！？\n]+(?:[.!?。！？]+[\u201d\u2019"']*|\n+|$)/gu), (match) => ({ text: match[0], start: match.index }));
  return spans.filter((span) => span.text.trim()).map((span) => {
    const leading = span.text.length - span.text.trimStart().length;
    const sentence = span.text.trim();
    const start = span.start + leading;
    const segments = typeof Intl.Segmenter === "function"
      ? Array.from(new Intl.Segmenter(undefined, { granularity: "word" }).segment(sentence)).filter((part) => part.isWordLike)
      : Array.from(sentence.matchAll(/\S+/gu), (match) => ({ segment: match[0], index: match.index }));
    return {
      text: sentence, start, end: start + sentence.length,
      words: segments.map((part) => ({ text: part.segment, start: start + part.index, end: start + part.index + part.segment.length })),
    };
  });
}

// Canvas owns its reader. Stored sentence IDs and chapter jumps do not alter the app player.
export function createSentencePlayer(options = {}) {
  const speech = options.speech || createLiveSpeech(options);
  const cache = options.cache || createAudioCache();
  const makeKey = options.cacheKey || audioCacheKey;
  const AudioContextClass = options.AudioContextClass || globalThis.AudioContext || globalThis.webkitAudioContext;
  const onState = options.onStateChange || (() => {});
  const onProgress = options.onProgress || (() => {});
  const onError = options.onError || (() => {});
  const maxMemoryBytes = Math.max(0, options.maxMemoryBytes ?? 64 * 1024 * 1024);
  const prefetchWithoutAutoplay = options.prefetchWithoutAutoplay === true;
  const records = new Map();
  let lastUse = 0;
  let sentences = [];
  let sessionId = "";
  let context;
  let audioReady;
  let queue;
  let status = "idle";
  let error = "";
  let sentenceIndex = 0;
  let wordIndex = -1;
  let autoplay = false;
  let pace = normalizePace(options.pace);
  let voice = normalizeVoice(options.voice);
  let desiredPlaying = false;
  let selectionRun = 0;
  let playbackRun = 0;
  let attachedChunks = 0;
  let activeRecord;
  let prefetchStarted = false;
  let disposed = false;
  let progressTimer;

  function durationOf(record) {
    return record?.chunks.reduce((sum, chunk) => sum + chunk.length / record.sampleRate, 0) || 0;
  }
  function state() {
    const duration = durationOf(activeRecord);
    return {
      status, sentences, sentenceIndex, wordIndex, autoplay, pace, voice,
      position: queue?.position() || 0,
      duration: activeRecord?.complete ? duration : Math.max(duration, (sentences[sentenceIndex]?.words.length || 1) * ({ slow: 0.55, normal: 0.4, fast: 0.28 }[pace])),
      durationKnown: !!activeRecord?.complete,
      playing: status === "playing", loading: status === "loading", error,
    };
  }
  function emit() { onState(state()); }
  function fail(reason) {
    if (disposed) return;
    desiredPlaying = false;
    status = "error";
    error = String(reason?.message || "Speech could not start. Try again.");
    queue?.clear();
    cancelExcept();
    stopTick();
    emit();
    onError(error, reason);
  }
  function cancelExcept(...indices) {
    const keep = new Set(indices);
    for (const [key, record] of records) {
      if (!keep.has(key) && !record.complete) {
        records.delete(key);
        record.controller.abort();
      }
    }
  }
  function trimMemory() {
    let bytes = 0;
    const older = [];
    const keep = new Set([sentenceIndex, ...lookaheadSentences(sentences, sentenceIndex)]);
    for (const [index, record] of records) {
      bytes += record.bytes;
      if (record.complete && !record.saving && !keep.has(index)) older.push([index, record]);
    }
    older.sort((left, right) => left[1].usedAt - right[1].usedAt);
    for (const [index, record] of older) {
      if (bytes <= maxMemoryBytes) break;
      records.delete(index);
      bytes -= record.bytes;
    }
  }
  function makeRecord(index) {
    if (records.has(index)) {
      const record = records.get(index);
      record.usedAt = ++lastUse;
      return record;
    }
    const record = { chunks: [], bytes: 0, usedAt: ++lastUse, saving: false, sampleRate: OUTPUT_SAMPLE_RATE, complete: false, controller: new AbortController(), error: null };
    const run = selectionRun;
    const speechOptions = { voice, pace, sessionId };
    records.set(index, record);
    record.promise = (async () => {
      try {
        const key = await makeKey(sentences[index].text, speechOptions);
        if (record.controller.signal.aborted || run !== selectionRun) return;
        const cached = await cache.get(key, speechOptions);
        if (record.controller.signal.aborted || run !== selectionRun) return;
        if (cached) {
          record.chunks = cached.chunks;
          record.sampleRate = cached.sampleRate;
          record.bytes = cached.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        } else {
          await speech.stream(sentences[index].text, {
            ...speechOptions,
            signal: record.controller.signal,
            onChunk: (samples, sampleRate) => {
              if (record.controller.signal.aborted || run !== selectionRun) return;
              record.sampleRate = sampleRate;
              record.chunks.push(samples);
              record.bytes += samples.byteLength;
              trimMemory();
              if (activeRecord === record) pump();
            },
          });
        }
        if (record.controller.signal.aborted || run !== selectionRun) return;
        record.complete = true;
        record.saving = !cached;
        if (activeRecord === record) pump();
        if (!cached) {
          try { await cache.put(key, record, speechOptions); } catch { /* Disk failures must not stop speech. */ }
          record.saving = false;
        }
        trimMemory();
      } catch (reason) {
        if (record.controller.signal.aborted || run !== selectionRun) return;
        record.error = reason;
        if (activeRecord === record) fail(reason);
      }
    })();
    return record;
  }
  function ensureAudio() {
    if (audioReady) return audioReady;
    if (!AudioContextClass) throw new Error("This browser cannot play speech.");
    context ||= new AudioContextClass({ sampleRate: OUTPUT_SAMPLE_RATE });
    const AudioWorkletNodeClass = options.AudioWorkletNodeClass || globalThis.AudioWorkletNode;
    if (!AudioWorkletNodeClass || !context.audioWorklet?.addModule) throw new Error("This browser cannot play streamed speech.");
    audioReady = context.audioWorklet.addModule(new URL("./live-audio-playback-worklet.js", import.meta.url)).then(() => {
      if (disposed) return;
      queue = new PcmPlaybackQueue(context, { onEnded: ended, AudioWorkletNodeClass });
    }).catch((reason) => {
      audioReady = null;
      throw reason;
    });
    return audioReady;
  }
  function pump() {
    if (!queue || !activeRecord || !["loading", "playing", "paused"].includes(status)) return;
    while (attachedChunks < activeRecord.chunks.length) {
      queue.append(activeRecord.chunks[attachedChunks++], activeRecord.sampleRate);
    }
    if (activeRecord.complete) queue.finish();
    tick();
  }
  function prefetch() {
    if (!desiredPlaying || (!autoplay && !prefetchWithoutAutoplay) || prefetchStarted || !queue?.hasStarted() || sentenceIndex + 1 >= sentences.length) return;
    prefetchStarted = true;
    for (const index of lookaheadSentences(sentences, sentenceIndex)) makeRecord(index);
  }
  function tick() {
    if (disposed) return;
    if (desiredPlaying && queue?.hasStarted() && status === "loading") {
      status = "playing";
      emit();
    }
    if (desiredPlaying && queue?.hasStarted()) {
      prefetch();
      const current = state();
      const words = sentences[sentenceIndex]?.words || [];
      // Live returns no word times. Use the audio clock and spread words by length.
      const weights = words.map((word) => Math.max(2, word.text.length));
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      const target = Math.min(1, current.position / Math.max(0.001, current.duration)) * total;
      let sum = 0;
      let nextWord = words.length ? 0 : -1;
      for (let index = 0; index < weights.length; index += 1) {
        if (sum > target) break;
        nextWord = index;
        sum += weights[index];
      }
      wordIndex = Math.max(wordIndex, nextWord);
    }
    onProgress(state());
  }
  function startTick() {
    if (!progressTimer) progressTimer = setInterval(tick, options.progressIntervalMs || 50);
  }
  function stopTick() { clearInterval(progressTimer); progressTimer = null; }
  function ended() {
    if (!activeRecord?.complete || disposed) return;
    if (desiredPlaying && autoplay && sentenceIndex + 1 < sentences.length) {
      void begin(sentenceIndex + 1);
    } else {
      desiredPlaying = false;
      status = "ended";
      wordIndex = Math.max(-1, (sentences[sentenceIndex]?.words.length || 0) - 1);
      stopTick();
      emit();
    }
  }
  async function begin(index) {
    if (disposed || !sentences.length) return;
    const run = ++playbackRun;
    sentenceIndex = Math.max(0, Math.min(sentences.length - 1, Math.floor(index)));
    cancelExcept(sentenceIndex, ...((autoplay || prefetchWithoutAutoplay) ? lookaheadSentences(sentences, sentenceIndex) : []));
    if (records.get(sentenceIndex)?.error) records.delete(sentenceIndex);
    error = "";
    status = "loading";
    desiredPlaying = true;
    wordIndex = -1;
    attachedChunks = 0;
    prefetchStarted = false;
    try {
      const ready = ensureAudio();
      queue?.clear();
      activeRecord = makeRecord(sentenceIndex);
      trimMemory();
      emit();
      startTick();
      const resumed = context.resume();
      pump();
      await Promise.all([ready, resumed]);
      if (run !== playbackRun || !desiredPlaying || disposed) return;
      pump();
    } catch (reason) { if (run === playbackRun) fail(reason); }
  }
  async function play() {
    if (disposed || !sentences.length) return;
    if (!activeRecord || ["idle", "ended", "error"].includes(status)) return begin(sentenceIndex);
    if (desiredPlaying) return;
    desiredPlaying = true;
    status = queue?.hasStarted() ? "playing" : "loading";
    const run = ++playbackRun;
    emit();
    startTick();
    try {
      await Promise.all([ensureAudio(), context.resume()]);
      if (run === playbackRun && desiredPlaying && !disposed) { pump(); prefetch(); }
    } catch (reason) { if (run === playbackRun) fail(reason); }
  }
  function pause() {
    if (!desiredPlaying || disposed) return;
    desiredPlaying = false;
    playbackRun += 1;
    status = "paused";
    cancelExcept(sentenceIndex);
    prefetchStarted = false;
    void context?.suspend().catch(() => {});
    stopTick();
    emit();
  }
  function changeSpeech(nextVoice, nextPace) {
    if (disposed || (voice === nextVoice && pace === nextPace)) return;
    const shouldPlay = desiredPlaying;
    voice = nextVoice;
    pace = nextPace;
    selectionRun += 1;
    playbackRun += 1;
    cancelExcept();
    records.clear();
    queue?.clear();
    stopTick();
    activeRecord = null;
    wordIndex = -1;
    desiredPlaying = false;
    prefetchStarted = false;
    error = "";
    status = sentences.length ? "paused" : "idle";
    emit();
    if (shouldPlay && sentences.length) return begin(sentenceIndex);
  }
  return {
    async load(text, { play: shouldPlay = true, sentenceIndex: startIndex = 0, sessionId: nextSessionId = "" } = {}) {
      selectionRun += 1;
      playbackRun += 1;
      cancelExcept();
      records.clear();
      queue?.clear();
      stopTick();
      sentences = Array.isArray(text)
        ? text.map(sentence => ({ ...sentence, start: 0, end: sentence.text.length,
            words: splitSentences(sentence.text).flatMap(part => part.words) }))
        : splitSentences(text);
      sessionId = nextSessionId;
      sentenceIndex = Math.max(0, Math.min(sentences.length - 1, Number.isFinite(startIndex) ? Math.floor(startIndex) : 0));
      wordIndex = -1;
      activeRecord = null;
      desiredPlaying = false;
      error = "";
      status = "idle";
      emit();
      if (shouldPlay && sentences.length) return begin(sentenceIndex);
    },
    async updateSentences(next, { sessionId: nextSessionId = sessionId } = {}) {
      const samePrefix = sentences.length <= next.length && sentences.every((sentence, index) =>
        sentence._id === next[index]._id && sentence.text === next[index].text);
      if (samePrefix && sessionId === nextSessionId) {
        sentences = next.map(sentence => ({ ...sentence, start: 0, end: sentence.text.length,
          words: splitSentences(sentence.text).flatMap(part => part.words) }));
        prefetchStarted = false;
        emit(); prefetch();
        return;
      }
      const currentId = sentences[sentenceIndex]?._id;
      const nextIndex = Math.max(0, next.findIndex(sentence => sentence._id === currentId));
      return this.load(next, { play: false, sentenceIndex: nextIndex, sessionId: nextSessionId });
    },
    selectSentence(index) {
      if (!Number.isInteger(index) || !sentences[index]) return;
      if (desiredPlaying) return begin(index);
      playbackRun += 1;
      cancelExcept(); queue?.clear(); stopTick();
      sentenceIndex = index; wordIndex = -1; activeRecord = null;
      prefetchStarted = false; error = ''; status = 'paused';
      emit();
    },
    play,
    pause,
    toggle() { return desiredPlaying ? pause() : play(); },
    previous() { return begin(Math.max(0, sentenceIndex - 1)); },
    next() { if (sentenceIndex + 1 < sentences.length) return begin(sentenceIndex + 1); },
    replay() { return begin(sentenceIndex); },
    seekSentence(index) { if (Number.isFinite(index)) return begin(index); },
    setAutoplay(value) {
      autoplay = !!value;
      if (!autoplay && !prefetchWithoutAutoplay) { cancelExcept(sentenceIndex); prefetchStarted = false; }
      else prefetch();
      emit();
    },
    setVoice(value) { if (VOICES.includes(value)) return changeSpeech(value, pace); },
    setPace(value) { if (PACES.includes(value)) return changeSpeech(voice, value); },
    setSpeed(value) { if (Number.isFinite(value)) return changeSpeech(voice, paceFromSpeed(value)); },
    getState: state,
    async dispose() {
      disposed = true;
      selectionRun += 1;
      playbackRun += 1;
      cancelExcept();
      records.clear();
      queue?.dispose();
      stopTick();
      try { await context?.close(); } catch { /* The panel may be closing already. */ }
      await cache.close?.();
    },
  };
}
