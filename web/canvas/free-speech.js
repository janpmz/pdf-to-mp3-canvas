export const FREE_VOICES = Object.freeze([
  ['af_heart', 'Heart', 'en'], ['af_bella', 'Bella', 'en'], ['am_michael', 'Michael', 'en'],
  ['bf_emma', 'Emma', 'en'], ['bm_george', 'George', 'en'], ['dm_martin', 'Martin', 'de'],
  ['ef_dora', 'Dora', 'es'], ['em_alex', 'Alex', 'es'], ['ff_siwis', 'Siwis', 'fr'],
  ['hf_alpha', 'Alpha', 'hi'], ['if_sara', 'Sara', 'it'], ['im_nicola', 'Nicola', 'it'],
  ['jf_alpha', 'Alpha', 'ja'], ['pf_dora', 'Dora', 'pt'], ['zf_xiaobei', 'Xiaobei', 'zh'],
].map(([id, name, language]) => Object.freeze({ id, name, language })));

export async function freeAudioCacheKey(text, { sessionId, voice } = {}) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['kokoro-free-v1', sessionId, voice, text])));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function decodeFreePcm(buffer) {
  if (!buffer.byteLength || buffer.byteLength % 2) throw new Error('Free speech returned unreadable audio.');
  const view = new DataView(buffer), samples = new Float32Array(buffer.byteLength / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  return samples;
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
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voice }),
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error('Free speech could not connect. Please try again.');
      }
      if (!response.ok) {
        // Display only our known messages, never an upstream reply or secret.
        throw new Error(({ 400: 'This voice or sentence is not supported. Try another voice or a shorter sentence.',
          404: 'This sentence changed. Reload the canvas.', 429: 'Free speech is busy. Please try again shortly.',
          503: 'Free speech is not set up on this server yet.', 504: 'Free speech is taking too long. Please try again shortly.',
        })[response.status] || 'Free speech could not finish. Please try again.');
      }
      if (!/^audio\/pcm;rate=24000;channels=1$/.test(response.headers.get('Content-Type') || '')) throw new Error('Free speech returned unreadable audio.');
      const samples = decodeFreePcm(await response.arrayBuffer());
      signal?.throwIfAborted();
      onChunk(samples, 24000);
      return { sampleRate: 24000 };
    },
  };
}
