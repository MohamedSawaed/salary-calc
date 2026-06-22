/* ============================================================
   ShiftPay — app logic
   Vanilla JS. State persisted to localStorage. Uses SalaryCalc.
   ============================================================ */
(function () {
  'use strict';

  var STORAGE_KEY = 'shiftpay.v1';
  var $ = function (id) { return document.getElementById(id); };

  /* ---------------- state ---------------- */
  var state = {
    profile: { name: '', rate: 0, currency: '₪' },
    prefs: { theme: 'system', lang: null, view: 'list' }, // lang null -> show language picker first; view: 'list' | 'calendar'
    shifts: {} // 'yyyy-mm-dd' -> { start, end, type, note }
  };

  /* ---------------- i18n ---------------- */
  function t(key, vars) { return I18N.t(state.prefs.lang || 'en', key, vars); }

  var view = { y: 0, m: 0 };          // currently displayed month
  var editKey = null;                 // date being edited in the sheet
  var editType = 'morning';           // selected shift type in the sheet (concrete; no 'auto')
  var typeAuto = true;                 // type follows the start time until the user picks one
  var editMode = 'work';              // 'work' | 'vacation'
  var editRate = 0;                   // wage applied to the day being edited
  var deferredInstall = null;         // PWA install prompt

  /* ---------------- persistence ---------------- */
  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var data = JSON.parse(raw);
        if (data.profile) state.profile = Object.assign(state.profile, data.profile);
        if (data.prefs) state.prefs = Object.assign(state.prefs, data.prefs);
        if (data.shifts) state.shifts = data.shifts;
      }
    } catch (e) { /* corrupt storage -> start fresh */ }
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
    if (typeof cloudPush === 'function') cloudPush(); // sync to cloud if signed in (debounced, hoisted)
  }
  // Older shifts had no rate of their own. Freeze them at the current wage once,
  // so a later wage change won't retroactively rewrite past months.
  function migrate() {
    if (!Array.isArray(state.profile.extras)) state.profile.extras = [];
    var changed = false;
    Object.keys(state.shifts).forEach(function (k) {
      var s = state.shifts[k];
      if (s && s.rate == null) { s.rate = state.profile.rate; changed = true; }
    });
    if (changed) save();
  }

  /* ---------------- date helpers ---------------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function keyOf(y, m, d) { return y + '-' + pad(m + 1) + '-' + pad(d); }
  function todayKey() { var t = new Date(); return keyOf(t.getFullYear(), t.getMonth(), t.getDate()); }
  function parseKey(k) { var p = k.split('-'); return { y: +p[0], m: +p[1] - 1, d: +p[2] }; }

  var WEEKDAYS_EN = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  function localeCode() { return state.prefs.lang || 'en'; } // BCP-47 short codes work for Intl
  function localeMonthYear(y, m) {
    try { return new Intl.DateTimeFormat(localeCode(), { month: 'long', year: 'numeric' }).format(new Date(y, m, 1)); }
    catch (e) { return new Date(y, m, 1).toDateString(); }
  }
  function localeWeekdayShort(dow) { // 2023-01-01 is a Sunday
    try { return new Intl.DateTimeFormat(localeCode(), { weekday: 'short' }).format(new Date(2023, 0, 1 + dow)); }
    catch (e) { return WEEKDAYS_EN[dow]; }
  }
  function prettyDate(k) {
    var p = parseKey(k);
    try { return new Intl.DateTimeFormat(localeCode(), { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(p.y, p.m, p.d)); }
    catch (e) { return k; }
  }

  /* ---------------- money / hours ---------------- */
  function fmtMoney(n, compact) {
    var cur = state.profile.currency || '';
    if (compact) return cur + Math.round(n).toLocaleString('en-US');
    return cur + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtHours(h) {
    var uh = t('u_h'), um = t('u_m');
    if (h === 0) return '0' + uh;
    var whole = Math.floor(h);
    var mins = Math.round((h - whole) * 60);
    if (mins === 0) return whole + uh;
    if (whole === 0) return mins + um;
    return whole + uh + ' ' + mins + um;
  }

  /* ---------------- theme ---------------- */
  var mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function applyTheme() {
    var pref = state.prefs.theme;
    var dark = pref === 'dark' || (pref === 'system' && mql && mql.matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0b0b0e' : '#f6f6f4');
  }
  if (mql && mql.addEventListener) mql.addEventListener('change', function () { if (state.prefs.theme === 'system') applyTheme(); });

  /* ---------------- toast ---------------- */
  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg; el.hidden = false;
    requestAnimationFrame(function () { el.classList.add('show'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.hidden = true; }, 220);
    }, 1900);
  }

  /* ---------------- apply language ---------------- */
  function langMeta(code) {
    var m = null;
    I18N.LANGS.forEach(function (L) { if (L.code === code) m = L; });
    return m;
  }
  function applyLang() {
    var lang = state.prefs.lang || 'en';
    var meta = langMeta(lang);
    var dir = meta ? meta.dir : 'ltr';
    var html = document.documentElement;
    html.setAttribute('lang', lang);
    html.setAttribute('dir', dir);
    document.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = t(el.getAttribute('data-i18n')); });
    document.querySelectorAll('[data-i18n-ph]').forEach(function (el) { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); });
    document.querySelectorAll('[data-i18n-html]').forEach(function (el) { el.innerHTML = t(el.getAttribute('data-i18n-html')); });
    renderLangPickers();
    if (typeof updateAccountUI === 'function') updateAccountUI();
    if (!$('app').hidden) { updateGreeting(); renderWeekdays(); renderView(); }
  }

  function updateGreeting() {
    $('greet-hi').textContent = t('greet', { name: state.profile.name || '' });
  }

  function buildLangButtons(container, onPick) {
    if (!container) return;
    container.innerHTML = '';
    I18N.LANGS.forEach(function (L) {
      var b = document.createElement('button');
      b.className = 'lang-btn' + (state.prefs.lang === L.code ? ' active' : '');
      b.setAttribute('data-lang', L.code);
      b.setAttribute('aria-pressed', state.prefs.lang === L.code ? 'true' : 'false');
      b.innerHTML = '<span class="lang-name">' + L.native + '</span><span class="lang-code">' + L.code.toUpperCase() + '</span>';
      b.addEventListener('click', function () { onPick(L.code); });
      container.appendChild(b);
    });
  }
  function renderLangPickers() {
    buildLangButtons($('lang-grid'), pickLangFirstRun);
    buildLangButtons($('lang-seg'), pickLangSettings);
  }
  function pickLangFirstRun(code) {
    state.prefs.lang = code; save(); applyLang();
    routeInitial();
  }
  function pickLangSettings(code) {
    state.prefs.lang = code; save(); applyLang();
  }
  function hideAuthScreen() { var a = $('auth-screen'); if (a) a.hidden = true; }

  function showLangScreen() {
    $('onboarding').hidden = true; $('app').hidden = true; hideAuthScreen();
    $('lang-screen').hidden = false;
    renderLangPickers();
  }

  /* ---------------- screen routing ---------------- */
  function showApp() {
    $('lang-screen').hidden = true;
    $('onboarding').hidden = true;
    hideAuthScreen();
    $('app').hidden = false;
    updateGreeting();
    var now = new Date();
    view.y = now.getFullYear(); view.m = now.getMonth();
    renderWeekdays();
    renderView();
  }
  function showOnboarding() {
    $('lang-screen').hidden = true;
    $('app').hidden = true;
    hideAuthScreen();
    $('onboarding').hidden = false;
  }

  /* ---------------- calendar ---------------- */
  function renderWeekdays() {
    var wd = $('weekdays');
    wd.innerHTML = '';
    for (var i = 0; i < 7; i++) {
      var s = document.createElement('span');
      s.textContent = localeWeekdayShort(i);
      wd.appendChild(s);
    }
  }

  function isFridayKey(key) {
    var p = parseKey(key);
    return new Date(p.y, p.m, p.d).getDay() === 5;
  }

  /** Paid minutes worked Sun..Thu of the week that ends on this Friday key. */
  function prevWeekPaidMin(key, shiftsMap) {
    shiftsMap = shiftsMap || state.shifts;
    var p = parseKey(key);
    var sum = 0;
    for (var off = 5; off >= 1; off--) {       // Friday-5=Sunday .. Friday-1=Thursday
      var dd = new Date(p.y, p.m, p.d - off);   // Date rolls over month/year boundaries
      var s = shiftsMap[keyOf(dd.getFullYear(), dd.getMonth(), dd.getDate())];
      if (s && s.type !== 'vacation') {
        sum += SalaryCalc.paidMinutesForWorkedDay(s.start, s.end, s.type, SalaryCalc.BREAK_MIN);
      }
    }
    return sum;
  }

  /** The wage a shift is paid at: its own saved rate, else a fallback (profile/user wage). */
  function rateOf(shift, fallbackRate) {
    if (shift && shift.rate != null) return shift.rate;
    return fallbackRate != null ? fallbackRate : state.profile.rate;
  }

  /** Count consecutive sick days immediately BEFORE `key` (so this day's position = result + 1). */
  function sickStreakBefore(key, shiftsMap) {
    shiftsMap = shiftsMap || state.shifts;
    var p = parseKey(key), n = 0;
    for (var back = 1; back < 370; back++) {
      var dd = new Date(p.y, p.m, p.d - back);
      var s = shiftsMap[keyOf(dd.getFullYear(), dd.getMonth(), dd.getDate())];
      if (s && s.type === 'sick') n++; else break;
    }
    return n;
  }

  /** Week-aware pay for one day. `override` supplies unsaved editor inputs.
      `shiftsMap`/`fallbackRate` let it compute over another user's data (admin view). */
  function dayResult(key, override, shiftsMap, fallbackRate) {
    shiftsMap = shiftsMap || state.shifts;
    var shift = override !== undefined ? override : shiftsMap[key];
    if (!shift) return null;
    var rate = rateOf(shift, fallbackRate);
    if (shift.type === 'vacation') return SalaryCalc.vacationResult(rate);
    if (shift.type === 'sick') return SalaryCalc.sickResult(rate, sickStreakBefore(key, shiftsMap) + 1);
    var fri = isFridayKey(key);
    return SalaryCalc.computeDayPay({
      shift: shift, isFriday: fri, rate: rate,
      prevPaidMin: fri ? prevWeekPaidMin(key, shiftsMap) : 0
    });
  }

  /** Month totals (pay/hours/shift-count/worked-days) for an arbitrary shifts map. */
  function totalsFor(shiftsMap, y, m, fallbackRate) {
    var pay = 0, hours = 0, count = 0, workedDays = 0;
    var dim = new Date(y, m + 1, 0).getDate();
    for (var d = 1; d <= dim; d++) {
      var k = keyOf(y, m, d);
      var s = shiftsMap[k]; if (!s) continue;
      var res = dayResult(k, undefined, shiftsMap, fallbackRate);
      if (res) { pay += res.pay; hours += res.totalHours; count++; if (s.type !== 'vacation' && s.type !== 'sick') workedDays++; }
    }
    return { pay: pay, hours: hours, count: count, workedDays: workedDays };
  }

  /* ---------------- extra payments (travel, allowances) ---------------- */
  function extrasAmount(extras, workedDays, hasEntries) {
    if (!extras || !extras.length) return 0;
    var sum = 0;
    extras.forEach(function (e) {
      var amt = Number(e.amount) || 0;
      if (e.per === 'month') { if (hasEntries) sum += amt; }
      else sum += amt * workedDays; // default 'day' (per worked day)
    });
    return sum;
  }
  function setMonthSummary(monthPay, monthHours, monthShifts, workedDays) {
    var ex = extrasAmount(state.profile.extras, workedDays, workedDays > 0);
    $('month-total').textContent = fmtMoney(monthPay + ex);
    $('month-hours').textContent = fmtHours(monthHours).replace(' ', '');
    $('month-shifts').textContent = monthShifts;
    return ex;
  }
  function renderExtras() {
    var box = $('extras-list'); if (!box) return;
    box.innerHTML = '';
    (state.profile.extras || []).forEach(function (e, i) {
      var row = document.createElement('div');
      row.className = 'extra-row';
      row.innerHTML =
        '<input class="ex-name" data-i="' + i + '" type="text" maxlength="30" placeholder="' + esc(t('ex_name_ph')) + '" value="' + esc(e.name || '') + '" />' +
        '<input class="ex-amt" data-i="' + i + '" type="number" inputmode="decimal" min="0" step="0.01" value="' + (e.amount != null ? e.amount : '') + '" />' +
        '<select class="ex-per" data-i="' + i + '" aria-label="per">' +
          '<option value="day"' + (e.per !== 'month' ? ' selected' : '') + '>' + t('ex_per_day') + '</option>' +
          '<option value="month"' + (e.per === 'month' ? ' selected' : '') + '>' + t('ex_per_month') + '</option>' +
        '</select>' +
        '<button class="ex-del" data-i="' + i + '" aria-label="remove">✕</button>';
      box.appendChild(row);
    });
  }
  function addExtra() {
    if (!Array.isArray(state.profile.extras)) state.profile.extras = [];
    state.profile.extras.push({ name: '', amount: 0, per: 'day' });
    save(); renderExtras();
  }

  function renderCalendar() {
    $('month-label').textContent = localeMonthYear(view.y, view.m);

    var cal = $('calendar');
    cal.innerHTML = '';

    var firstDow = new Date(view.y, view.m, 1).getDay();
    var daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
    var tKey = todayKey();

    // leading blanks
    for (var b = 0; b < firstDow; b++) {
      var blank = document.createElement('div');
      blank.className = 'day empty';
      cal.appendChild(blank);
    }

    var monthPay = 0, monthHours = 0, monthShifts = 0, workedDays = 0;

    for (var d = 1; d <= daysInMonth; d++) {
      var k = keyOf(view.y, view.m, d);
      var cell = document.createElement('button');
      cell.className = 'day';
      cell.setAttribute('data-key', k);

      var num = document.createElement('span');
      num.className = 'day-num';
      num.textContent = d;
      cell.appendChild(num);

      if (k === tKey) cell.classList.add('today');

      var shift = state.shifts[k];
      if (shift) {
        var res = dayResult(k);
        var meta = SalaryCalc.SHIFT_META[res.type] || SalaryCalc.SHIFT_META.morning;

        cell.classList.add('has-shift');
        cell.style.borderColor = 'color-mix(in srgb, ' + meta.accent + ' 55%, transparent)';

        var tag = document.createElement('span');
        tag.className = 'type-tag';
        tag.style.background = meta.accent;
        cell.appendChild(tag);

        var bar = document.createElement('div');
        bar.className = 'day-bar';
        bar.style.background = meta.accent;
        cell.appendChild(bar);

        var pay = document.createElement('span');
        pay.className = 'day-pay';
        pay.textContent = fmtMoney(res.pay, true);
        cell.appendChild(pay);

        monthPay += res.pay;
        monthHours += res.totalHours;
        monthShifts++;
        if (shift.type !== 'vacation' && shift.type !== 'sick') workedDays++;
      }

      cell.addEventListener('click', function () { openSheet(this.getAttribute('data-key')); });
      cal.appendChild(cell);
    }

    setMonthSummary(monthPay, monthHours, monthShifts, workedDays);
    $('empty-hint').hidden = monthShifts !== 0;
  }

  /* ---------------- list / table view (timesheet style) ---------------- */
  function renderTable() {
    var tbl = $('month-table');
    tbl.innerHTML = '';

    var head = document.createElement('div');
    head.className = 'mt-row mt-head';
    head.innerHTML =
      '<span class="mt-date">' + t('col_date') + '</span>' +
      '<span class="mt-cell">' + t('col_in') + '</span>' +
      '<span class="mt-cell">' + t('col_out') + '</span>' +
      '<span class="mt-pay">' + t('col_pay') + '</span>';
    tbl.appendChild(head);

    var daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
    var tKey = todayKey();
    var monthPay = 0, monthHours = 0, monthShifts = 0, workedDays = 0;

    for (var d = 1; d <= daysInMonth; d++) {
      var k = keyOf(view.y, view.m, d);
      var dow = new Date(view.y, view.m, d).getDay();
      var row = document.createElement('button');
      row.className = 'mt-row';
      row.setAttribute('data-key', k);
      if (k === tKey) row.classList.add('mt-today');
      if (dow === 5) row.classList.add('mt-fri');
      if (dow === 6) row.classList.add('mt-sat');

      var shift = state.shifts[k];
      var inHtml = '<span class="muted">—</span>';
      var outHtml = '<span class="muted">—</span>';
      var payHtml = '<span class="muted">—</span>';
      if (shift) {
        var res = dayResult(k);
        var meta = SalaryCalc.SHIFT_META[res.type] || SalaryCalc.SHIFT_META.morning;
        if (shift.type === 'vacation') {
          inHtml = '<span class="vac-label">' + t('leg_vacation') + '</span>';
        } else if (shift.type === 'sick') {
          inHtml = '<span class="sick-label">' + t('leg_sick') + '</span>';
        } else {
          inHtml = '<i class="t-pill in">' + shift.start + '</i>';
          outHtml = '<i class="t-pill out">' + shift.end + '</i>';
        }
        payHtml = '<b class="pay-num">' + fmtMoney(res.pay, true) + '</b>';
        monthPay += res.pay; monthHours += res.totalHours; monthShifts++;
        if (shift.type !== 'vacation' && shift.type !== 'sick') workedDays++;
      }
      row.innerHTML =
        '<span class="mt-date"><b>' + d + '</b><small>' + localeWeekdayShort(dow) + '</small></span>' +
        '<span class="mt-cell">' + inHtml + '</span>' +
        '<span class="mt-cell">' + outHtml + '</span>' +
        '<span class="mt-pay">' + payHtml + '</span>';
      row.addEventListener('click', function () { openSheet(this.getAttribute('data-key')); });
      tbl.appendChild(row);
    }

    // extra payments (travel, etc.)
    var ex = 0;
    (state.profile.extras || []).forEach(function (e) {
      var amt = (e.per === 'month') ? (workedDays > 0 ? (Number(e.amount) || 0) : 0) : (Number(e.amount) || 0) * workedDays;
      if (amt <= 0) return;
      ex += amt;
      var er = document.createElement('div');
      er.className = 'mt-row mt-extra';
      er.innerHTML = '<span class="mt-exname">' + esc(e.name || t('ex_label')) + '</span>' +
        '<span class="mt-pay"><b>' + fmtMoney(amt, true) + '</b></span>';
      tbl.appendChild(er);
    });

    var tot = document.createElement('div');
    tot.className = 'mt-row mt-total';
    tot.innerHTML =
      '<span class="mt-date">' + t('tbl_total') + '</span>' +
      '<span class="mt-cell"></span><span class="mt-cell"></span>' +
      '<span class="mt-pay"><b>' + fmtMoney(monthPay + ex) + '</b></span>';
    tbl.appendChild(tot);

    setMonthSummary(monthPay, monthHours, monthShifts, workedDays);
    $('empty-hint').hidden = true;
  }

  // dispatcher: render whichever view is selected, keep the toggle in sync
  function renderView() {
    $('month-label').textContent = localeMonthYear(view.y, view.m);
    var list = state.prefs.view === 'list';
    if ($('calendar-view')) $('calendar-view').hidden = list;
    if ($('table-view')) $('table-view').hidden = !list;
    document.querySelectorAll('#view-seg .seg-btn').forEach(function (b) {
      var on = b.getAttribute('data-view') === (list ? 'list' : 'calendar');
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (list) renderTable(); else renderCalendar();
  }

  /* ---------------- shift editor sheet ---------------- */
  function syncTypeSeg() {
    document.querySelectorAll('#type-seg .seg-btn').forEach(function (b) {
      var on = b.getAttribute('data-type') === editType;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  function setTypeSeg(type, skip) {
    editType = type;
    syncTypeSeg();
    if (!skip) renderPreview();
  }

  function setMode(mode, skip) {
    editMode = mode;
    document.querySelectorAll('#mode-seg .seg-btn').forEach(function (b) {
      var on = b.getAttribute('data-mode') === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    $('work-fields').hidden = (mode !== 'work');
    $('vacation-note').hidden = (mode !== 'vacation');
    $('sick-note').hidden = (mode !== 'sick');
    if (!skip) renderPreview();
  }

  // Friday is paid by the weekly 42h rule, so the shift-type picker is irrelevant.
  function applyFridayUi(key) {
    var fri = isFridayKey(key) && editMode === 'work';
    $('friday-note').hidden = !fri;
    var seg = $('type-seg');
    seg.classList.toggle('seg-disabled', fri);
    seg.querySelectorAll('.seg-btn').forEach(function (b) { b.disabled = fri; });
  }

  function openSheet(key) {
    if (!state.profile.rate) { toast(t('t_need_wage')); openSettings(); return; }
    editKey = key;
    var existing = state.shifts[key];
    // Editing an existing day keeps its saved wage; a new day uses the current wage.
    editRate = (existing && existing.rate != null) ? existing.rate : state.profile.rate;
    $('sheet-date').textContent = prettyDate(key);

    var exMode = existing ? (existing.type === 'vacation' ? 'vacation' : (existing.type === 'sick' ? 'sick' : 'work')) : 'work';
    setMode(exMode, true);

    if (existing && exMode === 'work') {
      $('in-start').value = existing.start;
      $('in-end').value = existing.end;
      var et = existing.type;
      if (!et || et === 'auto') et = SalaryCalc.detectShiftType(existing.start); // legacy 'auto' -> concrete
      typeAuto = false;                 // keep the saved type when editing
      setTypeSeg(et, true);
    } else {
      $('in-start').value = '07:00';
      $('in-end').value = isFridayKey(key) ? '13:00' : '16:00';
      typeAuto = true;                  // new shift: type follows the start time
      setTypeSeg(SalaryCalc.detectShiftType('07:00'), true);
    }
    $('in-note').value = existing ? (existing.note || '') : '';
    $('btn-delete').hidden = !existing;
    $('btn-save').textContent = existing ? t('btn_update') : t('btn_save');

    applyFridayUi(key);
    renderPreview();
    openSheetEl('sheet', 'sheet-backdrop');
  }

  function currentInputs() {
    return { start: $('in-start').value || '00:00', end: $('in-end').value || '00:00' };
  }

  function isValidDuration(inp) {
    if (editMode === 'vacation' || editMode === 'sick') return true;
    return inp.start !== inp.end; // equal -> ambiguous (0 or 24h); ask user to fix
  }

  // A muted "<rate>/h" note, flagged when the day keeps a wage different from the current one.
  function rateNoteHtml() {
    var usesOld = editRate !== state.profile.rate;
    var label = usesOld ? t('rate_locked', { rate: fmtMoney(editRate) + '/' + t('u_h') })
                        : t('rate_at', { rate: fmtMoney(editRate) + '/' + t('u_h') });
    return '<div class="prev-row is-context' + (usesOld ? ' is-oldrate' : '') + '">' +
      '<span class="pr-label">' + label + '</span></div>';
  }

  function renderPreview() {
    var saveBtn = $('btn-save');
    var rate = editRate || 0;
    var bars = $('prev-bars');
    var rows = $('prev-rows');

    // ----- vacation -----
    if (editMode === 'vacation') {
      var vr = SalaryCalc.vacationResult(rate);
      $('prev-type').innerHTML = '<span class="dot dot-vac"></span>' + t('prev_vac');
      $('prev-pay').textContent = fmtMoney(vr.pay);
      bars.innerHTML = '<i class="seg-100" style="width:100%"></i>';
      rows.innerHTML =
        '<div class="prev-vac"><span class="vac-line">' +
        t('vac_line', { h: SalaryCalc.VACATION_HOURS, rate: fmtMoney(rate) }) +
        '</span></div>' + rateNoteHtml();
      saveBtn.disabled = false; saveBtn.style.opacity = '1';
      return;
    }

    // ----- sick (consecutive tiers) -----
    if (editMode === 'sick') {
      var pos = sickStreakBefore(editKey, state.shifts) + 1;
      var sr = SalaryCalc.sickResult(rate, pos);
      var pctTxt = Math.round(sr.sickPct * 100) + '%';
      $('prev-type').innerHTML = '<span class="dot dot-sick"></span>' + t('prev_sick');
      $('prev-pay').textContent = fmtMoney(sr.pay);
      bars.innerHTML = sr.sickPct > 0 ? '<i class="seg-100" style="width:' + (sr.sickPct * 100) + '%"></i>' : '';
      rows.innerHTML =
        '<div class="prev-vac"><span class="vac-line">' +
        t('sick_day_n', { n: pos, pct: pctTxt }) + '</span></div>' + rateNoteHtml();
      saveBtn.disabled = false; saveBtn.style.opacity = '1';
      return;
    }

    // ----- worked shift -----
    var inp = currentInputs();
    // while not manually chosen, the type follows the start time (16:00->evening, 19:00->night)
    if (typeAuto && !isFridayKey(editKey)) {
      var det = SalaryCalc.detectShiftType(inp.start);
      if (det !== editType) { editType = det; syncTypeSeg(); }
    }
    var sm = SalaryCalc.parseTimeToMinutes(inp.start);
    var em = SalaryCalc.parseTimeToMinutes(inp.end);
    $('crosses-midnight').hidden = !(em <= sm && inp.start !== inp.end);

    if (!isValidDuration(inp)) {
      $('prev-type').textContent = '—';
      $('prev-pay').textContent = fmtMoney(0);
      bars.innerHTML = '';
      rows.innerHTML = '<div class="prev-empty">' + t('prev_set') + '</div>';
      saveBtn.disabled = true; saveBtn.style.opacity = '.5';
      return;
    }
    saveBtn.disabled = false; saveBtn.style.opacity = '1';

    var fri = isFridayKey(editKey);
    var res = dayResult(editKey, { start: inp.start, end: inp.end, type: editType, rate: editRate });
    var meta = SalaryCalc.SHIFT_META[res.type] || SalaryCalc.SHIFT_META.morning;

    var typeTxt = t('leg_' + res.type);
    if (fri) typeTxt += t('sfx_weekly');
    $('prev-type').innerHTML = '<span class="dot" style="background:' + meta.accent + '"></span>' + typeTxt;
    $('prev-pay').textContent = fmtMoney(res.pay);

    // stacked bar (paid hours)
    var total = res.totalHours || 1;
    bars.innerHTML = '';
    [['100', 'seg-100'], ['125', 'seg-125'], ['150', 'seg-150']].forEach(function (s) {
      var h = res.hours[s[0]];
      if (h <= 0) return;
      var i = document.createElement('i');
      i.className = s[1];
      i.style.width = (h / total * 100) + '%';
      bars.appendChild(i);
    });

    rows.innerHTML = '';

    // Friday context row
    if (fri) {
      rows.appendChild(rowEl('is-context',
        '', t('r_week'), res.weeklyBeforeHours + ' ' + t('u_h') + ' / 42 ' + t('u_h'), ''));
    }

    // tier rows
    var defs = [
      { key: '100', mult: 1.0, color: '#38bdf8', label: fri ? t('r_100f') : t('r_100') },
      { key: '125', mult: 1.25, color: '#f59e0b', label: t('r_125') },
      { key: '150', mult: 1.5, color: '#ef4444', label: t('r_150') }
    ];
    defs.forEach(function (def) {
      var h = res.hours[def.key];
      if (h <= 0) return;
      rows.appendChild(rowEl('',
        '<span class="swatch" style="background:' + def.color + '"></span>',
        def.label, fmtHours(h), fmtMoney(rate * def.mult * h)));
    });

    // unpaid break row
    var breakMin = Math.round((res.grossHours - res.paidHours) * 60);
    if (breakMin > 0) {
      rows.appendChild(rowEl('is-break',
        '<span class="swatch" style="background:var(--text-faint)"></span>',
        t('r_break'), '− ' + breakMin + t('u_m'), fmtMoney(0)));
    }

    // total row
    var totalRow = rowEl('',
      '<span style="font-weight:700;color:var(--text)">' + t('r_total') + '</span>',
      '', fmtHours(res.totalHours),
      '<b style="color:var(--money)">' + fmtMoney(res.pay) + '</b>');
    totalRow.style.borderTop = '1px solid var(--border)';
    totalRow.style.paddingTop = '8px';
    rows.appendChild(totalRow);

    rows.insertAdjacentHTML('beforeend', rateNoteHtml());
  }

  // helper to build a preview row
  function rowEl(cls, swatchHtml, label, hoursTxt, moneyHtml) {
    var row = document.createElement('div');
    row.className = 'prev-row' + (cls ? ' ' + cls : '');
    row.innerHTML =
      (swatchHtml || '') +
      '<span class="pr-label">' + label + '</span>' +
      '<span class="pr-hours">' + hoursTxt + '</span>' +
      '<span class="pr-money">' + (moneyHtml || '') + '</span>';
    return row;
  }

  function saveShift() {
    if (!state.profile.rate) { toast(t('t_need_wage2')); return; }
    if (editMode === 'vacation') {
      state.shifts[editKey] = { type: 'vacation', note: $('in-note').value.trim(), rate: editRate };
    } else if (editMode === 'sick') {
      state.shifts[editKey] = { type: 'sick', note: $('in-note').value.trim(), rate: editRate };
    } else {
      var inp = currentInputs();
      if (!isValidDuration(inp)) { toast(t('t_same')); return; }
      state.shifts[editKey] = {
        start: inp.start, end: inp.end, type: editType, note: $('in-note').value.trim(), rate: editRate
      };
    }
    save();
    renderView();
    closeSheetEl('sheet', 'sheet-backdrop');
    toast(t('t_saved', { x: fmtMoney(dayResult(editKey).pay) }));
  }

  function deleteShift() {
    if (editKey && state.shifts[editKey]) {
      delete state.shifts[editKey];
      save();
      renderView();
    }
    closeSheetEl('sheet', 'sheet-backdrop');
    toast(t('t_removed'));
  }

  /* ---------------- generic sheet open/close ---------------- */
  function openSheetEl(sheetId, backdropId) {
    var bd = $(backdropId), sh = $(sheetId);
    bd.hidden = false; sh.hidden = false;
    requestAnimationFrame(function () { bd.classList.add('show'); sh.classList.add('show'); });
  }
  function closeSheetEl(sheetId, backdropId) {
    var bd = $(backdropId), sh = $(sheetId);
    bd.classList.remove('show'); sh.classList.remove('show');
    setTimeout(function () { bd.hidden = true; sh.hidden = true; }, 320);
  }

  /* ---------------- settings ---------------- */
  function openSettings() {
    $('set-name').value = state.profile.name;
    $('set-rate').value = state.profile.rate || '';
    $('set-currency').value = state.profile.currency;
    document.querySelectorAll('#theme-seg .seg-btn').forEach(function (b) {
      var on = b.getAttribute('data-theme') === state.prefs.theme;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    updateAccountUI();
    renderExtras();
    openSheetEl('settings', 'set-backdrop');
  }
  function saveSettings() {
    var name = $('set-name').value.trim();
    var rate = parseFloat($('set-rate').value);
    var cur = $('set-currency').value.trim() || '₪';
    if (!name) { toast(t('t_name')); return; }
    if (!(rate >= 0) || isNaN(rate)) { toast(t('t_wage')); return; }
    state.profile.name = name;
    state.profile.rate = rate;
    state.profile.currency = cur;
    save();
    updateGreeting();
    renderView();
    closeSheetEl('settings', 'set-backdrop');
    toast(t('t_settings'));
  }

  /* ---------------- export ---------------- */
  // Native app (Capacitor): write the file with Filesystem, then open the share sheet
  // so it can be saved to Files/Drive/email. Browser/PWA: fall back to a blob download.
  function saveFile(content, filename, mime) {
    var cap = window.Capacitor;
    if (cap && cap.isNativePlatform && cap.isNativePlatform() && typeof cap.nativePromise === 'function') {
      // Call the native Filesystem/Share plugins straight through the bridge — the
      // injected Capacitor global has nativePromise() but not registerPlugin().
      cap.nativePromise('Filesystem', 'writeFile',
        { path: filename, data: content, directory: 'CACHE', encoding: 'utf8' })
        .then(function (res) {
          toast(t('t_exported'));
          var uri = (res && (res.uri || res.path)) || filename;
          cap.nativePromise('Share', 'share',
            { title: filename, text: filename, url: uri, dialogTitle: filename })
            .catch(function () {}); // sharing cancelled / unavailable is not a failure
        })
        .catch(function () { toast(t('t_exportfail')); });
      return;
    }
    // web / PWA: prefer the Web Share API with a file (works in an iOS Safari home-screen
    // app and Android Chrome), else fall back to a blob download (desktop browsers).
    try {
      var file = null;
      try { file = new File([content], filename, { type: mime }); } catch (e) {}
      if (file && navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: filename })
          .then(function () { toast(t('t_exported')); })
          .catch(function () {}); // user dismissed the share sheet
        return;
      }
      var blob = new Blob([content], { type: mime });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      toast(t('t_exported'));
    } catch (e) { toast(t('t_exportfail')); }
  }

  function exportData() {
    saveFile(JSON.stringify(state, null, 2), 'shiftpay-data.json', 'application/json');
  }

  // Restore: load a previously backed-up JSON (from Drive / iCloud / Files) and replace data.
  function onRestoreFile(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try { data = JSON.parse(reader.result); } catch (err) { data = null; }
      if (!data || typeof data !== 'object' || (!data.profile && !data.shifts)) { toast(t('t_restore_bad')); return; }
      if (!confirm(t('restore_confirm'))) return;
      state.profile = Object.assign({ name: '', rate: 0, currency: '₪' }, data.profile || {});
      state.prefs = Object.assign(state.prefs, data.prefs || {});
      state.shifts = (data.shifts && typeof data.shifts === 'object') ? data.shifts : {};
      save(); migrate();
      applyTheme(); applyLang();
      closeSheetEl('settings', 'set-backdrop');
      if (state.profile.name && state.profile.rate) showApp();
      else if (!state.prefs.lang) showLangScreen();
      else showOnboarding();
      toast(t('t_restored'));
    };
    reader.readAsText(file);
  }

  /* ---------------- account / cloud sync (Firebase) ---------------- */
  var AUTH_KEY = 'shiftpay.auth';
  var auth = null;          // { uid, email, idToken, refreshToken, expiresAt }
  var authMode = 'in';      // 'in' | 'up'
  var pushTimer = null;
  var pulling = false;      // true while loading from cloud -> suppress echo writes

  function loadAuth() { try { var r = localStorage.getItem(AUTH_KEY); auth = r ? JSON.parse(r) : null; } catch (e) { auth = null; } }
  function saveAuth() { try { localStorage.setItem(AUTH_KEY, JSON.stringify(auth)); } catch (e) {} }
  function clearAuthState() { auth = null; try { localStorage.removeItem(AUTH_KEY); } catch (e) {} }

  function authErrMsg(code) {
    code = code || '';
    if (code.indexOf('EMAIL_EXISTS') >= 0) return t('err_email_exists');
    if (code.indexOf('INVALID_PASSWORD') >= 0 || code.indexOf('INVALID_LOGIN_CREDENTIALS') >= 0 || code.indexOf('EMAIL_NOT_FOUND') >= 0) return t('err_bad_creds');
    if (code.indexOf('WEAK_PASSWORD') >= 0) return t('err_weak_pass');
    if (code.indexOf('INVALID_EMAIL') >= 0 || code.indexOf('MISSING_EMAIL') >= 0) return t('err_bad_email');
    return t('err_generic');
  }

  function ensureToken() {
    if (!auth) return Promise.reject(new Error('not signed in'));
    if (Date.now() < (auth.expiresAt || 0) - 60000) return Promise.resolve(auth.idToken);
    return Cloud.refresh(auth.refreshToken).then(function (j) {
      auth.idToken = j.id_token; auth.refreshToken = j.refresh_token;
      auth.expiresAt = Date.now() + (parseInt(j.expires_in, 10) || 3600) * 1000;
      saveAuth(); return auth.idToken;
    });
  }
  function cloudPayload() {
    return {
      name: state.profile.name, hourlyWage: state.profile.rate, currency: state.profile.currency,
      email: auth ? auth.email : '', extras: state.profile.extras || [], shifts: state.shifts
    };
  }
  function setSync(key) { var el = $('acc-sync'); if (el) el.textContent = key ? t(key) : ''; }

  function cloudPushNow() {
    if (!auth) return Promise.resolve();
    setSync('sync_syncing');
    return ensureToken().then(function (tok) { return Cloud.save(auth.uid, tok, cloudPayload()); })
      .then(function () { setSync('sync_synced'); })
      .catch(function () { setSync('sync_offline'); });
  }
  function cloudPush() {
    if (pulling || !auth || !Cloud.configured()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(cloudPushNow, 700);
  }
  function applyCloudData(data) {
    if (!data) return false;
    state.profile = {
      name: data.name || '',
      rate: (data.hourlyWage != null ? data.hourlyWage : 0),
      currency: data.currency || '₪',
      extras: Array.isArray(data.extras) ? data.extras : []
    };
    state.shifts = (data.shifts && typeof data.shifts === 'object') ? data.shifts : {};
    var prev = pulling; pulling = true; // don't echo the just-pulled data back to the cloud
    save(); migrate();
    pulling = prev;
    return true;
  }
  function cloudPull() {
    if (!auth) return Promise.resolve(null);
    return ensureToken().then(function (tok) { return Cloud.load(auth.uid, tok); }).then(function (data) {
      applyCloudData(data); return data;
    });
  }

  function updateAccountUI() {
    var box = document.querySelector('.account-box');
    if (box) box.hidden = !Cloud.configured();
    if (auth) {
      $('acc-signedin').hidden = false; $('acc-signedout').hidden = true;
      $('acc-email').textContent = t('acc_as', { email: auth.email });
      setSync('sync_synced');
    } else {
      $('acc-signedin').hidden = true; $('acc-signedout').hidden = false;
    }
    if ($('btn-admin')) $('btn-admin').hidden = !isAdmin();
  }

  function setAuthMode(mode) {
    authMode = mode;
    var up = mode === 'up';
    $('auth-title').textContent = t(up ? 'auth_do_up' : 'auth_do_in');
    $('auth-submit').textContent = t(up ? 'auth_do_up' : 'auth_do_in');
    $('auth-toggle').textContent = t(up ? 'auth_switch_in' : 'auth_switch_up');
    $('auth-pass-hint').hidden = !up;
    $('auth-pass').setAttribute('autocomplete', up ? 'new-password' : 'current-password');
    $('auth-error').hidden = true;
  }
  function showAuthScreen() {
    $('lang-screen').hidden = true;
    $('onboarding').hidden = true;
    $('app').hidden = true;
    $('auth-email').value = ''; $('auth-pass').value = '';
    $('auth-error').hidden = true;
    setAuthMode('in');
    $('auth-screen').hidden = false;
    setTimeout(function () { try { $('auth-email').focus(); } catch (e) {} }, 200);
  }
  function openAuth() { showAuthScreen(); }
  function showAuthErr(msg) { var el = $('auth-error'); el.textContent = msg; el.hidden = false; }

  function submitAuth() {
    var email = $('auth-email').value.trim();
    var pw = $('auth-pass').value;
    $('auth-error').hidden = true;
    if (!email || email.indexOf('@') < 1) { showAuthErr(t('err_bad_email')); return; }
    if (!pw || pw.length < 6) { showAuthErr(t('err_weak_pass')); return; }
    var btn = $('auth-submit'); btn.disabled = true; btn.style.opacity = '.6';
    var fn = authMode === 'up' ? Cloud.signUp : Cloud.signIn;
    fn(email, pw).then(function (j) {
      auth = { uid: j.localId, email: email, idToken: j.idToken, refreshToken: j.refreshToken,
        expiresAt: Date.now() + (parseInt(j.expiresIn, 10) || 3600) * 1000 };
      saveAuth();
      return Cloud.load(auth.uid, auth.idToken);
    }).then(function (data) {
      if (!applyCloudData(data)) cloudPushNow(); // empty/new account -> seed with current local data
      $('auth-screen').hidden = true;
      closeSheetEl('settings', 'set-backdrop');
      applyTheme(); applyLang();
      routeInitial();
      updateAccountUI();
      toast(t('t_signedin'));
    }).catch(function (e) {
      showAuthErr(authErrMsg(e && e.code));
    }).then(function () { btn.disabled = false; btn.style.opacity = '1'; });
  }

  function doSignOut() {
    clearAuthState();
    state.profile = { name: '', rate: 0, currency: '₪' };
    state.shifts = {};
    save();
    closeSheetEl('settings', 'set-backdrop');
    updateAccountUI();
    showAuthScreen();
    toast(t('t_signedout'));
  }

  /* ---- admin dashboard (all users) ---- */
  var ADMIN_EMAIL = 'sawaedmohamed.20@gmail.com';
  function isAdmin() { return !!(auth && auth.email && auth.email.toLowerCase() === ADMIN_EMAIL.toLowerCase()); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmtNum(n) { return (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 }); }

  function openAdmin() {
    openSheetEl('admin-sheet', 'admin-backdrop');
    var list = $('admin-list');
    list.innerHTML = '<p class="admin-msg">' + t('admin_loading') + '</p>';
    $('admin-count').textContent = '';
    ensureToken().then(function (tok) { return Cloud.listUsers(tok); })
      .then(renderAdmin)
      .catch(function () { list.innerHTML = '<p class="admin-msg">' + t('admin_error') + '</p>'; });
  }
  function renderAdmin(users) {
    var list = $('admin-list');
    list.innerHTML = '';
    $('admin-count').textContent = users.length;
    if (!users.length) { list.innerHTML = '<p class="admin-msg">' + t('admin_none') + '</p>'; return; }
    var now = new Date(), y = now.getFullYear(), m = now.getMonth();
    users.sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); });
    users.forEach(function (u) {
      var cur = u.currency || '₪';
      var tot = totalsFor(u.shifts || {}, y, m, u.hourlyWage);
      var totalPay = tot.pay + extrasAmount(u.extras, tot.workedDays, tot.workedDays > 0);
      var allShifts = Object.keys(u.shifts || {}).length;
      var row = document.createElement('div');
      row.className = 'admin-row';
      row.innerHTML =
        '<div class="admin-top"><span class="admin-name">' + esc(u.name || '—') + '</span>' +
        '<span class="admin-wage">' + cur + fmtNum(u.hourlyWage || 0) + '/' + t('u_h') + '</span></div>' +
        '<div class="admin-email">' + esc(u.email || u.uid) + '</div>' +
        '<div class="admin-stats"><span>' + allShifts + ' ' + t('stat_shifts') + '</span>' +
        '<span>' + t('admin_month') + ': ' + fmtHours(tot.hours) + ' · ' + cur + fmtNum(Math.round(totalPay)) + '</span></div>';
      list.appendChild(row);
    });
  }

  // Detailed month export: one row per day (hours per tier, break, pay) + totals + % shares.
  function exportMonthCSV() {
    var rows = [];
    var tot = { gross: 0, brk: 0, paid: 0, h100: 0, h125: 0, h150: 0, pay: 0 };
    var workedDays = 0;
    var daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
    for (var d = 1; d <= daysInMonth; d++) {
      var k = keyOf(view.y, view.m, d);
      var s = state.shifts[k];
      if (!s) continue;
      var res = dayResult(k);
      var wd = localeWeekdayShort(new Date(view.y, view.m, d).getDay());
      var typeName = t('leg_' + res.type);
      var brk = Math.round((res.grossHours - res.paidHours) * 60);
      var isVac = s.type === 'vacation';
      if (!isVac && s.type !== 'sick') workedDays++;
      rows.push([k, wd, typeName, isVac ? '' : (s.start || ''), isVac ? '' : (s.end || ''),
        res.grossHours, brk, res.paidHours, res.hours['100'], res.hours['125'], res.hours['150'], res.pay]);
      tot.gross += res.grossHours; tot.brk += brk; tot.paid += res.paidHours;
      tot.h100 += res.hours['100']; tot.h125 += res.hours['125']; tot.h150 += res.hours['150']; tot.pay += res.pay;
    }
    if (!rows.length) { toast(t('t_nodata')); return; }

    // extra payments (travel, etc.) as their own lines, added to the grand total
    var extraLines = [], extrasSum = 0;
    (state.profile.extras || []).forEach(function (e) {
      var amt = (e.per === 'month') ? (workedDays > 0 ? (Number(e.amount) || 0) : 0) : (Number(e.amount) || 0) * workedDays;
      if (amt <= 0) return;
      extrasSum += amt;
      extraLines.push([e.name || t('ex_label'), '', '', '', '', '', '', '', '', '', '', amt]);
    });

    var r2 = SalaryCalc.round2;
    function esc(v) { v = String(v); return /[",\n;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
    function pct(a, b) { return r2(a / (b || 1) * 100) + '%'; }

    var headers = ['csv_date','csv_weekday','csv_type','csv_start','csv_end','csv_gross','csv_break',
      'csv_paid','csv_100','csv_125','csv_150','csv_pay'].map(function (kk) { return t(kk); });

    var lines = [t('csv_month') + ': ' + localeMonthYear(view.y, view.m)];
    lines.push(headers.map(esc).join(','));
    rows.forEach(function (r) {
      lines.push(r.map(function (c, i) { return esc(i >= 5 ? r2(c) : c); }).join(','));
    });
    extraLines.forEach(function (r) {
      lines.push(r.map(function (c, i) { return esc(i === 11 ? r2(c) : c); }).join(','));
    });
    lines.push([t('csv_total'), '', '', '', '', r2(tot.gross), Math.round(tot.brk), r2(tot.paid),
      r2(tot.h100), r2(tot.h125), r2(tot.h150), r2(tot.pay + extrasSum)].map(esc).join(','));
    lines.push([t('csv_share'), '', '', '', '', '', '', '100%',
      pct(tot.h100, tot.paid), pct(tot.h125, tot.paid), pct(tot.h150, tot.paid), ''].map(esc).join(','));

    var csv = '﻿' + lines.join('\r\n'); // UTF-8 BOM so Excel reads Hebrew/Arabic/Cyrillic
    saveFile(csv, 'shiftpay-' + view.y + '-' + pad(view.m + 1) + '.csv', 'text/csv;charset=utf-8');
  }

  function clearData() {
    if (!confirm(t('confirm_erase'))) return;
    state.shifts = {};
    state.profile = { name: '', rate: 0, currency: '₪' };
    save();
    closeSheetEl('settings', 'set-backdrop');
    showOnboarding();
  }

  /* ---------------- onboarding ---------------- */
  function submitOnboarding(e) {
    e.preventDefault();
    var name = $('onb-name').value.trim();
    var rate = parseFloat($('onb-rate').value);
    var cur = $('onb-currency').value.trim() || '₪';
    if (!name) { toast(t('t_name')); return; }
    if (!(rate >= 0) || isNaN(rate)) { toast(t('t_wage')); return; }
    state.profile = { name: name, rate: rate, currency: cur, extras: state.profile.extras || [] };
    save();
    showApp();
  }

  /* ---------------- wiring ---------------- */
  function bind() {
    $('onb-form').addEventListener('submit', submitOnboarding);

    $('prev-month').addEventListener('click', function () {
      view.m--; if (view.m < 0) { view.m = 11; view.y--; } renderView();
    });
    $('next-month').addEventListener('click', function () {
      view.m++; if (view.m > 11) { view.m = 0; view.y++; } renderView();
    });
    $('month-label').addEventListener('click', function () {
      var now = new Date(); view.y = now.getFullYear(); view.m = now.getMonth(); renderView();
    });

    $('fab-today').addEventListener('click', function () {
      var now = new Date(); view.y = now.getFullYear(); view.m = now.getMonth();
      renderView(); openSheet(todayKey());
    });

    document.querySelectorAll('#view-seg .seg-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        state.prefs.view = b.getAttribute('data-view'); save(); renderView();
      });
    });

    // sheet
    $('sheet-close').addEventListener('click', function () { closeSheetEl('sheet', 'sheet-backdrop'); });
    $('sheet-backdrop').addEventListener('click', function () { closeSheetEl('sheet', 'sheet-backdrop'); });
    $('in-start').addEventListener('input', renderPreview);
    $('in-end').addEventListener('input', renderPreview);
    $('btn-save').addEventListener('click', saveShift);
    $('btn-delete').addEventListener('click', deleteShift);
    document.querySelectorAll('#type-seg .seg-btn').forEach(function (b) {
      b.addEventListener('click', function () { typeAuto = false; setTypeSeg(b.getAttribute('data-type')); });
    });
    document.querySelectorAll('#mode-seg .seg-btn').forEach(function (b) {
      b.addEventListener('click', function () { setMode(b.getAttribute('data-mode')); applyFridayUi(editKey); });
    });

    // settings
    $('btn-settings').addEventListener('click', openSettings);
    $('set-close').addEventListener('click', function () { closeSheetEl('settings', 'set-backdrop'); });
    $('set-backdrop').addEventListener('click', function () { closeSheetEl('settings', 'set-backdrop'); });
    $('set-save').addEventListener('click', saveSettings);
    $('btn-export-csv').addEventListener('click', exportMonthCSV);
    $('btn-add-extra').addEventListener('click', addExtra);
    // extras editor (event delegation)
    $('extras-list').addEventListener('input', function (e) {
      var el = e.target, i = +el.getAttribute('data-i'); if (isNaN(i) || !state.profile.extras[i]) return;
      if (el.classList.contains('ex-name')) state.profile.extras[i].name = el.value;
      else if (el.classList.contains('ex-amt')) state.profile.extras[i].amount = parseFloat(el.value) || 0;
      save(); if (!$('app').hidden) renderView();
    });
    $('extras-list').addEventListener('change', function (e) {
      var el = e.target, i = +el.getAttribute('data-i'); if (isNaN(i) || !state.profile.extras[i]) return;
      if (el.classList.contains('ex-per')) { state.profile.extras[i].per = el.value; save(); if (!$('app').hidden) renderView(); }
    });
    $('extras-list').addEventListener('click', function (e) {
      var el = e.target.closest('.ex-del'); if (!el) return;
      var i = +el.getAttribute('data-i'); if (isNaN(i)) return;
      state.profile.extras.splice(i, 1); save(); renderExtras(); if (!$('app').hidden) renderView();
    });
    $('btn-backup').addEventListener('click', exportData);
    $('btn-restore').addEventListener('click', function () { $('restore-file').value = ''; $('restore-file').click(); });
    $('restore-file').addEventListener('change', onRestoreFile);
    $('btn-clear').addEventListener('click', clearData);

    // account / cloud sign-in (sign-in is required)
    $('btn-signout').addEventListener('click', doSignOut);
    $('btn-admin').addEventListener('click', openAdmin);
    $('admin-close').addEventListener('click', function () { closeSheetEl('admin-sheet', 'admin-backdrop'); });
    $('admin-backdrop').addEventListener('click', function () { closeSheetEl('admin-sheet', 'admin-backdrop'); });
    $('auth-submit').addEventListener('click', submitAuth);
    $('auth-toggle').addEventListener('click', function () { setAuthMode(authMode === 'up' ? 'in' : 'up'); });
    $('auth-pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitAuth(); });
    document.querySelectorAll('#theme-seg .seg-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        state.prefs.theme = b.getAttribute('data-theme');
        document.querySelectorAll('#theme-seg .seg-btn').forEach(function (x) {
          x.classList.remove('active'); x.setAttribute('aria-pressed', 'false');
        });
        b.classList.add('active'); b.setAttribute('aria-pressed', 'true');
        save(); applyTheme();
      });
    });

    // PWA install
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault(); deferredInstall = e; addInstallButton();
    });
  }

  function addInstallButton() {
    if ($('btn-install')) return;
    var zone = document.querySelector('.danger-zone');
    if (!zone) return;
    var btn = document.createElement('button');
    btn.id = 'btn-install'; btn.className = 'btn-ghost';
    btn.textContent = t('install');
    btn.addEventListener('click', function () {
      if (!deferredInstall) return;
      deferredInstall.prompt();
      deferredInstall.userChoice.finally(function () { deferredInstall = null; btn.remove(); });
    });
    zone.insertBefore(btn, zone.firstChild);
  }

  function routeInitial() {
    if (!state.prefs.lang) { showLangScreen(); return; }
    if (!auth) { showAuthScreen(); return; }              // sign-in is required
    if (state.profile.name && state.profile.rate) showApp();
    else showOnboarding();
  }

  /* ---------------- boot ---------------- */
  function init() {
    load();
    loadAuth();
    pulling = true;            // suppress cloud writes until the first pull settles
    migrate();
    applyTheme();
    applyLang();
    bind();
    routeInitial();
    updateAccountUI();

    // signed in -> pull the latest from the cloud, then re-route/render
    if (auth && Cloud.configured()) {
      cloudPull()
        .then(function () { routeInitial(); updateAccountUI(); })
        .catch(function () { setSync('sync_offline'); })
        .then(function () { pulling = false; });
    } else {
      pulling = false;
    }

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('service-worker.js', { updateViaCache: 'none' }).catch(function () {});
      });
    }
  }

  init();
})();
