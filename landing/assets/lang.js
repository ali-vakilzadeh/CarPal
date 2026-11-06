/* Sets the language of the two pages whose URL may not carry one: the entry page and the coming-soon page.
   Order: the URL (/fa/..., /en/...), then the visitor's earlier choice, then English only when the browser has no Persian
   and asks for English first. entry.css shows the matching [data-lang] block. Without JS the pages stay Persian.
   In a file, not inline, because the site's Content-Security-Policy allows only its own scripts. */
(function () {
  var root = document.documentElement;
  var inPath = /^\/(fa|en)(\/|$)/.exec(location.pathname);
  var lang = inPath ? inPath[1] : null;
  if (!lang) {
    try { lang = localStorage.getItem('cp-lang'); } catch (e) {}
  }
  if (lang !== 'fa' && lang !== 'en') {
    var list = navigator.languages || [navigator.language || ''];
    var hasFa = list.some(function (l) { return /^fa\b/i.test(l); });
    lang = !hasFa && /^en\b/i.test(list[0] || '') ? 'en' : 'fa';
  }
  root.setAttribute('lang', lang);
  root.setAttribute('dir', lang === 'en' ? 'ltr' : 'rtl');
})();
