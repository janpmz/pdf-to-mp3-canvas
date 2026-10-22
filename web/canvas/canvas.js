import { createSentencePlayer } from './sentence-player.js';
import { createFreeSpeech, FREE_VOICES, freeAudioCacheKey } from './free-speech.js';
import { canvasPrompt, canvasSentences } from './model.js';

const $ = id => document.getElementById(id);
const configuredApi = document.querySelector('meta[name="canvas-api"]')?.content;
const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const apiBase = new URL(configuredApi || (local ? 'http://localhost:8702/canvas-api' : '/canvas-api'), location.href).href.replace(/\/$/, '');
const params = new URLSearchParams(location.search);
let canvasId = params.get('id') || '';
const request = apiRequest;
const pollInterval = 3000;
let canvas = null, model = { chapters: [], sentences: [] }, currentState = null;
let selectedId = '', fullRows = [], highlighted = [];
let pollTimer, etag, refreshing = false, firstLoad = true;
let lastSavedSentence = '', noticeTimer;
const storage = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(`canvas:${key}`)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`canvas:${key}`, JSON.stringify(value)); return true; } catch { return false; } },
  remove(key) { try { localStorage.removeItem(`canvas:${key}`); return true; } catch { return false; } },
};
const settingsKey = 'free-settings';
const settings = storage.get(settingsKey, {});
$('pace').value = 'normal';
const player = createSentencePlayer({
  voice: settings.voice, defaultVoice: 'af_heart', voices: FREE_VOICES.map(item => item.id), pace: 'normal',
  prefetchWithoutAutoplay: true, requireWordTimings: true, speech: createFreeSpeech({ apiBase }), cacheKey: freeAudioCacheKey,
  onStateChange: render, onProgress: renderWords, onError: text => message(text),
});
player.setAutoplay(settings.autoplay !== false);
function updateVoices(language) {
  const selected = player.getState().voice;
  const choices = FREE_VOICES.filter(item => item.language === language.split('-')[0]);
  $('voice').replaceChildren(...choices.map(item => {
    const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; return option;
  }));
  $('voice').value = choices.some(item => item.id === selected) ? selected : (choices[0]?.id || '');
  if ($('voice').value) void player.setVoice($('voice').value);
}
function message(text, temporary = false) {
  clearTimeout(noticeTimer);
  $('message').textContent = text; $('message').hidden = !text;
  if (temporary) noticeTimer = setTimeout(() => message(''), 3500);
}
function owner() { return storage.get(`owner:${canvasId}`, null); }
async function apiRequest(path, { method = 'GET', body, code, tag } = {}) {
  const response = await fetch(`${apiBase}${path}`, { method, credentials: 'omit', referrerPolicy: 'no-referrer',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(code ? { Authorization: `Bearer ${code}` } : {}), ...(tag ? { 'If-None-Match': tag } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 304) return { unchanged: true };
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw Object.assign(new Error(data?.error || 'Could not load this canvas.'), { status: response.status });
  return { data, tag: response.headers.get('ETag') };
}

function appendSentence(container, sentence) {
  const fragment = document.createDocumentFragment(), words = [];
  let offset = 0;
  for (const word of sentence.words) {
    fragment.append(document.createTextNode(sentence.text.slice(offset, word.start)));
    const span = document.createElement('span'); span.className = 'word spoken-part';
    span.textContent = sentence.text.slice(word.start, word.end); fragment.append(span); words.push(span);
    offset = word.end;
  }
  fragment.append(document.createTextNode(sentence.text.slice(offset)));
  container.replaceChildren(fragment);
  return words;
}
function renderWords(state) {
  if (!state) return;
  for (const element of highlighted) element?.classList.remove('is-current');
  highlighted = [fullRows[state.sentenceIndex]?.words[state.wordIndex]];
  for (const element of highlighted) element?.classList.add('is-current');
}
function render(state) {
  currentState = state;
  const sentence = state.sentences[state.sentenceIndex], hasText = Boolean(sentence);
  $('playButton').disabled = !hasText;
  $('repeatButton').disabled = !hasText;
  $('previousButton').disabled = !hasText || state.sentenceIndex === 0;
  $('nextButton').disabled = !hasText || state.sentenceIndex >= state.sentences.length - 1;
  const nextReady = !state.autoplay && state.status === 'ended' && !$('nextButton').disabled;
  $('nextButton').classList.toggle('control-purple', nextReady);
  $('nextButton').classList.toggle('next-callout-button', nextReady);
  const active = state.playing || state.loading;
  $('playButton').classList.toggle('is-playing', active);
  $('playButton').classList.toggle('is-loading', state.loading);
  $('playButton').setAttribute('aria-label', active ? 'Pause' : state.status === 'ended' && !$('nextButton').disabled ? 'Play next sentence' : 'Play');
  $('playButton').setAttribute('aria-busy', String(state.loading));
  $('autoButton').classList.toggle('tool-item-active', state.autoplay);
  $('autoButton').setAttribute('aria-label', state.autoplay ? 'Turn auto play off' : 'Turn auto play on');
  $('autoButton').setAttribute('aria-pressed', String(state.autoplay));
  $('chapterName').textContent = sentence?.chapterTitle || '';
  $('readingHeading').hidden = !sentence?.chapterTitle;
  if (sentence?._id !== selectedId) {
    selectedId = sentence?._id || '';
    fullRows.forEach((row, index) => {
      row.button.classList.toggle('is-selected', index === state.sentenceIndex);
      row.button.setAttribute('aria-current', String(index === state.sentenceIndex));
    });
    fullRows[state.sentenceIndex]?.button.scrollIntoView({ block: 'nearest' });
    for (const button of $('chapterList').querySelectorAll('button')) {
      const selected = button.dataset.chapterId === sentence?.chapterId;
      button.setAttribute('aria-current', String(selected));
      button.classList.toggle('is-selected', selected);
    }
  }
  if (canvasId && sentence?._id && sentence._id !== lastSavedSentence) {
    lastSavedSentence = sentence._id; storage.set(`position:${canvasId}`, sentence._id);
  }
  renderWords(state);
}
function renderFullText() {
  fullRows = [];
  const fragment = document.createDocumentFragment();
  for (const [index, sentence] of (currentState?.sentences || []).entries()) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'sentence';
    button.classList.toggle('is-selected', currentState.sentenceIndex === index);
    button.setAttribute('aria-current', String(currentState.sentenceIndex === index));
    const words = appendSentence(button, sentence);
    button.addEventListener('click', () => { void readingAction(() => player.selectSentence(index)); });
    fullRows.push({ button, words }); fragment.append(button);
  }
  $('fullReader').replaceChildren(fragment);
  fullRows[currentState?.sentenceIndex]?.button.scrollIntoView({ block: 'nearest' });
  renderWords(currentState);
}
function showChapters(show) {
  const dialog = $('chapterSidebar');
  if (show && !dialog.open) dialog.showModal();
  if (!show && dialog.open) dialog.close();
  dialog.classList.toggle('is-open', show);
  $('chaptersButton').setAttribute('aria-expanded', String(show));
  if (show) $('closeChapters').focus();
  else if (document.activeElement?.closest('#chapterSidebar')) $('chaptersButton').focus();
}
function renderChapters() {
  const fragment = document.createDocumentFragment();
  for (const chapter of model.chapters) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'chapter-option';
    button.classList.toggle('is-direct', chapter.depth === 0);
    const title = document.createElement('span'); title.className = 'chapter-option-title'; title.textContent = chapter.title;
    button.append(title);
    button.style.setProperty('--depth', chapter.depth); button.dataset.chapterId = chapter.id;
    button.disabled = chapter.startIndex === chapter.endIndex;
    const selected = chapter.id === currentState?.sentences[currentState.sentenceIndex]?.chapterId;
    button.setAttribute('aria-current', String(selected)); button.classList.toggle('is-selected', selected);
    button.addEventListener('click', () => { void readingAction(() => player.selectSentence(chapter.startIndex)); showChapters(false); });
    fragment.append(button);
  }
  $('chapterList').replaceChildren(fragment);
  $('chaptersButton').hidden = !model.chapters.length;
}
function showReader() {
  $('welcome').hidden = true; $('playerFooter').hidden = false;
  $('shareButton').hidden = false;
  $('promptButton').hidden = !owner(); $('emptyPrompt').hidden = !owner();
}
async function refresh() {
  if (refreshing || !canvasId) return;
  refreshing = true;
  try {
    const result = await request(`/canvases/${encodeURIComponent(canvasId)}`, { tag: etag });
    if (result.unchanged) return;
    canvas = result.data; etag = result.tag; model = canvasSentences(canvas);
    document.title = `${canvas.title} — PDF TO MP3 Canvas`; document.documentElement.lang = canvas.language;
    if (firstLoad) updateVoices(canvas.language);
    showReader();
    const empty = !model.sentences.length;
    $('emptyCanvas').hidden = !empty;
    $('fullReader').hidden = empty; $('readingSettings').hidden = empty;
    if (firstLoad) {
      const saved = storage.get(`position:${canvasId}`, '');
      const index = Math.max(0, model.sentences.findIndex(sentence => sentence._id === saved));
      await player.load(model.sentences, { play: false, sentenceIndex: index, sessionId: canvasId });
      firstLoad = false;
    } else await player.updateSentences(model.sentences, { sessionId: canvasId });
    renderChapters();
    renderFullText();
  } catch (error) {
    if (error.status === 404) {
      await player.load([], { play: false }); model = { chapters: [], sentences: [] };
      renderChapters(); showReader(); $('emptyCanvas').hidden = false;
      $('emptyCanvas').querySelector('h2').textContent = 'Canvas not found';
      $('emptyMessage').textContent = 'Check the link. The canvas may have been deleted.';
      $('emptyTip').hidden = true; $('fullReader').hidden = true;
      $('readingSettings').hidden = true; $('emptyPrompt').hidden = true; $('promptButton').hidden = true;
      clearTimeout(pollTimer); canvasId = '';
    } else message('Could not load your canvas. We will try again.');
  } finally {
    refreshing = false;
    clearTimeout(pollTimer);
    if (canvasId && pollInterval) pollTimer = setTimeout(refresh, document.hidden ? pollInterval * 5 : pollInterval);
  }
}
async function copy(text, success) {
  try { await navigator.clipboard.writeText(text); message(success, true); return true; }
  catch { return false; }
}
async function preparePrompt() {
  const access = owner();
  if (!access || !canvas) return;
  try {
    if (new Date(access.upload_expires_at).getTime() <= Date.now()) {
      const result = await request(`/canvases/${canvasId}/upload-code`, { method: 'POST', body: {}, code: access.manage_code });
      Object.assign(access, result.data); storage.set(`owner:${canvasId}`, access);
    }
    const prompt = canvasPrompt({ canvas, apiBase, uploadCode: access.upload_code, expiresAt: access.upload_expires_at });
    $('promptText').value = prompt;
    $('ownerAccess').hidden = false; $('ownerCode').value = access.manage_code;
    $('promptDialog').showModal();
    await copy(prompt, 'Prompt copied. Paste it into your AI and add your task.');
  } catch { message('Could not prepare the prompt. Try again.'); }
}
function saveSettings() {
  storage.set(settingsKey, { voice: $('voice').value, pace: $('pace').value, autoplay: player.getState().autoplay });
}

function readingAction(action) { message(''); return action(); }
function toggleReading() {
  return readingAction(() => {
    const state = player.getState();
    return state.status === 'ended' && state.sentenceIndex + 1 < state.sentences.length ? player.next() : player.toggle();
  });
}

$('createForm').addEventListener('submit', async event => {
  event.preventDefault(); $('createButton').disabled = true; message('');
  try {
    const { data } = await request('/canvases', { method: 'POST', body: {
      title: $('canvasTitle').value.trim(), language: $('canvasLanguage').value,
    } });
    canvasId = data._id;
    storage.set(`owner:${canvasId}`, { manage_code: data.manage_code, upload_code: data.upload_code, upload_expires_at: data.upload_expires_at });
    history.replaceState(null, '', `?id=${encodeURIComponent(canvasId)}`);
    await refresh(); await preparePrompt();
  } catch { message('Could not create your canvas. Try again shortly.'); }
  finally { $('createButton').disabled = false; }
});
$('promptButton').onclick = preparePrompt;
$('emptyPrompt').onclick = preparePrompt;
$('closePrompt').onclick = () => $('promptDialog').close();
$('copyPromptText').onclick = async () => {
  if (!await copy($('promptText').value, 'Prompt copied.')) { $('promptText').focus(); $('promptText').select(); }
};
$('shareButton').onclick = async () => {
  const link = new URL(canvas?.url || location.href); link.hash = '';
  if (!await copy(link.href, 'Canvas link copied. Anyone with this link can read the text.')) {
    $('promptText').value = link.href; $('ownerAccess').hidden = true; $('promptDialog').showModal(); $('promptText').select();
  }
};
$('deleteCanvas').onclick = async () => {
  const access = owner();
  if (!access || !confirm('Delete this canvas and its text? Its shared link will stop working.')) return;
  try {
    await request(`/canvases/${canvasId}`, { method: 'DELETE', code: access.manage_code });
    storage.set(`owner:${canvasId}`, null); $('promptDialog').close(); etag = null; await refresh();
  } catch { message('Could not delete the canvas. Try again.'); }
};
$('playButton').onclick = () => { void toggleReading(); };
$('repeatButton').onclick = () => { void readingAction(() => player.replay()); };
$('previousButton').onclick = () => { void readingAction(() => player.previous()); };
$('nextButton').onclick = () => { void readingAction(() => player.next()); };
$('autoButton').onclick = () => {
  player.setAutoplay(!player.getState().autoplay); saveSettings();
  const state = player.getState();
  if (state.autoplay && state.status === 'ended' && state.sentenceIndex + 1 < state.sentences.length) void readingAction(() => player.next());
};
$('voice').onchange = () => { void readingAction(() => player.setVoice($('voice').value)); saveSettings(); };
$('pace').onchange = () => { void readingAction(() => player.setPace($('pace').value)); saveSettings(); };
$('chaptersButton').onclick = () => showChapters(!$('chapterSidebar').open);
$('closeChapters').onclick = () => showChapters(false);
$('chapterSidebar').addEventListener('close', () => {
  $('chapterSidebar').classList.remove('is-open');
  $('chaptersButton').setAttribute('aria-expanded', 'false');
});
// Keep the site's menu closed after choosing a tool.
$('canvasMenu').addEventListener('click', event => {
  if (event.target.closest('button, a')) $('canvasMenu').open = false;
});
document.addEventListener('click', event => {
  if (!event.target.closest('#canvasMenu')) $('canvasMenu').open = false;
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { showChapters(false); $('canvasMenu').open = false; }
  if (event.target.closest('input, textarea, select, button, a') || document.querySelector('dialog[open]') || !currentState?.sentences.length) return;
  if (event.code === 'Space') { event.preventDefault(); void toggleReading(); }
  if (event.key === 'ArrowRight') { event.preventDefault(); void readingAction(() => player.next()); }
  if (event.key === 'ArrowLeft') { event.preventDefault(); void readingAction(() => player.previous()); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
window.addEventListener('online', () => void refresh());
window.addEventListener('pagehide', () => player.pause());

if (!canvasId && params.get('example') === '1') {
  try {
    const { data } = await request('/canvases', { method: 'POST', body: {
      title: 'Free Kokoro speech test', language: 'en', chapters: [{ title: 'Listen and read', pages: [{ title: 'First steps',
        text: 'This canvas uses the free Kokoro voice on our server. You do not need a key to listen. Read each sentence as the player speaks. You can pause, repeat a sentence, or move to the next one.',
      }], subchapters: [] }],
    } });
    canvasId = data._id;
    storage.set(`owner:${canvasId}`, { manage_code: data.manage_code, upload_code: data.upload_code, upload_expires_at: data.upload_expires_at });
    history.replaceState(null, '', `?id=${encodeURIComponent(canvasId)}`);
  } catch { message('Could not create the test canvas. Please try again.'); }
}
if (canvasId) { showReader(); void refresh(); }
