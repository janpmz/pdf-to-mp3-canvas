import { createSentencePlayer } from './sentence-player.js';
import { createSentenceConversation } from './live-conversation.js';
import { canvasPrompt, canvasSentences } from './model.js';
import { normalizeVoice, normalizePace } from './speech-options.js';

const $ = id => document.getElementById(id);
const configuredApi = document.querySelector('meta[name="canvas-api"]')?.content;
const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const apiBase = new URL(configuredApi || (local ? 'http://localhost:8702/canvas-api' : '/canvas-api'), location.href).href.replace(/\/$/, '');
const params = new URLSearchParams(location.search);
let canvasId = params.get('id') || '';
const source = !canvasId && params.get('example') === '1'
  ? (await import('./example.js?v=20261019-chat')).createCanvasExample() : {};
canvasId ||= source.canvasId || '';
const request = source.request || apiRequest;
const pollInterval = source.pollInterval ?? 3000;
let canvas = null, model = { chapters: [], sentences: [] }, currentState = null;
let focusedId = '', focusedWords = [], fullRows = [], highlighted = [];
let focus = true, pollTimer, etag, refreshing = false, firstLoad = true;
let pendingAction = '', lastSavedSentence = '', noticeTimer;
let activeChat = null, chatRun = 0;
const storage = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(`canvas:${key}`)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`canvas:${key}`, JSON.stringify(value)); return true; } catch { return false; } },
  remove(key) { try { localStorage.removeItem(`canvas:${key}`); return true; } catch { return false; } },
};
function savedSpeechKey() {
  const value = storage.get('gemini-key', '');
  return typeof value === 'string' && value.length <= 1024 ? value.trim() : '';
}
// One saved key serves all canvases in this browser. Only Google receives it.
let geminiKey = savedSpeechKey();
const settingsKey = source.settingsKey || 'settings';
const settings = storage.get(settingsKey, {});
$('voice').value = normalizeVoice(settings.voice);
$('pace').value = normalizePace(settings.pace || 'normal');
source.configureControls?.({ voice: $('voice'), pace: $('pace') });
const player = createSentencePlayer({
  voice: $('voice').value, pace: $('pace').value, prefetchWithoutAutoplay: true,
  getToken: speechKey,
  onStateChange: render, onProgress: renderWords,
  onError: (text, error) => {
    if (error?.code === 'CANVAS_KEY_REQUIRED') { pendingAction = 'read'; openKey(); }
    else message(source.speechError || 'Speech could not start. Check your Gemini key and its access to Gemini Live, then try again.');
  },
  ...source.playerOptions,
});
const conversation = (source.createConversation || createSentenceConversation)({
  getToken: speechKey,
  playbackWorkletUrl: new URL('./live-audio-playback-worklet.js', import.meta.url),
  onStateChange: renderChat,
  onError: text => message(text),
});
player.setAutoplay(settings.autoplay !== false);

function speechKey() {
  if (!geminiKey) throw Object.assign(new Error('Enter your Gemini key to listen.'), { code: 'CANVAS_KEY_REQUIRED' });
  return geminiKey;
}
function syncSpeechKey() {
  const saved = savedSpeechKey();
  if (saved === geminiKey) return;
  geminiKey = saved;
  updateKeyField();
  void stopChat();
  void player.load(currentState?.sentences || [], { play: false, sentenceIndex: currentState?.sentenceIndex || 0, sessionId: canvasId });
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
  highlighted = activeChat ? [] : [focusedWords[state.wordIndex], fullRows[state.sentenceIndex]?.words[state.wordIndex]];
  for (const element of highlighted) element?.classList.add('is-current');
}
function render(state) {
  currentState = state;
  const sentence = state.sentences[state.sentenceIndex], hasText = Boolean(sentence);
  $('playButton').disabled = !hasText;
  $('repeatButton').disabled = !hasText;
  $('previousButton').disabled = !hasText || state.sentenceIndex === 0;
  $('nextButton').disabled = !hasText || state.sentenceIndex >= state.sentences.length - 1;
  $('askButton').disabled = !hasText;
  $('explainButton').disabled = !hasText;
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
  if (sentence?._id !== focusedId) {
    focusedId = sentence?._id || '';
    focusedWords = sentence ? appendSentence($('focusSentence'), sentence) : [];
    if (!sentence) $('focusSentence').replaceChildren();
    fullRows.forEach((row, index) => row.button.classList.toggle('is-selected', index === state.sentenceIndex));
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
    const words = appendSentence(button, sentence);
    button.addEventListener('click', () => { void readingAction(() => player.selectSentence(index)); });
    fullRows.push({ button, words }); fragment.append(button);
  }
  $('fullReader').replaceChildren(fragment);
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
  document.body.classList.toggle('is-focus-mode', focus);
  $('welcome').hidden = true; $('reader').hidden = false; $('playerFooter').hidden = false;
  $('shareButton').hidden = false; $('keyButton').hidden = false;
  $('promptButton').hidden = !owner(); $('emptyPrompt').hidden = !owner();
}
async function refresh() {
  if (refreshing || !canvasId) return;
  refreshing = true;
  try {
    const result = await request(`/canvases/${encodeURIComponent(canvasId)}`, { tag: etag });
    if (result.unchanged) return;
    canvas = result.data; etag = result.tag; model = canvasSentences(canvas);
    if (activeChat) {
      const previous = currentState?.sentences[currentState.sentenceIndex];
      if (!model.sentences.some(sentence => sentence._id === previous?._id && sentence.text === previous?.text)) await stopChat();
    }
    document.title = `${canvas.title} — PDF TO MP3 Canvas`; document.documentElement.lang = canvas.language;
    $('canvasName').textContent = canvas.title;
    showReader();
    const empty = !model.sentences.length;
    $('emptyCanvas').hidden = !empty; $('focusReader').hidden = empty || !focus;
    $('fullReader').hidden = empty || focus; $('readingSettings').hidden = empty;
    if (firstLoad) {
      const saved = storage.get(`position:${canvasId}`, '');
      const index = Math.max(0, model.sentences.findIndex(sentence => sentence._id === saved));
      await player.load(model.sentences, { play: false, sentenceIndex: index, sessionId: canvasId });
      firstLoad = false;
    } else await player.updateSentences(model.sentences, { sessionId: canvasId });
    renderChapters();
    if (!focus) renderFullText();
  } catch (error) {
    if (error.status === 404) {
      await stopChat();
      await player.load([], { play: false }); model = { chapters: [], sentences: [] };
      renderChapters(); showReader(); $('emptyCanvas').hidden = false;
      $('emptyCanvas').querySelector('h2').textContent = 'Canvas not found';
      $('emptyMessage').textContent = 'Check the link. The canvas may have been deleted.';
      $('emptyTip').hidden = true; $('focusReader').hidden = true; $('fullReader').hidden = true;
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
function updateKeyField() {
  $('geminiKey').value = '';
  $('geminiKey').required = !geminiKey;
  $('geminiKey').placeholder = geminiKey ? `•••••••• ${geminiKey.slice(-4)}` : 'Paste your Gemini key';
  $('forgetKey').hidden = !geminiKey;
}
function openKey() {
  updateKeyField();
  if (!$('keyDialog').open) $('keyDialog').showModal();
  $('geminiKey').focus();
}
function saveSettings() {
  storage.set(settingsKey, { voice: $('voice').value, pace: $('pace').value, autoplay: player.getState().autoplay });
}

function renderChat(state = 'idle') {
  if (state === 'idle') activeChat = null;
  const row = document.querySelector('.action-row');
  const activeButton = activeChat && $(activeChat === 'ask' ? 'askButton' : 'explainButton');
  if (activeButton && !activeButton.classList.contains('is-feature-active')) {
    const parent = row.getBoundingClientRect(), button = activeButton.getBoundingClientRect();
    activeButton.style.setProperty('--feature-start-x', `${button.left + button.width / 2 - parent.left - parent.width / 2}px`);
    activeButton.style.setProperty('--feature-start-y', `${button.top + button.height / 2 - parent.top - parent.height / 2}px`);
  }
  row.classList.toggle('has-feature-active', !!activeChat);
  row.querySelector('.player-controls').inert = !!activeChat;
  for (const type of ['ask', 'explain']) {
    const button = $(type === 'ask' ? 'askButton' : 'explainButton'), selected = activeChat === type;
    button.classList.toggle('is-feature-active', selected);
    button.inert = !!activeChat && !selected;
    for (const value of ['connecting', 'speaking', 'listening']) button.classList.toggle(`is-${value}`, selected && state === value);
    if (selected) button.dataset.voiceState = state;
    else {
      delete button.dataset.voiceState;
      button.style.removeProperty('--feature-start-x'); button.style.removeProperty('--feature-start-y');
    }
    button.setAttribute('aria-pressed', String(selected));
    button.setAttribute('aria-label', selected ? `Stop ${type} voice chat` : type === 'ask' ? 'Ask about this sentence' : 'Explain this sentence');
    button.querySelector('.speak-label').textContent = selected
      ? ({ connecting: 'Connecting…', listening: 'Listening…', speaking: 'Speaking…' }[state] || 'End chat')
      : type === 'ask' ? 'Ask' : 'Explain';
  }
  if (currentState) renderWords(currentState);
}
async function stopChat() {
  const run = ++chatRun;
  await conversation.stop();
  if (run === chatRun) renderChat();
  return run;
}
async function startChat(type) {
  if (!currentState?.sentences.length) return;
  pendingAction = '';
  if (activeChat === type) { await stopChat(); return; }
  const run = ++chatRun;
  await conversation.stop();
  if (run !== chatRun) return;
  player.pause(); message('');
  if (!geminiKey && conversation.requiresKey !== false) { pendingAction = type; openKey(); return; }
  activeChat = type; renderChat('connecting');
  const state = player.getState();
  await conversation.start({ type, sentences: state.sentences, sentenceIndex: state.sentenceIndex, voice: state.voice, pace: state.pace });
}
async function readingAction(action) {
  pendingAction = '';
  const run = await stopChat();
  if (run !== chatRun) return;
  message('');
  return action();
}
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
$('keyButton').onclick = openKey;
$('closeKey').onclick = () => $('keyDialog').close();
$('keyDialog').addEventListener('close', () => { $('geminiKey').value = ''; pendingAction = ''; });
$('keyForm').addEventListener('submit', async event => {
  event.preventDefault();
  const value = $('geminiKey').value.trim();
  if (value) geminiKey = value;
  if (!geminiKey) return;
  const saved = storage.set('gemini-key', geminiKey);
  const resume = pendingAction; pendingAction = ''; $('geminiKey').value = '';
  $('keyDialog').close(); message('');
  if (resume === 'read') await readingAction(() => player.play());
  else if (resume) await startChat(resume);
  if (!saved && geminiKey) message('Your browser could not save the key. You will need to enter it again after closing or reloading this page.');
});
$('forgetKey').onclick = () => {
  if (!storage.remove('gemini-key')) { message('Your browser could not remove the saved key. Try again.'); return; }
  geminiKey = ''; $('geminiKey').value = '';
  updateKeyField();
  void stopChat();
  void player.load(currentState?.sentences || [], { play: false, sentenceIndex: currentState?.sentenceIndex || 0, sessionId: canvasId });
  $('keyDialog').close(); message('Gemini key removed from this browser.', true);
};
$('playButton').onclick = () => { void toggleReading(); };
$('focusSentence').onclick = () => { void toggleReading(); };
$('repeatButton').onclick = () => { void readingAction(() => player.replay()); };
$('previousButton').onclick = () => { void readingAction(() => player.previous()); };
$('nextButton').onclick = () => { void readingAction(() => player.next()); };
$('askButton').onclick = () => { void startChat('ask'); };
$('explainButton').onclick = () => { void startChat('explain'); };
$('autoButton').onclick = () => {
  player.setAutoplay(!player.getState().autoplay); saveSettings();
  const state = player.getState();
  if (state.autoplay && state.status === 'ended' && state.sentenceIndex + 1 < state.sentences.length) void readingAction(() => player.next());
};
$('voice').onchange = () => { void readingAction(() => player.setVoice($('voice').value)); saveSettings(); };
$('pace').onchange = () => { void readingAction(() => player.setPace($('pace').value)); saveSettings(); };
$('focusButton').onclick = () => {
  focus = !focus; document.body.classList.toggle('is-focus-mode', focus);
  $('focusModeLabel').textContent = focus ? 'Full text' : 'Focus';
  $('focusButton').setAttribute('aria-label', focus ? 'Full text' : 'Focus');
  $('focusButton').title = focus ? 'Full text' : 'Focus';
  $('focusButton').setAttribute('aria-pressed', String(focus));
  $('focusReader').hidden = !focus || !model.sentences.length; $('fullReader').hidden = focus || !model.sentences.length;
  if (!focus) renderFullText();
};
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
  if (event.key === 'Escape' && activeChat) { event.preventDefault(); void stopChat(); return; }
  if (event.key === 'Escape') { showChapters(false); $('canvasMenu').open = false; }
  if (event.target.closest('input, textarea, select, button, a') || document.querySelector('dialog[open]') || !currentState?.sentences.length) return;
  if (event.code === 'Space') { event.preventDefault(); void toggleReading(); }
  if (event.key === 'ArrowRight') { event.preventDefault(); void readingAction(() => player.next()); }
  if (event.key === 'ArrowLeft') { event.preventDefault(); void readingAction(() => player.previous()); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
window.addEventListener('online', () => void refresh());
window.addEventListener('storage', event => {
  if (event.key === 'canvas:gemini-key' || event.key === null) syncSpeechKey();
});
window.addEventListener('pageshow', syncSpeechKey);
window.addEventListener('pagehide', () => {
  void stopChat();
  geminiKey = ''; $('geminiKey').value = '';
  void player.load(currentState?.sentences || [], { play: false, sentenceIndex: currentState?.sentenceIndex || 0, sessionId: canvasId });
});

if (canvasId) { showReader(); void refresh(); }
