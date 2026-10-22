import { decodeFreePcm, mapWordTimes } from './free-speech.js';
import { EXAMPLE_VOICE, EXAMPLE_RECORDINGS as recordings } from './example-data.js?v=20261022-example-2';

function chapter(id, title, items, subchapters = []) {
  return { _id: `chapter_example_${id}`, title, subchapters, pages: items.length ? [{
    _id: `page_example_${id}`, title,
    sentences: items.map(([audioId, text]) => ({ _id: `sentence_example_${audioId}`, text, words: [] })),
  }] : [] };
}

export function createCanvasExample({ fetchAudio = (...args) => fetch(...args) } = {}) {
  const canvas = { _id: 'example', title: 'Try PDF TO MP3 Canvas', language: 'en', revision: 2,
    url: new URL('./', import.meta.url).href,
    chapters: [chapter('try', 'Try the free player', recordings)],
  };
  let manifestPromise;
  async function manifest(signal) {
    manifestPromise ||= fetchAudio(new URL('./example-audio/kokoro-manifest.json?v=kokoro-2', import.meta.url).href,
      { credentials: 'omit', referrerPolicy: 'no-referrer' }).then(async response => {
        if (!response.ok) throw new Error('The example word times could not load. Please try again.');
        const data = await response.json();
        if (data.version !== 1 || data.source !== 'kokoro' || data.voice !== EXAMPLE_VOICE || data.sample_rate !== 24000) {
          throw new Error('The example speech and word times do not match. Reload the page.');
        }
        return data;
      }).catch(error => { manifestPromise = null; throw error; });
    const data = await manifestPromise;
    signal?.throwIfAborted();
    return data;
  }
  return {
    canvasId: canvas._id,
    pollInterval: 0,
    configureControls({ voice, pace }) {
      const option = document.createElement('option'); option.value = EXAMPLE_VOICE; option.textContent = 'Heart';
      voice.replaceChildren(option);
      pace.value = 'normal';
      for (const control of [voice, pace]) {
        control.disabled = true;
        control.title = 'This example uses saved Kokoro speech with the Heart voice.';
      }
    },
    async request(path) {
      if (path !== '/canvases/example') throw new Error('The example cannot be changed.');
      return { data: canvas, tag: 'kokoro-example-v2' };
    },
    playerOptions: {
      // The browser and player keep these three recordings in memory.
      cache: { get: async () => null, put: async () => {} },
      speech: {
        async stream(text, { signal, onChunk }) {
          signal?.throwIfAborted();
          const id = recordings.find(([, passage]) => passage === text)?.[0];
          const data = await manifest(signal), clip = data.clips?.[id];
          if (!clip || clip.text !== text || !/^kokoro-[0-9]{3}-[a-f0-9]{16}\.pcm$/.test(clip.file)) {
            throw new Error('The example speech and word times do not match. Reload the page.');
          }
          const reply = await fetchAudio(new URL(`./example-audio/${clip.file}`, import.meta.url).href,
            { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
          if (!reply.ok) throw new Error('The example audio could not load. Please try again.');
          const buffer = await reply.arrayBuffer();
          const hash = await crypto.subtle.digest('SHA-256', buffer);
          const sha256 = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
          if (sha256 !== clip.audio_sha256 || buffer.byteLength !== clip.bytes ||
              buffer.byteLength / 48000 !== clip.duration_seconds) {
            throw new Error('The example speech and word times do not match. Reload the page.');
          }
          const samples = decodeFreePcm(buffer);
          const wordTimings = mapWordTimes(text, clip.words, samples.length / data.sample_rate);
          if (!wordTimings.length) throw new Error('The example word times do not match its text. Reload the page.');
          signal?.throwIfAborted();
          onChunk(samples, data.sample_rate, { wordTimings });
          return { sampleRate: data.sample_rate, wordTimings };
        },
      },
    },
  };
}
