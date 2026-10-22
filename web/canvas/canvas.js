import { createSentencePlayer } from './sentence-player.js';
import { createFreeSpeech, FREE_VOICES, freeAudioCacheKey } from './free-speech.js';
import { canvasPrompt, canvasSentences, canvasPage } from './model.js';

const $ = id => document.getElementById(id);
const configuredApi = document.querySelector('meta[name="canvas-api"]')?.content;
const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const apiBase = new URL(configuredApi || (local ? 'http://localhost:8702/canvas-api' : '/canvas-api'), location.href).href.replace(/\/$/, '');
const params = new URLSearchParams(location.search);
let canvasId = params.get('id') || '';
const request = apiRequest;
const pollInterval = 3000;
let canvas = null, model = { chapters: [], sentences: [], pages: [] }, currentState = null;
let selectedId = '', renderedPageId = '', fullRows = [], highlighted = [];
let focusSentenceId = '', focusWords = [], focusSwipe = null;
let pollTimer, etag, refreshing = false, firstLoad = true, initialViewPending = true;
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
  highlighted = [fullRows[state.sentenceIndex]?.words[state.wordIndex], focusWords[state.wordIndex]];
  for (const element of highlighted) element?.classList.add('is-current');
}
function render(state) {
  currentState = state;
  const sentence = state.sentences[state.sentenceIndex], hasText = Boolean(sentence);
  $('playButton').disabled = !hasText;
  $('focusModeButton').disabled = !hasText;
  if (!hasText && document.body.classList.contains('is-focus-mode')) setFocusMode(false, { moveFocus: false });
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
  renderFullText();
  updateFocusSentence();
  if (sentence?._id !== selectedId) {
    selectedId = sentence?._id || '';
    fullRows.forEach((row, index) => {
      row.button.classList.toggle('is-current', index === state.sentenceIndex);
      row.button.setAttribute('aria-current', String(index === state.sentenceIndex));
    });
    fullRows[state.sentenceIndex]?.button.scrollIntoView({ block: 'nearest' });
    for (const button of document.querySelectorAll('#chapterList button, #chapterPickerList button')) {
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
function renderFullText(force = false) {
  const page = currentState?.sentences[currentState.sentenceIndex]
    ? canvasPage(model, currentState.sentenceIndex) : undefined;
  if (!force && renderedPageId === (page?.id || '')) return;
  renderedPageId = page?.id || '';
  fullRows = [];
  $('fullReader').hidden = !page;
  $('previousPageButton').hidden = !page;
  $('nextPageButton').hidden = !page;
  const pageIndex = model.pages.indexOf(page);
  $('previousPageButton').disabled = pageIndex <= 0;
  $('nextPageButton').disabled = pageIndex < 0 || pageIndex >= model.pages.length - 1;
  const chapterIndex = model.chapters.findIndex(chapter => chapter.id === page?.chapterId);
  $('chapterPosition').textContent = page ? `Chapter ${chapterIndex + 1} of ${model.chapters.length}` : '';
  $('chapterTitleText').textContent = page?.chapterTitle || '';
  $('pagePosition').textContent = page ? `Page ${page.number} of ${page.total}` : '';
  const fragment = document.createDocumentFragment();
  if (page) for (let index = page.startIndex; index < page.endIndex; index++) {
    const sentence = currentState.sentences[index];
    const button = document.createElement('button'); button.type = 'button'; button.className = 'sentence';
    const marker = document.createElement('span'); marker.className = 'sentence-marker';
    button.classList.toggle('is-current', currentState.sentenceIndex === index);
    button.setAttribute('aria-current', String(currentState.sentenceIndex === index));
    const words = appendSentence(marker, sentence);
    button.append(marker);
    button.addEventListener('click', () => { void readingAction(() => player.seekSentence(index)); });
    fullRows[index] = { button, words }; fragment.append(button);
  }
  $('sentenceList').replaceChildren(fragment);
  $('fullReader').scrollTop = 0;
  renderWords(currentState);
}
const sidebarWide = window.matchMedia('(min-width: 721px)');
const controlsWide = window.matchMedia('(min-width: 1041px)');
function showChapters(show) {
  const open = show && !sidebarWide.matches && model.chapters.length > 0;
  $('chapterSidebar').classList.toggle('is-drawer-open', open);
  $('chapterSidebarBackdrop').hidden = !open;
  $('chapterSidebarBackdrop').classList.toggle('is-open', open);
  $('chaptersButton').setAttribute('aria-expanded', String(open));
  if (open) {
    $('chapterSidebar').setAttribute('role', 'dialog');
    $('chapterSidebar').setAttribute('aria-modal', 'true');
    $('chapterList').querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
    $('closeChapters').focus();
  } else {
    $('chapterSidebar').removeAttribute('role');
    $('chapterSidebar').removeAttribute('aria-modal');
    if (document.activeElement?.closest('#chapterSidebar') && !sidebarWide.matches) $('chaptersButton').focus();
  }
}
function openChapterPicker() {
  if (!model.chapters.length) return;
  showChapters(false);
  $('canvasMenu').open = false;
  $('chapterPicker').showModal();
  $('menuChaptersButton').setAttribute('aria-expanded', 'true');
  const selected = $('chapterPickerList').querySelector('.is-selected');
  selected?.scrollIntoView({ block: 'nearest' });
  (selected || $('pickerClose')).focus({ preventScroll: true });
}
function placeReaderTools() {
  const focused = document.body.classList.contains('is-focus-mode');
  const wideCard = !focused && controlsWide.matches;
  const active = document.activeElement;
  showChapters(false);
  if (!focused && sidebarWide.matches) $('playerCardBody').prepend($('chapterSidebar'));
  else document.body.append($('chapterSidebar'));
  (focused ? document.querySelector('.player-stage') : $('playerCard')).append($('playerFooter'));
  if (wideCard) $('playerCardWindows').append($('focusModeButton'));
  else $('playerFooter').prepend($('focusModeButton'));
  (wideCard ? $('readingSettings') : $('footerTools')).append($('autoButton'));
  const settings = focused ? $('focusReadingSettings') : wideCard ? $('readingSettings') : $('menuReadingSettings');
  settings.append($('voiceSetting'), $('paceSetting'));
  $('focusReadingSettings').hidden = !focused;
  $('canvasMenu').classList.toggle('mobile-toolbar-menu', focused);
  (focused ? $('focusToolbarMenu') : $('playerSiteMenu')).append($('canvasMenu'));
  if (active && [$("focusModeButton"), $("autoButton"), $("voiceSetting"), $("paceSetting"), $("canvasMenu")].some(node => node.contains(active))) active.focus({ preventScroll: true });
}
function updateFocusSentence() {
  const sentence = currentState?.sentences[currentState.sentenceIndex];
  if (focusSentenceId !== (sentence?._id || '')) {
    focusSentenceId = sentence?._id || '';
    focusWords = sentence ? appendSentence($('focusSentence'), sentence) : [];
    if (!sentence) $('focusSentence').replaceChildren();
    $('focusReader').scrollTop = 0;
  }
  renderWords(currentState);
}
function setFocusMode(enabled, { moveFocus = true } = {}) {
  enabled = Boolean(enabled && currentState?.sentences.length);
  focusSwipe = null;
  $('canvasMenu').open = false;
  showChapters(false);
  document.body.classList.toggle('is-focus-mode', enabled);
  document.body.classList.toggle('is-card-player', !enabled && !$('playerLayout').hidden);
  $('focusReader').hidden = !enabled;
  $('focusModeButton').setAttribute('aria-pressed', String(enabled));
  const label = enabled ? 'Exit focus mode' : 'Enter focus mode';
  $('focusModeButton').setAttribute('aria-label', label);
  $('focusModeButton').title = label;
  $('focusModeLabel').textContent = enabled ? 'Exit focus' : 'Focus';
  placeReaderTools();
  updateFocusSentence();
  if (moveFocus) (enabled ? $('focusReader') : $('focusModeButton')).focus({ preventScroll: true });
}
sidebarWide.addEventListener('change', placeReaderTools);
controlsWide.addEventListener('change', placeReaderTools);
placeReaderTools();
function renderChapters() {
  for (const [listId, sidebar] of [['chapterList', true], ['chapterPickerList', false]]) {
    const fragment = document.createDocumentFragment();
    for (const chapter of model.chapters) {
      const button = document.createElement('button'); button.type = 'button';
      button.className = sidebar ? 'chapter-option chapter-sidebar-option' : 'chapter-option';
      button.classList.toggle('is-direct', chapter.depth === 0);
      const title = document.createElement('span'); title.className = 'chapter-option-title'; title.textContent = chapter.title;
      button.append(title);
      button.style.setProperty('--depth', chapter.depth); button.dataset.chapterId = chapter.id;
      button.disabled = chapter.startIndex === chapter.endIndex;
      const selected = chapter.id === currentState?.sentences[currentState.sentenceIndex]?.chapterId;
      button.setAttribute('aria-current', String(selected)); button.classList.toggle('is-selected', selected);
      button.addEventListener('click', () => {
        void readingAction(() => player.selectSentence(chapter.startIndex));
        showChapters(false);
        if ($('chapterPicker').open) $('chapterPicker').close();
      });
      fragment.append(button);
    }
    $(listId).replaceChildren(fragment);
  }
  $('chaptersButton').hidden = !model.chapters.length;
  $('menuChaptersButton').hidden = !model.chapters.length;
  $('chapterSidebar').hidden = !model.chapters.length;
  if (!model.chapters.length) {
    showChapters(false);
    if ($('chapterPicker').open) $('chapterPicker').close();
  }
}
function turnPage(direction) {
  const page = canvasPage(model, player.getState().sentenceIndex);
  const next = model.pages[model.pages.indexOf(page) + direction];
  if (next) return readingAction(() => player.selectSentence(next.startIndex));
}
function showReader() {
  document.body.classList.toggle('is-card-player', !document.body.classList.contains('is-focus-mode')); document.body.classList.remove('content-page');
  $('welcome').hidden = true; $('playerLayout').hidden = false; $('playerFooter').hidden = false;
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
    $('bookLabel').textContent = canvas.title; $('bookLabel').title = canvas.title;
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
    renderFullText(true);
    if (initialViewPending && model.sentences.length) {
      initialViewPending = false;
      setFocusMode(params.get('focus') !== '0', { moveFocus: false });
    }
  } catch (error) {
    if (error.status === 404) {
      model = { chapters: [], sentences: [], pages: [] }; await player.load([], { play: false });
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
$('focusModeButton').onclick = () => setFocusMode($('focusReader').hidden);
$('focusSentence').onclick = () => { void readingAction(() => player.replay()); };
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
$('chaptersButton').onclick = () => showChapters(!$('chapterSidebar').classList.contains('is-drawer-open'));
$('closeChapters').onclick = () => showChapters(false);
$('menuChaptersButton').onclick = openChapterPicker;
$('pickerClose').onclick = () => $('chapterPicker').close();
$('chapterPicker').addEventListener('close', () => {
  $('menuChaptersButton').setAttribute('aria-expanded', 'false');
  $('canvasMenu').querySelector('summary').focus({ preventScroll: true });
});
$('chapterPicker').addEventListener('click', event => {
  if (event.target !== $('chapterPicker')) return;
  const bounds = $('chapterPicker').getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) $('chapterPicker').close();
});
$('chapterSidebarBackdrop').onclick = () => showChapters(false);
$('previousPageButton').onclick = () => { void turnPage(-1); };
$('nextPageButton').onclick = () => { void turnPage(1); };
// Keep the site's menu closed after choosing a tool.
$('canvasMenu').addEventListener('click', event => {
  if (event.target.closest('button, a')) $('canvasMenu').open = false;
});
document.addEventListener('click', event => {
  if (!event.target.closest('#canvasMenu')) $('canvasMenu').open = false;
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (document.querySelector('dialog[open]')) return;
    if ($('chapterSidebar').classList.contains('is-drawer-open')) {
      event.preventDefault(); showChapters(false); return;
    }
    if ($('canvasMenu').open) {
      event.preventDefault(); $('canvasMenu').open = false;
      $('canvasMenu').querySelector('summary').focus({ preventScroll: true }); return;
    }
    if (!$('focusReader').hidden) { event.preventDefault(); setFocusMode(false); return; }
  }
  if (event.key === 'Tab' && $('chapterSidebar').classList.contains('is-drawer-open')) {
    const buttons = [...$('chapterSidebar').querySelectorAll('button:not(:disabled)')];
    const first = buttons[0], last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    return;
  }
  if (event.target.closest('input, textarea, select, [contenteditable="true"]') || document.querySelector('dialog[open]') || $('canvasMenu').open || $('chapterSidebar').classList.contains('is-drawer-open') || !currentState?.sentences.length) return;
  if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) {
    event.preventDefault();
    if (!event.repeat) handlePlayerArrow(event.key);
  } else if (event.code === 'Space' && !event.target.closest('button:not(.sentence, .focus-sentence), a')) {
    event.preventDefault(); void toggleReading();
  }
});
function handlePlayerArrow(key) {
  if (document.activeElement?.matches('button, a')) document.activeElement.blur();
  void readingAction(() => ['ArrowRight', 'ArrowDown'].includes(key) ? player.next() : player.previous());
}
function canSwipeFocusReader() {
  return !$('focusReader').hidden && !document.querySelector('dialog[open]') && Boolean(currentState?.sentences.length);
}

$('focusReader').addEventListener("touchstart", (event) => {
  focusSwipe = null;
  if (!canSwipeFocusReader() || event.touches.length !== 1) return;
  const touch = event.touches[0];
  focusSwipe = {
    id: touch.identifier,
    x: touch.clientX,
    y: touch.clientY,
    startedAt: event.timeStamp,
    scrolling: false,
    claimed: false,
  };
}, { passive: true });

$('focusReader').addEventListener("touchmove", (event) => {
  if (!focusSwipe) return;
  if (!canSwipeFocusReader() || event.touches.length !== 1) {
    focusSwipe = null;
    return;
  }
  const touch = event.touches[0];
  const dx = touch.clientX - focusSwipe.x;
  const dy = touch.clientY - focusSwipe.y;
  if (focusSwipe.scrolling || Math.max(Math.abs(dx), Math.abs(dy)) < 10) return;
  if (!focusSwipe.claimed && Math.abs(dy) > Math.abs(dx)) {
    const remainingScroll = $('focusReader').scrollHeight - $('focusReader').clientHeight - $('focusReader').scrollTop;
    // Let a long sentence scroll until the reader reaches its edge.
    if ((dy < 0 && remainingScroll > 1) || (dy > 0 && $('focusReader').scrollTop > 1)) {
      focusSwipe.scrolling = true;
      return;
    }
  }
  if (!event.cancelable) {
    focusSwipe = null;
    return;
  }
  event.preventDefault();
  focusSwipe.claimed = true;
}, { passive: false });

$('focusReader').addEventListener("touchend", (event) => {
  const swipe = focusSwipe;
  focusSwipe = null;
  if (!swipe || swipe.scrolling || event.touches.length || !canSwipeFocusReader()) return;
  const touch = [...event.changedTouches].find((item) => item.identifier === swipe.id);
  if (!touch) return;
  const dx = touch.clientX - swipe.x;
  const dy = touch.clientY - swipe.y;
  const distance = Math.max(Math.abs(dx), Math.abs(dy));
  // A drag must not also replay the sentence through its tap handler.
  if ((swipe.claimed || distance >= 10) && event.cancelable) event.preventDefault();
  if (Math.abs(dy) < 40 || event.timeStamp - swipe.startedAt > 800) return;
  if (Math.abs(dy) < Math.abs(dx) * 1.25) return;
  // Swiping up moves forward; swiping down goes back.
  handlePlayerArrow(dy < 0 ? "ArrowDown" : "ArrowUp");
}, { passive: false });

$('focusReader').addEventListener("touchcancel", () => { focusSwipe = null; });

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
