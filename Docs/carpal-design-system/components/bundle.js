/* @ds-bundle: {"format":4,"namespace":"CarPal","components":[{"name":"Button"},{"name":"Icon"},{"name":"TextField"},{"name":"Chip"},{"name":"Badge"},{"name":"Avatar"},{"name":"PostCard"},{"name":"Tagged"},{"name":"TopBar"},{"name":"TabBar"}]} */
(function () {
  var React = window.React, h = React.createElement;
  function cx() { return Array.prototype.filter.call(arguments, Boolean).join(' '); }

  /* Icons: 24px grid, 2px round stroke. FLIP = direction-bearing glyphs, mirrored under [dir=rtl]. */
  var P = {
    home: ['M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z'],
    search: ['M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14z', 'M20 20l-4-4'],
    plus: ['M12 5v14', 'M5 12h14'],
    chat: ['M4 5h16v11H9l-5 4z'],
    user: ['M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8z', 'M4 21c0-4 4-6 8-6s8 2 8 6'],
    heart: ['M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z'],
    comment: ['M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z'],
    share: ['M4 13v6h16v-6', 'M12 3v12', 'M7 8l5-5 5 5'],
    car: ['M3 17v-4l2.2-5.5A2 2 0 0 1 7 6h10a2 2 0 0 1 1.8 1.5L21 13v4z', 'M5 17v2', 'M19 17v2', 'M7.5 13.5h.01', 'M16.5 13.5h.01'],
    wrench: ['M14.7 6.3a4 4 0 0 0-5.2 5.2L4 17l3 3 5.5-5.5a4 4 0 0 0 5.2-5.2l-2.5 2.5-2.5-.5-.5-2.5z'],
    part: ['M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z', 'M12 2v3', 'M12 19v3', 'M2 12h3', 'M19 12h3', 'M4.9 4.9 7 7', 'M17 17l2.1 2.1', 'M4.9 19.1 7 17', 'M17 7l2.1-2.1'],
    store: ['M3 10l2-6h14l2 6z', 'M4 10v10h16V10', 'M10 20v-5h4v5'],
    star: ['M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3l-5.5 2.9 1-6.2L3 9.6l6.2-.9z'],
    pin: ['M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z', 'M12 7.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z'],
    back: ['M15 5l-7 7 7 7'],
    next: ['M9 5l7 7-7 7'],
    arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
    more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
    check: ['M5 12.5l4.5 4.5L19 7'],
    alert: ['M12 3l10 18H2z', 'M12 10v4', 'M12 17.5h.01'],
    bell: ['M6 16V11a6 6 0 1 1 12 0v5l2 2H4z', 'M10 21h4']
  };
  var FLIP = { back: 1, next: 1, arrow: 1, chat: 1, comment: 1 };

  function Icon(p) {
    var name = p.name || 'home', size = p.size || 24;
    return h('svg', {
      className: cx('cp-icon', FLIP[name] && 'cp-flip', p.filled && 'cp-icon-filled', p.className),
      width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': p.label ? undefined : 'true',
      role: p.label ? 'img' : undefined, 'aria-label': p.label, focusable: 'false'
    }, (P[name] || P.home).map(function (d, i) { return h('path', { key: i, d: d }); }));
  }

  function Button(p) {
    var variant = p.variant || 'secondary', size = p.size || 'md';
    var rest = Object.assign({}, p);
    ['variant', 'size', 'icon', 'iconEnd', 'block', 'loading', 'className', 'children'].forEach(function (k) { delete rest[k]; });
    return h('button', Object.assign({ type: 'button' }, rest, {
      className: cx('cp-btn', 'cp-btn-' + variant, 'cp-btn-' + size, p.block && 'cp-btn-block', p.loading && 'is-loading', p.className),
      'aria-busy': p.loading ? 'true' : undefined, disabled: p.disabled || p.loading
    }),
      p.icon ? h(Icon, { name: p.icon, size: 20 }) : null,
      h('span', { className: 'cp-btn-label' }, p.children),
      p.iconEnd ? h(Icon, { name: p.iconEnd, size: 20 }) : null);
  }

  var uid = 0;
  function TextField(p) {
    var ref = React.useRef(null); if (!ref.current) ref.current = 'cp-f' + (++uid);
    var id = p.id || ref.current, Tag = p.multiline ? 'textarea' : 'input';
    var rest = Object.assign({}, p);
    ['label', 'hint', 'error', 'multiline', 'icon', 'className'].forEach(function (k) { delete rest[k]; });
    return h('div', { className: cx('cp-field', p.error && 'is-error', p.className) },
      h('label', { className: 'cp-field-label', htmlFor: id }, p.label),
      h('div', { className: 'cp-field-box' },
        p.icon ? h(Icon, { name: p.icon, size: 20 }) : null,
        h(Tag, Object.assign({ dir: 'auto' }, rest, { id: id, className: 'cp-field-input', 'aria-invalid': p.error ? 'true' : undefined, 'aria-describedby': (p.error || p.hint) ? id + '-d' : undefined }))),
      (p.error || p.hint) ? h('p', { id: id + '-d', className: 'cp-field-hint' }, p.error ? h(Icon, { name: 'alert', size: 16 }) : null, p.error || p.hint) : null);
  }

  function Chip(p) {
    return h('button', { type: 'button', className: cx('cp-chip', p.selected && 'is-selected', p.className), 'aria-pressed': p.selected ? 'true' : 'false', onClick: p.onClick },
      p.selected ? h(Icon, { name: 'check', size: 18 }) : (p.icon ? h(Icon, { name: p.icon, size: 18 }) : null),
      h('span', null, p.children));
  }

  function Badge(p) {
    return h('span', { className: cx('cp-badge', 'cp-badge-' + (p.tone || 'neutral'), p.className) },
      p.icon ? h(Icon, { name: p.icon, size: 14 }) : null, p.children);
  }

  function initials(n) { return (n || '?').trim().split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0); }).join(''); }
  function Avatar(p) {
    var s = p.size || 44;
    return h('span', { className: cx('cp-avatar', p.ring && 'has-ring', p.className), style: { width: s, height: s, fontSize: Math.round(s * 0.38) } },
      p.src ? h('img', { src: p.src, alt: '', loading: 'lazy', decoding: 'async', width: s, height: s }) : h('span', { 'aria-hidden': 'true' }, initials(p.name)));
  }

  /* Numbers follow the UI locale: fmt(12, 'fa') -> ۱۲ */
  function fmt(n, locale) { try { return new Intl.NumberFormat(locale === 'fa' ? 'fa-IR' : (locale || 'en-US')).format(n); } catch (e) { return String(n); } }

  var ROLE = { owner: ['Car owner', 'neutral', 'car'], mechanic: ['Mechanic', 'accent', 'wrench'], seller: ['Parts seller', 'accent', 'store'] };

  /* A business or product tagged in a post: a mechanic's shop (with rating) or a part (with price and stock). */
  function Tagged(p) {
    var loc = p.locale || 'en';
    return h('div', { className: 'cp-tagged' },
      h('span', { className: 'cp-tagged-icon' }, h(Icon, { name: p.icon || 'wrench', size: 20 })),
      h('span', { className: 'cp-tagged-body' },
        h('bdi', { className: 'cp-tagged-title' }, p.title),
        p.detail ? h('span', { className: 'cp-tagged-detail', dir: 'auto' }, p.detail) : null,
        (p.price || p.badge) ? h('span', { className: 'cp-tagged-buy' },
          p.price ? h('span', { className: 'cp-price' }, p.price) : null,
          p.badge ? h(Badge, { tone: p.badge.tone || 'success', icon: p.badge.icon }, p.badge.text) : null) : null),
      p.rating != null ? h('span', { className: 'cp-rating', 'aria-label': (p.ratingLabel || 'Rating') + ' ' + p.rating },
        h(Icon, { name: 'star', size: 18, filled: true, className: 'cp-star' }), fmt(p.rating, loc)) : null,
      null);
  }

  function PostCard(p) {
    var loc = p.locale || 'en', t = p.labels || {}, role = ROLE[p.role];
    var roleText = role ? ((t.roles && t.roles[p.role]) || role[0]) : null;
    return h('article', { className: cx('cp-post', p.highlight && 'is-highlight', p.className), lang: p.lang },
      h('header', { className: 'cp-post-head' },
        h(Avatar, { name: p.author, src: p.avatar, ring: p.verified }),
        h('div', { className: 'cp-post-who' },
          h('span', { className: 'cp-post-name' }, h('bdi', { className: 'cp-post-author' }, p.author),
            role ? h(Badge, { tone: role[1], icon: role[2] }, roleText) : null),
          h('span', { className: 'cp-post-meta' }, h('bdi', { dir: 'ltr' }, p.handle), ' · ', h('time', null, p.time))),
        h('button', { type: 'button', className: 'cp-iconbtn', 'aria-label': t.more || 'More' }, h(Icon, { name: 'more' }))),
      h('p', { className: 'cp-post-text', dir: 'auto' }, p.text),
      (p.tagged || []).map(function (x, i) { return h(Tagged, Object.assign({ key: i, locale: loc }, x)); }),
      h('footer', { className: 'cp-post-actions' },
        h('button', { type: 'button', className: cx('cp-action', p.liked && 'is-on'), 'aria-pressed': p.liked ? 'true' : 'false' }, h(Icon, { name: 'heart', filled: p.liked }), h('span', null, fmt(p.likes || 0, loc))),
        h('button', { type: 'button', className: 'cp-action' }, h(Icon, { name: 'comment' }), h('span', null, fmt(p.comments || 0, loc))),
        h('button', { type: 'button', className: 'cp-action' }, h(Icon, { name: 'share' }), h('span', null, t.share || 'Share')),
        p.cta ? h(Button, { variant: 'primary', size: 'sm', className: 'cp-post-cta' }, p.cta) : null));
  }

  function TopBar(p) {
    return h('header', { className: cx('cp-topbar', p.className) },
      p.onBack !== undefined ? h('button', { type: 'button', className: 'cp-iconbtn', 'aria-label': p.backLabel || 'Back', onClick: p.onBack }, h(Icon, { name: 'back' })) : null,
      h('h1', { className: 'cp-topbar-title' }, p.title),
      h('div', { className: 'cp-topbar-actions' }, p.actions));
  }

  function TabBar(p) {
    return h('nav', { className: cx('cp-tabbar', p.className), 'aria-label': p.label || 'Main' },
      (p.items || []).map(function (it) {
        var on = it.id === p.active;
        return h('button', { key: it.id, type: 'button', className: cx('cp-tab', on && 'is-active', it.primary && 'is-primary'), 'aria-current': on ? 'page' : undefined, onClick: p.onChange ? function () { p.onChange(it.id); } : undefined },
          h('span', { className: 'cp-tab-icon' }, h(Icon, { name: it.icon, filled: on && !it.primary }), it.badge ? h('span', { className: 'cp-tab-dot', 'aria-label': it.badge }) : null),
          h('span', { className: 'cp-tab-label' }, it.label));
      }));
  }

  window.CarPal = Object.assign(window.CarPal || {}, {
    Button: Button, Icon: Icon, TextField: TextField, Chip: Chip, Badge: Badge, Avatar: Avatar,
    PostCard: PostCard, Tagged: Tagged, TopBar: TopBar, TabBar: TabBar, fmt: fmt
  });
})();
