/* Loaded in <head>, before first paint, so the page never flashes the wrong theme.
   Theme: the visitor's choice if there is one, otherwise the OS settings (design system README, Themes). */
(function () {
  var THEME_KEY = 'cp-theme';
  var LANG_KEY = 'cp-lang';
  var THEMES = ['light', 'sun', 'dark'];
  var root = document.documentElement;
  var contrast = window.matchMedia('(prefers-contrast: more)');
  var dark = window.matchMedia('(prefers-color-scheme: dark)');

  function read(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* private mode: the choice lasts for this page only */ }
  }
  function chosen() {
    var t = read(THEME_KEY);
    return THEMES.indexOf(t) >= 0 ? t : null;
  }
  function fromOs() {
    if (contrast.matches) return 'sun';
    return dark.matches ? 'dark' : 'light';
  }
  function apply(theme) {
    root.setAttribute('data-theme', theme);
    var chips = document.querySelectorAll('[data-set-theme]');
    for (var i = 0; i < chips.length; i++) {
      var on = chips[i].getAttribute('data-set-theme') === theme;
      chips[i].classList.toggle('is-selected', on);
      chips[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', getComputedStyle(root).getPropertyValue('--surface').trim() || meta.getAttribute('content'));
  }
  function followOs() {
    if (!chosen()) apply(fromOs());
  }

  root.classList.add('js');
  root.setAttribute('data-theme', chosen() || fromOs());
  contrast.addEventListener('change', followOs);
  dark.addEventListener('change', followOs);

  document.addEventListener('DOMContentLoaded', function () {
    apply(root.getAttribute('data-theme'));
    document.addEventListener('click', function (e) {
      var el = e.target.closest ? e.target.closest('[data-set-theme],[data-set-lang]') : null;
      if (!el) return;
      if (el.hasAttribute('data-set-lang')) {
        write(LANG_KEY, el.getAttribute('data-set-lang'));
        return;
      }
      var theme = el.getAttribute('data-set-theme');
      write(THEME_KEY, theme);
      apply(theme);
    });
  });
})();
