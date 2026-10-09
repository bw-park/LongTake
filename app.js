'use strict';
const $ = selector => document.querySelector(selector);
const items = new Map();
let media, activeHorizon = 30, shown = 0, activeComparison = null;
let comparisonVideos = [], comparisonLoading = false, comparisonToken = 0;
let comparisonOperation = 0, comparisonSeeking = false, comparisonResume = false, seekTimer;
const videoStates = new WeakMap(), inlineSlots = new Set(), slotStates = new WeakMap();
const playbackRates = new Map();
const inlineGroups = new Map();
let comparisonVisible = false, comparisonManualPause = false;
let hlsLoader;
const mediaReady = fetch('data/media.json?v=public20260925').then(response => {
  if (!response.ok) throw new Error('The video collection could not be loaded.');
  return response.json();
}).then(data => {
  media = data;
  data.items.forEach(item => items.set(item.id, item));
  renderComparisonTabs(); selectComparison(data.comparisons[0].id);
  renderGallery(true);
  return data;
});

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function clock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function imageFor(item) {
  const img = element('img');
  img.src = item.poster; img.alt = item.title;
  img.width = item.width; img.height = item.height;
  img.loading = 'lazy'; img.decoding = 'async';
  return img;
}
function mediaButton(item, compact = false) {
  const button = element('button', 'media-open');
  button.type = 'button'; button.dataset.item = item.id;
  button.setAttribute('aria-label', `Play ${item.title}, ${item.method}, ${item.duration} seconds`);
  const play = element('span', 'play-circle', '▶'); play.setAttribute('aria-hidden', 'true');
  button.append(imageFor(item), play);
  if (!compact) button.append(element('span', 'duration', `${item.duration} s`));
  return button;
}
function updateSpeedControl(control, rate) {
  control.querySelectorAll('[data-speed]').forEach(button => {
    button.setAttribute('aria-pressed', String(Number(button.dataset.speed) === rate));
  });
}
function applyPlaybackRate(video, rate) {
  if (video.defaultPlaybackRate !== rate) video.defaultPlaybackRate = rate;
  if (video.playbackRate !== rate) video.playbackRate = rate;
}
function makeSpeedControl(key, getVideo) {
  const control = element('div', 'playback-speed');
  control.setAttribute('role', 'group'); control.setAttribute('aria-label', 'Playback speed');
  for (const rate of [1, 2, 5]) {
    const button = element('button', '', `${rate}×`);
    button.type = 'button'; button.dataset.speed = rate;
    button.setAttribute('aria-label', `${rate}× playback speed`);
    control.append(button);
  }
  updateSpeedControl(control, playbackRates.get(key) || 1);
  control.addEventListener('click', event => {
    const button = event.target.closest('[data-speed]');
    if (!button) return;
    event.stopPropagation();
    const rate = Number(button.dataset.speed);
    playbackRates.set(key, rate); updateSpeedControl(control, rate);
    const video = getVideo();
    if (video) applyPlaybackRate(video, rate);
  });
  return control;
}
function bindPlaybackRate(video, key, control) {
  applyPlaybackRate(video, playbackRates.get(key) || 1);
  video.addEventListener('ratechange', () => {
    if (videoStates.get(video).disposed) return;
    playbackRates.set(key, video.playbackRate);
    updateSpeedControl(control, video.playbackRate);
  });
}
// Group intent also applies to cards that have not entered the viewport yet.
function setupInlineGroup(rootId, controlsId, playId, label) {
  const root = document.getElementById(rootId), play = document.getElementById(playId);
  const group = {root, play, rate:1, paused:false, prefix:`inline:${rootId}:`};
  group.speed = makeSpeedControl(`${rootId}:all`, () => null);
  group.speed.setAttribute('aria-label', `Playback speed for all ${label}`);
  document.getElementById(controlsId).append(group.speed);
  inlineGroups.set(root, group);
  group.speed.addEventListener('click', event => {
    const button = event.target.closest('[data-speed]');
    if (!button) return;
    group.rate = Number(button.dataset.speed);
    for (const key of playbackRates.keys()) {
      if (key.startsWith(group.prefix)) playbackRates.set(key, group.rate);
    }
    root.querySelectorAll('.inline-player').forEach(slot => {
      const state = slotStates.get(slot);
      playbackRates.set(state.rateKey, group.rate);
      updateSpeedControl(state.speedControl, group.rate);
      if (state.video) applyPlaybackRate(state.video, group.rate);
    });
    updateInlineGroup(group);
  });
  play.addEventListener('click', () => {
    const slots = [...root.querySelectorAll('.inline-player')];
    group.paused = slots.some(slot => !slotStates.get(slot).manualPause);
    slots.forEach(slot => {
      const state = slotStates.get(slot);
      state.manualPause = group.paused;
      if (group.paused && state.video) suspendVideo(state.video);
      else updateInline(slot);
    });
    updateInlineGroup(group);
  });
}
function updateInlineGroup(group) {
  if (!group) return;
  const states = [...group.root.querySelectorAll('.inline-player')].map(slot => slotStates.get(slot));
  const rates = states.map(state => playbackRates.get(state.rateKey) || 1);
  updateSpeedControl(group.speed, rates.length && rates.every(rate => rate === rates[0]) ? rates[0] : null);
  group.play.textContent = states.some(state => !state.manualPause) ? 'Pause together Ⅱ' : 'Play together ▶';
}
setupInlineGroup('video-gallery', 'gallery-speed-all', 'play-gallery', 'gallery videos');
// The host does not serve byte ranges. Fetch small independent HLS segments
// so an unbuffered seek never requires downloading the preceding video.
function loadHls() {
  if (!hlsLoader) hlsLoader = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'assets/vendor/hls.light.min.js';
    script.onload = () => resolve(window.Hls);
    script.onerror = () => { hlsLoader = null; script.remove(); reject(new Error('The video player could not load. Please retry.')); };
    document.head.append(script);
  });
  return hlsLoader;
}
function makeVideo(item, controls = false) {
  const video = document.createElement('video');
  video.preload = 'none'; video.playsInline = true; video.muted = true;
  video.poster = item.poster; video.controls = controls;
  video.width = item.width; video.height = item.height;
  video.setAttribute('aria-label', `${item.title} — ${item.method}, ${item.duration} seconds`);
  videoStates.set(video, {disposed:false, hls:null, failed:false, suspended:false, downloadStopped:false});
  return video;
}
async function attachVideo(video, item, startTime = 0) {
  const state = videoStates.get(video);
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    if (state.disposed) return;
    video.src = item.video;
    if (startTime) video.addEventListener('loadedmetadata', () => { if (!state.disposed) video.currentTime = startTime; }, {once:true});
    video.load();
    return;
  }
  const Hls = await loadHls();
  if (state.disposed) return;
  if (!Hls.isSupported()) throw new Error('Video playback is not supported by this browser.');
  const hls = state.hls = new Hls({
    maxBufferLength:6, maxMaxBufferLength:12, backBufferLength:4,
    maxBufferSize:4 * 1024 * 1024, startPosition:startTime,
  });
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (data.fatal && !state.disposed) {
      state.failed = true;
      video.dispatchEvent(new Event('playbackerror'));
    }
  });
  hls.loadSource(item.video); hls.attachMedia(video);
}
function pauseComparison() {
  ++comparisonOperation; clearTimeout(seekTimer);
  comparisonResume = false; comparisonSeeking = false; comparisonLoading = false;
  comparisonVideos.forEach(video => video.pause());
  const button = $('#play-comparison');
  if (button) { button.disabled = false; button.textContent = 'Play together ▶'; }
}
function disposeVideo(video) {
  const state = videoStates.get(video);
  if (state) { state.disposed = true; state.hls?.destroy(); }
  video.dispatchEvent(new Event('playbackdisposed'));
  video.pause(); video.removeAttribute('src'); video.load();
}
// Observe stable poster slots: only visible examples create a player or fetch video.
function registerInline(root) {
  const group = inlineGroups.get(root);
  root.querySelectorAll('.media-open').forEach(button => {
    if (button.closest('.inline-player')) return;
    const slot = element('div', 'inline-player' + (button.classList.contains('featured') ? ' featured' : ''));
    slot.dataset.item = button.dataset.item;
    button.classList.remove('featured');
    button.replaceWith(slot); slot.append(button);
    const rateKey = `${group.prefix}${slot.dataset.item}`;
    if (!playbackRates.has(rateKey)) playbackRates.set(rateKey, group.rate);
    const speedControl = makeSpeedControl(rateKey, () => slotStates.get(slot)?.video);
    slot.append(speedControl);
    slotStates.set(slot, {visible:false, manualPause:group.paused, video:null, rateKey, speedControl, group});
    speedControl.addEventListener('click', () => updateInlineGroup(group));
    inlineSlots.add(slot); inlineObserver.observe(slot);
  });
  updateInlineGroup(group);
}
function clearInline(root) {
  root.querySelectorAll('.inline-player').forEach(slot => {
    inlineObserver.unobserve(slot); inlineSlots.delete(slot);
    if (slotStates.get(slot)?.video) disposeVideo(slotStates.get(slot).video);
  });
}
function suspendVideo(video) {
  const state = videoStates.get(video);
  if (!state || state.disposed) return;
  state.suspended = true; video.pause();
  if (state.hls && !state.downloadStopped) { state.hls.stopLoad(); state.downloadStopped = true; }
}
function resumeVideo(video) {
  const state = videoStates.get(video);
  if (!state || state.disposed) return;
  state.suspended = false;
  if (state.hls && state.downloadStopped) { state.hls.startLoad(-1); state.downloadStopped = false; }
}
function updateInline(slot) {
  const state = slotStates.get(slot);
  if (!state || !slot.isConnected) return;
  if (!state.visible || document.hidden) {
    if (state.video) suspendVideo(state.video);
    return;
  }
  if (state.manualPause) {
    if (state.video) suspendVideo(state.video);
    return;
  }
  if (!state.video) { startInline(items.get(slot.dataset.item), slot); return; }
  const playback = videoStates.get(state.video);
  if (playback.disposed || playback.failed) return;
  resumeVideo(state.video);
  // A rejected autoplay leaves the native controls available for a manual start.
  state.video.play().catch(() => {});
}
async function startInline(item, slot) {
  if (!item || !slot.isConnected) return;
  const slotState = slotStates.get(slot);
  if (slotState.video) disposeVideo(slotState.video);
  const topline = slot.querySelector('.media-topline')?.cloneNode(true);
  const video = makeVideo(item, true); video.loop = true;
  bindPlaybackRate(video, slotState.rateKey, slotState.speedControl);
  video.addEventListener('ratechange', () => { if (!videoStates.get(video).disposed) updateInlineGroup(slotState.group); });
  const status = element('div', 'inline-status', 'Loading video…');
  status.setAttribute('role', 'status');
  slot.replaceChildren(video, status, slotState.speedControl);
  if (topline) slot.append(topline);
  slotState.video = video;
  const state = videoStates.get(video);
  const waiting = () => { if (!state.failed) { status.textContent = video.seeking ? 'Loading this moment…' : 'Loading video…'; status.hidden = false; } };
  const ready = () => { status.hidden = true; };
  const failed = () => {
    if (state.disposed) return;
    state.failed = true; suspendVideo(video); status.hidden = false;
    const retry = element('button', '', 'Retry video'); retry.type = 'button';
    retry.addEventListener('click', () => { slotState.manualPause = false; startInline(item, slot); });
    status.replaceChildren(element('span', '', 'Video could not load. '), retry);
  };
  video.addEventListener('waiting', waiting); video.addEventListener('seeking', waiting);
  video.addEventListener('playing', ready); video.addEventListener('canplay', ready);
  video.addEventListener('error', failed); video.addEventListener('playbackerror', failed);
  video.addEventListener('pause', () => {
    if (video.paused && !state.disposed && !state.suspended && !state.failed && !video.ended && !video.seeking) slotState.manualPause = true;
    if (!state.disposed) updateInlineGroup(slotState.group);
  });
  video.addEventListener('play', () => {
    if (video.paused) return;
    if (!slotState.visible || document.hidden) { suspendVideo(video); return; }
    slotState.manualPause = false; resumeVideo(video);
    updateInlineGroup(slotState.group);
  });
  try {
    await attachVideo(video, item);
    if (!state.disposed) updateInline(slot);
  } catch (error) { if (!state.disposed) failed(); }
}
const inlineObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    const state = slotStates.get(entry.target);
    if (!state) continue;
    state.visible = entry.isIntersecting && entry.intersectionRatio >= .1;
    updateInline(entry.target);
  }
}, {threshold:[0, .1]});
document.addEventListener('click', event => {
  const button = event.target.closest('.media-open');
  if (!button) return;
  if (button.closest('#comparison-grid')) {
    comparisonManualPause = false;
    if (!comparisonLoading) runComparison(Number($('#comparison-seek').value), true);
    return;
  }
  const slot = button.closest('.inline-player'), state = slotStates.get(slot);
  if (state) { state.manualPause = false; state.visible = true; updateInline(slot); updateInlineGroup(state.group); }
});

function renderGallery(reset = false) {
  const grid = $('#video-gallery');
  const ids = media.galleries[String(activeHorizon)];
  if (reset) { clearInline(grid); grid.replaceChildren(); shown = 0; }
  const next = ids.slice(shown, shown + 12);
  const fragment = document.createDocumentFragment();
  for (const id of next) {
    const item = items.get(id);
    const card = element('article', 'video-card'); card.id = `card-${id}`;
    const prompt = element('details', 'card-prompt');
    prompt.append(element('summary', '', `Prompt ${id.split('-').at(-1)}`), element('p', '', item.prompt));
    card.append(mediaButton(item), prompt); fragment.append(card);
  }
  grid.append(fragment); shown += next.length; registerInline(grid);
  $('#load-more').hidden = shown >= ids.length;
  $('#load-more').textContent = `Show ${Math.min(12, ids.length - shown)} more videos +`;
  $('#gallery-count').textContent = `${shown} of ${ids.length} videos · ${activeHorizon} s`;
  $('#gallery-panel').setAttribute('aria-labelledby', `gallery-tab-${activeHorizon}`);
  for (const tab of document.querySelectorAll('[data-horizon]')) {
    const selected = Number(tab.dataset.horizon) === activeHorizon;
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
  }
}
$('.segmented').addEventListener('click', event => {
  const button = event.target.closest('[data-horizon]');
  if (!button || !media) return;
  activeHorizon = Number(button.dataset.horizon); renderGallery(true);
});
$('#load-more').addEventListener('click', () => renderGallery());
function keyboardTabs(event) {
  const tabs = [...event.currentTarget.querySelectorAll('[role=tab]')];
  const index = tabs.indexOf(document.activeElement); if (index < 0) return;
  let target;
  if (event.key === 'ArrowRight') target = tabs[(index + 1) % tabs.length];
  if (event.key === 'ArrowLeft') target = tabs[(index - 1 + tabs.length) % tabs.length];
  if (event.key === 'Home') target = tabs[0];
  if (event.key === 'End') target = tabs.at(-1);
  if (target) { event.preventDefault(); target.focus(); target.click(); }
}
$('.segmented').addEventListener('keydown', keyboardTabs);
$('#comparison-tabs').addEventListener('keydown', keyboardTabs);

function renderComparisonTabs() {
  media.comparisons.forEach(comparison => {
    const button = element('button', '', comparison.tabLabel);
    button.type = 'button'; button.id = `compare-tab-${comparison.id}`;
    button.dataset.comparison = comparison.id; button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', 'comparison-panel'); button.setAttribute('aria-selected', 'false');
    button.tabIndex = -1; $('#comparison-tabs').append(button);
  });
}
function selectComparison(id) {
  pauseComparison(); ++comparisonToken;
  $('#comparison-grid').querySelectorAll('video').forEach(disposeVideo); comparisonVideos = [];
  activeComparison = media.comparisons.find(c => c.id === id);
  $('#comparison-meta').textContent = `${activeComparison.horizon} seconds · ${activeComparison.horizon === 30 ? 'MovieGen' : 'VBench'} prompt ${String(activeComparison.promptIndex).padStart(3, '0')}`;
  $('#comparison-prompt').textContent = activeComparison.prompt;
  $('#comparison-status').textContent = '';
  $('#comparison-duration').textContent = clock(activeComparison.horizon);
  const seek = $('#comparison-seek'); seek.max = activeComparison.horizon; seek.value = 0;
  $('#comparison-time').textContent = '0:00';
  $('#play-comparison').disabled = false; $('#play-comparison').textContent = 'Play together ▶';
  $('#comparison-grid').replaceChildren();
  activeComparison.items.forEach(id => {
    const item = items.get(id);
    const cell = element('article', 'comparison-cell' + (id.startsWith('ours-') ? ' ours' : ''));
    const title = element('h4', '', id.startsWith('ours-') ? 'LongTake' : item.method);
    const stage = element('div', 'comparison-media'); stage.append(mediaButton(item, true));
    const rateKey = `comparison:${activeComparison.id}:${id}`;
    if (!playbackRates.has(rateKey)) playbackRates.set(rateKey, playbackRates.get('comparison:all') || 1);
    stage.dataset.rateKey = rateKey;
    const speed = makeSpeedControl(rateKey, () => stage.querySelector('video'));
    speed.addEventListener('click', updateComparisonSpeed);
    stage.append(speed);
    cell.append(title, stage); $('#comparison-grid').append(cell);
  });
  $('#comparison-panel').setAttribute('aria-labelledby', `compare-tab-${id}`);
  document.querySelectorAll('[data-comparison]').forEach(tab => {
    const selected = tab.dataset.comparison === id; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
  });
  updateComparisonSpeed(); updateComparisonVisibility();
}
const comparisonAllSpeed = makeSpeedControl('comparison:all', () => null);
comparisonAllSpeed.setAttribute('aria-label', 'Playback speed for all comparison videos');
$('#comparison-speed-all').append(comparisonAllSpeed);
function updateComparisonSpeed() {
  const rates = [...document.querySelectorAll('.comparison-media')].map(stage => playbackRates.get(stage.dataset.rateKey) || 1);
  updateSpeedControl(comparisonAllSpeed, rates.length && rates.every(rate => rate === rates[0]) ? rates[0] : null);
}
comparisonAllSpeed.addEventListener('click', event => {
  const button = event.target.closest('[data-speed]');
  if (!button) return;
  const rate = Number(button.dataset.speed);
  for (const key of playbackRates.keys()) {
    if (key.startsWith('comparison:')) playbackRates.set(key, rate);
  }
  document.querySelectorAll('.comparison-media').forEach(stage => {
    playbackRates.set(stage.dataset.rateKey, rate);
    updateSpeedControl(stage.querySelector('.playback-speed'), rate);
    const video = stage.querySelector('video');
    if (video) applyPlaybackRate(video, rate);
  });
  updateComparisonSpeed();
});
$('#comparison-tabs').addEventListener('click', event => {
  const button = event.target.closest('[data-comparison]');
  if (button) selectComparison(button.dataset.comparison);
});
function waitUntilReady(video, metadataOnly = false) {
  return new Promise((resolve, reject) => {
    const state = videoStates.get(video);
    const event = metadataOnly ? 'loadedmetadata' : 'canplay';
    const isReady = () => video.readyState >= (metadataOnly ? 1 : 3) && (metadataOnly || !video.seeking);
    if (state.failed || state.disposed || video.error) return reject(new Error('Video could not load. Please retry.'));
    if (isReady()) return resolve();
    let timer;
    function cleanup() { clearTimeout(timer); video.removeEventListener(event, ready); video.removeEventListener('error', failed); video.removeEventListener('playbackerror', failed); video.removeEventListener('playbackdisposed', failed); }
    function ready() { if (isReady()) { cleanup(); resolve(); } }
    function failed() { cleanup(); reject(new Error('Video could not load. Please retry.')); }
    video.addEventListener(event, ready); video.addEventListener('error', failed); video.addEventListener('playbackerror', failed); video.addEventListener('playbackdisposed', failed);
    timer = setTimeout(failed, 30000);
  });
}
async function runComparison(t, play, align = true) {
  const token = comparisonToken, operation = ++comparisonOperation;
  const current = () => token === comparisonToken && operation === comparisonOperation;
  comparisonResume = play; comparisonLoading = true; comparisonSeeking = true;
  comparisonVideos.forEach(video => { resumeVideo(video); video.pause(); });
  const button = $('#play-comparison');
  button.disabled = true; button.textContent = t > 0 ? 'Seeking…' : 'Loading videos…';
  $('#comparison-status').textContent = '';
  t = Math.min(t, activeComparison.horizon - .07);
  $('#comparison-seek').value = t; $('#comparison-time').textContent = clock(t);
  try {
    if (!comparisonVideos.length || comparisonVideos.some(v => v.error || videoStates.get(v).failed)) {
      align = true;
      $('#comparison-grid').querySelectorAll('video').forEach(disposeVideo);
      comparisonVideos = activeComparison.items.map((id, i) => {
        const video = makeVideo(items.get(id));
        const stage = document.querySelectorAll('.comparison-media')[i];
        const speedControl = stage.querySelector('.playback-speed');
        video.loop = true;
        bindPlaybackRate(video, stage.dataset.rateKey, speedControl);
        video.addEventListener('ratechange', () => { if (!videoStates.get(video).disposed) updateComparisonSpeed(); });
        if (i === 0) video.addEventListener('timeupdate', () => {
          if (token !== comparisonToken || comparisonSeeking) return;
          $('#comparison-seek').value = video.currentTime;
          $('#comparison-time').textContent = clock(video.currentTime);
          // Independent rates need independent timelines. Equal rates keep the matched comparison in sync.
          const sharedRate = comparisonVideos.every(other => other.playbackRate === video.playbackRate);
          if (sharedRate && !video.paused && !video.seeking) comparisonVideos.slice(1).forEach(other => {
            if (!other.seeking && other.readyState >= 3 && Math.abs(other.currentTime - video.currentTime) > .35) other.currentTime = video.currentTime;
          });
        });
        stage.replaceChildren(video, speedControl);
        return video;
      });
      await Promise.all(comparisonVideos.map((video, i) => attachVideo(video, items.get(activeComparison.items[i]), t)));
    }
    if (!current()) { comparisonVideos.forEach(v => { if (!comparisonVisible || document.hidden) suspendVideo(v); }); return; }
    await Promise.all(comparisonVideos.map(v => waitUntilReady(v, true)));
    if (!current()) return;
    if (align) comparisonVideos.forEach(v => { v.currentTime = Math.min(t, v.duration - .07); });
    await Promise.all(comparisonVideos.map(v => waitUntilReady(v)));
    if (!current()) return;
    if (play) await Promise.all(comparisonVideos.map(v => v.play()));
    if (!current()) return;
    button.textContent = play ? 'Pause together Ⅱ' : 'Play together ▶';
  } catch (error) {
    if (current()) {
      comparisonVideos.forEach(v => v.pause()); comparisonResume = false;
      $('#comparison-status').textContent = error.message || 'Playback could not start. Please retry.';
      button.textContent = 'Retry playback ▶';
    }
  } finally {
    if (current()) { comparisonLoading = false; comparisonSeeking = false; button.disabled = false; }
  }
}
$('#play-comparison').addEventListener('click', () => {
  if (!activeComparison || comparisonLoading) return;
  if (comparisonVideos.some(v => !v.paused)) { comparisonManualPause = true; pauseComparison(); return; }
  comparisonManualPause = false;
  let t = Number($('#comparison-seek').value);
  if (t >= activeComparison.horizon - .12) t = 0;
  runComparison(t, true, false);
});
$('#comparison-seek').addEventListener('input', event => {
  const t = Number(event.target.value);
  if (!comparisonSeeking) comparisonResume = comparisonVideos.some(v => !v.paused);
  ++comparisonOperation; comparisonSeeking = true;
  comparisonVideos.forEach(v => v.pause());
  $('#comparison-time').textContent = clock(t);
  clearTimeout(seekTimer);
  seekTimer = setTimeout(() => runComparison(t, comparisonResume), 120);
});
function updateComparisonVisibility() {
  if (!comparisonVisible || document.hidden) {
    pauseComparison(); comparisonVideos.forEach(suspendVideo);
    return;
  }
  if (!activeComparison || comparisonManualPause || comparisonLoading || comparisonSeeking || comparisonVideos.some(v => !v.paused)) return;
  let t = Number($('#comparison-seek').value);
  if (t >= activeComparison.horizon - .12) t = 0;
  runComparison(t, true, false);
}
document.addEventListener('visibilitychange', () => {
  inlineSlots.forEach(updateInline);
  updateComparisonVisibility();
});
const comparisonObserver = new IntersectionObserver(entries => {
  comparisonVisible = entries[0].isIntersecting && entries[0].intersectionRatio >= .05;
  updateComparisonVisibility();
}, {threshold:[0, .05]});
comparisonObserver.observe($('#comparison-grid'));
function showGlobalError() {
  $('#gallery-count').textContent = 'The video collection is temporarily unavailable.';
  if (!$('#collection-retry')) {
    const retry = element('button', 'button', 'Reload videos'); retry.id = 'collection-retry'; retry.type = 'button';
    retry.addEventListener('click', () => location.reload()); $('#video-gallery').append(retry);
  }
  $('#load-more').hidden = true;
}
mediaReady.catch(showGlobalError);
