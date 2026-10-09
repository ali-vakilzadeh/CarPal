/* Doc 21 §4.4 — Help Me triage wizard (Doc 55 IDs). Full screen: close + vehicle chip + step indicator on top, Back + primary at the bottom. */
(function () {
  var C = window.CarPal, K = PV, html = PV.html, t = PV.t, n = PV.n, h = React.createElement, useState = React.useState;

  function Bar(p) {
    var a = PV.use();
    return html`<${React.Fragment}>
      ${p.back === false ? null : html`<${K.Btn} icon="back" style=${{ flex: 'none' }} onClick=${function () { a.nav.back(); }}>${t('Back', 'بازگشت')}<//>`}
      <${K.Btn} variant=${p.secondary ? 'secondary' : 'primary'} disabled=${p.disabled} iconEnd=${p.icon === false ? null : (p.icon || 'next')} onClick=${p.onClick}>${p.label}<//>
    <//>`;
  }

  function towSheet(a) {
    a.ui.sheet({ title: t('Towing options', 'خدمات یدک‌کش'), body: html`<${K.List}>
      <${K.Li} icon="truck" title=${t('Tehran Roadside Tow', 'امداد خودرو تهران')} sub=${t('About 25 min · 2,500,000 T', 'حدود ۲۵ دقیقه · ۲٬۵۰۰٬۰۰۰ تومان')} end=${html`<${K.Btn} size="sm" icon="phone">${t('Call', 'تماس')}<//>`} />
      <${K.Li} icon="truck" title=${t('Sattarkhan Towing', 'یدک‌کش ستارخان')} sub=${t('About 40 min', 'حدود ۴۰ دقیقه')} end=${html`<${K.Btn} size="sm" icon="phone">${t('Call', 'تماس')}<//>`} />
    <//>` });
  }

  /* ---------- C-HELP-01 ---------- */
  K.reg('C-HELP-01', {
    name: 'Help Me Landing', area: 'Help Me', kind: 'full', tab: 'help', story: '6',
    purpose: 'Start describing a problem with zero friction.',
    notes: 'Progress autosaves as a triage session. Closing asks “Save this as an open issue?”',
    states: [['default', 'Default'], ['novehicle', 'No vehicles'], ['aioff', 'Guided help unavailable']]
  }, function (props) {
    var a = props.a, D = PV.D(), v = D.v[a.vehicle] || D.v.silver, txt = useState(''), chips = useState([]);
    var noV = a.st === 'novehicle';
    if (a.st === 'aioff') return html`<${K.Screen} header=${html`<${K.FlowBar} step=${1} />`} bottom=${html`<${Bar} back=${false} secondary label=${t('Search instead', 'جستجو به‌جای آن')} icon="search" onClick=${function () { a.nav.go('S-SHARED-01'); }} />`}>
      <${K.Banner} tone="warn" title=${t('Guided help is temporarily unavailable', 'راهنمای هوشمند موقتاً در دسترس نیست')} text=${t('Choose a category instead and we will show matching shops.', 'به‌جای آن یک دسته انتخاب کنید تا تعمیرگاه‌های مناسب را نشان دهیم.')} />
      <${K.List}>${[['alert', t('Brakes', 'ترمز')], ['wrench', t('Suspension and steering', 'جلوبندی و فرمان')], ['car', t('Engine', 'موتور')], ['info', t('Electrical and warning lights', 'برق و چراغ‌های هشدار')], ['sun', t('Air conditioning', 'کولر')], ['part', t('Tyres and wheels', 'تایر و رینگ')]].map(function (c, i) {
        return html`<${K.Li} key=${i} icon=${c[0]} title=${c[1]} onClick=${function () { a.nav.go('C-SEARCH-01'); }} />`;
      })}<//>
    <//>`;
    return html`<${K.Screen} header=${html`<${K.FlowBar} step=${1} vehicle=${!noV} title=${t('Help Me', 'کمکم کن')} />`}
      bottom=${html`<${Bar} back=${false} label=${t('Start', 'شروع')} onClick=${function () { a.nav.go(noV ? 'C-HELP-02' : 'C-HELP-03'); }} />`}>
      ${noV ? html`<${K.Banner} tone="info" icon="car" title=${t('Add your car for the best match', 'برای بهترین پیشنهاد خودرو را اضافه کنید')} text=${t('You can also continue without a car — matching will be less specific.', 'می‌توانید بدون خودرو هم ادامه دهید — پیشنهادها کلی‌تر خواهند بود.')}>
        <div className="pv-row" style=${{ marginBlockStart: 'var(--space-2)' }}><${K.Btn} size="sm" icon="plus" onClick=${function () { a.nav.go('C-GARAGE-03', { state: 'add' }); }}>${t('Add vehicle', 'افزودن خودرو')}<//><${K.Btn} size="sm" variant="ghost" onClick=${function () { a.nav.go('C-HELP-03'); }}>${t('Continue without a car', 'ادامه بدون خودرو')}<//></div>
      <//>` : null}
      <h1 className="pv-t1">${noV ? t('What is happening with your car?', 'خودروی شما چه مشکلی دارد؟') : html`${t('What is happening with ', 'چه اتفاقی برای ')}<bdi>${v.nick}</bdi>${t('?', ' افتاده؟')}`}</h1>
      <${K.Field} multiline aria-label=${t('Describe the problem', 'مشکل را توضیح دهید')} placeholder=${t('e.g. A knock from the front when I drive over bumps', 'مثلاً صدای ضربه از جلو هنگام رد شدن از دست‌انداز')} value=${txt[0]} onChange=${function (e) { txt[1](e.target.value); }} />
      <${K.ChipSet} wrap multi label=${t('Common symptoms', 'نشانه‌های رایج')} value=${chips[0]} onChange=${chips[1]} items=${PV.symptoms()} />
      <div className="pv-row is-nowrap"><${K.Btn} className="pv-grow" icon="camera">${t('Photo', 'عکس')}<//><${K.Btn} className="pv-grow" icon="video">${t('Video (30 s)', 'ویدیو (۳۰ ثانیه)')}<//></div>
      ${noV ? null : html`<${K.Card} tight onClick=${function () { a.nav.go('C-HELP-04'); }}>
        <div className="pv-row is-nowrap"><span className="pv-tile"><${K.Ic} name="clock" size=${20} /></span>
          <div className="pv-col pv-grow"><span className="pv-cap pv-muted">${t('Continue your draft', 'ادامه پیش‌نویس')}</span><span className="pv-bs">${t('Clunk from front right', 'تق‌تق از جلوی راست')}</span><span className="pv-c pv-muted">${t('2 days ago', '۲ روز پیش')}</span></div>
          <${K.Ic} name="next" size=${20} /></div>
      <//>`}
      <${K.Banner} tone="plain" icon="alert" text=${t('If the car feels unsafe, stop driving and get urgent help.', 'اگر خودرو ناایمن به نظر می‌رسد، رانندگی را متوقف کنید و کمک فوری بگیرید.')}>
        <div><button type="button" className="pv-link is-danger" onClick=${function () { a.nav.go('C-HELP-05', { state: 'critical' }); }}>${t('Urgent help', 'کمک فوری')}</button></div>
      <//>
    <//>`;
  });

  /* ---------- C-HELP-02 ---------- */
  K.reg('C-HELP-02', {
    name: 'Select Vehicle', area: 'Help Me', kind: 'full', tab: 'help', parent: 'C-HELP-01', story: '6',
    purpose: 'Pick which car the problem is about.',
    notes: 'A vehicle with an open issue asks “Is this about the same problem?” so the user can resume it.'
  }, function (props) {
    var a = props.a, D = PV.D(), sel = useState('silver');
    return html`<${K.Screen} header=${html`<${K.FlowBar} step=${1} vehicle=${false} title=${t('Which car?', 'کدام خودرو؟')} />`}
      bottom=${html`<${Bar} label=${t('Next', 'بعدی')} onClick=${function () { a.setVehicle(sel[0]); a.nav.go('C-HELP-03'); }} />`}>
      <h1 className="pv-t1">${t('Which car is it about?', 'مشکل مربوط به کدام خودرو است؟')}</h1>
      ${['silver', 'corolla'].map(function (id) {
        return html`<${K.VehicleCard} key=${id} v=${D.v[id]} selected=${sel[0] === id} onClick=${function () { sel[1](id); }}>
          ${id === 'silver' && sel[0] === 'silver' ? html`<div className="pv-card is-signal is-tight" onClick=${function (e) { e.stopPropagation(); }}>
            <p className="pv-bs">${t('Is this about the same problem?', 'درباره همان مشکل قبلی است؟')}</p>
            <p className="pv-c">${t('Open issue: clunk from front right over bumps.', 'مشکل باز: تق‌تق از جلوی راست روی دست‌انداز.')}</p>
            <div className="pv-row"><${K.Btn} size="sm" onClick=${function () { a.nav.go('C-HELP-06'); }}>${t('Resume it', 'ادامه همان')}<//><${K.Btn} size="sm" variant="ghost" onClick=${function () { a.nav.go('C-HELP-03'); }}>${t('New problem', 'مشکل تازه')}<//></div>
          </div>` : null}
        <//>`;
      })}
      <${K.List}><${K.Li} icon="plus" title=${t('Add vehicle', 'افزودن خودرو')} onClick=${function () { a.nav.go('C-GARAGE-03', { state: 'add' }); }} /><//>
      <div><button type="button" className="pv-link" onClick=${function () { a.setVehicle('any'); a.nav.go('C-HELP-03'); }}>${t('Continue without a car', 'ادامه بدون خودرو')}</button></div>
    <//>`;
  });

  /* ---------- C-HELP-03 ---------- */
  K.reg('C-HELP-03', {
    name: 'Symptom Intake', area: 'Help Me', kind: 'full', tab: 'help', parent: 'C-HELP-01', story: '6',
    purpose: "Capture the problem in the user's own words, with media.",
    notes: 'Safety keywords (brakes, steering, smoke, burning, airbag, overheating, loss of power) show the red banner at once and route to the safety check.',
    states: [['default', 'Described'], ['safety', 'Safety keywords detected'], ['short', 'Too short'], ['uploadfail', 'Upload failed']]
  }, function (props) {
    var a = props.a, D = PV.D(), st = a.st, urg = useState(st === 'safety' ? 'unsafe' : 'soon');
    var text = st === 'safety' ? t('Brakes feel soft and the pedal goes down further than usual since yesterday.', 'از دیروز ترمز نرم شده و پدال بیشتر از همیشه پایین می‌رود.') : (st === 'short' ? t('noise', 'صدا') : D.symptom);
    var danger = st === 'safety' || urg[0] === 'unsafe';
    return html`<${K.Screen} header=${html`<${K.FlowBar} step=${2} />`}
      bottom=${html`<${Bar} label=${t('Next', 'بعدی')} onClick=${function () { a.nav.go(danger ? 'C-HELP-05' : 'C-HELP-04', danger ? { state: 'critical' } : null); }} />`}>
      <h1 className="pv-t2">${t('Describe the problem', 'مشکل را توضیح دهید')}</h1>
      <${K.Field} multiline aria-label=${t('Description', 'توضیح')} defaultValue=${text}
        hint=${st === 'short' ? null : t('Where, when, how often, since when?', 'کجا، کی، چند وقت یک‌بار، از کی؟')}
        error=${st === 'short' ? t('Add a little more detail so we can help.', 'کمی بیشتر توضیح دهید تا بتوانیم کمک کنیم.') : null} />
      ${st === 'safety' ? html`<${K.SafetyBanner} title=${t('Brake problems can be dangerous', 'مشکل ترمز می‌تواند خطرناک باشد')} text=${t('If the pedal feels soft, stop driving. We will check urgency next.', 'اگر پدال نرم است، رانندگی نکنید. در مرحله بعد فوریت را بررسی می‌کنیم.')} />` : null}
      ${st === 'default' ? html`<div className="pv-col">
        <div className="pv-row"><${K.Badge} icon="spark">${t('AI suggestion', 'پیشنهاد هوش مصنوعی')}<//><span className="pv-cap pv-muted">${t('Tap to add', 'برای افزودن بزنید')}</span></div>
        <${K.ChipSet} wrap multi value=${['clunk']} items=${[['clunk', t('Clunk over bumps', 'تق‌تق روی دست‌انداز')], ['fr', t('Front right', 'جلوی راست')], ['louder', t('Getting louder', 'بلندتر می‌شود')]]} />
      </div>` : null}
      <${K.Sec} title=${t('Photos and video', 'عکس و ویدیو')}>
        <div className="pv-row is-nowrap">
          <${K.Thumb} icon="video" label=${t('Video, 10 seconds', 'ویدیو، ۱۰ ثانیه')} badge=${html`<${K.Badge}>${n(0)}:${n(10)}<//>`} />
          ${st === 'uploadfail' ? html`<div className="pv-upload"><span className="pv-c pv-danger" style=${{ fontWeight: 700 }}><${K.Ic} name="alert" size=${16} /> ${t('Upload failed', 'بارگذاری ناموفق بود')}</span>
              <div className="pv-row"><${K.Btn} size="sm" icon="refresh">${t('Retry', 'تلاش دوباره')}<//><${K.Btn} size="sm" variant="ghost">${t('Continue without', 'ادامه بدون آن')}<//></div></div>`
            : html`<div className="pv-upload"><span className="pv-c">${t('Uploading video', 'در حال بارگذاری ویدیو')}</span><div className="pv-meter"><span style=${{ inlineSize: '72%' }}></span></div><span className="pv-cap pv-muted">${t('Continues if you leave this screen', 'اگر از صفحه خارج شوید ادامه می‌یابد')}</span></div>`}
        </div>
        <div className="pv-row is-nowrap"><${K.Btn} className="pv-grow" icon="camera">${t('Photo', 'عکس')}<//><${K.Btn} className="pv-grow" icon="video">${t('Video', 'ویدیو')}<//><${K.Btn} className="pv-grow" icon="image">${t('Gallery', 'گالری')}<//></div>
      <//>
      <${K.Sec} title=${t('How urgent does it feel?', 'چقدر فوری به نظر می‌رسد؟')}>
        <${K.ChipSet} wrap value=${urg[0]} onChange=${urg[1]} items=${[['not', t('Not urgent', 'غیرفوری')], ['soon', t('Soon', 'به‌زودی')], ['urgent', t('Urgent', 'فوری')], ['unsafe', t('Unsafe to drive', 'رانندگی ناایمن است'), 'alert']]} />
      <//>
    <//>`;
  });

  /* ---------- C-HELP-04 ---------- */
  K.reg('C-HELP-04', {
    name: 'AI Clarifying Questions', area: 'Help Me', kind: 'full', tab: 'help', parent: 'C-HELP-03', story: '6',
    purpose: 'Narrow down the problem with a few quick taps.',
    notes: 'Each answer loads the next question in under 2 s. A dangerous answer jumps to the safety check. The app may stop before 5 questions.',
    states: [['default', 'Question'], ['loading', 'Loading next question']]
  }, function (props) {
    var a = props.a, q = useState(0), ans = useState(null);
    var Q = [
      [t('Does it also happen when you turn the steering wheel while parked?', 'وقتی پارک هستید و فرمان را می‌چرخانید هم صدا می‌آید؟'), [['y', t('Yes', 'بله')], ['n', t('No', 'نه')], ['moving', t('Only when moving', 'فقط هنگام حرکت')], ['loose', t('The steering feels loose', 'فرمان لق است')]]],
      [t('Is it louder with passengers or luggage?', 'با سرنشین یا بار بلندتر می‌شود؟'), [['y', t('Yes', 'بله')], ['n', t('No', 'نه')]]],
      [t('Do you feel it through the steering wheel?', 'آن را در فرمان حس می‌کنید؟'), [['y', t('Yes', 'بله')], ['n', t('No', 'نه')], ['little', t('A little', 'کمی')]]]
    ];
    function next(skip) {
      if (!skip && ans[0] === 'loose') { a.nav.go('C-HELP-05', { state: 'critical' }); return; }
      if (q[0] < Q.length - 1) { q[1](q[0] + 1); ans[1](null); } else a.nav.go('C-HELP-05', { state: 'soon' });
    }
    var cur = Q[q[0]];
    return html`<${K.Screen} header=${html`<${K.FlowBar} step=${3} />`}
      bottom=${html`<${Bar} label=${t('Next', 'بعدی')} disabled=${a.st !== 'loading' && !ans[0]} onClick=${function () { next(false); }} />`}>
      <p className="pv-l pv-muted">${t('Question ', 'پرسش ') + n(q[0] + 2) + t(' of up to 5', ' از حداکثر ۵')}</p>
      ${a.st === 'loading' ? html`<${K.Card}><${K.Skel} w="90%" /><${K.Skel} w="60%" /><div className="pv-row"><${K.Skel} lg w="25%" /><${K.Skel} lg w="25%" /><${K.Skel} lg w="35%" /></div><//>` : html`<${K.Card} className="is-hero">
        <div className="pv-row"><${K.Badge} icon="spark">${t('AI question', 'پرسش هوش مصنوعی')}<//></div>
        <h1 className="pv-t2">${cur[0]}</h1>
        <${K.ChipSet} key=${q[0]} wrap value=${ans[0]} onChange=${ans[1]} items=${cur[1]} />
      <//>`}
      <div className="pv-row"><${K.Btn} size="sm" onClick=${function () { ans[1]('unsure'); next(true); }}>${t('Not sure', 'مطمئن نیستم')}<//><${K.Btn} size="sm" variant="ghost" onClick=${function () { next(true); }}>${t('Skip', 'رد شدن')}<//></div>
      <div><button type="button" className="pv-link"><${K.Ic} name="camera" size=${20} />${t('Add a photo or video', 'افزودن عکس یا ویدیو')}</button></div>
      <details className="pv-card is-flat" open>
        <summary className="pv-l" style=${{ minBlockSize: 'var(--tap-min)', display: 'flex', alignItems: 'center', cursor: 'pointer' }}>${t('Your answers so far', 'پاسخ‌های شما تا اینجا')}</summary>
        <dl className="pv-kv">
          <dt>${t('When do you hear it?', 'کی صدا را می‌شنوید؟')}</dt><dd>${t('Over bumps', 'روی دست‌انداز')}</dd>
          ${q[0] > 0 ? html`<${React.Fragment}><dt>${Q[0][0]}</dt><dd>${t('Only when moving', 'فقط هنگام حرکت')}</dd><//>` : null}
          ${q[0] > 1 ? html`<${React.Fragment}><dt>${Q[1][0]}</dt><dd>${t('No', 'نه')}</dd><//>` : null}
        </dl>
      </details>
    <//>`;
  });

  /* ---------- C-HELP-05 ---------- */
  K.reg('C-HELP-05', {
    name: 'Safety and Urgency Check', area: 'Help Me', kind: 'full', tab: 'help', parent: 'C-HELP-04', story: '6',
    purpose: 'Protect the driver first.',
    notes: 'Colour + icon + words at every level. Never says “safe to ignore”; never gives a diagnosis. Continuing after a red warning records an acknowledgment.',
    states: [['critical', 'Safety-critical'], ['urgent', 'Urgent'], ['soon', 'Soon'], ['ok', 'Not urgent'], ['nourgent', 'No urgent provider nearby']]
  }, function (props) {
    var a = props.a, st = a.st, ack = useState(false);
    function tow() { towSheet(a); }
    if (st === 'critical' || st === 'nourgent') return html`<${K.Screen} header=${html`<${K.FlowBar} step=${4} />`}
      bottom=${html`<${Bar} label=${t('Find urgent help', 'یافتن کمک فوری')} icon="alert" onClick=${function () { a.nav.go('C-HELP-06', { state: 'safety' }); }} />`}>
      <div className="pv-level is-critical" role="alert">
        <div className="pv-row is-nowrap"><span className="pv-tile is-danger is-lg"><${K.Ic} name="alert" /></span><h1 className="pv-t2 pv-danger">${t('Safety-critical', 'بحرانی برای ایمنی')}</h1></div>
        <p className="pv-b">${t('Stop driving if the brakes feel soft or the steering feels loose. Pull over safely and switch on your hazard lights.', 'اگر ترمز نرم است یا فرمان لق است رانندگی نکنید. با احتیاط کنار بزنید و فلاشر را روشن کنید.')}</p>
      </div>
      ${st === 'nourgent' ? html`<${K.Banner} tone="warn" title=${t('No urgent shops within 10 km right now', 'الان هیچ تعمیرگاه فوری تا ۱۰ کیلومتری نیست')} text=${t('We widened the search to 25 km. Towing may be faster.', 'جستجو را تا ۲۵ کیلومتر گسترش دادیم. یدک‌کش ممکن است سریع‌تر باشد.')} />` : null}
      <${K.Btn} block icon="truck" onClick=${tow}>${t('Towing options', 'خدمات یدک‌کش')}<//>
      <${K.Btn} block variant="danger" icon="phone">${t('Call emergency services', 'تماس با اورژانس')}<//>
      <${K.Btn} block variant="ghost" icon="bookmark" onClick=${function () { a.nav.tab('discover'); a.ui.toast(t('Saved as an open issue', 'به‌عنوان مشکل باز ذخیره شد')); }}>${t('Save and decide later', 'ذخیره و تصمیم بعداً')}<//>
      <${K.Card} tone="sunken" tight>
        <${K.Check} value=${ack[0]} onChange=${ack[1]}>${t('I understand the risk and want to see normal results', 'خطر را می‌دانم و نتایج عادی را می‌خواهم')}<//>
        <div><${K.Btn} size="sm" disabled=${!ack[0]} onClick=${function () { a.nav.go('C-HELP-06'); }}>${t('See recommendations', 'مشاهده پیشنهادها')}<//></div>
      <//>
    <//>`;
    var L = {
      urgent: ['is-urgent', 'alert', t('Urgent', 'فوری'), t('Get it checked today or tomorrow. Drive only short distances.', 'امروز یا فردا بررسی شود. فقط مسافت کوتاه رانندگی کنید.')],
      soon: ['is-soon', 'clock', t('Soon', 'به‌زودی'), t('Get it checked within two weeks. Take speed bumps slowly until then.', 'ظرف دو هفته بررسی شود. تا آن موقع از سرعت‌گیرها آرام رد شوید.')],
      ok: ['is-ok', 'check', t('Not urgent', 'غیرفوری'), t('Book when convenient. If anything changes, check again.', 'هر وقت راحت بودید رزرو کنید. اگر چیزی تغییر کرد دوباره بررسی کنید.')]
    }[st];
    return html`<${K.Screen} header=${html`<${K.FlowBar} step=${4} />`}
      bottom=${html`<${Bar} label=${t('See recommendations', 'مشاهده پیشنهادها')} onClick=${function () { a.nav.go('C-HELP-06'); }} />`}>
      <div className=${'pv-level ' + L[0]}>
        <div className="pv-row is-nowrap"><span className=${'pv-tile is-lg ' + (st === 'ok' ? 'is-success' : 'is-solid')}><${K.Ic} name=${L[1]} /></span>
          <div className="pv-col"><span className="pv-cap">${t('Urgency', 'فوریت')}</span><h1 className="pv-t2">${L[2]}</h1></div></div>
        <p className="pv-b">${L[3]}</p>
      </div>
      ${st === 'soon' ? html`<${K.Card}>
        <p className="pv-h">${t('One more check: does the car pull to one side when braking?', 'یک بررسی دیگر: هنگام ترمز خودرو به یک طرف می‌کشد؟')}</p>
        <${K.ChipSet} value="n" items=${[['y', t('Yes', 'بله')], ['n', t('No', 'نه')], ['unsure', t('Not sure', 'مطمئن نیستم')]]} onChange=${function (v) { if (v === 'y') a.nav.setState('C-HELP-05', 'urgent'); }} />
      <//>` : null}
      <${K.Btn} block variant="ghost" icon="bookmark" onClick=${function () { a.nav.tab('discover'); a.ui.toast(t('Saved as an open issue', 'به‌عنوان مشکل باز ذخیره شد')); }}>${t('Save and decide later', 'ذخیره و تصمیم بعداً')}<//>
    <//>`;
  });

  /* ---------- C-HELP-06 ---------- */
  K.reg('C-HELP-06', {
    name: 'Issue Summary and Recommendations', area: 'Help Me', kind: 'full', tab: 'help', parent: 'C-HELP-05', story: '6, 7',
    purpose: 'Show what CarPal understood and the best experts for it, with honest reasons.',
    notes: 'Changing the category re-runs matching and is recorded for AI evaluation. On the map the 3 recommended shops carry the numbers 1–3, and urgent providers come first when the issue is safety-critical. A Featured strip is reserved and not shown in the MVP.',
    states: [['default', 'Default'], ['safety', 'Safety-critical'], ['lowconf', 'Low confidence'], ['nomatch', 'No match'], ['aioff', 'AI personalisation off']]
  }, function (props) {
    var a = props.a, D = PV.D(), st = a.st, ai = st !== 'aioff';
    function category() {
      a.ui.sheet({ title: t('Change category', 'تغییر دسته'), body: html`<div role="radiogroup">
        ${[t('Suspension → Inspection / repair', 'جلوبندی ← بازدید / تعمیر'), t('Steering → Inspection', 'فرمان ← بازدید'), t('Tyres and wheels → Balancing', 'تایر و رینگ ← بالانس'), t('General inspection', 'بازدید عمومی')].map(function (c, i) {
          return html`<${K.Check} key=${i} radio on=${i === 0} onChange=${function () { a.ui.close(); a.ui.toast(t('Matches updated for the new category', 'پیشنهادها برای دسته تازه به‌روز شد')); }}>${c}<//>`;
        })}</div>` });
    }
    var cat = st === 'lowconf' ? t('General inspection', 'بازدید عمومی') : t('Suspension → Suspension inspection / repair', 'جلوبندی ← بازدید / تعمیر جلوبندی');
    var provs = st === 'safety' ? [D.p.karimi, D.p.ali] : (st === 'lowconf' ? [D.p.karimi, D.p.bimmer] : [D.p.reza, D.p.bimmer, D.p.karimi]);
    return html`<${K.Screen} header=${html`<${K.FlowBar} step=${5} />`}
      bottom=${html`<${Bar} secondary label=${t('Save for later', 'ذخیره برای بعد')} icon="bookmark" onClick=${function () { a.nav.tab('discover'); a.ui.toast(t('Saved as an open issue', 'به‌عنوان مشکل باز ذخیره شد')); }} />`}>
      ${st === 'safety' ? html`<${K.SafetyBanner} title=${t('Safety-critical: showing shops that can see you today', 'بحرانی: تعمیرگاه‌هایی که امروز وقت دارند')} text=${t('Do not drive far. Consider towing.', 'مسافت زیادی رانندگی نکنید. یدک‌کش را در نظر بگیرید.')} action=${t('Towing options', 'خدمات یدک‌کش')} onAction=${function () { towSheet(a); }} />` : null}
      <${K.Card}>
        <div className="pv-row is-between"><span className="pv-l">${t('What we understood', 'آنچه فهمیدیم')}</span><${K.Btn} size="sm" variant="ghost" icon="edit" onClick=${function () { a.nav.go('C-HELP-03'); }}>${t('Edit', 'ویرایش')}<//></div>
        <div className="pv-row"><${K.Ic} name="car" size=${20} className="pv-accent" /><span className="pv-c"><bdi>${D.v.silver.nick}</bdi> · BMW 320i E90 · ${D.v.silver.mileage}</span></div>
        <p className="pv-c pv-ugc" dir="auto" style=${{ borderInlineStart: '3px solid var(--divider)', paddingInlineStart: 'var(--space-3)' }}>${D.symptom}</p>
        ${ai ? html`<div className="pv-col"><${K.Badge} icon="spark">${t('AI summary', 'خلاصه هوش مصنوعی')}<//>
          <p className="pv-bs" style=${{ marginBlockStart: 'var(--space-2)' }}>${st === 'lowconf' ? t('Likely area: not clear yet', 'محدوده احتمالی: هنوز روشن نیست') : t('Likely area: front suspension', 'محدوده احتمالی: جلوبندی')}</p>
          <p className="pv-c">${st === 'lowconf' ? t('We recommend a general inspection.', 'بازدید عمومی را پیشنهاد می‌کنیم.') : t('E.g. sway bar links, control arm bushings, strut mounts.', 'مثلاً میل موجگیر، بوش طبق، سرکمک.')}</p></div>` : html`<p className="pv-c">${t('You chose: Suspension', 'انتخاب شما: جلوبندی')}</p>`}
        <div className="pv-row"><${K.Urgency} level=${st === 'safety' ? 'critical' : 'soon'} />${ai ? html`<${K.Badge} icon="info">${st === 'lowconf' ? t('Confidence: low', 'اطمینان: کم') : t('Confidence: medium', 'اطمینان: متوسط')}<//>` : null}</div>
        ${ai ? html`<p className="pv-c pv-muted">${t('History: front brake work 14 months ago, unlikely related.', 'سابقه: کار ترمز جلو ۱۴ ماه پیش، احتمالاً بی‌ارتباط.')}</p>` : null}
        <div className="pv-row"><${K.Thumb} icon="video" badge=${html`<${K.Badge}>${n(0)}:${n(10)}<//>`} /></div>
        <p className="pv-cap pv-muted">${t('This is not a diagnosis; a mechanic needs to inspect the car.', 'این تشخیص نیست؛ مکانیک باید خودرو را ببیند.')}</p>
      <//>
      <${K.List}><${K.Li} icon="wrench" title=${cat} sub=${t('Service category', 'دسته خدمت')} end=${html`<${K.Btn} size="sm" variant="ghost" onClick=${category}>${t('Change', 'تغییر')}<//>`} /><//>
      ${st === 'nomatch' ? html`<${K.Card} tone="sunken">
        <p className="pv-h">${t('No suspension specialists for E90 within 10 km', 'هیچ متخصص جلوبندی E90 تا ۱۰ کیلومتری نیست')}</p>
        <div className="pv-col is-gap3"><${K.Btn} block>${t('Widen to 25 km', 'گسترش تا ۲۵ کیلومتر')}<//><${K.Btn} block icon="truck">${t('Mobile mechanics who come to you', 'مکانیک سیار که به محل شما می‌آید')}<//></div>
        <p className="pv-c">${t('Or a well-rated generalist nearby. Karimi Auto Service has done 3 BMW suspension jobs.', 'یا یک تعمیرکار عمومی خوش‌نام در نزدیکی. تعمیرگاه کریمی ۳ کار جلوبندی BMW انجام داده است.')}</p>
        <${K.ProviderCard} p=${D.p.karimi} triage primary />
      <//>` : html`<${K.Sec} title=${st === 'safety' ? t('Can see you today', 'امروز وقت دارند') : t('Best matches for Silver', 'بهترین گزینه‌ها برای نقره‌ای')}>
        ${provs.map(function (x, i) { return html`<${K.ProviderCard} key=${x.id} p=${x} match=${ai} triage primary=${i === 0} />`; })}
      <//>`}
      <${K.Sec} title=${t('More options', 'گزینه‌های دیگر')}>
        <${K.List}>
          <${K.Li} icon="map" title=${t('See more shops', 'تعمیرگاه‌های بیشتر')} sub=${t('List or map. On the map your 3 matches are numbered 1–3.', 'فهرست یا نقشه. روی نقشه سه گزینه شما با ۱ تا ۳ شماره‌گذاری شده‌اند.')} onClick=${function () { a.nav.go('S-SHARED-02'); }} />
          <${K.Li} icon="part" title=${t('Search for parts instead', 'جستجوی قطعه به‌جای آن')} onClick=${function () { a.nav.go('C-INV-01'); }} />
          <${K.Li} icon="chat" title=${t('Ask the community', 'از انجمن بپرسید')} onClick=${function () { a.nav.go('C-COMM-04'); }} />
        <//>
      <//>
    <//>`;
  });

  /* ---------- C-HELP-07 ---------- */
  K.reg('C-HELP-07', {
    name: 'Appointment Request Draft (shared by every entry point)', area: 'Help Me', kind: 'full', tab: 'help', parent: 'C-HELP-06', story: '7, 11',
    purpose: 'Turn the problem into a clear request in one screen, with the user in control of what is shared.',
    notes: 'Used from Help Me, search results, a map pin, a profile, a showcase and favourites (Book again); the request source is stored. Without Help Me there is no triage: the user types what they need, and the shop sees “Triage: not provided”. Consent is asked here, where data leaves the user, scoped to this appointment.',
    states: [['default', 'From Help Me (with triage)'], ['notriage', 'From search, map, profile or showcase (no triage)'], ['safety', 'Safety words in the note'], ['unavailable', 'Chosen times unavailable'], ['failed', 'Send failed']]
  }, function (props) {
    var a = props.a, D = PV.D(), x = D.p.reza, st = a.st, hist = useState(true), nt = st === 'notriage' || st === 'safety';
    var historyPreview = html`<${React.Fragment}><p className="pv-c">${t('The shop will see these records:', 'تعمیرگاه این سوابق را می‌بیند:')}</p>
      <${K.List}><${K.Li} icon="doc" title=${t('Front brake pads and discs', 'لنت و دیسک ترمز جلو')} sub=${t('Apr 2025 · 139,500 km', 'فروردین ۱۴۰۴ · ۱۳۹٬۵۰۰ کیلومتر')} /><${K.Li} icon="doc" title=${t('Oil and filter change', 'تعویض روغن و فیلتر')} sub=${t('Apr 2026 · 146,200 km', 'فروردین ۱۴۰۵ · ۱۴۶٬۲۰۰ کیلومتر')} /><//>
      <p className="pv-c pv-muted">${t('Costs and invoices are not shared.', 'هزینه‌ها و فاکتورها به اشتراک گذاشته نمی‌شوند.')}</p><//>`;
    return html`<${K.Screen} header=${html`<${K.FlowBar} step=${6} />`}
      bottom=${html`<${Bar} label=${t('Send request', 'ارسال درخواست')} icon="send" onClick=${function () { a.nav.go('C-HELP-08'); }} />`}>
      ${st === 'failed' ? html`<${K.Banner} tone="warn" title=${t("Couldn't send your request", 'درخواست ارسال نشد')} text=${t('Your draft is saved. Check your connection and try again.', 'پیش‌نویس ذخیره شده است. اتصال را بررسی کنید و دوباره تلاش کنید.')}>
        <div style=${{ marginBlockStart: 'var(--space-2)' }}><${K.Btn} size="sm" icon="refresh">${t('Retry', 'تلاش دوباره')}<//></div><//>` : null}
      <h1 className="pv-t2">${t('Request an appointment', 'درخواست نوبت')}</h1>
      <${K.Card} tight>
        <div className="pv-row is-nowrap"><${C.Avatar} name=${x.name} ring />
          <div className="pv-col pv-grow"><bdi className="pv-bs">${x.name}</bdi><span className="pv-row pv-c"><${K.Rating} value=${x.rating} /> · ${x.dist}</span></div>
          <${K.Btn} size="sm" variant="ghost" onClick=${function () { a.nav.back(); }}>${t('Change', 'تغییر')}<//></div>
      <//>
      ${nt ? html`<${K.Card} tight>
        <div className="pv-row is-nowrap"><span className="pv-tile"><${K.Ic} name="car" size=${20} /></span><div className="pv-col pv-grow"><span className="pv-cap pv-muted">${t('Vehicle', 'خودرو')}</span><span className="pv-bs"><bdi>${D.v.silver.nick}</bdi> · ${D.v.silver.short}</span></div>
          <${K.Btn} size="sm" variant="ghost" onClick=${function () { a.nav.go('S-SHARED-09'); }}>${t('Change', 'تغییر')}<//></div>
        <${K.Field} multiline label=${t('What do you need?', 'چه چیزی لازم دارید؟')} defaultValue=${st === 'safety' ? '' : t('Front brake pads and a wheel alignment.', 'لنت ترمز جلو و تنظیم فرمان.')} hint=${t('Your own words. The shop will read exactly this.', 'با کلمات خودتان. تعمیرگاه دقیقاً همین را می‌خواند.')} />
        <${K.ChipSet} wrap value="brakes" items=${[['susp', t('Suspension', 'جلوبندی')], ['brakes', t('Brakes', 'ترمز')], ['tyres', t('Wheels & tyres', 'لاستیک و رینگ')], ['battery', t('Battery', 'باتری')], ['other', t('Other', 'سایر')]]} />
        <div><button type="button" className="pv-link" onClick=${function () { a.nav.go('C-HELP-03'); }}><${K.Ic} name="help" size=${20} />${t('Describe it with Help Me', 'با «کمکم کن» توضیح دهید')}</button></div>
        <p className="pv-c pv-muted"><${K.Ic} name="info" size=${16} /> ${t('The shop will see “Triage: not provided” and your own description.', 'تعمیرگاه «بررسی هوشمند: ارائه نشده» و توضیح خود شما را می‌بیند.')}</p>
        <div className="pv-row"><${K.Thumb} add icon="plus" label=${t('Add media', 'افزودن رسانه')} /></div>
      <//>` : html`<${K.Card} tight>
        <div className="pv-row is-between is-nowrap"><span className="pv-bs"><bdi>${D.v.silver.nick}</bdi> · ${t('Clunk from front right', 'تق‌تق از جلوی راست')}</span><${K.Btn} size="sm" variant="ghost" icon="edit">${t('Edit', 'ویرایش')}<//></div>
        <p className="pv-c pv-ugc" dir="auto">${D.symptom}</p>
        <div className="pv-row"><${K.Thumb} icon="video" remove badge=${html`<${K.Badge}>${n(0)}:${n(10)}<//>`} /><${K.Thumb} add icon="plus" label=${t('Add media', 'افزودن رسانه')} /></div>
      <//>`}
      <${K.Sec} title=${t('Service type', 'نوع خدمت')}><${K.ChipSet} value="insp" items=${[['diag', t('Diagnosis', 'عیب‌یابی')], ['repair', t('Repair', 'تعمیر')], ['insp', t('Inspection', 'بازدید')]]} /><//>
      <${K.List}><${K.Li} icon="clock" title=${t('Within two weeks', 'ظرف دو هفته')} sub=${t('Urgency', 'فوریت')} end=${html`<${K.Btn} size="sm" variant="ghost">${t('Change', 'تغییر')}<//>`} /><//>
      <${K.Sec} title=${t('Preferred times', 'زمان‌های دلخواه')} sub=${t('Up to 3. These are the shop’s next openings.', 'تا ۳ مورد. این‌ها نزدیک‌ترین نوبت‌های خالی تعمیرگاه است.')}>
        ${st === 'unavailable' ? html`<${K.Banner} tone="warn" title=${t('Reza has no openings in your chosen times', 'رضا در زمان‌های انتخابی شما وقت ندارد')} text=${t('Try one of these, or send to another shop.', 'یکی از این‌ها را امتحان کنید یا برای تعمیرگاه دیگری بفرستید.')} />` : null}
        <${K.ChipSet} wrap multi value=${st === 'unavailable' ? [] : ['thu9', 'sat10']} items=${[['thu9', t('Thu 15 Oct · 09:00', 'پنجشنبه ۲۳ مهر · ۰۹:۰۰')], ['thu11', t('Thu 15 Oct · 11:00', 'پنجشنبه ۲۳ مهر · ۱۱:۰۰')], ['sat10', t('Sat 17 Oct · 10:00', 'شنبه ۲۵ مهر · ۱۰:۰۰')], ['sat12', t('Sat 17 Oct · 12:00', 'شنبه ۲۵ مهر · ۱۲:۰۰')], ['any', t('Any time this week', 'هر زمانی در این هفته')]]} />
        <p className="pv-c"><${K.Ic} name="spark" size=${16} className="pv-accent" /> ${t('AI hint: allow about 2 hours for an inspection.', 'نکته هوش مصنوعی: حدود ۲ ساعت برای بازدید وقت بگذارید.')}</p>
      <//>
      <${K.Field} key=${st} multiline label=${t('Note to the shop (optional)', 'یادداشت برای تعمیرگاه (اختیاری)')} placeholder=${t('e.g. I can leave the car for the day', 'مثلاً می‌توانم خودرو را تا عصر بگذارم')}
        defaultValue=${st === 'safety' ? t('The brake pedal feels soft since yesterday.', 'از دیروز پدال ترمز نرم شده است.') : ''} />
      ${st === 'safety' ? html`<${K.SafetyBanner} title=${t('Safety words in your note', 'واژه‌های ایمنی در یادداشت شما')} text=${t('If the brakes feel wrong, stop driving and get urgent help. You can still send this request.', 'اگر ترمز غیرعادی است، رانندگی را متوقف کنید و کمک فوری بگیرید. همچنان می‌توانید این درخواست را بفرستید.')} />` : null}
      <${K.Sec} title=${t('What to share', 'چه چیزی به اشتراک گذاشته شود')}>
        <${K.Card} tight>
          <${K.Consent} locked on=${true} title=${t('Vehicle details', 'مشخصات خودرو')} text=${t('Required so the shop can prepare: model, series, year, mileage.', 'برای آماده شدن تعمیرگاه لازم است: مدل، نسل، سال، کارکرد.')} />
          <hr className="pv-hr" />
          <${K.Consent} on=${true} onChange=${hist[1]} title=${t('Service history for this issue', 'سابقه سرویس مرتبط')} text=${t('2 relevant records.', '۲ سابقه مرتبط.')} link=${t('Preview', 'پیش‌نمایش')} preview=${historyPreview}>
            ${hist[0] ? null : html`<p className="pv-c" style=${{ marginBlockStart: 'var(--space-2)' }}><${K.Ic} name="info" size=${16} /> ${t("The shop won't see past repairs. They'll know you chose not to share.", 'تعمیرگاه تعمیرات قبلی را نمی‌بیند. می‌داند که شما اشتراک را انتخاب نکردید.')}</p>`}
          <//>
          <hr className="pv-hr" />
          <${K.Consent} on=${true} title=${t('Photos and video', 'عکس و ویدیو')} text=${t('The 10-second video you recorded.', 'ویدیوی ۱۰ ثانیه‌ای که ضبط کردید.')} />
        <//>
        <div><button type="button" className="pv-link" onClick=${function () { a.nav.go('C-APP-03', { preview: true, state: nt ? 'notriage' : 'default' }); }}><${K.Ic} name="eye" size=${20} />${t('See what the shop will receive', 'ببینید تعمیرگاه چه دریافت می‌کند')}</button></div>
      <//>
    <//>`;
  });

  /* ---------- C-HELP-08 ---------- */
  K.reg('C-HELP-08', {
    name: 'Request Confirmation', area: 'Help Me', kind: 'full', tab: 'help', parent: 'C-HELP-07', story: '7',
    purpose: 'Confirm the request was sent and say what happens next.'
  }, function (props) {
    var a = props.a, D = PV.D();
    return html`<${K.Screen} header=${html`<${K.CloseBar} title="" onClose=${function () { a.nav.tab('discover'); }} />`} stack bottom=${html`<${React.Fragment}>
        <${K.Btn} variant="primary" block onClick=${function () { a.nav.reset('C-APP-02', { state: 'requested' }); }}>${t('Track request', 'پیگیری درخواست')}<//>
        <${K.Btn} block onClick=${function () { a.nav.tab('discover'); }}>${t('Back to home', 'بازگشت به خانه')}<//>
      <//>`}>
      <${K.Empty} icon="check" tone="success" title=${t('Request sent to Reza Auto Suspension', 'درخواست برای جلوبندی‌سازی رضا ارسال شد')} text=${t('Reference #1042', 'شماره پیگیری ۱۰۴۲')} />
      <${K.Card} tone="soft"><p className="pv-l">${t('What happens next', 'مرحله بعد')}</p><p className="pv-c">${t("They usually respond within about 2 hours. We'll notify you.", 'معمولاً ظرف حدود ۲ ساعت پاسخ می‌دهند. خبرتان می‌کنیم.')}</p><//>
      <${K.Card} tight><dl className="pv-kv">
        <dt>${t('Vehicle', 'خودرو')}</dt><dd><bdi>${D.v.silver.nick}</bdi> · BMW 320i</dd>
        <dt>${t('Issue', 'مشکل')}</dt><dd>${t('Clunk from front right over bumps', 'تق‌تق از جلوی راست روی دست‌انداز')}</dd>
        <dt>${t('Times', 'زمان‌ها')}</dt><dd>${t('Thu 15 Oct 09:00 · Sat 17 Oct 10:00', 'پنجشنبه ۲۳ مهر ۰۹:۰۰ · شنبه ۲۵ مهر ۱۰:۰۰')}</dd>
      </dl><//>
      <div className="pv-center pv-col"><button type="button" className="pv-link is-danger" onClick=${function () {
        a.ui.dialog({ title: t('Cancel this request?', 'این درخواست لغو شود؟'), text: t('Reza Auto Suspension will be told you no longer need the appointment.', 'به جلوبندی‌سازی رضا اطلاع داده می‌شود که دیگر نوبت لازم ندارید.'), confirm: t('Cancel request', 'لغو درخواست'), cancel: t('Keep it', 'نگه دار'), danger: true, onConfirm: function () { a.nav.tab('discover'); a.ui.toast(t('Request cancelled', 'درخواست لغو شد')); } });
      }}>${t('Cancel request', 'لغو درخواست')}</button></div>
    <//>`;
  });
})();
