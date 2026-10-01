'use strict';
// Keep the weight sweep independent of the eight-method comparison above it.
mediaReady.then(data => {
  const sweep = data.ablation;
  if (!sweep) return;
  const root = $('#guidance-weight'), grid = $('#lambda-grid');
  const playButton = $('#play-lambda'), seek = $('#lambda-seek');
  const status = $('#lambda-status'), time = $('#lambda-time');
  let videos = [], operation = 0, visible = false, manualPause = false;
  let busy = false, seeking = false, seekResume = false, timer;
  const cells = sweep.entries.map(entry => {
    const item = items.get(entry.item);
    const cell = element('article', 'lambda-cell');
    cell.dataset.lambda = entry.lambda;
    const title = element('h4', '', `λ = ${entry.lambda.toFixed(1)}`);
    const stage = element('div', 'lambda-media');
    const key = `ablation:${item.id}`;
    const speed = makeSpeedControl(key, () => stage.querySelector('video'));
    speed.setAttribute('aria-label', `Playback speed for λ = ${entry.lambda}`);
    stage.append(mediaButton(item, true));
    cell.append(title, stage, speed); grid.append(cell);
    return {item, stage, key, speed};
  });
  $('#lambda-prompt').textContent = sweep.prompt;
  const allSpeed = makeSpeedControl('ablation:all', () => null);
  allSpeed.setAttribute('aria-label', 'Playback speed for all conditional DMD weights');
  $('#lambda-speed-all').append(allSpeed);

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
    const t = Math.max(0, Math.min(position, sweep.horizon - .07));
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
          video.setAttribute('aria-label', `Tokyo street, λ = ${sweep.entries[index].lambda}, 30 seconds`);
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
        if (!visible || !root.open || document.hidden) videos.forEach(suspendVideo);
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
    if (!visible || !root.open || document.hidden) {
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
  cells.forEach(cell => cell.speed.addEventListener('click', sharedSpeed));
  allSpeed.addEventListener('click', event => {
    const button = event.target.closest('[data-speed]');
    if (!button) return;
    const rate = Number(button.dataset.speed);
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
  observer.observe(root.querySelector('.lambda-scroll'));
  root.addEventListener('toggle', updateVisibility);
  document.addEventListener('visibilitychange', updateVisibility);
}).catch(() => {
  $('#lambda-status').textContent = 'The weight comparison could not load. Please reload the page.';
});
