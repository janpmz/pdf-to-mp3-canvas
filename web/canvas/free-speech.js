import { splitSentences } from './sentence-player.js';

export const FREE_VOICES = Object.freeze([
  ['af_heart', 'Heart', 'en'], ['af_bella', 'Bella', 'en'], ['am_michael', 'Michael', 'en'],
  ['bf_emma', 'Emma', 'en'], ['bm_george', 'George', 'en'], ['dm_martin', 'Martin', 'de'],
  ['ef_dora', 'Dora', 'es'], ['em_alex', 'Alex', 'es'], ['ff_siwis', 'Siwis', 'fr'],
  ['hf_alpha', 'Alpha', 'hi'], ['if_sara', 'Sara', 'it'], ['im_nicola', 'Nicola', 'it'],
  ['jf_alpha', 'Alpha', 'ja'], ['pf_dora', 'Dora', 'pt'], ['zf_xiaobei', 'Xiaobei', 'zh'],
].map(([id, name, language]) => Object.freeze({ id, name, language })));

export async function freeAudioCacheKey(text, { sessionId, voice } = {}) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['kokoro-free-v2-word-times', sessionId, voice, text])));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function decodeFreePcm(buffer) {
  if (!buffer.byteLength || buffer.byteLength % 2) throw new Error('Free speech returned unreadable audio.');
  const view = new DataView(buffer), samples = new Float32Array(buffer.byteLength / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  return samples;
}

// Match by the supplied text. Contractions or joined tokens can share an interval.
// A mismatch leaves the words unhighlighted rather than inventing new times.
export function mapWordTimes(text, timings, duration) {
  if (!Array.isArray(timings) || !timings.length) return [];
  const normalize = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const words = splitSentences(text).flatMap(sentence => sentence.words);
  const source = words.map(word => normalize(word.text));
  let previous = 0;
  for (const word of timings) {
    if (typeof word?.text !== 'string' || !Number.isFinite(word.start) || !Number.isFinite(word.end) ||
        word.start < previous || word.end < word.start || word.end > duration) return [];
    previous = word.start;
  }
  const spoken = timings.map(word => normalize(word.text));
  if (source.join('') !== spoken.join('')) return [];
  let offset = 0;
  const spans = timings.map((word, index) => {
    const start = offset; offset += spoken[index].length;
    return { ...word, from: start, to: offset };
  });
  offset = 0;
  return source.flatMap((word, index) => {
    const start = offset; offset += word.length;
    const matches = spans.filter(span => span.to > start && span.from < offset);
    return matches.length ? [{ index, start: matches[0].start, end: matches.at(-1).end }] : [];
  });
}

export function createFreeSpeech({ apiBase, fetchImpl = fetch } = {}) {
  return {
    async stream(text, { sessionId, sentenceId, voice, signal, onChunk = () => {} }) {
      if (!sessionId || !sentenceId) throw new Error('Reload the canvas before listening.');
      signal?.throwIfAborted();
      let response;
      try {
        response = await fetchImpl(`${apiBase}/canvases/${encodeURIComponent(sessionId)}/sentences/${encodeURIComponent(sentenceId)}/speech`, {
          method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', signal,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ voice }),
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error('Free speech could not connect. Please try again.');
      }
      if (!response.ok) {
        throw new Error(({ 400: 'This voice or sentence is not supported. Try another voice or a shorter sentence.',
          404: 'This sentence changed. Reload the canvas.', 429: 'Free speech is busy. Please try again shortly.',
          503: 'Free speech is not set up on this server yet.', 504: 'Free speech is taking too long. Please try again shortly.',
        })[response.status] || 'Free speech could not finish. Please try again.');
      }
      const data = await response.json();
      if (data.sample_rate !== 24000 || typeof data.audio !== 'string' || data.audio.length > 12000000) throw new Error('Free speech returned unreadable audio.');
      const samples = decodeFreePcm(Uint8Array.from(atob(data.audio), char => char.charCodeAt(0)).buffer);
      const wordTimings = data.timing_source === 'kokoro' ? mapWordTimes(text, data.words, samples.length / 24000) : [];
      signal?.throwIfAborted();
      onChunk(samples, 24000, { wordTimings });
      return { sampleRate: 24000, wordTimings };
    },
  };
}
