/* Sample data from Story 10 (Sara), Story 11 (Reza Auto Suspension) and Story 12 (Mina Parts).
   Today in the preview is Thursday 8 October 2026 = پنجشنبه ۱۶ مهر ۱۴۰۵. */
(function () {
  PV.D = function () {
    var t = PV.t, n = PV.n;
    var km = function (x) { return n(x) + ' ' + t('km', 'کیلومتر'); };
    var toman = function (x) { return n(x) + t(' T', ' تومان'); };

    var me = { name: t('Sara M.', 'سارا م.'), full: t('Sara Mohammadi', 'سارا محمدی'), phone: '+98 912 345 4567', email: 'sara.m@example.com' };

    var v = {
      silver: {
        id: 'silver', primary: true, nick: t('Silver', 'نقره‌ای'), short: 'BMW 320i',
        model: t('BMW 3 Series 320i · E90 · 2012', 'BMW سری ۳ ‏320i · E90 · ۲۰۱۲'),
        engine: t('2.0 petrol · Automatic', 'بنزینی ۲٫۰ · اتوماتیک'),
        mileage: km(151200), mileageN: 151200, updated: t('updated 3 days ago', '۳ روز پیش به‌روز شد'),
        vinMasked: '••••••••4521', vin: 'WBAPH5C55BA274521', completeness: 95,
        chips: [['neutral', 'clock', t('Open issue · Soon', 'مشکل باز · به‌زودی')], ['signal', 'calendar', t('Service due', 'سرویس نزدیک است')]],
        lastService: t('Last service: 12 Farvardin 1405', 'آخرین سرویس: ۱۲ فروردین ۱۴۰۵')
      },
      corolla: {
        id: 'corolla', nick: t('Family', 'خانوادگی'), short: t('Toyota Corolla', 'تویوتا کرولا'),
        model: t('Toyota Corolla · 2019', 'تویوتا کرولا · ۲۰۱۹'), engine: t('1.8 petrol · CVT', 'بنزینی ۱٫۸ · CVT'),
        mileage: km(62400), mileageN: 62400, updated: t('updated 3 weeks ago', '۳ هفته پیش به‌روز شد'),
        vinMasked: '••••••••8810', completeness: 70,
        chips: [['neutral', 'doc', t('Insurance expires in 21 days', 'بیمه ۲۱ روز دیگر تمام می‌شود')]],
        lastService: t('Last service: 3 Tir 1405', 'آخرین سرویس: ۳ تیر ۱۴۰۵')
      }
    };

    var p = {
      reza: {
        id: 'reza', name: t('Reza Auto Suspension', 'جلوبندی‌سازی رضا'), verified: true,
        type: t('Independent garage · Suspension', 'تعمیرگاه مستقل · جلوبندی'),
        rating: 4.8, overall: 4.7, ratingFor: t('in suspension', 'در جلوبندی'), reviews: 126, dist: km(2.4), price: t('Mid-range price', 'قیمت متوسط'),
        respond: t('Usually responds in 2 h', 'معمولاً ظرف ۲ ساعت پاسخ می‌دهد'),
        badges: [['verified'], ['specialist', t('Suspension Specialist', 'متخصص جلوبندی')]],
        reason: t('19 suspension jobs on BMW 3 Series E90/F30', '۱۹ کار جلوبندی روی BMW سری ۳ E90/F30'),
        matchLong: t('Recommended because this shop has 19 completed suspension jobs on BMW 3 Series E90/F30, a 4.8 rating for suspension work, and an opening on Thursday morning.',
          'پیشنهاد شده چون این تعمیرگاه ۱۹ کار جلوبندی تکمیل‌شده روی BMW سری ۳ E90/F30 دارد، امتیاز ۴٫۸ در کار جلوبندی گرفته و پنجشنبه صبح وقت خالی دارد.'),
        reasons: [t('Evidence: 19 completed jobs, 11 verified reviews on E90/F30 suspension', 'شواهد: ۱۹ کار تکمیل‌شده و ۱۱ نظر تأییدشده روی جلوبندی E90/F30'),
          t('Rating: 4.8 for suspension work', 'امتیاز: ۴٫۸ در کار جلوبندی'), t('Distance: 2.4 km from you', 'فاصله: ۲٫۴ کیلومتر از شما'),
          t('Availability: Thursday 09:00', 'وقت خالی: پنجشنبه ۰۹:۰۰'), t('Your preference: verified businesses', 'ترجیح شما: کسب‌وکارهای تأییدشده')],
        next: t('Thu 15 Oct, 09:00', 'پنجشنبه ۲۳ مهر، ۰۹:۰۰'), saved: true
      },
      bimmer: {
        id: 'bimmer', name: t('Pars Bimmer Center', 'مرکز تخصصی بی‌ام‌و پارس'), verified: true,
        type: t('BMW specialist · All systems', 'متخصص BMW · همه سیستم‌ها'),
        rating: 4.6, ratingFor: t('in suspension', 'در جلوبندی'), reviews: 88, dist: km(5.8), price: t('Higher price', 'قیمت بالاتر'),
        badges: [['verified'], ['specialist', t('BMW Specialist', 'متخصص BMW')]],
        reason: t('BMW specialist with 11 suspension jobs on E90', 'متخصص BMW با ۱۱ کار جلوبندی روی E90'),
        matchLong: t('Recommended because this BMW specialist has 11 suspension jobs on E90 and strong reviews for diagnosis, though it is further away.',
          'پیشنهاد شده چون این متخصص BMW یازده کار جلوبندی روی E90 و نظرهای خوبی در عیب‌یابی دارد، هرچند دورتر است.'),
        reasons: [t('Evidence: 11 completed jobs on E90 suspension', 'شواهد: ۱۱ کار تکمیل‌شده روی جلوبندی E90'), t('Rating: 4.6 for suspension work', 'امتیاز: ۴٫۶ در جلوبندی'), t('Distance: 5.8 km', 'فاصله: ۵٫۸ کیلومتر')],
        next: t('Sat 17 Oct, 10:00', 'شنبه ۲۵ مهر، ۱۰:۰۰')
      },
      karimi: {
        id: 'karimi', name: t('Karimi Auto Service', 'تعمیرگاه کریمی'), verified: true,
        type: t('General repair', 'تعمیرات عمومی'),
        rating: 4.9, ratingFor: t('overall', 'کلی'), reviews: 312, dist: km(1.1), price: t('Budget price', 'قیمت اقتصادی'),
        badges: [['verified']],
        reason: t('Top rated nearby, but only 3 BMW suspension jobs', 'بالاترین امتیاز در نزدیکی، اما فقط ۳ کار جلوبندی BMW'),
        matchLong: t('Shown lower because, although it is rated 4.9 overall, it has only 3 suspension jobs on BMWs.',
          'پایین‌تر نمایش داده شده چون با وجود امتیاز کلی ۴٫۹، فقط ۳ کار جلوبندی روی BMW دارد.'),
        reasons: [t('Evidence: 3 BMW suspension jobs', 'شواهد: ۳ کار جلوبندی BMW'), t('Rating: 4.9 overall', 'امتیاز: ۴٫۹ کلی'), t('Distance: 1.1 km', 'فاصله: ۱٫۱ کیلومتر')],
        next: t('Today, 16:00', 'امروز، ۱۶:۰۰')
      },
      ali: {
        id: 'ali', name: t('Ali Mobile Mechanic', 'مکانیک سیار علی'), verified: false,
        type: t('Mobile mechanic · Comes to you', 'مکانیک سیار · به محل شما می‌آید'),
        rating: 4.5, ratingFor: t('overall', 'کلی'), reviews: 41, dist: t('Covers your area', 'منطقه شما را پوشش می‌دهد'), price: t('Budget price', 'قیمت اقتصادی'),
        badges: [['pending']],
        reason: t('Inspections at your home or work', 'بازدید در خانه یا محل کار شما'), matchLong: '', reasons: [t('Comes to you within 10 km', 'تا ۱۰ کیلومتری به محل شما می‌آید')],
        next: t('Tomorrow, 08:00', 'فردا، ۰۸:۰۰')
      },
      tyre: {
        id: 'tyre', name: t('Tehran Tyre Pro', 'تایر پرو تهران'), verified: true, type: t('Tyres · Alignment', 'تایر · تنظیم فرمان'),
        rating: 4.7, ratingFor: t('in tyres', 'در تایر'), reviews: 203, dist: km(3.2), price: t('Mid-range price', 'قیمت متوسط'),
        badges: [['verified'], ['specialist', t('Tyre Specialist', 'متخصص تایر')]], reason: t('Winter tyre fitting this month', 'نصب لاستیک زمستانی در این ماه'),
        matchLong: '', reasons: [], next: t('Sat 17 Oct, 12:00', 'شنبه ۲۵ مهر، ۱۲:۰۰')
      },
      mina: {
        id: 'mina', vendor: true, name: t('Mina Parts', 'قطعات مینا'), verified: true, type: t('OEM and aftermarket parts · Some used', 'قطعات اصلی و غیراصلی · برخی دست‌دوم'),
        rating: 4.7, ratingFor: t('part accuracy', 'دقت قطعه'), reviews: 64, dist: km(3.6), price: t('Pickup or delivery', 'تحویل حضوری یا ارسال'),
        badges: [['verified']], reason: t('Has the Lemförder control arm for E90 in stock', 'بازوی کنترل Lemförder برای E90 را موجود دارد'), matchLong: '', reasons: [],
        next: t('Open until 19:00', 'باز تا ۱۹:۰۰')
      }
    };

    var part = {
      name: t('Front lower control arm, right', 'طبق پایین جلو، راست'), brand: 'Lemförder', number: '31 12 6 855 742',
      fits: t('Fits BMW 3 Series E90/E91/E92/E93, 2005–2012', 'مناسب BMW سری ۳ E90/E91/E92/E93، ۲۰۰۵ تا ۲۰۱۲'),
      price: toman(9800000), condition: t('New · Aftermarket (OE quality)', 'نو · غیراصلی (کیفیت اصلی)')
    };

    var symptom = t('A knocking sound from the front right when I go over bumps. Started two weeks ago, getting louder.',
      'صدای تق‌تق از جلوی سمت راست وقتی از سرعت‌گیر رد می‌شوم. از دو هفته پیش شروع شده و بلندتر می‌شود.');

    return { me: me, v: v, p: p, part: part, symptom: symptom, km: km, toman: toman };
  };
})();
