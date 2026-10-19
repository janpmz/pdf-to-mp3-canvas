import { LIVE_MODEL, LIVE_VOICE } from "./speech.js";
import { DEFAULT_PACE, normalizeVoice, normalizePace } from "./speech-options.js";

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 200;

export async function audioCacheKey(text, { voice = LIVE_VOICE, pace = DEFAULT_PACE, sessionId = "" } = {}) {
  const bytes = new TextEncoder().encode(`${LIVE_MODEL}\n${normalizeVoice(voice)}\n${normalizePace(pace)}\nexact-reading-v3\n${sessionId}\n${text}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function encodeCachedAudio(audio) {
  const count = audio.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const pcm = new Int16Array(count);
  let offset = 0;
  for (const chunk of audio.chunks) {
    for (const sample of chunk) pcm[offset++] = Math.max(-32768, Math.min(32767, Math.round(sample * 32768)));
  }
  return { pcm, sampleRate: audio.sampleRate, bytes: pcm.byteLength };
}

export function decodeCachedAudio(record) {
  if (!(record?.pcm instanceof Int16Array) || !record.pcm.length || !Number.isFinite(record.sampleRate) || record.sampleRate <= 0) return null;
  const samples = new Float32Array(record.pcm.length);
  for (let index = 0; index < samples.length; index += 1) samples[index] = record.pcm[index] / 32768;
  return { chunks: [samples], sampleRate: record.sampleRate };
}

export function createAudioCache({ indexedDB = globalThis.indexedDB, maxBytes = MAX_BYTES, maxEntries = MAX_ENTRIES,
  onLimit = () => {},
  isDeleted = async () => false,
  lock = (action) => globalThis.navigator?.locks?.request ? globalThis.navigator.locks.request('pdftomp3-canvas-audio', action) : action(),
} = {}) {
  let opening;
  function open() {
    if (!indexedDB) return Promise.resolve(null);
    if (!opening) {
      opening = new Promise((resolve) => {
        const request = indexedDB.open("pdftomp3-canvas-speech", 1);
        request.onupgradeneeded = (event) => {
          if (event?.oldVersion) request.transaction.objectStore("audio").clear();
          else request.result.createObjectStore("audio", { keyPath: "key" });
        };
        request.onsuccess = () => {
          request.result.onversionchange = () => { request.result.close(); opening = null; };
          resolve(request.result);
        };
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      });
    }
    return opening;
  }
  return {
    async get(key, { sessionId } = {}) {
      try {
        if (await isDeleted(sessionId)) return null;
        const db = await open();
        if (!db) return null;
        return await new Promise((resolve) => {
          const transaction = db.transaction("audio", "readwrite");
          const store = transaction.objectStore("audio");
          const request = store.get(key);
          let audio = null;
          request.onsuccess = () => {
            audio = decodeCachedAudio(request.result);
            if (audio) store.put({ ...request.result, usedAt: Date.now() });
          };
          transaction.oncomplete = () => resolve(audio);
          transaction.onerror = transaction.onabort = () => resolve(null);
        });
      } catch { return null; }
    },
    async put(key, audio, { sessionId } = {}) {
      try {
        return await lock(async () => {
          if (await isDeleted(sessionId)) return;
          const record = encodeCachedAudio(audio);
          if (!record.bytes || record.bytes > maxBytes) return;
          const db = await open();
          if (!db) return;
          await new Promise((resolve) => {
            const transaction = db.transaction("audio", "readwrite");
            const store = transaction.objectStore("audio");
            store.put({ ...record, key, sessionId, usedAt: Date.now() });
            const request = store.getAll();
            request.onsuccess = () => {
              const entries = request.result.sort((left, right) => right.usedAt - left.usedAt);
              let bytes = 0;
              entries.forEach((entry, index) => {
                bytes += entry.bytes;
                if (bytes > maxBytes || index >= maxEntries) store.delete(entry.key);
              });
            };
            transaction.oncomplete = () => resolve();
            transaction.onerror = transaction.onabort = () => {
              if (transaction.error?.name === 'QuotaExceededError') onLimit();
              resolve();
            };
          });
        });
      } catch (error) { if (error?.name === 'QuotaExceededError') onLimit(); }
    },
    async removeSessions(ids) {
      const removed = new Set(ids);
      return lock(async () => {
        const db = await open();
        if (!db) throw new Error('Could not clear saved audio. Try again.');
        await new Promise((resolve, reject) => {
          const transaction = db.transaction('audio', 'readwrite');
          const store = transaction.objectStore('audio');
          const request = store.getAll();
          request.onsuccess = () => {
            for (const entry of request.result) if (removed.has(entry.sessionId)) store.delete(entry.key);
          };
          transaction.oncomplete = () => resolve();
          transaction.onerror = transaction.onabort = () => reject(new Error('Could not clear saved audio. Try again.'));
        });
      });
    },
    async close() {
      try {
        const db = await opening;
        db?.close();
      } catch { /* Storage may be blocked in this browser. */ }
      opening = null;
    },
  };
}
