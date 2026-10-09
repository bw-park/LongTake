'use strict';
(() => {
  const root = document.documentElement;
  const toggle = document.querySelector('.theme-toggle');
  const preference = window.matchMedia('(prefers-color-scheme: dark)');
  let saved;
  try { saved = localStorage.getItem('longtake-theme'); } catch (_) {}
  if (saved !== 'light' && saved !== 'dark') saved = null;
  function apply(theme) {
    root.dataset.theme = theme;
    const label = `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`;
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
    document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#1c1c1d' : '#ffffff';
  }
  apply(saved || (preference.matches ? 'dark' : 'light'));
  toggle.hidden = false;
  toggle.addEventListener('click', () => {
    saved = root.dataset.theme === 'dark' ? 'light' : 'dark';
    apply(saved);
    try { localStorage.setItem('longtake-theme', saved); } catch (_) {}
  });
  preference.addEventListener('change', () => {
    if (!saved) apply(preference.matches ? 'dark' : 'light');
  });
})();
