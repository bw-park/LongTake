'use strict';
// Figure 3: matched teacher initializations, independent of the other players.
mediaReady.then(data => {
  const experiments = data.teacherComparison?.examples;
  if (!experiments?.length) return;
  let experiment, cells = [];
  const root = $('#teacher-initialization'), grid = $('#teacher-grid');
  const playButton = $('#play-teacher'), seek = $('#teacher-seek');
  const status = $('#teacher-status'), time = $('#teacher-time');
  let videos = [], operation = 0, visible = false, manualPause = false;
  let busy = false, seeking = false, seekResume = false, timer;
  const tabs = $('#teacher-tabs');
  experiments.forEach(example => {
    const tab = element('button', '', example.title);
    tab.type = 'button'; tab.id = `teacher-tab-${example.id}`;
    tab.dataset.example = example.id; tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', 'teacher-panel');
    tab.setAttribute('aria-selected', 'false'); tab.tabIndex = -1;
    tabs.append(tab);
  });
  function selectExample(id) {
    stop(); videos.forEach(disposeVideo); videos = [];
    experiment = experiments.find(example => example.id === id);
    grid.replaceChildren();
    cells = experiment.entries.map(entry => {
      const item = items.get(entry.item);
      const cell = element('article', 'teacher-cell' + (entry.key === 'ours' ? ' ours' : ''));
      cell.dataset.method = entry.key;
      const title = element('h4', '', entry.label);
      const stage = element('div', 'teacher-media');
      const key = `teacher:${item.id}`;
      if (!playbackRates.has(key)) playbackRates.set(key, playbackRates.get('teacher:all') || 1);
      const speed = makeSpeedControl(key, () => stage.querySelector('video'));
      speed.setAttribute('aria-label', `Playback speed for ${entry.label}`);
      stage.append(mediaButton(item, true));
      cell.append(title, stage, speed); grid.append(cell);
      speed.addEventListener('click', sharedSpeed);
      return {item, stage, key, speed};
    });
    $('#teacher-prompt').textContent = experiment.prompt;
    seek.value = 0; time.textContent = '0:00'; status.textContent = '';
    $('#teacher-meta').textContent = `30 seconds · MovieGen prompt ${String(experiment.promptIndex).padStart(3, '0')}`;
    $('#teacher-panel').setAttribute('aria-labelledby', `teacher-tab-${experiment.id}`);
    tabs.querySelectorAll('[role=tab]').forEach(tab => {
      const selected = tab.dataset.example === id;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    });
    sharedSpeed(); updateVisibility();
  }
  tabs.addEventListener('click', event => {
    const tab = event.target.closest('[data-example]');
    if (tab) selectExample(tab.dataset.example);
  });
  tabs.addEventListener('keydown', keyboardTabs);
  const allSpeed = makeSpeedControl('teacher:all', () => null);
  allSpeed.setAttribute('aria-label', 'Playback speed for all teacher initializations');
  $('#teacher-speed-all').append(allSpeed);

  function sharedSpeed() {
    const rates = cells.map(cell => playbackRates.get(cell.key) || 1);
    updateSpeedControl(allSpeed, rates.every(rate => rate === rates[0]) ? rates[0] : null);
  }
  function stop() {
    ++operation; clearTimeout(timer);
    busy = false; seeking = false; seekResume = false;
    videos.forEach(video => video.pause());
    playButton.disabled = false; playButton.textContent = 'Play together ▶';
  }
  async function run(position, play, align = true) {
    const op = ++operation;
    const current = () => op === operation;
    const t = Math.max(0, Math.min(position, experiment.horizon - .07));
    busy = true; seeking = true;
    videos.forEach(video => { resumeVideo(video); video.pause(); });
    playButton.disabled = true;
    playButton.textContent = t > 0 ? 'Seeking…' : 'Loading videos…';
    status.textContent = ''; seek.value = t; time.textContent = clock(t);
    try {
      if (!videos.length || videos.some(video => video.error || videoStates.get(video).failed)) {
        videos.forEach(disposeVideo); align = true;
        videos = cells.map((cell, index) => {
          const video = makeVideo(cell.item);
          video.setAttribute('aria-label', `${experiment.entries[index].label}, MovieGen prompt ${experiment.promptIndex}, 30 seconds`);
          video.loop = true;
          bindPlaybackRate(video, cell.key, cell.speed);
          video.addEventListener('ratechange', sharedSpeed);
          if (index === 0) video.addEventListener('timeupdate', () => {
            if (seeking || videoStates.get(video).disposed) return;
            seek.value = video.currentTime; time.textContent = clock(video.currentTime);
            if (!video.paused && !video.seeking && videos.every(other => other.playbackRate === video.playbackRate)) {
              videos.slice(1).forEach(other => {
                if (!other.seeking && other.readyState >= 3 && Math.abs(other.currentTime - video.currentTime) > .3) other.currentTime = video.currentTime;
              });
            }
          });
          cell.stage.replaceChildren(video);
          return video;
        });
        await Promise.all(videos.map((video, index) => attachVideo(video, cells[index].item, t)));
      }
      if (!current()) {
        if (!visible || document.hidden) videos.forEach(suspendVideo);
        return;
      }
      await Promise.all(videos.map(video => waitUntilReady(video, true)));
      if (!current()) return;
      if (align) videos.forEach(video => { video.currentTime = Math.min(t, video.duration - .07); });
      await Promise.all(videos.map(video => waitUntilReady(video)));
      if (!current()) return;
      if (play) await Promise.all(videos.map(video => video.play()));
      if (current()) playButton.textContent = play ? 'Pause together Ⅱ' : 'Play together ▶';
    } catch (error) {
      if (current()) {
        videos.forEach(video => video.pause());
        status.textContent = error.message || 'Playback could not start. Please retry.';
        playButton.textContent = 'Retry playback ▶';
      }
    } finally {
      if (current()) { busy = false; seeking = false; playButton.disabled = false; }
    }
  }
  function updateVisibility() {
    if (!visible || document.hidden) {
      stop(); videos.forEach(suspendVideo); return;
    }
    if (manualPause || busy || seeking || videos.some(video => !video.paused)) return;
    run(Number(seek.value), true, false);
  }
  playButton.addEventListener('click', () => {
    if (busy) return;
    if (videos.some(video => !video.paused)) { manualPause = true; stop(); return; }
    manualPause = false; run(Number(seek.value), true, false);
  });
  grid.addEventListener('click', event => {
    if (!event.target.closest('.media-open') || busy) return;
    manualPause = false; run(Number(seek.value), true);
  });
  seek.addEventListener('input', () => {
    if (!seeking) seekResume = videos.some(video => !video.paused);
    ++operation; seeking = true;
    videos.forEach(video => video.pause());
    time.textContent = clock(seek.value); clearTimeout(timer);
    timer = setTimeout(() => run(Number(seek.value), seekResume), 120);
  });
  allSpeed.addEventListener('click', event => {
    const button = event.target.closest('[data-speed]');
    if (!button) return;
    const rate = Number(button.dataset.speed);
    for (const key of playbackRates.keys()) {
      if (key.startsWith('teacher:')) playbackRates.set(key, rate);
    }
    cells.forEach((cell, index) => {
      playbackRates.set(cell.key, rate); updateSpeedControl(cell.speed, rate);
      if (videos[index]) applyPlaybackRate(videos[index], rate);
    });
    if (videos.length && !busy) run(Number(seek.value), videos.some(video => !video.paused));
  });
  const observer = new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting && entries[0].intersectionRatio >= .05;
    updateVisibility();
  }, {threshold: [0, .05]});
  observer.observe(root.querySelector('.teacher-scroll'));
  document.addEventListener('visibilitychange', updateVisibility);
  selectExample(experiments[0].id);
}).catch(() => {
  $('#teacher-status').textContent = 'The teacher comparison could not load. Please reload the page.';
});
