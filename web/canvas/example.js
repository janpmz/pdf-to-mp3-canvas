const recordings = [
  ['003', 'Control the playback sentence by sentence.'],
  ['009', 'You decide when to hear a sentence again or move to the next one.'],
  ['010', 'When your attention shifts away, listen to the sentence again.'],
  ['011', 'Move to the next sentence at your own pace.'],
  ['012', 'You can also choose to play the next sentence automatically.'],
];

function chapter(id, title, items, subchapters = []) {
  return { _id: `chapter_example_${id}`, title, subchapters, pages: items.length ? [{
    _id: `page_example_${id}`, title,
    sentences: items.map(([audioId, text]) => ({ _id: `sentence_example_${audioId}`, text, words: [] })),
  }] : [] };
}

export function createCanvasExample({ fetchAudio = (...args) => fetch(...args),
  OfflineAudioContextClass = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext,
} = {}) {
  const canvas = { _id: 'example', title: 'Try PDF TO MP3 Canvas', language: 'en', revision: 1,
    url: new URL('./?example=1', import.meta.url).href,
    chapters: [
      chapter('listen', 'Listen sentence by sentence', recordings.slice(0, 2), [
        chapter('pause', 'Take your time', recordings.slice(2, 4)),
      ]),
      chapter('autoplay', 'Choose when to continue', recordings.slice(4)),
    ],
  };
  const audioFiles = new Map(recordings.map(([id, text]) => [text, new URL(`./example-audio/${id}.mp3`, import.meta.url).href]));
  let decoder;
  return {
    canvasId: canvas._id,
    pollInterval: 0,
    settingsKey: 'example-settings',
    speechError: 'The example audio could not load. Please try again.',
    configureControls({ voice, pace }) {
      voice.selectedOptions[0].textContent = 'Demo voice';
      pace.value = 'normal';
      for (const control of [voice, pace]) {
        control.disabled = true;
        control.title = 'This example uses fixed audio.';
      }
    },
    async request(path) {
      if (path !== '/canvases/example') throw new Error('The example cannot be changed.');
      return { data: canvas, tag: 'example-v1' };
    },
    playerOptions: {
      // Browser file caching and the player's memory cache suffice for these five recordings.
      cache: { get: async () => null, put: async () => {} },
      speech: {
        async stream(text, { signal, onChunk }) {
          const file = audioFiles.get(text);
          if (!file || !OfflineAudioContextClass) throw new Error('This browser cannot play the example audio.');
          const reply = await fetchAudio(file, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
          if (!reply.ok) throw new Error('The example audio could not load.');
          decoder ||= new OfflineAudioContextClass(1, 1, 24000);
          const audio = await decoder.decodeAudioData(await reply.arrayBuffer());
          signal.throwIfAborted();
          onChunk(audio.getChannelData(0), audio.sampleRate);
        },
      },
    },
  };
}
