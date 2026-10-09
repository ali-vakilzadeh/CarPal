/* CarPal mobile preview — app shell.
   Navigation (stack + tabs), sheets/dialogs/snackbar, the phone frame, and the preview chrome around it. */
(function () {
  var C = window.CarPal, h = React.createElement, html = PV.html, t = PV.t, n = PV.n, K = PV;
  var useState = React.useState, useEffect = React.useEffect;

  /* Screen inventory order and areas — Doc 21 §3. */
  var ORDER = ['S-AUTH-01', 'S-AUTH-02', 'S-AUTH-03', 'S-AUTH-07', 'S-AUTH-08', 'S-AUTH-09', 'S-AUTH-04', 'S-AUTH-05',
    'C-ONB-01', 'C-ONB-02', 'C-ONB-03',
    'C-HOME-01', 'S-SHARED-01', 'C-SEARCH-01', 'S-SHARED-02', 'S-SHARED-03', 'S-SHARED-09', 'S-SHARED-10', 'C-PROV-01', 'C-PROV-02', 'C-VEND-01', 'C-INV-01', 'C-INV-02', 'C-INV-03',
    'C-GARAGE-01', 'C-GARAGE-02', 'C-GARAGE-03', 'C-GARAGE-04', 'C-GARAGE-05', 'C-GARAGE-06', 'C-GARAGE-07', 'C-GARAGE-08', 'C-GARAGE-09', 'C-PLAN-01',
    'C-HELP-01', 'C-HELP-02', 'C-HELP-03', 'C-HELP-04', 'C-HELP-05', 'C-HELP-06', 'C-HELP-07', 'C-HELP-08',
    'C-APP-01', 'C-APP-02', 'C-APP-03', 'C-APP-04',
    'C-REV-01', 'C-REV-02', 'C-REV-03', 'C-REV-04',
    'C-COMM-01', 'C-COMM-02', 'C-COMM-03', 'C-COMM-04', 'C-COMM-05', 'C-COMM-06',
    'S-SHARED-04', 'S-SHARED-05', 'C-PROF-01', 'C-PROF-02', 'C-PROF-03', 'C-PROF-04', 'C-PROF-05', 'C-PROF-06', 'C-PROF-07', 'C-PROF-08', 'C-PROF-09',
    'S-SHARED-06', 'S-SHARED-08', 'S-SHARED-07'];

  var TABS = { discover: 'C-HOME-01', garage: 'C-GARAGE-01', help: 'C-HELP-01', appts: 'C-APP-01', community: 'C-COMM-01' };

  /* Key flows — Doc 21 §5. */
  var FLOWS = [
    ['Ch. 1 · Sign up', ['S-AUTH-01', 'S-AUTH-03', 'S-AUTH-07', 'S-AUTH-04', 'S-AUTH-05']],
    ['Ch. 2 · First vehicle', ['C-ONB-01', 'C-ONB-02', 'C-HOME-01']],
    ['Ch. 3 · Log in with code', ['S-AUTH-02', 'S-AUTH-07', 'C-HOME-01']],
    ['Ch. 4 · Add a past repair', ['C-GARAGE-02', 'C-GARAGE-05']],
    ['Ch. 5 · Update mileage', ['S-SHARED-04', 'C-GARAGE-08']],
    ['Ch. 6 · Describe a problem', ['C-HELP-01', 'C-HELP-03', 'C-HELP-04', 'C-HELP-05', 'C-HELP-06']],
    ['Ch. 7 · Request a specialist', ['C-HELP-06', 'C-PROV-01', 'C-HELP-07', 'C-HELP-08']],
    ['Ch. 8 · Accept a new time', ['S-SHARED-04', 'C-APP-02']],
    ['Ch. 9 · Review a visit', ['S-SHARED-04', 'C-REV-01', 'C-REV-02']],
    ['Ch. 9 · Approve a showcase', ['S-SHARED-04', 'C-REV-03']],
    ['Ch. 10 · Rebook a favourite', ['C-HOME-01', 'C-HELP-07', 'C-HELP-08']],
    ['Ch. 10 · Sell a car', ['C-GARAGE-02', 'C-GARAGE-09']],
    ['Ch. 11 · Find a shop without Help Me', ['C-HOME-01', 'S-SHARED-01', 'C-SEARCH-01', 'C-PROV-01', 'C-HELP-07']],
    ['Ch. 11 · Browse on the map', ['C-HOME-01', 'S-SHARED-02', 'S-SHARED-10', 'C-HELP-07']],
    ['Ch. 11 · Review from an emailed link', ['S-AUTH-07', 'C-REV-01', 'C-REV-02']]
  ];

  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  function meta(id) { return PV.screens[id]; }
  function baseStack(id, params) {
    var m = meta(id); if (!m) return [{ id: 'C-HOME-01' }];
    var base = m.kind === 'sheet' ? [{ id: m.over }] : (m.parent ? [{ id: m.parent }] : []);
    return base.concat([{ id: id, params: params || {} }]);
  }
  function stateOf(states, id) { var m = meta(id); return states[id] || (m && m.states ? m.states[0][0] : 'default'); }

  var NOOP = function () {};
  var STATIC_API = {
    nav: { go: NOOP, back: NOOP, tab: NOOP, reset: NOOP, replace: NOOP, setState: NOOP },
    ui: { toast: NOOP, sheet: NOOP, dialog: NOOP, close: NOOP, hideToast: NOOP }, setVehicle: NOOP, setLang: NOOP, setTheme: NOOP, theme: 'light'
  };

  /* Catch a broken screen inside its phone instead of blanking the whole preview. */
  class Boundary extends React.Component {
    constructor(p) { super(p); this.state = { err: null }; }
    static getDerivedStateFromError(err) { return { err: err }; }
    componentDidCatch(err) { if (window.console) console.error('PV-ERROR ' + this.props.k + ': ' + (err && err.message)); }
    componentDidUpdate(prev) { if (prev.k !== this.props.k && this.state.err) this.setState({ err: null }); }
    render() {
      if (this.state.err) return html`<div className="pv-pad"><${K.Banner} tone="danger" title="This screen failed to render" text=${String(this.state.err && this.state.err.message)} /></div>`;
      return this.props.children;
    }
  }

  function tabItems() {
    return [
      { id: 'discover', label: t('Discover', 'کشف'), icon: 'home' },
      { id: 'garage', label: t('My Garage', 'گاراژ من'), icon: 'car', badge: t('Open issue', 'مشکل باز') },
      { id: 'help', label: t('Help Me', 'کمکم کن'), icon: 'help', primary: true },
      { id: 'appts', label: t('Appointments', 'نوبت‌ها'), icon: 'calendar', badge: t('1 needs your action', '۱ مورد منتظر شماست') },
      { id: 'community', label: t('Community', 'انجمن'), icon: 'chat', badge: t('New replies', 'پاسخ‌های تازه') }
    ];
  }

  /* One phone: status bar, the screen (or a sheet over its parent), the tab bar, overlays. */
  function Phone(p) {
    var stack = p.stack, top = stack[stack.length - 1], mt = meta(top.id) || meta('C-HOME-01');
    var isSheet = mt.kind === 'sheet';
    var base = isSheet ? (stack.length > 1 ? stack[stack.length - 2] : { id: mt.over }) : top;
    var mb = meta(base.id);
    var api = p.api || STATIC_API;
    function ctx(entry) {
      var st = stateOf(p.states, entry.id);
      return Object.assign({}, api, { id: entry.id, params: entry.params || {}, st: st, vehicle: p.vehicle, lang: PV.lang, offline: st === 'offline' });
    }
    function render(entry) {
      var m = meta(entry.id), c = ctx(entry);
      return h(PV.Ctx.Provider, { value: c, key: entry.id + c.st + PV.lang },
        h(Boundary, { k: entry.id + c.st }, h(m.comp, { a: c })));
    }
    var showTabs = mb.kind === 'root' || mb.kind === 'stack';
    var ov = p.overlay, toast = p.toast;
    var phoneCtx = ctx(top);

    return html`<div className="pv-phone">
      <div className="pv-status" dir="ltr" aria-hidden="true">
        <span>${PV.lang === 'fa' ? '۹:۴۱' : '9:41'}</span>
        <span className="pv-status-icons"><${K.Ic} name="globe" size=${16} /><span className="pv-batt"></span></span>
      </div>
      <div className="pv-app" dir=${PV.lang === 'fa' ? 'rtl' : 'ltr'} lang=${PV.lang}>
        <div className=${'pv-screen' + (isSheet ? ' pv-inert' : '')} inert=${isSheet ? '' : undefined}>${render(base)}</div>
        ${showTabs ? h(K.TabBar, { items: tabItems(), active: mb.tab, label: t('Main', 'اصلی'), onChange: function (id) { api.nav.tab(id); } }) : null}
        ${isSheet ? html`<${React.Fragment}>
          <button type="button" className="pv-scrim" aria-label=${t('Close', 'بستن')} onClick=${function () { api.nav.back(); }}></button>
          <div className="pv-sheet" role="dialog" aria-modal="true">${render(top)}</div>
        <//>` : null}
        ${ov && ov.type === 'sheet' ? h(PV.Ctx.Provider, { value: phoneCtx }, html`<${React.Fragment}>
          <button type="button" className="pv-scrim" aria-label=${t('Close', 'بستن')} onClick=${api.ui.close}></button>
          <div className="pv-sheet" role="dialog" aria-modal="true" style=${{ zIndex: 25 }}>
            <${K.SheetFrame} title=${ov.title} onClose=${api.ui.close} foot=${ov.foot}>${ov.body}<//>
          </div>
        <//>`) : null}
        ${ov && ov.type === 'dialog' ? html`<${React.Fragment}>
          <div className="pv-scrim is-dialog"></div>
          <div className="pv-dialog" role="alertdialog" aria-modal="true">
            <h2 className="pv-t2">${ov.title}</h2>
            ${ov.text ? html`<p className="pv-b">${ov.text}</p>` : null}
            <div className="pv-row">
              <${K.Btn} onClick=${function () { api.ui.close(); if (ov.onCancel) ov.onCancel(); }}>${ov.cancel || t('Cancel', 'انصراف')}<//>
              <${K.Btn} variant=${ov.danger ? 'danger' : 'primary'} onClick=${function () { api.ui.close(); if (ov.onConfirm) ov.onConfirm(); }}>${ov.confirm}<//>
            </div>
          </div>
        <//>` : null}
        ${toast ? html`<div className="pv-snack" role="status" style=${showTabs ? null : { insetBlockEnd: 'var(--space-4)' }}>
          <span className="pv-grow">${toast.text}</span>
          ${toast.undo ? html`<button type="button" onClick=${function () { toast.undo(); api.ui.hideToast(); }}>${t('Undo', 'واگرد')}</button>` : null}
        </div>` : null}
      </div>
    </div>`;
  }

  /* ---------- The preview app ---------- */
  function App() {
    var hash = decodeURIComponent((location.hash || '').slice(1));
    var start = meta(hash) ? hash : (meta(store('pv-screen')) ? store('pv-screen') : 'C-HOME-01');
    var initLang = store('pv-lang') === 'fa' ? 'fa' : 'en';
    PV.lang = PV.lang || initLang;

    var S = useState(function () {
      PV.lang = initLang;
      return { theme: store('pv-theme') || 'light', lang: initLang, view: 'proto', stack: baseStack(start), states: {}, vehicle: 'silver', overlay: null, toast: null, q: '' };
    });
    var s = S[0], set = S[1];
    PV.lang = s.lang;
    function upd(f) { set(function (o) { return Object.assign({}, o, f(o)); }); }

    useEffect(function () { document.documentElement.setAttribute('data-theme', s.theme); store('pv-theme', s.theme); }, [s.theme]);
    useEffect(function () { store('pv-lang', s.lang); }, [s.lang]);
    var topId = s.stack[s.stack.length - 1].id;
    useEffect(function () { store('pv-screen', topId); try { history.replaceState(null, '', '#' + topId); } catch (e) {} }, [topId]);
    useEffect(function () {
      if (!s.toast) return;
      var k = s.toast.k, tm = setTimeout(function () { upd(function (o) { return o.toast && o.toast.k === k ? { toast: null } : {}; }); }, 5000);
      return function () { clearTimeout(tm); };
    }, [s.toast && s.toast.k]);

    var api = {
      nav: {
        go: function (id, params) {
          if (!meta(id)) return;
          upd(function (o) {
            var st = Object.assign({}, o.states); if (params && params.state) st[id] = params.state;
            var stack = o.stack.concat([{ id: id, params: params || {} }]);
            if (stack.length > 30) stack = stack.slice(-30);
            return { stack: stack, states: st, overlay: null };
          });
        },
        replace: function (id, params) {
          upd(function (o) {
            var st = Object.assign({}, o.states); if (params && params.state) st[id] = params.state;
            return { stack: o.stack.slice(0, -1).concat([{ id: id, params: params || {} }]), states: st, overlay: null };
          });
        },
        back: function () {
          upd(function (o) {
            if (o.stack.length > 1) return { stack: o.stack.slice(0, -1), overlay: null };
            var m = meta(o.stack[0].id), to = m.kind === 'sheet' ? m.over : m.parent;
            return to ? { stack: [{ id: to }], overlay: null } : {};
          });
        },
        tab: function (tab) { upd(function () { return { stack: [{ id: TABS[tab] }], overlay: null }; }); },
        reset: function (id, params) {
          upd(function (o) {
            var st = Object.assign({}, o.states); if (params && params.state) st[id] = params.state;
            return { stack: baseStack(id, params), states: st, overlay: null, view: 'proto' };
          });
        },
        setState: function (id, v) { upd(function (o) { var st = Object.assign({}, o.states); st[id] = v; return { states: st, overlay: null }; }); }
      },
      ui: {
        toast: function (text, undo) { upd(function () { return { toast: { text: text, undo: undo, k: Date.now() + Math.random() } }; }); },
        hideToast: function () { upd(function () { return { toast: null }; }); },
        sheet: function (o) { upd(function () { return { overlay: Object.assign({ type: 'sheet' }, o) }; }); },
        dialog: function (o) { upd(function () { return { overlay: Object.assign({ type: 'dialog' }, o) }; }); },
        close: function () { upd(function () { return { overlay: null }; }); }
      },
      setVehicle: function (v) { upd(function () { return { vehicle: v }; }); },
      setLang: function (l) { PV.lang = l; upd(function () { return { lang: l }; }); },
      setTheme: function (v) { upd(function () { return { theme: v }; }); },
      theme: s.theme
    };

    /* Scale the phone down to fit short windows (CSS zoom keeps hit-testing correct). */
    var Z = useState(1);
    useEffect(function () {
      function fit() {
        var st = document.querySelector('.pv-stage');
        if (!st || window.innerWidth <= 760) { Z[1](1); return; }
        Z[1](Math.max(0.6, Math.min(1, (st.clientHeight - (window.innerWidth > 1240 ? 64 : 140)) / 848)));
      }
      fit(); window.addEventListener('resize', fit);
      return function () { window.removeEventListener('resize', fit); };
    }, [s.view]);

    var m = meta(topId);
    var curState = stateOf(s.states, topId);
    var q = s.q.trim().toLowerCase();
    var groups = [];
    ORDER.forEach(function (id) {
      var x = meta(id); if (!x) return;
      if (q && (id + ' ' + x.name + ' ' + x.area).toLowerCase().indexOf(q) < 0) return;
      var g = groups[groups.length - 1];
      if (!g || g.area !== x.area) groups.push(g = { area: x.area, ids: [] });
      g.ids.push(id);
    });

    function ctl(label, value, opts, on) {
      return html`<div className="pv-ctl" role="radiogroup" aria-label=${label}>
        <span className="pv-cap">${label}</span>
        ${opts.map(function (o) { return html`<${K.Chip} key=${o[0]} selected=${value === o[0]} icon=${o[2]} onClick=${function () { on(o[0]); }}>${o[1]}<//>`; })}
      </div>`;
    }

    var chrome = html`<header className="pv-top">
      <div className="pv-brand"><b>CarPal</b><span className="pv-c pv-muted">Car owner app · ${ORDER.length} screens</span>
        ${location.protocol === 'file:' ? html`<${K.Badge} tone="signal" icon="info">Opened as a file: the browser blocks the brand fonts. Serve it locally (see README).<//>` : null}</div>
      ${ctl('View', s.view, [['proto', 'Prototype', 'car'], ['all', 'All screens', 'grid']], function (v) { upd(function () { return { view: v }; }); })}
      ${ctl('Theme', s.theme, [['light', 'Daylight', 'sun'], ['sun', 'Sunlight', 'eye'], ['dark', 'Night', 'moon']], function (v) { upd(function () { return { theme: v }; }); })}
      ${ctl('Language', s.lang, [['en', 'English', 'globe'], ['fa', 'فارسی', 'globe']], api.setLang)}
    </header>`;

    var side = html`<aside className="pv-side" aria-label="Screen inventory">
      <div className="pv-side-search">
        <${K.Field} label="Find a screen" icon="search" placeholder="ID, name or area" value=${s.q} onChange=${function (e) { var v = e.target.value; upd(function () { return { q: v }; }); }} />
      </div>
      <nav className="pv-side-list">
        ${groups.map(function (g) {
          return html`<div key=${g.area}>
            <p className="pv-side-group pv-cap">${g.area}</p>
            ${g.ids.map(function (id) {
              var x = meta(id);
              return html`<button key=${id} type="button" className=${'pv-side-item' + (id === topId ? ' is-current' : '')} aria-current=${id === topId ? 'page' : undefined}
                onClick=${function () { api.nav.reset(id); }}>
                <span className="pv-id">${id}</span><span className="pv-name">${x.name}</span>
                ${x.isNew ? html`<${K.Badge} tone="signal">New<//>` : null}
              </button>`;
            })}
          </div>`;
        })}
      </nav>
    </aside>`;

    var states = m && m.states && m.states.length > 1 ? html`<div className="pv-stage-bar pv-stage-states" role="radiogroup" aria-label="Screen state">
      ${m.states.map(function (x) { return html`<${K.Chip} key=${x[0]} selected=${curState === x[0]} onClick=${function () { api.nav.setState(topId, x[0]); }}>${x[1]}<//>`; })}
    </div>` : null;

    var picker = html`<select className="pv-mobile-pick cp-field-box" aria-label="Screen" value=${topId} onChange=${function (e) { api.nav.reset(e.target.value); }}>
      ${ORDER.filter(meta).map(function (id) { return html`<option key=${id} value=${id}>${id} — ${meta(id).name}</option>`; })}
    </select>`;

    var stage = s.view === 'proto'
      ? html`<main className="pv-stage">
          ${picker}
          <div className="pv-stage-bar"><span className="pv-l">${topId}</span><span className="pv-c pv-muted">${m ? m.name : ''}</span></div>
          <div style=${{ zoom: Z[0] }}>${h(Phone, { stack: s.stack, states: s.states, vehicle: s.vehicle, api: api, overlay: s.overlay, toast: s.toast })}</div>
          ${states}
        </main>`
      : html`<main className="pv-stage"><div className="pv-overview">
          ${groups.map(function (g) {
            return html`<section key=${g.area} className="pv-ov-group"><h2 className="pv-t2">${g.area}</h2><div className="pv-ov-grid">
              ${g.ids.map(function (id) {
                return html`<button key=${id} type="button" className="pv-ov-tile" onClick=${function () { api.nav.reset(id); }}>
                  <div className="pv-ov-frame pv-inert" inert="">${h(Phone, { stack: baseStack(id), states: s.states, vehicle: s.vehicle })}</div>
                  <span className="pv-cap pv-muted">${id}</span><span className="pv-l">${meta(id).name}</span>
                </button>`;
              })}
            </div></section>`;
          })}
        </div></main>`;

    var info = m ? html`<aside className="pv-info" aria-label="Screen spec">
      <div className="pv-col">
        <span className="pv-cap pv-muted">${m.area} · ${m.priority || 'Must'}${m.story ? ' · Story ch. ' + m.story : ''}</span>
        <h2 className="pv-t2">${m.name}</h2>
        <div className="pv-row"><${K.Badge} tone="accent">${topId}<//>${m.isNew ? html`<${K.Badge} tone="signal">New in Doc 21<//>` : null}</div>
      </div>
      ${m.purpose ? html`<div className="pv-sec"><span className="pv-cap pv-muted">Purpose</span><p className="pv-b">${m.purpose}</p></div>` : null}
      ${m.states && m.states.length > 1 ? html`<div className="pv-sec"><span className="pv-cap pv-muted">States (${m.states.length})</span>
        <div className="pv-wrap">${m.states.map(function (x) { return html`<${K.Chip} key=${x[0]} selected=${curState === x[0]} onClick=${function () { api.nav.setState(topId, x[0]); }}>${x[1]}<//>`; })}</div></div>` : null}
      ${m.notes ? html`<div className="pv-sec"><span className="pv-cap pv-muted">UX notes</span><p className="pv-c">${m.notes}</p></div>` : null}
      <div className="pv-sec">
        <span className="pv-cap pv-muted">Key flows (Doc 21 §5)</span>
        ${FLOWS.map(function (f, i) {
          return html`<div key=${i} className="pv-flow">
            <span className="pv-l">${f[0]}</span>
            <div className="pv-flow-steps">${f[1].map(function (id, j) {
              return html`<${React.Fragment} key=${j}>${j ? html`<${K.Ic} name="next" size=${16} />` : null}<button type="button" className=${id === topId ? 'is-current' : ''} onClick=${function () { api.nav.reset(id); }}>${id}</button><//>`;
            })}</div>
          </div>`;
        })}
      </div>
      <p className="pv-c pv-muted">Tap through the phone: buttons, cards, tabs and sheets navigate like the app. Use the chips under the phone to see each screen's loading, empty, error and special states.</p>
    </aside>` : null;

    return html`<div className="pv-chrome">${chrome}${side}${stage}${info}</div>`;
  }

  /* ?selftest renders every screen in every state (both languages via ?selftest=fa) and logs render errors. */
  function SelfTest() {
    useEffect(function () { setTimeout(function () { console.log('PV-DONE ' + document.querySelectorAll('.pv-phone').length + ' phones'); }, 500); }, []);
    /* &only=ID or ID~state, comma-separated, renders those at full size (for screenshots). */
    var only = (location.search.match(/[?&]only=([^&]+)/) || [])[1];
    var tiles = [];
    if (only) decodeURIComponent(only).split(',').forEach(function (x) {
      var id = x.split('~')[0], states = {}; states[id] = x.split('~')[1];
      if (meta(id)) tiles.push(h('div', { key: x }, h(Phone, { stack: baseStack(id), states: states, vehicle: 'silver' })));
    });
    else ORDER.filter(meta).forEach(function (id) {
      (meta(id).states || [['default']]).forEach(function (st) {
        var states = {}; states[id] = st[0];
        tiles.push(h('div', { key: id + st[0], className: 'pv-ov-frame' }, h(Phone, { stack: baseStack(id), states: states, vehicle: 'silver' })));
      });
    });
    return h('div', { className: 'pv-ov-grid', style: only ? { padding: 'var(--space-4)', flexWrap: 'nowrap' } : null }, tiles);
  }

  window.addEventListener('DOMContentLoaded', function () {
    var missing = ORDER.filter(function (id) { return !meta(id); });
    if (missing.length && window.console) console.warn('Screens not registered:', missing);
    var test = /selftest/.test(location.search);
    if (test) {
      PV.lang = /selftest=fa/.test(location.search) ? 'fa' : 'en';
      var th = (location.search.match(/[?&]theme=(\w+)/) || [])[1];
      if (th) document.documentElement.setAttribute('data-theme', th);
    }
    ReactDOM.createRoot(document.getElementById('root')).render(h(test ? SelfTest : App));
  });
})();
