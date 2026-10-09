/* CarPal mobile preview — shared kit.
   - i18n: t('English', 'فارسی') picks the UI language; n(12) formats digits for it (CarPal.fmt).
   - Button, Chip, Badge, TextField and TabBar are ports of Docs/carpal-design-system/components/bundle.js with the same
     class names and props. The only change: their icon slot also accepts the extra icons below (same 24px grid, 2px round stroke).
   - Everything else is a screen-level building block made from those components and tokens.css. */
(function () {
  var C = window.CarPal, h = React.createElement, html = htm.bind(h);
  var useState = React.useState;

  var PV = window.PV = { lang: 'en', screens: {}, html: html };
  function cx() { return Array.prototype.filter.call(arguments, Boolean).join(' '); }
  PV.cx = cx;
  PV.t = function (en, fa) { return PV.lang === 'fa' && fa != null ? fa : en; };
  PV.n = function (x) { return C.fmt(x, PV.lang); };
  /* Years, codes and other digit strings: localised digits, no grouping. */
  PV.yr = function (x) { return PV.lang === 'fa' ? String(x).replace(/\d/g, function (d) { return '۰۱۲۳۴۵۶۷۸۹'[d]; }) : String(x); };
  var t = PV.t, n = PV.n;
  PV.reg = function (id, meta, comp) { meta.id = id; meta.comp = comp; PV.screens[id] = meta; };
  PV.Ctx = React.createContext(null);
  PV.use = function () { return React.useContext(PV.Ctx); };

  /* ---------- Icons the app needs beyond the core set. Proposed additions to the design system. ---------- */
  var EX = {
    close: ['M6 6l12 12', 'M18 6 6 18'],
    down: ['M6 9l6 6 6-6'],
    up: ['M6 15l6-6 6 6'],
    minus: ['M5 12h14'],
    calendar: ['M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'M4 10h16', 'M8 3v4', 'M16 3v4'],
    clock: ['M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z', 'M12 7v5l3 2'],
    camera: ['M4 8h3l2-3h6l2 3h3v11H4z', 'M12 10a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7z'],
    video: ['M3 7h12v10H3z', 'M15 10.5 21 7v10l-6-3.5z'],
    image: ['M4 5h16v14H4z', 'M4 16l5-5 4 4 3-3 4 4', 'M15.5 8.5h.01'],
    doc: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 12h6', 'M9 16h6'],
    shield: ['M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z', 'M8.5 12l2.5 2.5 4.5-5'],
    info: ['M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z', 'M12 11v5', 'M12 7.5h.01'],
    help: ['M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z', 'M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.4', 'M12 16.5h.01'],
    lock: ['M6 11h12v10H6z', 'M8 11V8a4 4 0 0 1 8 0v3'],
    eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z'],
    phone: ['M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z'],
    mic: ['M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z', 'M5 11a7 7 0 0 0 14 0', 'M12 18v3'],
    globe: ['M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z', 'M3 12h18', 'M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9', 'M12 3c-2.5 2.5-3.5 5.5-3.5 9s1 6.5 3.5 9'],
    spark: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z', 'M19 15l.7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7z'],
    download: ['M12 4v11', 'M7 10l5 5 5-5', 'M4 20h16'],
    trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
    edit: ['M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'],
    flag: ['M5 21V4', 'M5 4h12l-2 4 2 4H5'],
    filter: ['M4 5h16l-6 8v6l-4-2v-4z'],
    sliders: ['M4 7h9', 'M17 7h3', 'M15 5v4', 'M4 17h3', 'M11 17h9', 'M9 15v4'],
    map: ['M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z', 'M9 4v14', 'M15 6v14'],
    list: ['M9 6h11', 'M9 12h11', 'M9 18h11', 'M4.5 6h.01', 'M4.5 12h.01', 'M4.5 18h.01'],
    logout: ['M10 4H5v16h5', 'M14 8l4 4-4 4', 'M18 12H9'],
    refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4v7h-7'],
    offline: ['M2 8.5a15 15 0 0 1 20 0', 'M5.5 12a10 10 0 0 1 13 0', 'M9 15.5a5 5 0 0 1 6 0', 'M12 19h.01', 'M3 3l18 18'],
    scan: ['M4 8V4h4', 'M16 4h4v4', 'M20 16v4h-4', 'M8 20H4v-4', 'M7 12h10'],
    gauge: ['M3.5 18a8.5 8.5 0 1 1 17 0', 'M12 17l4-5.5', 'M12 17h.01'],
    bookmark: ['M6 3h12v18l-6-4-6 4z'],
    thumb: ['M7 11v9H4v-9z', 'M7 11l4-8a2.5 2.5 0 0 1 2.5 2.5V9h5.2a2 2 0 0 1 2 2.4l-1.5 7A2 2 0 0 1 17.2 20H7'],
    truck: ['M2 6h12v10H2z', 'M14 10h4l3 3.5V16h-7', 'M6.5 15a2 2 0 1 1 0 4 2 2 0 0 1 0-4z', 'M17 15a2 2 0 1 1 0 4 2 2 0 0 1 0-4z'],
    copy: ['M8 8h12v12H8z', 'M16 8V4H4v12h4'],
    send: ['M4 12 20 4l-4 16-4-7z', 'M12 13l8-9'],
    grid: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
    sun: ['M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z', 'M12 2v2', 'M12 20v2', 'M2 12h2', 'M20 12h2', 'M4.9 4.9l1.4 1.4', 'M17.7 17.7l1.4 1.4', 'M4.9 19.1l1.4-1.4', 'M17.7 6.3l1.4-1.4'],
    moon: ['M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z'],
    locate: ['M12 5a7 7 0 1 1 0 14 7 7 0 0 1 0-14z', 'M12 2v3', 'M12 19v3', 'M2 12h3', 'M19 12h3'],
    attach: ['M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10 17.5a2 2 0 0 1-3-3l7.5-7.5'],
    building: ['M4 21V5h10v16', 'M14 9h6v12', 'M2 21h20', 'M8 9h2', 'M8 13h2', 'M8 17h2'],
    tag: ['M3 12V4h8l10 10-8 8z', 'M7.5 7.5h.01'],
    route: ['M6 19a2 2 0 1 1 0-4 2 2 0 0 1 0 4z', 'M18 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4z', 'M8 17h7a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h7']
  };
  var EXFLIP = { send: 1, logout: 1 };

  function Ic(p) {
    if (!EX[p.name]) return h(C.Icon, p);
    var s = p.size || 24;
    return h('svg', {
      className: cx('cp-icon', EXFLIP[p.name] && 'cp-flip', p.filled && 'cp-icon-filled', p.className),
      width: s, height: s, viewBox: '0 0 24 24', 'aria-hidden': p.label ? undefined : 'true',
      role: p.label ? 'img' : undefined, 'aria-label': p.label, focusable: 'false'
    }, EX[p.name].map(function (d, i) { return h('path', { key: i, d: d }); }));
  }

  /* ---------- Ports of bundle.js (same classes and props, extended icon names) ---------- */
  function Btn(p) {
    var variant = p.variant || 'secondary', size = p.size || 'md';
    var rest = Object.assign({}, p);
    ['variant', 'size', 'icon', 'iconEnd', 'block', 'loading', 'className', 'children'].forEach(function (k) { delete rest[k]; });
    return h('button', Object.assign({ type: 'button' }, rest, {
      className: cx('cp-btn', 'cp-btn-' + variant, 'cp-btn-' + size, p.block && 'cp-btn-block', p.loading && 'is-loading', p.className),
      'aria-busy': p.loading ? 'true' : undefined, disabled: p.disabled || p.loading
    }),
      p.icon ? h(Ic, { name: p.icon, size: 20 }) : null,
      h('span', { className: 'cp-btn-label' }, p.children),
      p.iconEnd ? h(Ic, { name: p.iconEnd, size: 20 }) : null);
  }

  function Chip(p) {
    return h('button', {
      type: 'button', className: cx('cp-chip', p.selected && 'is-selected', p.className), onClick: p.onClick, disabled: p.disabled,
      'aria-pressed': p.toggle === false ? undefined : (p.selected ? 'true' : 'false'), 'aria-label': p.label
    },
      p.selected ? h(Ic, { name: 'check', size: 18 }) : (p.icon ? h(Ic, { name: p.icon, size: 18 }) : null),
      h('span', null, p.children),
      p.iconEnd ? h(Ic, { name: p.iconEnd, size: 18 }) : null);
  }

  function Badge(p) {
    return h('span', { className: cx('cp-badge', 'cp-badge-' + (p.tone || 'neutral'), p.className) },
      p.icon ? h(Ic, { name: p.icon, size: 14 }) : null, p.children);
  }

  var uid = 0;
  function Field(p) {
    var ref = React.useRef(null); if (!ref.current) ref.current = 'pv-f' + (++uid);
    var id = p.id || ref.current, Tag = p.multiline ? 'textarea' : 'input';
    var rest = Object.assign({}, p);
    ['label', 'hint', 'error', 'multiline', 'icon', 'className', 'end', 'prefix'].forEach(function (k) { delete rest[k]; });
    return h('div', { className: cx('cp-field', p.error && 'is-error', p.className) },
      p.label ? h('label', { className: 'cp-field-label', htmlFor: id }, p.label) : null,
      h('div', { className: 'cp-field-box' },
        p.icon ? h(Ic, { name: p.icon, size: 20 }) : null,
        p.prefix || null,
        h(Tag, Object.assign({ dir: 'auto' }, rest, {
          id: id, className: 'cp-field-input', 'aria-invalid': p.error ? 'true' : undefined,
          'aria-describedby': (p.error || p.hint) ? id + '-d' : undefined
        })),
        p.end || null),
      (p.error || p.hint) ? h('p', { id: id + '-d', className: 'cp-field-hint' }, p.error ? h(Ic, { name: 'alert', size: 16 }) : null, p.error || p.hint) : null);
  }

  function TabBar(p) {
    return h('nav', { className: cx('cp-tabbar', p.className), 'aria-label': p.label || 'Main' },
      (p.items || []).map(function (it) {
        var on = it.id === p.active;
        return h('button', {
          key: it.id, type: 'button', className: cx('cp-tab', on && 'is-active', it.primary && 'is-primary'),
          'aria-current': on ? 'page' : undefined, onClick: p.onChange ? function () { p.onChange(it.id); } : undefined
        },
          h('span', { className: 'cp-tab-icon' }, h(Ic, { name: it.icon, filled: on && !it.primary }),
            it.badge ? h('span', { className: 'cp-tab-dot', 'aria-label': it.badge }) : null),
          h('span', { className: 'cp-tab-label' }, it.label));
      }));
  }

  function IconBtn(p) {
    return h('button', {
      type: 'button', className: cx('cp-iconbtn', p.className), 'aria-label': p.label, onClick: p.onClick,
      'aria-pressed': p.pressed == null ? undefined : String(!!p.pressed)
    },
      h(Ic, { name: p.icon, filled: p.filled, className: p.iconClass, size: p.size }),
      p.count ? h('span', { className: 'pv-count' }, p.count) : null,
      p.dot ? h('span', { className: 'pv-dot pv-dot-abs' }) : null);
  }

  /* ---------- Screen frame ---------- */
  function Screen(p) {
    var a = PV.use();
    return html`<div className="pv-screen">
      ${p.header}
      ${a && a.offline && p.offline !== false ? html`<div className="pv-offline" role="status"><${Ic} name="offline" size=${16} />${t("You're offline. Showing saved data.", 'آفلاین هستید. اطلاعات ذخیره‌شده نمایش داده می‌شود.')}</div>` : null}
      <div className="pv-bodywrap">
        <div className=${cx('pv-body', p.sunken && 'is-sunken')}>
          ${p.pad === false ? p.children : html`<div className=${cx('pv-pad', p.center && 'is-center')}>${p.children}</div>`}
        </div>
        ${p.fab || null}
      </div>
      ${p.bottom ? html`<div className=${cx('pv-bottom', p.stack && 'is-stack')}>${p.bottom}</div>` : null}
    </div>`;
  }

  function Top(p) {
    var a = PV.use();
    return h(C.TopBar, {
      title: p.title, backLabel: t('Back', 'بازگشت'), actions: p.actions,
      onBack: p.back === false ? undefined : (p.onBack || function () { a.nav.back(); })
    });
  }

  function CloseBar(p) {
    var a = PV.use();
    return html`<header className="cp-topbar">
      <${IconBtn} icon="close" label=${t('Close', 'بستن')} onClick=${p.onClose || function () { a.nav.back(); }} />
      <h1 className="cp-topbar-title">${p.title}</h1>
      <div className="cp-topbar-actions">${p.actions}</div>
    </header>`;
  }

  function RootBar(p) {
    var a = PV.use();
    return html`<header className="cp-topbar pv-rootbar">
      ${p.title ? html`<h1 className="cp-topbar-title">${p.title}</h1>` : null}
      ${p.vehicle ? html`<${VehicleChip} />` : null}
      <span className="pv-grow"></span>
      ${p.search !== false ? html`<${IconBtn} icon="search" label=${t('Search', 'جستجو')} onClick=${function () { a.nav.go('S-SHARED-01'); }} />` : null}
      <${IconBtn} icon="bell" label=${t('Notifications, 4 unread', 'اعلان‌ها، ۴ خوانده‌نشده')} count=${n(4)} onClick=${function () { a.nav.go('S-SHARED-04'); }} />
      <button type="button" className="cp-iconbtn pv-avbtn" aria-label=${t('Account menu, 1 pending action', 'منوی حساب، ۱ کار در انتظار')} onClick=${function () { a.nav.go('S-SHARED-05'); }}>
        <${C.Avatar} name=${PV.D().me.name} size=${32} />
        <span className="pv-dot pv-dot-abs"></span>
      </button>
    </header>`;
  }

  function VehicleChip() {
    var a = PV.use(), D = PV.D(), v = D.v[a ? a.vehicle : 'silver'];
    return h(Chip, { icon: 'car', iconEnd: 'down', toggle: false, className: 'pv-vchip', label: t('Active vehicle: ', 'خودروی فعال: ') + (v ? v.nick : ''),
      onClick: function () { a.nav.go('S-SHARED-09'); } },
      v ? h('bdi', null, v.nick + ' · ' + v.short) : t('Any vehicle', 'هر خودرویی'));
  }

  function Steps(p) {
    var s = [];
    for (var i = 1; i <= p.total; i++) s.push(h('span', { key: i, className: i < p.step ? 'is-done' : (i === p.step ? 'is-now' : '') }));
    return h('div', { className: 'pv-steps', role: 'progressbar', 'aria-valuemin': 1, 'aria-valuemax': p.total, 'aria-valuenow': p.step }, s);
  }

  /* Help Me wizard header: close, vehicle chip, step indicator. Closing asks to save the draft. */
  function FlowBar(p) {
    var a = PV.use();
    function close() {
      a.ui.dialog({
        title: t('Save this as an open issue?', 'این را به‌عنوان مشکل باز ذخیره کنیم؟'),
        text: t('You can pick it up later from Help Me or from Silver’s Issues tab.', 'بعداً از «کمکم کن» یا زبانه مشکلات «نقره‌ای» ادامه می‌دهید.'),
        confirm: t('Save', 'ذخیره'), cancel: t('Discard', 'دور انداختن'),
        onConfirm: function () { a.nav.tab('discover'); a.ui.toast(t('Saved as an open issue', 'به‌عنوان مشکل باز ذخیره شد')); },
        onCancel: function () { a.nav.tab('discover'); }
      });
    }
    return html`<${React.Fragment}>
      <header className="cp-topbar">
        <${IconBtn} icon="close" label=${t('Close Help Me', 'بستن کمکم کن')} onClick=${close} />
        ${p.vehicle === false ? html`<h1 className="cp-topbar-title">${p.title}</h1>` : html`<${VehicleChip} />`}
        <span className="pv-grow"></span>
        ${p.step ? html`<span className="pv-cap pv-muted pv-stepcount">${t('Step ', 'مرحله ') + n(p.step) + t(' of ', ' از ') + n(p.total || 6)}</span>` : null}
      </header>
      ${p.step ? h(Steps, { step: p.step, total: p.total || 6 }) : null}
    <//>`;
  }

  /* ---------- Content blocks ---------- */
  function Sec(p) {
    return html`<section className="pv-sec">
      ${p.title ? html`<div className="pv-sec-head">
        <h2 className="pv-t2">${p.title}</h2>
        ${p.action ? html`<${Btn} variant="ghost" size="sm" iconEnd="next" onClick=${p.onAction}>${p.action}<//>` : (p.end || null)}
      </div>` : null}
      ${p.sub ? html`<p className="pv-c pv-muted">${p.sub}</p>` : null}
      ${p.children}
    </section>`;
  }

  function Card(p) {
    return h(p.as || 'div', {
      className: cx('pv-card', p.tone && 'is-' + p.tone, p.tight && 'is-tight', p.onClick && 'is-tap', p.className),
      onClick: p.onClick, role: p.onClick ? 'link' : undefined, tabIndex: p.onClick ? 0 : undefined, style: p.style
    }, p.children);
  }

  function Li(p) {
    var Tag = p.onClick ? 'button' : 'div';
    return h(Tag, { type: p.onClick ? 'button' : undefined, className: cx('pv-li', p.current && 'is-current', p.className), onClick: p.onClick },
      p.icon ? h('span', { className: cx('pv-tile', p.tileTone && 'is-' + p.tileTone) }, h(Ic, { name: p.icon, size: 20 })) : (p.lead || null),
      h('span', { className: 'pv-col pv-grow' },
        h('span', { className: cx('pv-li-title', p.danger && 'pv-danger') }, p.title),
        p.sub ? h('span', { className: 'pv-li-sub' }, p.sub) : null,
        p.below || null),
      p.end || null,
      p.dot ? h('span', { className: 'pv-dot' }) : null,
      p.onClick && p.chevron !== false ? h(Ic, { name: 'next', size: 20, className: 'pv-muted' }) : null);
  }
  function List(p) { return h('div', { className: 'pv-list' }, p.children); }

  function Switch(p) {
    var s = useState(!!p.on), on = p.value != null ? p.value : s[0];
    return h('button', {
      type: 'button', role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': p.label, disabled: p.locked || p.disabled,
      className: cx('pv-switch', on && 'is-on'),
      onClick: function () { var v = !on; s[1](v); if (p.onChange) p.onChange(v); }
    }, h('span', { className: 'pv-switch-track' }, h('span', { className: 'pv-switch-thumb' },
      p.locked ? h(Ic, { name: 'lock', size: 14 }) : (on ? h(Ic, { name: 'check', size: 16 }) : null))));
  }

  function Check(p) {
    var s = useState(!!p.on), on = p.value != null ? p.value : s[0];
    return h('button', {
      type: 'button', role: p.radio ? 'radio' : 'checkbox', 'aria-checked': on ? 'true' : 'false',
      className: cx('pv-check', p.radio && 'is-radio', on && 'is-on'),
      onClick: function () { var v = p.radio ? true : !on; s[1](v); if (p.onChange) p.onChange(v); }
    }, h('span', { className: 'pv-check-box' }, on ? h(Ic, { name: 'check', size: 16 }) : null),
      h('span', { className: 'pv-check-label' }, p.children));
  }

  function Option(p) {
    return html`<button type="button" role="radio" aria-checked=${p.selected ? 'true' : 'false'} className=${cx('pv-option', p.selected && 'is-selected')} onClick=${p.onClick}>
      ${p.icon ? html`<span className=${cx('pv-tile', p.selected && 'is-solid')}><${Ic} name=${p.icon} size=${20} /></span>` : null}
      <span className="pv-col pv-grow"><span className="pv-bs">${p.title}</span>${p.sub ? html`<span className="pv-c pv-muted">${p.sub}</span>` : null}${p.children}</span>
      ${p.selected ? html`<${Ic} name="check" className="pv-option-mark" />` : null}
    </button>`;
  }

  /* Sub tabs. items: [[id, label]] */
  function Tabs(p) {
    return h('div', { className: cx('pv-tabs', p.fill && 'is-fill'), role: 'tablist' }, p.items.map(function (it) {
      var on = it[0] === p.value;
      return h('button', { key: it[0], type: 'button', role: 'tab', 'aria-selected': on ? 'true' : 'false', className: on ? 'is-active' : '',
        onClick: function () { p.onChange(it[0]); } }, it[1]);
    }));
  }

  /* Chip group. items: [[id, label, icon?]]; multi or single select. */
  function ChipSet(p) {
    var init = p.value != null ? p.value : (p.multi ? [] : null);
    var s = useState(init), v = s[0];
    function on(id) { return p.multi ? v.indexOf(id) >= 0 : v === id; }
    function tap(id) {
      var nv = p.multi ? (on(id) ? v.filter(function (x) { return x !== id; }) : v.concat([id])) : id;
      s[1](nv); if (p.onChange) p.onChange(nv);
    }
    return h('div', { className: p.wrap ? 'pv-wrap' : 'pv-chips', role: p.multi ? 'group' : 'radiogroup', 'aria-label': p.label },
      p.items.map(function (it) { return h(Chip, { key: it[0], selected: on(it[0]), icon: it[2], onClick: function () { tap(it[0]); } }, it[1]); }));
  }

  function Banner(p) {
    var icon = p.icon || { danger: 'alert', warn: 'alert', success: 'check', info: 'info', plain: 'info' }[p.tone || 'info'];
    return html`<div className=${cx('pv-banner', p.tone && 'is-' + p.tone)} role=${p.tone === 'danger' ? 'alert' : 'status'}>
      <${Ic} name=${icon} />
      <div className="pv-col pv-grow">
        ${p.title ? html`<p className=${cx('pv-l', p.tone === 'danger' && 'pv-safety-title')}>${p.title}</p>` : null}
        ${p.text ? html`<p className="pv-c">${p.text}</p>` : null}
        ${p.children}
      </div>
    </div>`;
  }

  /* Safety banner: red edge, icon, plain instruction, one action. Never hidden behind a tap. */
  function SafetyBanner(p) {
    var a = PV.use();
    return html`<${Banner} tone="danger" title=${p.title || t('This may not be safe to drive', 'ممکن است رانندگی با این خودرو ایمن نباشد')}
      text=${p.text || t('If the brakes or steering feel wrong, stop driving and get urgent help.', 'اگر ترمز یا فرمان غیرعادی است، رانندگی را متوقف کنید و کمک فوری بگیرید.')}>
      <div className="pv-row" style=${{ marginBlockStart: 'var(--space-2)' }}>
        <${Btn} variant="danger" size="sm" icon="alert" onClick=${p.onAction || function () { a.nav.go('C-HELP-05', { state: 'critical' }); }}>${p.action || t('Find urgent help', 'یافتن کمک فوری')}<//>
      </div>
    <//>`;
  }

  /* AI suggestion: soft ground, label, "based on" info, Use / Edit / Dismiss. Nothing is applied without a tap. */
  function AI(p) {
    var a = PV.use(), s = useState(false);
    if (s[0]) return null;
    function why() {
      a.ui.sheet({ title: t('About this suggestion', 'درباره این پیشنهاد'), body: html`<${React.Fragment}>
        <p className="pv-b">${t('Based on: ', 'بر اساس: ')}${p.basis || t('your description, your vehicle, your service history.', 'توضیح شما، خودروی شما و سابقه سرویس آن.')}</p>
        <p className="pv-c pv-muted">${t('AI suggestions can be wrong. Nothing is saved or shared until you choose Use.', 'پیشنهاد هوش مصنوعی ممکن است اشتباه باشد. تا «استفاده» را نزنید چیزی ذخیره یا ارسال نمی‌شود.')}</p>
        <${Btn} variant="ghost" icon="sliders" onClick=${function () { a.ui.close(); a.nav.go('C-PROF-03'); }}>${t('AI preferences', 'تنظیمات هوش مصنوعی')}<//>
      <//>` });
    }
    function dismiss() { s[1](true); a.ui.toast(t('Suggestion dismissed', 'پیشنهاد کنار گذاشته شد'), function () { s[1](false); }); }
    return html`<div className="pv-card is-soft is-tight" role="group" aria-label=${t('AI suggestion', 'پیشنهاد هوش مصنوعی')}>
      <div className="pv-row is-nowrap">
        <${Badge} icon="spark">${t('AI suggestion', 'پیشنهاد هوش مصنوعی')}<//>
        <span className="pv-grow"></span>
        <${IconBtn} icon="info" label=${t('What is this based on?', 'بر اساس چه چیزی؟')} onClick=${why} />
      </div>
      ${p.title ? html`<p className="pv-bs">${p.title}</p>` : null}
      ${p.text ? html`<p className="pv-c">${p.text}</p>` : null}
      ${p.children}
      ${p.actions === false ? null : html`<div className="pv-row">
        ${(p.actions || [[t('Use', 'استفاده'), null], [t('Edit', 'ویرایش'), null]]).map(function (x, i) {
          return html`<${Btn} key=${i} size="sm" variant=${i === 0 ? 'secondary' : 'ghost'} onClick=${x[1] || function () { a.ui.toast(t('Applied', 'اعمال شد')); }}>${x[0]}<//>`;
        })}
        <${Btn} size="sm" variant="ghost" onClick=${dismiss}>${t('Dismiss', 'رد کردن')}<//>
      </div>`}
    </div>`;
  }

  /* Consent row: switch + one-line explanation + "What is shared?" preview. */
  function Consent(p) {
    var a = PV.use();
    return html`<div className="pv-row is-nowrap is-top" style=${{ paddingBlock: 'var(--space-2)' }}>
      <div className="pv-col pv-grow">
        <span className="pv-bs">${p.title}</span>
        <span className="pv-c pv-muted">${p.text}</span>
        ${p.preview ? html`<span><button type="button" className="pv-link" onClick=${function () { a.ui.sheet({ title: t('What is shared?', 'چه چیزی به اشتراک گذاشته می‌شود؟'), body: p.preview }); }}>${p.link || t('What is shared?', 'چه چیزی به اشتراک گذاشته می‌شود؟')}</button></span>` : null}
        ${p.children}
      </div>
      <${Switch} on=${p.on} locked=${p.locked} label=${p.title} onChange=${p.onChange} />
    </div>`;
  }

  function Timeline(p) {
    return h('ol', { className: 'pv-tl' }, p.steps.map(function (s, i) {
      var st = i < p.now ? 'is-done' : (i === p.now ? 'is-now' : '');
      return h('li', { key: i, className: st, 'aria-current': i === p.now ? 'step' : undefined },
        h('span', { className: 'pv-tl-dot' }, i < p.now ? h(Ic, { name: 'check', size: 14 }) : null),
        h('div', { className: 'pv-col' },
          h('span', { className: 'pv-row' }, h('span', { className: 'pv-tl-title' }, s[0]), i === p.now ? h(Badge, { tone: 'signal' }, t('Now', 'اکنون')) : null),
          s[1] ? h('span', { className: 'pv-cap pv-muted' }, s[1]) : null,
          s[2] ? h('p', { className: 'pv-c pv-ugc', dir: 'auto' }, s[2]) : null));
    }));
  }

  function Meter(p) {
    return html`<div className="pv-col">
      ${p.label ? html`<div className="pv-row is-between"><span className="pv-l">${p.label}</span><span className="pv-l pv-num">${n(p.value)}${t('%', '٪')}</span></div>` : null}
      <div className=${cx('pv-meter', p.signal && 'is-signal')} role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${p.value}><span style=${{ inlineSize: p.value + '%' }}></span></div>
      ${p.missing ? html`<div className="pv-wrap" style=${{ marginBlockStart: 'var(--space-2)' }}>${p.missing.map(function (m, i) { return html`<${Chip} key=${i} icon="plus" toggle=${false} onClick=${m[1]}>${m[0]}<//>`; })}</div>` : null}
    </div>`;
  }

  function Rating(p) {
    return h('span', { className: 'cp-rating', 'aria-label': t('Rating ', 'امتیاز ') + p.value },
      h(Ic, { name: 'star', size: 18, filled: true, className: 'cp-star' }), n(p.value),
      p.count != null ? h('span', { className: 'pv-c pv-muted' }, ' (' + n(p.count) + ')') : null);
  }

  function Stars(p) {
    var s = useState(p.value || 0);
    var out = [];
    for (var i = 1; i <= 5; i++) (function (k) {
      out.push(h('button', { key: k, type: 'button', className: cx('pv-star', k <= s[0] && 'is-on'), 'aria-label': n(k) + t(' stars', ' ستاره'), 'aria-pressed': k <= s[0] ? 'true' : 'false',
        onClick: function () { s[1](k); } }, h(Ic, { name: 'star', size: p.size || 32, filled: k <= s[0] })));
    })(i);
    return h('div', { className: cx('pv-stars', p.small && 'is-sm'), role: 'group', 'aria-label': p.label }, out);
  }

  /* Flat media placeholder: no photos are needed to judge layout. */
  function Ph(p) {
    return html`<div className=${cx('pv-ph', p.tone && 'is-' + p.tone, p.shape && 'is-' + p.shape, p.className)} role="img" aria-label=${p.label || ''} style=${p.style}>
      <${Ic} name=${p.icon || 'car'} size=${p.size || 48} />
      ${p.badge ? html`<span className="pv-ph-badge">${p.badge}</span>` : null}
      ${p.badgeEnd ? html`<span className="pv-ph-badge-end">${p.badgeEnd}</span>` : null}
    </div>`;
  }

  function Thumb(p) {
    var a = PV.use();
    return html`<div className=${cx('pv-thumb', p.add && 'is-add')} role=${p.add ? 'button' : 'img'} aria-label=${p.label || ''} onClick=${p.onClick}>
      <${Ic} name=${p.icon || 'image'} />
      ${p.badge ? html`<span className="pv-ph-badge-end">${p.badge}</span>` : null}
      ${p.remove ? html`<span className="pv-thumb-x"><${IconBtn} icon="close" size=${16} label=${t('Remove', 'حذف')} onClick=${function () { a.ui.toast(t('Photo removed', 'عکس حذف شد'), function () {}); }} /></span>` : null}
    </div>`;
  }

  function BeforeAfter(p) {
    var s = useState(50);
    return html`<div className="pv-ba">
      <div className="pv-ba-layer pv-ba-after"><${Ic} name=${p.icon || 'part'} size=${48} /><span className="pv-l">${p.after || t('New part fitted', 'قطعه نو نصب شد')}</span></div>
      <div className="pv-ba-clip" style=${{ inlineSize: s[0] + '%' }}>
        <div className="pv-ba-layer pv-ba-before"><${Ic} name=${p.icon || 'part'} size=${48} /><span className="pv-l">${p.before || t('Worn bushing', 'بوش فرسوده')}</span></div>
      </div>
      <span className="pv-ba-tag is-start"><${Badge}>${t('Before', 'قبل')}<//></span>
      <span className="pv-ba-tag is-end"><${Badge} tone="accent">${t('After', 'بعد')}<//></span>
      ${p.blur ? html`<span className="pv-ph-badge-end" style=${{ zIndex: 2 }}><span className="pv-blur"><${Ic} name="eye" size=${14} />${p.blur}</span></span>` : null}
      <span className="pv-ba-handle" style=${{ insetInlineStart: s[0] + '%' }}><span className="pv-ba-knob"><span className="pv-row is-nowrap" style=${{ gap: 0 }}><${Ic} name="back" size=${16} /><${Ic} name="next" size=${16} /></span></span></span>
      <input type="range" min="0" max="100" value=${s[0]} aria-label=${t('Drag to compare before and after', 'برای مقایسه قبل و بعد بکشید')} onInput=${function (e) { s[1](+e.target.value); }} onChange=${function (e) { s[1](+e.target.value); }} />
    </div>`;
  }

  /* Map canvas: geography keeps LTR in both languages; only the controls around it mirror. */
  function MapView(p) {
    return html`<div className="pv-map" dir="ltr" style=${p.style} role="img" aria-label=${t('Map', 'نقشه')}>
      <svg viewBox="0 0 390 600" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <rect className="pv-map-park" x="230" y="70" width="120" height="90" rx="20" />
        <rect className="pv-map-park" x="30" y="400" width="110" height="120" rx="20" />
        <path className="pv-map-road" d="M-20 220 C 100 200, 220 260, 420 230" />
        <path className="pv-map-road" d="M150 -20 C 170 160, 130 380, 190 620" />
        <path className="pv-map-road is-minor" d="M-20 360 L 420 330" />
        <path className="pv-map-road is-minor" d="M300 -20 L 280 620" />
        <path className="pv-map-road is-minor" d="M-20 100 L 200 130" />
        <path className="pv-map-road is-minor" d="M60 620 L 90 230" />
        <path className="pv-map-road is-minor" d="M200 470 L 420 500" />
      </svg>
      ${p.children}
    </div>`;
  }

  function Skel(p) { return h('span', { className: cx('pv-skel', p.lg && 'is-lg'), style: { inlineSize: p.w || '100%' } }); }

  function Empty(p) {
    return html`<div className="pv-empty">
      <span className=${cx('pv-hero-mark', p.tone && 'is-' + p.tone)}><${Ic} name=${p.icon || 'info'} size=${48} /></span>
      <h2 className="pv-t2">${p.title}</h2>
      ${p.text ? html`<p className="pv-b pv-muted">${p.text}</p>` : null}
      ${p.children ? html`<div className="pv-col is-gap3" style=${{ inlineSize: '100%' }}>${p.children}</div>` : null}
    </div>`;
  }

  function SheetFrame(p) {
    var a = PV.use();
    return html`<${React.Fragment}>
      <div className="pv-sheet-handle" aria-hidden="true"></div>
      <div className="pv-sheet-head">
        <h2 className="pv-t2 pv-grow">${p.title}</h2>
        ${p.headEnd || null}
        <${IconBtn} icon="close" label=${t('Close', 'بستن')} onClick=${p.onClose || function () { a.nav.back(); }} />
      </div>
      <div className="pv-sheet-body">${p.children}</div>
      ${p.foot ? html`<div className="pv-sheet-foot">${p.foot}</div>` : null}
    <//>`;
  }

  /* Trust badge: text always visible; tap explains how it was earned (rule-based). */
  function Trust(p) {
    var a = PV.use();
    var info = {
      verified: [t('Verified Business', 'کسب‌وکار تأییدشده'), 'shield', t('CarPal checked this business’s licence, address and owner identity.', 'کارپال مجوز، نشانی و هویت مالک این کسب‌وکار را بررسی کرده است.')],
      specialist: [p.text || t('Suspension Specialist', 'متخصص جلوبندی'), 'wrench', t('Earned automatically: at least 15 completed jobs in this category on CarPal with an average rating of 4.5 or more. Not paid for.', 'به‌طور خودکار: دست‌کم ۱۵ کار تکمیل‌شده در این دسته در کارپال با میانگین امتیاز ۴٫۵ یا بیشتر. خریدنی نیست.')],
      visit: [t('Verified visit', 'مراجعه تأییدشده'), 'check', t('The reviewer had an appointment with this shop that was confirmed and took place. It was verified automatically; the shop cannot approve or block it. Full weight in the score.', 'نویسنده نوبتی با این تعمیرگاه داشته که تأیید شده و انجام شده است. به‌طور خودکار تأیید شده؛ تعمیرگاه نمی‌تواند آن را تأیید یا مسدود کند. وزن کامل در امتیاز.')],
      purchase: [t('Verified purchase', 'خرید تأییدشده'), 'check', t('The reviewer had a stock inquiry with this seller that was marked completed. Verified automatically; the seller cannot approve or block it.', 'نویسنده استعلام موجودی با این فروشنده داشته که تکمیل‌شده ثبت شده است. به‌طور خودکار تأیید شده؛ فروشنده نمی‌تواند آن را تأیید یا مسدود کند.')],
      approved: [t('Approved by the business and CarPal', 'تأییدشده توسط کسب‌وکار و کارپال'), 'shield', t('Written without an appointment. The business confirmed the reviewer was its customer (the opinion is never judged), and a CarPal reviewer approved it. It counts in the score, but for less than a verified visit.', 'بدون نوبت نوشته شده. کسب‌وکار تأیید کرده که نویسنده مشتری‌اش بوده (نظر او قضاوت نمی‌شود) و یک بازبین کارپال آن را پذیرفته است. در امتیاز حساب می‌شود، اما کمتر از مراجعه تأییدشده.')],
      record: [t('Verified record', 'سابقه تأییدشده'), 'check', t('Created from a completed appointment or confirmed by the provider.', 'از یک نوبت تکمیل‌شده ایجاد شده یا ارائه‌دهنده آن را تأیید کرده است.')],
      pending: [t('Verification pending', 'در انتظار تأیید'), 'clock', t('This business has applied for verification. CarPal has not finished checking it yet.', 'این کسب‌وکار درخواست تأیید داده است. بررسی کارپال هنوز تمام نشده است.')]
    }[p.kind || 'verified'];
    return html`<button type="button" className="pv-badgebtn" style=${{ border: 0, background: 'none', padding: 0, cursor: 'pointer' }}
      onClick=${function (e) { e.stopPropagation(); a.ui.sheet({ title: info[0], body: html`<p className="pv-b">${info[2]}</p>` }); }}>
      <${Badge} tone=${p.kind === 'pending' ? 'neutral' : (p.kind === 'visit' || p.kind === 'record' || p.kind === 'purchase' ? 'success' : 'accent')} icon=${info[1]}>${info[0]}<//>
    </button>`;
  }

  /* Urgency is colour + icon + word. */
  function Urgency(p) {
    var u = {
      critical: ['danger', 'alert', t('Safety-critical', 'بحرانی برای ایمنی')],
      urgent: ['signal', 'alert', t('Urgent', 'فوری')],
      soon: ['neutral', 'clock', t('Soon', 'به‌زودی')],
      ok: ['success', 'check', t('Not urgent', 'غیرفوری')]
    }[p.level || 'soon'];
    return h(Badge, { tone: u[0], icon: u[1] }, u[2]);
  }

  /* Provider result card: name, distance, category rating, badges, match reason, next slot, save, request. */
  function ProviderCard(p) {
    var a = PV.use(), x = p.p, s = useState(!!x.saved), ex = useState(false);
    function stop(e) { e.stopPropagation(); }
    function save(e) {
      stop(e); var v = !s[0]; s[1](v);
      a.ui.toast(v ? t('Saved to favourites', 'به علاقه‌مندی‌ها اضافه شد') : t('Removed from favourites', 'از علاقه‌مندی‌ها حذف شد'), function () { s[1](!v); });
    }
    return html`<article className=${cx('pv-card is-tap', p.compact && 'pv-hcard')} onClick=${function () { a.nav.go(x.vendor ? 'C-VEND-01' : 'C-PROV-01', { state: p.match ? 'from-match' : 'direct' }); }}>
      <div className="pv-row is-nowrap is-top">
        <${C.Avatar} name=${x.name} ring=${x.verified} />
        <div className="pv-col pv-grow">
          <bdi className="pv-h">${x.name}</bdi>
          <span className="pv-c pv-muted">${x.type}</span>
        </div>
        <${IconBtn} icon="heart" filled=${s[0]} iconClass=${s[0] ? 'cp-star' : ''} pressed=${s[0]} label=${t('Save ', 'ذخیره ') + x.name} onClick=${save} />
      </div>
      <div className="pv-row">
        <${Rating} value=${x.rating} />
        <span className="pv-c pv-muted">${x.ratingFor} · ${n(x.reviews)} ${t('reviews', 'نظر')}</span>
      </div>
      <div className="pv-row pv-c pv-muted">
        <${Ic} name="pin" size=${20} /><span>${x.dist}</span><span>·</span><span>${x.price}</span>
      </div>
      <div className="pv-wrap">${(x.badges || []).map(function (b, i) { return html`<${Trust} key=${i} kind=${b[0]} text=${b[1]} />`; })}</div>
      ${p.featured ? null : html`<button type="button" className="pv-link pv-c" style=${{ fontWeight: 600, textDecoration: 'none', color: 'var(--ink)' }} aria-expanded=${ex[0] ? 'true' : 'false'}
          onClick=${function (e) { stop(e); ex[1](!ex[0]); }}>
        <${Ic} name="info" size=${20} className="pv-accent" /><span className="pv-grow">${p.match ? x.matchLong : x.reason}</span><${Ic} name=${ex[0] ? 'up' : 'down'} size=${20} />
      </button>`}
      ${ex[0] ? html`<ul className="pv-col pv-c" style=${{ margin: 0, paddingInlineStart: 'var(--space-5)' }}>${x.reasons.map(function (r, i) { return html`<li key=${i}>${r}</li>`; })}</ul>` : null}
      <div className="pv-row is-nowrap">
        <${Ic} name="calendar" size=${20} className="pv-accent" />
        <span className="pv-c pv-grow">${t('Next: ', 'نوبت بعدی: ')}<b>${x.next}</b></span>
        ${p.request === false ? null : html`<${Btn} size="sm" variant=${p.primary ? 'primary' : 'secondary'} onClick=${function (e) { stop(e); a.nav.go('C-HELP-07', { state: p.triage ? 'default' : 'notriage' }); }}>${t('Request', 'درخواست')}<//>`}
      </div>
    </article>`;
  }

  function VehicleCard(p) {
    var a = PV.use(), v = p.v;
    return html`<article className=${cx('pv-card is-tap', p.selected && 'is-selected')} onClick=${p.onClick || function () { a.nav.go('C-GARAGE-02'); }}>
      <div className="pv-row is-nowrap is-top">
        <div className="pv-thumb"><${Ic} name="car" size=${32} /></div>
        <div className="pv-col pv-grow">
          <div className="pv-row is-nowrap"><bdi className="pv-h">${v.nick}</bdi>${v.primary ? html`<${Ic} name="star" size=${20} filled=${true} className="cp-star" label=${t('Primary vehicle', 'خودروی اصلی')} />` : null}</div>
          <span className="pv-c">${v.model}</span>
          <span className="pv-c pv-muted"><${Ic} name="gauge" size=${16} /> ${v.mileage} · ${v.updated}</span>
        </div>
        ${p.end || null}
      </div>
      ${v.chips && v.chips.length ? html`<div className="pv-wrap">${v.chips.map(function (c, i) { return html`<${Badge} key=${i} tone=${c[0]} icon=${c[1]}>${c[2]}<//>`; })}</div>` : null}
      ${p.children}
    </article>`;
  }

  /* Query chips: how the search text was understood. Removing or editing a chip re-runs the search. */
  function QueryChips(p) {
    var a = PV.use(), s = useState(p.items.map(function (x) { return true; }));
    return html`<div className="pv-wrap" role="group" aria-label=${t('How we understood your search', 'برداشت ما از جستجوی شما')}>
      <span className="pv-cap pv-muted">${t('Understood as', 'برداشت ما')}</span>
      ${p.items.map(function (x, i) {
        if (!s[0][i]) return null;
        return html`<${Chip} key=${i} icon=${x[1]} iconEnd="close" toggle=${false} label=${t('Remove ', 'حذف ') + x[0]}
          onClick=${function () { var v = s[0].slice(); v[i] = false; s[1](v); a.ui.toast(t('Search updated', 'جستجو به‌روز شد')); }}>${x[0]}<//>`;
      })}
    </div>`;
  }

  /* Directions: opens the remembered map app at once, otherwise the Directions sheet S-SHARED-10. */
  PV.directions = function (a, params) {
    if (PV.navApp) { a.ui.toast(t('Opening ', 'باز شدن ') + PV.navApp + t(' with the destination', ' با مقصد')); return; }
    a.nav.go('S-SHARED-10', params || {});
  };

  Object.assign(PV, {
    QueryChips: QueryChips,
    Ic: Ic, Btn: Btn, Chip: Chip, Badge: Badge, Field: Field, TabBar: TabBar, IconBtn: IconBtn,
    Screen: Screen, Top: Top, CloseBar: CloseBar, RootBar: RootBar, VehicleChip: VehicleChip, Steps: Steps, FlowBar: FlowBar,
    Sec: Sec, Card: Card, Li: Li, List: List, Switch: Switch, Check: Check, Option: Option, Tabs: Tabs, ChipSet: ChipSet,
    Banner: Banner, SafetyBanner: SafetyBanner, AI: AI, Consent: Consent, Timeline: Timeline, Meter: Meter, Rating: Rating, Stars: Stars,
    Ph: Ph, Thumb: Thumb, BeforeAfter: BeforeAfter, MapView: MapView, Skel: Skel, Empty: Empty, SheetFrame: SheetFrame,
    Trust: Trust, Urgency: Urgency, ProviderCard: ProviderCard, VehicleCard: VehicleCard
  });
})();
